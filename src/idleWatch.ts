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

// Process `devslim _idle-watch <platform> <id> --idle-ms <n>`, launched
// detached by `up --idle-down`. Watches only the session entry that existed
// when it started (same pid and startedAt) and only while its idleDown record
// holds this process pid. Shuts down the same way as `android down` /
// `ios down` and exits. Each log line starts with a timestamp.

export type IdleWatchOptions = IosContext & {
  idlePollMs?: number;
  selfPid?: number; // default process.pid
  log?: (line: string) => void; // default runtime stderr
};

function deviceText(e: SessionEntry): string {
  return e.platform === 'android' ? `android ${e.avd} (${e.serial})` : `ios ${e.avd} (${e.serial})`;
}

async function androidProbe(rt: Runtime, serial: string): Promise<IdleProbe> {
  const adb = rt.adb();
  if (!(await adb.listDevices()).some((d) => d.serial === serial)) return 'gone';
  const res = await adb.shell(serial, ['dumpsys', 'activity', 'activities'], 60_000);
  if (res.code !== 0) throw new DevslimError(`dumpsys activity activities on ${serial} failed (exit ${res.code})`);
  return androidForeground(res.stdout).active ? 'active' : 'idle';
}

async function iosProbe(rt: Runtime, udid: string): Promise<IdleProbe> {
  const simctl = createSimctl({ exec: rt.exec, sleep: rt.sleep, now: rt.now });
  const dev = (await simctl.listDevices()).find((d) => d.udid.toUpperCase() === udid.toUpperCase());
  if (dev === undefined || dev.state !== 'Booted') return 'gone';
  const res = await rt.exec('xcrun', ['simctl', 'spawn', dev.udid, 'launchctl', 'list'], { timeoutMs: 60_000 });
  if (res.code !== 0) throw new DevslimError(`launchctl list on ${udid} failed (exit ${res.code})`);
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
      return null; // unreadable session: treated as gone (never shuts down without an owner)
    }
  };

  const initial = find();
  if (initial === undefined || initial === null) {
    log(`idle-watch ${platform} ${id}: no session entry; exiting without shutting down`);
    return Object.freeze({ reason: 'session-gone', idleForMs: 0 });
  }
  const what = deviceText(initial);
  log(`idle-watch ${what}: shuts down after ${formatDuration(idleMs)} with no app in use (watcher pid ${selfPid})`);

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
      if (r?.result !== 'killed') throw new DevslimError(`android down ${initial.avd}: ${r?.result ?? 'no result'}${r?.detail ? ` (${r.detail})` : ''}`);
    } else {
      const res = await downSim(initial.serial, o);
      const r = res.find((x) => x.udid === initial.serial);
      if (r?.result !== 'shutdown') throw new DevslimError(`ios down ${initial.serial}: ${r?.result ?? 'no result'}${r?.detail ? ` (${r.detail})` : ''}`);
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
    'shutdown-failed': `shutdown failed: ${res.detail ?? '?'}`,
    'device-gone': 'device is no longer running; exiting without shutting down',
    'session-gone': 'entry left the session; exiting without shutting down',
    'session-changed': 'session entry belongs to another boot; exiting without shutting down',
    'watcher-removed': 'watcher record left the session (down or a new up --idle-down); exiting without shutting down',
    'probe-failed': `3 consecutive failures probing the device (${res.detail ?? '?'}); exiting without shutting down`,
  };
  if (res.reason === 'shutdown') {
    log(`idle-down: ${what} shut down after ${formatDuration(res.idleForMs)} with no app in use (limit ${formatDuration(idleMs)})`);
  } else {
    log(`idle-watch ${what}: ${why[res.reason]}`);
  }
  return res;
}
