import { DevslimError } from './errors.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { downAvd, type DownOutcome } from './android/runtime.ts';
import { loadSession, removeSession, type SessionEntry } from './android/session.ts';
import { downSim, type DownSimOutcome, type IosContext } from './ios/slim.ts';
import { measureAvd, measureSim, type AndroidMeasurement, type IosMeasurement } from './measure.ts';
import { listStates } from './state.ts';
import { stopIdleWatcher } from './idle.ts';
import { avdLiveness, listSimDevices, sessionStatus, type SessionStatus } from './status.ts';

// Top-level commands: `devslim down`, `devslim prune` and `devslim measure` cover Android and iOS.

// result 'skipped': with --force and nothing alive in the session for that platform, its
// tooling was missing (no Android SDK, no Xcode); name and id empty, the
// reason goes in detail and in a stderr warning. Does not count as a failure.
export type TopDownOutcome = Readonly<{
  platform: 'android' | 'ios';
  name: string;
  id: string; // serial or UDID
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

// Why a session entry is dead (same detection as the status STALE).
export function staleDetail(platform: 'android' | 'ios'): string {
  return platform === 'android' ? 'no lock and no qemu running' : 'simulator shut down or missing';
}

function skipped(rt: Runtime, platform: 'android' | 'ios', err: unknown): TopDownOutcome {
  const o = skippedFor(platform, err);
  rt.stderr(`devslim: warning: down --force skipped ${platform}: ${o.detail}\n`);
  return o;
}

// Shuts down everything the session recorded. Dead entries (status `stale`, no adb)
// leave the session without any device command; the rest goes to downAvd/downSim.
// `force` is passed to both (also shuts down what devslim did not start).
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
      // A live entry that could not be shut down = failed. Only --force and nothing
      // of ours on Android (e.g. no SDK) = platform skipped, with a warning.
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
  id: string; // serial or UDID
  startedAt: string;
  detail: string;
  // Idle-down record removed along with the entry; the watcher gets no
  // signal (it exits on its own once it sees the device stopped or the entry gone).
  idleDown: Readonly<{ ms: number; watcherPid: number }> | null;
}>;

// `devslim prune`: removes from the session the entries whose device is no longer running
// (same detection as the status STALE), along with their idle-down record. Never
// shuts down a device, never signals a process, never deletes state. Only removes the
// exact entry judged dead (same pid and startedAt): an `up` that
// recorded again in the meantime stays.
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

// Measures everything running: AVDs with state or in the session (running by lock or
// pgrep, no adb) and booted simulators. A failure on one device becomes a warning.
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
      rt.stderr(`devslim: warning: measure of ${avd} failed: ${(err as Error).message}\n`);
    }
  }
  for (const d of (await listSimDevices(rt)) ?? []) {
    if (d.state !== 'Booted') continue;
    try {
      out.push(await measureSim(d.udid, ctx));
    } catch (err) {
      rt.stderr(`devslim: warning: measure of ${d.name} (${d.udid}) failed: ${(err as Error).message}\n`);
    }
  }
  return out;
}
