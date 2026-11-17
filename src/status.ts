import type { Exec } from './exec.ts';
import { findAvd, runningLocks } from './android/avd.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { readEffectiveHardware } from './android/hardwareQemu.ts';
import { launcherFor, launcherText, listQemuProcesses, type Launcher } from './android/launcher.ts';
import { hasSlimSnapshot } from './android/runtime.ts';
import { findRunningEntry, isAdvertised, nodePidAlive, scanRunning, type PidAlive, type RunningEntry } from './android/runningIni.ts';
import { formatDuration } from './idle.ts';
import { loadSession, type SessionEntry } from './android/session.ts';
import { readStore } from './ios/disabledStore.ts';
import { labelsToDisable } from './ios/labels.ts';
import { createSimctl, type SimDevice } from './ios/simctl.ts';
import type { IosContext } from './ios/slim.ts';
import { findQemuPid } from './measure.ts';
import { listStates, loadState, requestedRamMb, type AndroidState, type IosProfileRecord, type IosState } from './state.ts';
import type { Capability } from './capabilities.ts';
import { NO_SWAP_FILE_TEXT, readSwap, type SwapStatus } from './swap.ts';

// `devslim status`: read-only. Never calls adb (it would start the daemon) and
// never writes anything; running emulator = lock in the .avd or qemu `pgrep`. Who
// launched each emulator comes from the qemu command line (pgrep -fl / ps).

// ---------------------------------------------------------------------------
// Liveness without adb (also used by doctor, top-level down and measure).

export type AvdLiveness = Readonly<{ dir: string | null; lock: boolean; pgrep: boolean; pid: number | null; running: boolean }>;

export async function avdLiveness(avd: string, opts: { exec: Exec; env: Runtime['env']; dir?: string | null }): Promise<AvdLiveness> {
  let dir = opts.dir ?? null;
  if (dir === null) {
    try {
      dir = findAvd(avd, { env: opts.env }).dir;
    } catch {
      dir = null; // AVD gone from disk: only pgrep decides
    }
  }
  const lock = dir !== null && runningLocks(dir).length > 0;
  const pid = await findQemuPid(avd, { exec: opts.exec });
  return Object.freeze({ dir, lock, pgrep: pid !== null, pid, running: lock || pid !== null });
}

// `simctl list devices -j`; failure (no Xcode) = null, never an error.
export async function listSimDevices(rt: Runtime): Promise<SimDevice[] | null> {
  try {
    return await createSimctl({ exec: rt.exec, sleep: rt.sleep, now: rt.now }).listDevices();
  } catch {
    return null;
  }
}

export type SessionStatus = Readonly<{
  platform: 'android' | 'ios';
  name: string;
  id: string; // serial (Android) or UDID (iOS)
  pid: number;
  startedAt: string;
  alive: boolean;
  stale: boolean;
  // Idle-down (`up --idle-down`): idle ms before shutdown, watcher pid and
  // whether it is still alive (pidAlive). null = no idle-down.
  idleDown: Readonly<{ ms: number; watcherPid: number; watcherAlive: boolean }> | null;
}>;

// Dead entry: Android with no lock and no qemu; iOS with the device shut down or
// missing. Without the simctl list (null) we cannot tell: counts as alive.
export async function sessionStatus(
  entries: readonly SessionEntry[],
  opts: { exec: Exec; env: Runtime['env']; devices: readonly SimDevice[] | null; pidAlive?: PidAlive },
): Promise<SessionStatus[]> {
  const pidAlive = opts.pidAlive ?? nodePidAlive;
  const out: SessionStatus[] = [];
  for (const e of entries) {
    let alive: boolean;
    if (e.platform === 'android') {
      alive = (await avdLiveness(e.avd, { exec: opts.exec, env: opts.env })).running;
    } else if (opts.devices === null) {
      alive = true;
    } else {
      const dev = opts.devices.find((d) => d.udid.toUpperCase() === e.serial.toUpperCase());
      alive = dev !== undefined && dev.state !== 'Shutdown';
    }
    const w = e.idleDown;
    const idleDown = w == null ? null : Object.freeze({ ms: w.ms, watcherPid: w.watcherPid, watcherAlive: pidAlive(w.watcherPid) });
    out.push(Object.freeze({ platform: e.platform, name: e.avd, id: e.serial, pid: e.pid, startedAt: e.startedAt, alive, stale: !alive, idleDown }));
  }
  return out;
}

export { readSwap, type SwapStatus } from './swap.ts';

// ---------------------------------------------------------------------------
// status

export type IosStatus = Readonly<{
  udid: string;
  name: string;
  state: string; // from simctl; 'missing' (gone) or 'unknown' (simctl failed)
  booted: boolean;
  hasState: boolean;
  profile: IosProfileRecord | null;
  expected: number | null; // labels the saved profile disables
  disabledInStore: number | null; // of those, how many are disabled in the store now
  drift: boolean | null; // store lost profile entries (e.g. after erase)
}>;

export type AndroidStatus = Readonly<{
  avd: string;
  dir: string | null;
  exists: boolean;
  tuned: boolean;
  ramMb: number | null; // = ramRequestedMb (kept for compatibility)
  gpu: string | null; // gpu requested by tune
  ramRequestedMb: number | null; // -memory of the last up/bake (lastLaunch); old state: the tune profile one
  ramEffectiveMb: number | null; // hw.ramSize from the last boot hardware-qemu.ini; null without the file
  ramFloored: boolean; // effective above requested: the emulator raised it
  gpuEffective: string | null; // hw.gpu.mode from the last boot hardware-qemu.ini
  baked: boolean; // snapshots/slim_base exists
  bakedAt: string | null;
  running: boolean;
  runningBy: Readonly<{ lock: boolean; pgrep: boolean }>;
  pid: number | null;
  // false = AVD running without devslim state (shown only while it runs).
  hasState: boolean;
  // Who launched the running emulator (qemu command line); null when stopped or unreadable.
  launcher: Launcher | null;
  // Running: entry in avd/running with grpc.port and grpc.token (the only way argent
  // sees it); null when stopped. grpcPort from the entry, if any.
  advertised: boolean | null;
  grpcPort: number | null;
}>;

// Stable contract of `status --json`.
export type StatusReport = Readonly<{
  ios: readonly IosStatus[];
  android: readonly AndroidStatus[];
  session: readonly SessionStatus[];
  swap: SwapStatus;
  at: string;
}>;

async function iosStatus(rt: Runtime, ctx: IosContext, devices: readonly SimDevice[] | null): Promise<IosStatus[]> {
  const byUdid = new Map<string, IosStatus>();
  for (const d of devices ?? []) {
    if (d.state !== 'Booted') continue;
    byUdid.set(d.udid, Object.freeze({
      udid: d.udid, name: d.name, state: d.state, booted: true, hasState: false, profile: null, expected: null, disabledInStore: null, drift: null,
    }));
  }
  for (const udid of listStates('ios', { env: rt.env })) {
    let st: IosState | null;
    try {
      st = loadState<IosState>('ios', udid, { env: rt.env });
    } catch {
      st = null; // corrupt state: shown without profile
    }
    const dev = devices?.find((d) => d.udid.toUpperCase() === udid.toUpperCase());
    const profile = st?.profile ?? null;
    let expectedLabels: string[] | null = null;
    if (profile !== null) {
      try {
        expectedLabels = labelsToDisable({ capabilities: profile.capabilities as Capability[], except: profile.except, keep: profile.keep });
      } catch {
        expectedLabels = null; // saved profile with an id that no longer exists
      }
    }
    let disabledInStore: number | null = null;
    if (expectedLabels !== null) {
      try {
        const store = await readStore(udid, { base: ctx.storeBase, exec: rt.exec });
        disabledInStore = expectedLabels.filter((l) => store.get(l) === true).length;
      } catch {
        disabledInStore = null; // unreadable store
      }
    }
    const expected = expectedLabels?.length ?? profile?.labels ?? null;
    byUdid.set(dev?.udid ?? udid, Object.freeze({
      udid: dev?.udid ?? udid,
      name: dev?.name ?? st?.name ?? udid,
      state: dev?.state ?? (devices === null ? 'unknown' : 'missing'),
      booted: dev?.state === 'Booted',
      hasState: true,
      profile,
      expected,
      disabledInStore,
      drift: expected === null || disabledInStore === null ? null : disabledInStore < expected,
    }));
  }
  return [...byUdid.values()].sort((a, b) => a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
}

// AVDs with state, plus every running emulator of an AVD without state (pgrep -fl).
async function androidStatus(rt: Runtime, session: readonly SessionEntry[]): Promise<AndroidStatus[]> {
  const processes = await listQemuProcesses(rt.exec);
  // Only live pid entries: pid_<pid>.ini of a dead emulator is not an advertisement.
  const announced: readonly RunningEntry[] = scanRunning(rt.runningDir, rt.pidAlive).live;
  const stated = listStates('android', { env: rt.env });
  const unstated = [...new Set(processes.map((p) => p.avd))].filter((n) => !stated.includes(n));
  const out: AndroidStatus[] = [];
  for (const avd of [...stated, ...unstated]) {
    const hasState = stated.includes(avd);
    let st: AndroidState | null = null;
    if (hasState) {
      try {
        st = loadState<AndroidState>('android', avd, { env: rt.env });
      } catch {
        st = null;
      }
    }
    let info: ReturnType<typeof findAvd> | null;
    try {
      info = findAvd(avd, { env: rt.env });
    } catch {
      info = null;
    }
    const live = await avdLiveness(avd, { exec: rt.exec, env: rt.env, dir: info?.dir ?? null });
    const pid = live.pid ?? processes.find((p) => p.avd === avd)?.pid ?? null;
    const running = live.running || pid !== null;
    const inSession = session.some((e) => e.platform === 'android' && e.avd === avd);
    const launcher = running ? (await launcherFor(avd, { exec: rt.exec, pid, inSession, processes })).launcher : null;
    const hw = info === null ? null : readEffectiveHardware(info.dir);
    const entry = running ? findRunningEntry(announced, avd) : null;
    const requested = requestedRamMb(st); // last up/bake (lastLaunch), else the tune profile
    const effective = hw?.ramMb ?? null;
    out.push(Object.freeze({
      avd,
      dir: info?.dir ?? st?.avdDir ?? null,
      exists: info !== null,
      tuned: typeof st?.originalConfigIni === 'string',
      ramMb: requested,
      gpu: st?.profile?.gpu ?? null,
      ramRequestedMb: requested,
      ramEffectiveMb: effective,
      ramFloored: requested !== null && effective !== null && effective > requested,
      gpuEffective: hw?.gpu ?? null,
      baked: info !== null && hasSlimSnapshot(info),
      bakedAt: st?.bakedAt ?? null,
      running,
      runningBy: Object.freeze({ lock: live.lock, pgrep: pid !== null }),
      pid,
      hasState,
      launcher,
      advertised: running ? isAdvertised(entry) : null,
      grpcPort: entry?.grpcPort ?? null,
    }));
  }
  return out.sort((a, b) => a.avd.localeCompare(b.avd));
}

export async function collectStatus(ctx: IosContext = {}): Promise<StatusReport> {
  const rt = resolveRuntime(ctx);
  const devices = await listSimDevices(rt);
  const ios = await iosStatus(rt, ctx, devices);
  const entries = loadSession(rt.env);
  const android = await androidStatus(rt, entries);
  const session = await sessionStatus(entries, { exec: rt.exec, env: rt.env, devices, pidAlive: rt.pidAlive });
  const swap = await readSwap(rt.exec);
  return Object.freeze({
    ios: Object.freeze(ios),
    android: Object.freeze(android),
    session: Object.freeze(session),
    swap,
    at: rt.date().toISOString(),
  });
}

// "ram requested 2048 MB, effective 2560 MB (emulator raised it)"; without hardware-qemu.ini, only the requested one.
function ramText(a: AndroidStatus): string {
  const asked = `ram requested ${a.ramRequestedMb ?? '?'} MB`;
  if (a.ramEffectiveMb === null) return asked;
  return `${asked}, effective ${a.ramEffectiveMb} MB${a.ramFloored ? ' (emulator raised it)' : ''}`;
}

// AVD without state: only what the emulator actually used, if there is a hardware-qemu.ini.
function effectiveText(a: AndroidStatus): string {
  const parts = [
    a.ramEffectiveMb === null ? null : `effective ram ${a.ramEffectiveMb} MB`,
    a.gpuEffective === null ? null : `effective gpu ${a.gpuEffective}`,
  ].filter((x) => x !== null);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

function gpuText(a: AndroidStatus): string {
  if (a.gpuEffective === null || a.gpuEffective === a.gpu) return `gpu ${a.gpu ?? '?'}`;
  return `gpu requested ${a.gpu ?? '?'}, effective ${a.gpuEffective}`;
}

// Text lines: one per device/entry, plus swap.
export function statusText(s: StatusReport): string[] {
  const lines: string[] = [];
  for (const d of s.ios) {
    if (!d.hasState) {
      lines.push(`ios ${d.name} (${d.udid}) ${d.state}: no devslim state`);
      continue;
    }
    const p = d.profile;
    const caps = p !== null && p.capabilities.length > 0 ? ` (capabilities ${p.capabilities.join(',')})` : '';
    const store = d.disabledInStore === null ? 'store unreadable or absent' : `store ${d.disabledInStore}/${d.expected} disabled`;
    // State of a simulator that no longer exists: only the record remains.
    const orphan = d.state === 'missing' ? `, simulator no longer exists; orphan state: devslim ios forget ${d.udid}` : '';
    lines.push(`ios ${d.name} (${d.udid}) ${d.state}: profile ${d.expected ?? '?'} labels${caps}, ${store}${d.drift ? ', DRIFT (run devslim ios up again)' : ''}${orphan}`);
  }
  for (const a of s.android) {
    const parts: string[] = [];
    if (!a.hasState) {
      parts.push(`no devslim state${effectiveText(a)}`);
      parts.push(a.exists ? `baked ${a.baked ? 'yes' : 'no'}` : 'AVD not found');
    } else {
      parts.push(
        a.exists
          ? a.tuned
            ? `tuned (${ramText(a)}, ${gpuText(a)})`
            : 'not tuned'
          : `AVD not found (${a.dir ?? '?'}); orphan state: devslim android forget ${a.avd}`,
        `baked ${a.baked ? 'yes' : 'no'}`,
      );
    }
    const by = [a.runningBy.lock ? 'lock' : null, a.runningBy.pgrep ? `pgrep pid ${a.pid}` : null].filter((x) => x !== null);
    // Suffix only when the emulator is not ours.
    const who = a.launcher === 'argent' || a.launcher === 'other' ? ` ${launcherText(a.launcher)}` : '';
    const ad = a.running && a.advertised === false ? ' no gRPC advertisement' : '';
    parts.push(a.running ? `running (${by.join(', ')})${who}${ad}` : 'stopped');
    lines.push(`android ${a.avd}: ${parts.join(', ')}`);
  }
  for (const e of s.session) {
    const w = e.idleDown;
    const idle = w === null ? '' : `, idle-down after ${formatDuration(w.ms)} with no app in use (watcher pid ${w.watcherPid} ${w.watcherAlive ? 'alive' : 'DEAD'})`;
    lines.push(`session ${e.platform} ${e.name} ${e.id}: ${e.stale ? 'STALE (devslim down cleans it)' : 'alive'}${idle}`);
  }
  if (s.ios.length === 0) lines.push('ios: nothing booted and no state');
  if (s.android.length === 0) lines.push('android: no AVD with state and no emulator running');
  if (s.session.length === 0) lines.push('session: empty');
  const w = s.swap;
  if (w.percent === null) lines.push('swap: not read');
  else if (w.totalMb === 0) lines.push(`swap: ${NO_SWAP_FILE_TEXT}`);
  else lines.push(`swap: ${w.usedMb} of ${w.totalMb} MB (${w.percent}%)`);
  return lines;
}
