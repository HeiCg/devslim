import { DevslimError } from './errors.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { downAvd, type DownOutcome } from './android/runtime.ts';
import { loadSession, removeSession, type SessionEntry } from './android/session.ts';
import { downSim, type DownSimOutcome, type IosContext } from './ios/slim.ts';
import { measureAvd, measureSim, type AndroidMeasurement, type IosMeasurement } from './measure.ts';
import { listStates } from './state.ts';
import { stopIdleWatcher } from './idle.ts';
import { avdLiveness, listSimDevices, sessionStatus, type SessionStatus } from './status.ts';

// Comandos de topo: `devslim down`, `devslim prune` e `devslim measure` cobrem Android e iOS.

// result 'skipped': com --force e nada vivo na sessao daquela plataforma, a
// ferramenta dela faltou (sem SDK Android, sem Xcode); name e id vazios, o
// motivo vai em detail e num aviso em stderr. Nao conta como falha.
export type TopDownOutcome = Readonly<{
  platform: 'android' | 'ios';
  name: string;
  id: string; // serial ou UDID
  registered: boolean;
  result: DownOutcome['result'] | DownSimOutcome['result'] | 'skipped';
  detail?: string;
}>;

const fromAndroid = (r: DownOutcome): TopDownOutcome =>
  Object.freeze({ platform: 'android', name: r.avd, id: r.serial, registered: r.registered, result: r.result, ...(r.detail ? { detail: r.detail } : {}) });

const fromIos = (r: DownSimOutcome): TopDownOutcome =>
  Object.freeze({ platform: 'ios', name: r.name, id: r.udid, registered: r.registered, result: r.result, ...(r.detail ? { detail: r.detail } : {}) });

const failedFor = (s: SessionStatus, err: unknown): TopDownOutcome =>
  Object.freeze({ platform: s.platform, name: s.name, id: s.id, registered: true, result: 'failed', detail: (err as Error).message });

const skippedFor = (platform: 'android' | 'ios', err: unknown): TopDownOutcome =>
  Object.freeze({ platform, name: '', id: '', registered: false, result: 'skipped', detail: (err as Error).message });

// Por que uma entrada da sessao e morta (mesma deteccao do STALE do status).
export function staleDetail(platform: 'android' | 'ios'): string {
  return platform === 'android' ? 'sem lock nem qemu rodando' : 'simulador desligado ou inexistente';
}

function skipped(rt: Runtime, platform: 'android' | 'ios', err: unknown): TopDownOutcome {
  const o = skippedFor(platform, err);
  rt.stderr(`devslim: aviso: down --force pulou ${platform}: ${o.detail}\n`);
  return o;
}

// Desliga tudo que a sessao registrou. Entradas mortas (status `stale`, sem adb)
// saem da sessao sem nenhum comando no device; o resto vai para downAvd/downSim.
// `force` repassa para os dois (desliga tambem o que o devslim nao subiu).
export async function downAll(ctx: IosContext & { force?: boolean } = {}): Promise<TopDownOutcome[]> {
  const rt = resolveRuntime(ctx);
  const force = ctx.force === true;
  const entries = loadSession(rt.env);
  if (entries.length === 0 && !force) return [];
  const devices = entries.some((e) => e.platform === 'ios') ? await listSimDevices(rt) : [];
  const st = await sessionStatus(entries, { exec: rt.exec, env: rt.env, devices, pidAlive: rt.pidAlive });

  const out: TopDownOutcome[] = [];
  for (const s of st.filter((x) => x.stale)) {
    const entry = entries.find((e) => e.platform === s.platform && e.serial === s.id);
    if (entry !== undefined) await stopIdleWatcher(entry, rt);
    removeSession((e) => e.platform === s.platform && e.serial === s.id, rt.env);
    out.push(Object.freeze({
      platform: s.platform,
      name: s.name,
      id: s.id,
      registered: true,
      result: 'stale',
      detail: staleDetail(s.platform),
    }));
  }

  const live = st.filter((x) => !x.stale);
  const liveAndroid = live.filter((x) => x.platform === 'android');
  const liveIos = live.filter((x) => x.platform === 'ios');
  if (liveAndroid.length > 0 || force) {
    try {
      out.push(...(await downAvd(undefined, { ...ctx, force })).map(fromAndroid));
    } catch (err) {
      if (!(err instanceof DevslimError)) throw err;
      // Entrada viva que nao deu para desligar = failed. So --force e nada
      // nosso no Android (ex.: sem SDK) = plataforma pulada, avisada.
      if (liveAndroid.length > 0) out.push(...liveAndroid.map((s) => failedFor(s, err)));
      else out.push(skipped(rt, 'android', err));
    }
  }
  if (liveIos.length > 0 || force) {
    try {
      out.push(...(await downSim(undefined, { ...ctx, force })).map(fromIos));
    } catch (err) {
      if (!(err instanceof DevslimError)) throw err;
      if (liveIos.length > 0) out.push(...liveIos.map((s) => failedFor(s, err)));
      else out.push(skipped(rt, 'ios', err));
    }
  }
  return out;
}

export type PruneOutcome = Readonly<{
  platform: 'android' | 'ios';
  name: string;
  id: string; // serial ou UDID
  startedAt: string;
  detail: string;
  // Registro do auto-desligar que saiu junto com a entrada; o watcher nao
  // recebe sinal (sai sozinho ao ver o device parado ou a entrada sumida).
  idleDown: Readonly<{ ms: number; watcherPid: number }> | null;
}>;

// `devslim prune`: tira da sessao as entradas cujo device ja nao roda (a mesma
// deteccao do STALE do status), com o registro do auto-desligar delas. Nunca
// desliga device, nunca sinaliza processo, nunca apaga state. So remove a
// entrada exata que foi julgada morta (mesmo pid e startedAt): um `up` que
// registrou de novo no meio do caminho fica.
export async function pruneSession(ctx: IosContext = {}): Promise<PruneOutcome[]> {
  const rt = resolveRuntime(ctx);
  const entries = loadSession(rt.env);
  if (entries.length === 0) return [];
  const devices = entries.some((e) => e.platform === 'ios') ? await listSimDevices(rt) : [];
  const st = await sessionStatus(entries, { exec: rt.exec, env: rt.env, devices, pidAlive: rt.pidAlive });
  const dead = entries.filter((_, i) => st[i].stale);
  if (dead.length === 0) return [];
  const same = (a: SessionEntry, b: SessionEntry) =>
    a.platform === b.platform && a.serial === b.serial && a.avd === b.avd && a.pid === b.pid && a.startedAt === b.startedAt;
  const removed = removeSession((e) => dead.some((d) => same(d, e)), rt.env);
  return removed.map((e) =>
    Object.freeze({
      platform: e.platform,
      name: e.avd,
      id: e.serial,
      startedAt: e.startedAt,
      detail: staleDetail(e.platform),
      idleDown: e.idleDown == null ? null : Object.freeze({ ms: e.idleDown.ms, watcherPid: e.idleDown.watcherPid }),
    }),
  );
}

export type AnyMeasurement = AndroidMeasurement | IosMeasurement;

// Mede tudo que esta rodando: AVDs com state ou na sessao (rodando por lock ou
// pgrep, sem adb) e simuladores bootados. Falha de um device vira aviso.
export async function measureAll(ctx: IosContext = {}): Promise<AnyMeasurement[]> {
  const rt = resolveRuntime(ctx);
  const out: AnyMeasurement[] = [];
  const names = new Set<string>(listStates('android', { env: rt.env }));
  for (const e of loadSession(rt.env)) if (e.platform === 'android') names.add(e.avd);
  for (const avd of [...names].sort()) {
    if (!(await avdLiveness(avd, { exec: rt.exec, env: rt.env })).running) continue;
    try {
      out.push(await measureAvd(avd, ctx));
    } catch (err) {
      rt.stderr(`devslim: aviso: measure de ${avd} falhou: ${(err as Error).message}\n`);
    }
  }
  for (const d of (await listSimDevices(rt)) ?? []) {
    if (d.state !== 'Booted') continue;
    try {
      out.push(await measureSim(d.udid, ctx));
    } catch (err) {
      rt.stderr(`devslim: aviso: measure de ${d.name} (${d.udid}) falhou: ${(err as Error).message}\n`);
    }
  }
  return out;
}
