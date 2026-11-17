import { DevslimError } from './errors.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { downAvd } from './android/runtime.ts';
import { loadSession, type SessionEntry } from './android/session.ts';
import { createSimctl } from './ios/simctl.ts';
import { downSim, type IosContext } from './ios/slim.ts';
import {
  androidForeground,
  formatDuration,
  idleLoop,
  iosForeground,
  sessionMatcher,
  type IdleLoopResult,
  type IdleOwnership,
  type IdlePlatform,
  type IdleProbe,
} from './idle.ts';

// Processo `devslim _idle-watch <platform> <id> --idle-ms <n>`, lancado
// destacado pelo `up --idle-down`. Vigia so a entrada da sessao que existia
// quando subiu (mesmo pid e startedAt) e so enquanto o registro idleDown dela
// tiver o pid deste processo. Desliga pelo mesmo caminho do `android down` /
// `ios down` e sai. Cada linha do log comeca pelo carimbo de hora.

export type IdleWatchOptions = IosContext & {
  idlePollMs?: number;
  selfPid?: number; // padrao process.pid
  log?: (line: string) => void; // padrao stderr do runtime
};

function deviceText(e: SessionEntry): string {
  return e.platform === 'android' ? `android ${e.avd} (${e.serial})` : `ios ${e.avd} (${e.serial})`;
}

async function androidProbe(rt: Runtime, serial: string): Promise<IdleProbe> {
  const adb = rt.adb();
  if (!(await adb.listDevices()).some((d) => d.serial === serial)) return 'gone';
  const res = await adb.shell(serial, ['dumpsys', 'activity', 'activities'], 60_000);
  if (res.code !== 0) throw new DevslimError(`dumpsys activity activities em ${serial} falhou (exit ${res.code})`);
  return androidForeground(res.stdout).active ? 'active' : 'idle';
}

async function iosProbe(rt: Runtime, udid: string): Promise<IdleProbe> {
  const simctl = createSimctl({ exec: rt.exec, sleep: rt.sleep, now: rt.now });
  const dev = (await simctl.listDevices()).find((d) => d.udid.toUpperCase() === udid.toUpperCase());
  if (dev === undefined || dev.state !== 'Booted') return 'gone';
  const res = await rt.exec('xcrun', ['simctl', 'spawn', dev.udid, 'launchctl', 'list'], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new DevslimError(`launchctl list em ${udid} falhou (exit ${res.code})`);
  return iosForeground(res.stdout).active ? 'active' : 'idle';
}

export async function runIdleWatch(platform: IdlePlatform, id: string, idleMs: number, o: IdleWatchOptions = {}): Promise<IdleLoopResult> {
  const rt = resolveRuntime(o);
  const selfPid = o.selfPid ?? process.pid;
  const write = o.log ?? rt.stderr;
  const log = (msg: string) => write(`${rt.date().toISOString()} ${msg}\n`);
  const match = sessionMatcher(platform, id);
  const find = (): SessionEntry | undefined | null => {
    try {
      return loadSession(rt.env).find(match);
    } catch {
      return null; // sessao ilegivel: trata como sumida (nunca desliga sem dono)
    }
  };

  const initial = find();
  if (initial === undefined || initial === null) {
    log(`idle-watch ${platform} ${id}: sem entrada na sessao; saindo sem desligar`);
    return Object.freeze({ reason: 'session-gone', idleForMs: 0 });
  }
  const what = deviceText(initial);
  log(`idle-watch ${what}: desliga apos ${formatDuration(idleMs)} sem app em uso (watcher pid ${selfPid})`);

  const owner = async (): Promise<IdleOwnership> => {
    const e = find();
    if (e === undefined || e === null) return 'session-gone';
    if (e.pid !== initial.pid || e.startedAt !== initial.startedAt || e.serial !== initial.serial) return 'session-changed';
    if (e.idleDown?.watcherPid !== selfPid) return 'watcher-removed';
    return 'owned';
  };

  const probe = () => (platform === 'android' ? androidProbe(rt, initial.serial) : iosProbe(rt, initial.serial));

  const shutdown = async () => {
    if (platform === 'android') {
      const res = await downAvd(initial.avd, o);
      const r = res.find((x) => x.serial === initial.serial);
      if (r?.result !== 'killed') throw new DevslimError(`android down ${initial.avd}: ${r?.result ?? 'sem resultado'}${r?.detail ? ` (${r.detail})` : ''}`);
    } else {
      const res = await downSim(initial.serial, o);
      const r = res.find((x) => x.udid === initial.serial);
      if (r?.result !== 'shutdown') throw new DevslimError(`ios down ${initial.serial}: ${r?.result ?? 'sem resultado'}${r?.detail ? ` (${r.detail})` : ''}`);
    }
  };

  const res = await idleLoop({
    idleMs,
    pollMs: o.idlePollMs,
    probe,
    owner,
    shutdown,
    sleep: rt.sleep,
    now: rt.now,
    log: (m) => log(`idle-watch ${what}: ${m}`),
  });

  const why: Record<IdleLoopResult['reason'], string> = {
    shutdown: '',
    'shutdown-failed': `desligar falhou: ${res.detail ?? '?'}`,
    'device-gone': 'device nao esta mais rodando; saindo sem desligar',
    'session-gone': 'entrada saiu da sessao; saindo sem desligar',
    'session-changed': 'entrada da sessao e de outro boot; saindo sem desligar',
    'watcher-removed': 'registro do watcher saiu da sessao (down ou novo up --idle-down); saindo sem desligar',
    'probe-failed': `3 falhas seguidas ao sondar o device (${res.detail ?? '?'}); saindo sem desligar`,
  };
  if (res.reason === 'shutdown') {
    log(`auto-desligar: ${what} desligado apos ${formatDuration(res.idleForMs)} sem app em uso (limite ${formatDuration(idleMs)})`);
  } else {
    log(`idle-watch ${what}: ${why[res.reason]}`);
  }
  return res;
}
