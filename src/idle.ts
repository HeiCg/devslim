import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.ts';
import type { Runtime } from './android/deps.ts';
import { loadSession, updateSession, type IdleDownRecord, type SessionEntry } from './android/session.ts';
import { devslimHome } from './state.ts';

// Idle-down (`up --idle-down <dur>`): a detached process (`devslim
// _idle-watch`) checks the device every 30 s and, after <dur> with no
// third-party app in the foreground, shuts it down the same way as `down`. This file
// holds the pure parts (duration, foreground parsing, loop) and the watcher
// record in the session; the process itself lives in idleWatch.ts.

export const IDLE_MIN_MS = 2 * 60_000;
export const IDLE_POLL_MS = 30_000;
export const MAX_PROBE_FAILURES = 3;
export const IDLE_WATCH_CMD = '_idle-watch';

// bin/devslim of this checkout: the watcher runs the same code as `up`.
export const DEVSLIM_BIN = fileURLToPath(new URL('../bin/devslim', import.meta.url));

const DURATION_RE = /^(\d{1,9})([smh]?)$/;
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({ s: 1000, m: 60_000, h: 3_600_000, '': 60_000 });

// `30m`, `90s`, `1h` or a bare number (minutes). Minimum 2 minutes.
export function parseIdleDuration(text: string): number {
  const m = DURATION_RE.exec(text);
  if (m === null) throw new UsageError(`--idle-down requires a duration like 30m, 90s, 1h or minutes (bare number), got: ${text}`);
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  if (ms < IDLE_MIN_MS) throw new UsageError(`--idle-down minimum is 2m, got: ${text}`);
  return ms;
}

// 5400000 -> "1h30m"; 150000 -> "2m30s"; rounds to the second.
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', s > 0 ? `${s}s` : ''].join('');
  return parts === '' ? '0s' : parts;
}

// ---------------------------------------------------------------------------
// What is in the foreground

// Launcher and system apps do not count as use.
export function isSystemPackage(pkg: string): boolean {
  return pkg.startsWith('com.android.') || pkg.startsWith('com.google.android.') || pkg.startsWith('android');
}

// Lines `topResumedActivity=ActivityRecord{<hash> u0 <pkg>/<activity> t5}`
// (Android 10+) and `mResumedActivity: ...`/`ResumedActivity: ...` (per display,
// and older spelling) from `dumpsys activity activities`. Empty or unreadable = nothing
// in the foreground (idle). More than one (split screen): any third-party app counts as use.
const RESUMED_RE = /ResumedActivity\s*[=:]\s*ActivityRecord\{[^\s}]+\s+(?:u\d+\s+)?([A-Za-z][A-Za-z0-9_.]*)\//g;

export function androidForeground(dumpsys: string): { active: boolean; packages: string[] } {
  const packages = [...new Set([...dumpsys.matchAll(RESUMED_RE)].map((m) => m[1]))];
  return { active: packages.some((p) => !isSystemPackage(p)), packages };
}

// Simulator `launchctl list`: `UIKitApplication:<bundle>[...]` is a running
// app. A bundle outside `com.apple.` = use.
const UIKIT_RE = /UIKitApplication:([^\s[]+)/g;

export function iosForeground(launchctlList: string): { active: boolean; apps: string[] } {
  const apps = [...new Set([...launchctlList.matchAll(UIKIT_RE)].map((m) => m[1]))].filter((b) => !b.startsWith('com.apple.'));
  return { active: apps.length > 0, apps };
}

// ---------------------------------------------------------------------------
// Watcher loop

export type IdleProbe = 'active' | 'idle' | 'gone';
export type IdleOwnership = 'owned' | 'session-gone' | 'session-changed' | 'watcher-removed';
export type IdleStopReason = 'shutdown' | 'shutdown-failed' | 'device-gone' | 'probe-failed' | Exclude<IdleOwnership, 'owned'>;
export type IdleLoopResult = Readonly<{ reason: IdleStopReason; idleForMs: number; detail?: string }>;

export type IdleLoopOptions = {
  idleMs: number;
  pollMs?: number;
  probe: () => Promise<IdleProbe>; // exception = probe failure
  owner: () => Promise<IdleOwnership>; // is the session entry still owned by this watcher?
  shutdown: () => Promise<void>; // exception = shutdown-failed
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (msg: string) => void;
};

// Every `pollMs`: checks the owner, probes the device. Use resets the clock; a probe
// failure neither resets nor counts. Shuts down only after a full `idleMs` idle with the owner
// checked again right before. Any other exit never calls shutdown.
export async function idleLoop(o: IdleLoopOptions): Promise<IdleLoopResult> {
  const pollMs = o.pollMs ?? IDLE_POLL_MS;
  let lastActive = o.now();
  let failures = 0;
  const stop = (reason: IdleStopReason, detail?: string): IdleLoopResult =>
    Object.freeze({ reason, idleForMs: o.now() - lastActive, ...(detail === undefined ? {} : { detail }) });
  for (;;) {
    await o.sleep(pollMs);
    const own = await o.owner();
    if (own !== 'owned') return stop(own);
    let state: IdleProbe;
    try {
      state = await o.probe();
      failures = 0;
    } catch (err) {
      failures++;
      o.log?.(`probe failed (${failures}/${MAX_PROBE_FAILURES}): ${(err as Error).message}`);
      if (failures >= MAX_PROBE_FAILURES) return stop('probe-failed', (err as Error).message);
      continue;
    }
    if (state === 'gone') return stop('device-gone');
    if (state === 'active') {
      lastActive = o.now();
      continue;
    }
    if (o.now() - lastActive < o.idleMs) continue;
    const again = await o.owner();
    if (again !== 'owned') return stop(again);
    const idleForMs = o.now() - lastActive;
    try {
      await o.shutdown();
    } catch (err) {
      return Object.freeze({ reason: 'shutdown-failed', idleForMs, detail: (err as Error).message });
    }
    return Object.freeze({ reason: 'shutdown', idleForMs });
  }
}

// ---------------------------------------------------------------------------
// Watcher record in the session

export type IdlePlatform = 'android' | 'ios';

const ID_RE = /^[A-Za-z0-9._-]+$/;

// Android: id = AVD name. iOS: id = UDID.
export function sessionMatcher(platform: IdlePlatform, id: string): (e: SessionEntry) => boolean {
  return platform === 'android'
    ? (e) => e.platform === 'android' && e.avd === id
    : (e) => e.platform === 'ios' && e.serial.toUpperCase() === id.toUpperCase();
}

export function sessionIdOf(e: SessionEntry): string {
  return e.platform === 'android' ? e.avd : e.serial;
}

export function idleLogFile(id: string, env: Runtime['env']): string {
  return join(devslimHome(env), 'logs', `idle-${id}.log`);
}

// Is the pid still our watcher? Checks the command line (`ps -o command=`)
// so we never signal a process that inherited the pid.
async function isOurWatcher(pid: number, e: SessionEntry, rt: Runtime): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const res = await rt.exec('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 10_000 });
    return res.code === 0 && res.stdout.includes(`${IDLE_WATCH_CMD} ${e.platform} ${sessionIdOf(e)} `);
  } catch {
    return false;
  }
}

// SIGTERM to the watcher registered in the entry (if it really is it and not this
// process) and removes the field from the session. Dead or reused pid: just cleans up.
export async function stopIdleWatcher(e: SessionEntry, rt: Runtime): Promise<'stopped' | 'not-running' | 'self' | 'none'> {
  const w = e.idleDown;
  if (w === undefined || w === null) return 'none';
  let out: 'stopped' | 'not-running' | 'self' = 'not-running';
  if (w.watcherPid === process.pid) out = 'self';
  else if (await isOurWatcher(w.watcherPid, e, rt)) {
    try {
      rt.signalPid(w.watcherPid, 'SIGTERM');
      out = 'stopped';
    } catch (err) {
      rt.stderr(`devslim: warning: SIGTERM to the idle-down watcher (pid ${w.watcherPid}) failed: ${(err as Error).message}\n`);
    }
  }
  const match = sessionMatcher(e.platform, sessionIdOf(e));
  updateSession((x) => match(x) && x.idleDown?.watcherPid === w.watcherPid, ({ idleDown: _drop, ...rest }) => rest, rt.env);
  return out;
}

export type IdleWatcherInfo = Readonly<{ ms: number; watcherPid: number; startedAt: string; logFile: string }>;

// Starts the watcher for the session device (replaces the previous one). null = the
// device is not in the session (devslim did not start it): nothing is launched.
export async function startIdleWatcher(platform: IdlePlatform, id: string, ms: number, rt: Runtime): Promise<IdleWatcherInfo | null> {
  if (!ID_RE.test(id)) throw new UsageError(`invalid id for idle-down: ${id}`);
  const match = sessionMatcher(platform, id);
  const entry = loadSession(rt.env).find(match);
  if (entry === undefined) return null;
  await stopIdleWatcher(entry, rt);
  const logFile = idleLogFile(id, rt.env);
  mkdirSync(join(devslimHome(rt.env), 'logs'), { recursive: true, mode: 0o700 });
  const { pid } = await rt.spawnDetached(process.execPath, [DEVSLIM_BIN, IDLE_WATCH_CMD, platform, id, '--idle-ms', String(ms)], {
    logFile,
    env: rt.env,
  });
  const record: IdleDownRecord = Object.freeze({ ms, watcherPid: pid, startedAt: rt.date().toISOString() });
  updateSession(match, (e) => ({ ...e, idleDown: record }), rt.env);
  return Object.freeze({ ...record, logFile });
}

export function idleUpLine(w: IdleWatcherInfo): string {
  return `idle-down: after ${formatDuration(w.ms)} with no app in use (watcher pid ${w.watcherPid}, log ${w.logFile})`;
}

// `why`: concrete reason (e.g. simulator already booted and slim, which up does not reboot).
export function idleSkippedWarning(what: string, why?: string): string {
  if (why !== undefined) return `devslim: warning: idle-down ignored: ${what}: ${why} (nothing in the session)\n`;
  return `devslim: warning: idle-down ignored: ${what} was not started by devslim (nothing in the session)\n`;
}

export const IOS_ALREADY_SLIM_REASON = 'simulator was already booted and slim; devslim did not start it';
