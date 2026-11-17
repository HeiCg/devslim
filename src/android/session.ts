import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DevslimError } from '../errors.ts';
import type { Exec } from '../exec.ts';
import { writeFileAtomic } from '../fsAtomic.ts';
import { devslimHome } from '../state.ts';
import { DEFAULT_EXIT_TIMEOUT_MS, type Adb, type AdbDevice } from './adb.ts';
import { runningLocks } from './avd.ts';
import { nodePidAlive, type PidAlive } from './runningIni.ts';
import { parseSwapUsage, SWAP_WARN_PERCENT, type SwapUsage } from '../swap.ts';

type Env = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Record of what THIS lib started, for `down`. Lives in
// $DEVSLIM_HOME/state/session.json (outside state/android/ so it does not collide
// with an AVD named "session").
// iOS uses the same format: `avd` = simulator name, `serial` = UDID,
// `pid` and `port` = 0 (no process or port of its own).

// Idle-down watcher (`up --idle-down`): idle ms before shutdown, pid of the
// `devslim _idle-watch` process and when it started. Absent = no idle-down.
export type IdleDownRecord = Readonly<{ ms: number; watcherPid: number; startedAt: string }>;

export type SessionEntry = Readonly<{
  platform: 'android' | 'ios';
  avd: string;
  serial: string;
  pid: number;
  port: number;
  startedAt: string;
  idleDown?: IdleDownRecord;
}>;

type SessionFile = { version: 1; entries: SessionEntry[] };

export function sessionPath(env: Env = process.env): string {
  return join(devslimHome(env), 'state', 'session.json');
}

export function loadSession(env: Env = process.env): SessionEntry[] {
  const path = sessionPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return [];
    throw err;
  }
  try {
    const data = JSON.parse(text) as SessionFile;
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    throw new DevslimError(`corrupt session state (invalid JSON): ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Advisory session lock. `up`, `down` and the idle-down watcher are
// separate processes that read-modify-write session.json; every write
// goes through withSessionLock (read, change and write in one critical section).
// The lock is `session.json.lock`, created with `wx` holding the owner pid and time.
// Older than SESSION_LOCK_STALE_MS or with a dead pid = abandoned: it is deleted
// (if it is still the same file) and acquisition starts over. Reads do not lock: the
// write is atomic (fsAtomic), a reader sees the whole old or new session.

export const SESSION_LOCK_TIMEOUT_MS = 5_000;
export const SESSION_LOCK_STALE_MS = 30_000;
export const SESSION_LOCK_STEP_MS = 50;

// Synchronous on purpose: the session write functions are synchronous and the
// process has nothing else to do while waiting for the lock.
export type SessionLockOptions = {
  sleep?: (ms: number) => void;
  now?: () => number;
  pidAlive?: PidAlive;
  pid?: number; // owner written to the lock; default process.pid
  timeoutMs?: number;
  staleMs?: number;
  stepMs?: number;
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function sessionLockPath(env: Env = process.env): string {
  return `${sessionPath(env)}.lock`;
}

type HeldLock = { raw: string; pid: number | null; atMs: number | null; token: string | null };

// null = no file. Unreadable content (the owner just created it and has not
// written yet) comes with pid/atMs null; the age comes from mtime.
function readLock(path: string): HeldLock | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const d = JSON.parse(raw) as { pid?: unknown; at?: unknown; token?: unknown };
    const at = typeof d.at === 'string' ? Date.parse(d.at) : NaN;
    return {
      raw,
      pid: Number.isInteger(d.pid) ? (d.pid as number) : null,
      atMs: Number.isFinite(at) ? at : null,
      token: typeof d.token === 'string' ? d.token : null,
    };
  } catch {
    return { raw, pid: null, atMs: null, token: null };
  }
}

function lockAgeMs(path: string, held: HeldLock, now: number): number | null {
  if (held.atMs !== null) return now - held.atMs;
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null; // gone: the next round tries to create it
  }
}

export function withSessionLock<T>(env: Env, fn: () => T, o: SessionLockOptions = {}): T {
  const path = sessionLockPath(env);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleepSync;
  const pidAlive = o.pidAlive ?? nodePidAlive;
  const timeoutMs = o.timeoutMs ?? SESSION_LOCK_TIMEOUT_MS;
  const staleMs = o.staleMs ?? SESSION_LOCK_STALE_MS;
  const stepMs = o.stepMs ?? SESSION_LOCK_STEP_MS;
  const token = randomUUID();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const deadline = now() + timeoutMs;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, JSON.stringify({ pid: o.pid ?? process.pid, at: new Date(now()).toISOString(), token }) + '\n');
      } finally {
        closeSync(fd);
      }
      break;
    }
    const held = readLock(path);
    if (held === null) continue; // released between the open and the read
    const age = lockAgeMs(path, held, now());
    const stale = (age !== null && age > staleMs) || (held.pid !== null && !pidAlive(held.pid));
    if (stale) {
      // Only deletes if it is still the same abandoned lock (someone else may have taken it).
      if (readLock(path)?.raw === held.raw) {
        try {
          unlinkSync(path);
        } catch (err) {
          if ((err as { code?: string }).code !== 'ENOENT') throw err;
        }
      }
      continue;
    }
    if (now() >= deadline) {
      throw new DevslimError(
        `session busy: timed out after ${timeoutMs / 1000} s waiting for the lock ${path} (owner pid ${held.pid ?? '?'}); ` +
          'if that process is stuck, kill it or delete the file',
      );
    }
    sleep(stepMs);
  }

  try {
    return fn();
  } finally {
    // Releases only our own lock: if someone judged it abandoned and put theirs, it stays.
    if (readLock(path)?.token === token) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    }
  }
}

function saveSession(entries: readonly SessionEntry[], env: Env): void {
  const path = sessionPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const data: SessionFile = { version: 1, entries: [...entries] };
  writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// One entry per AVD and per serial: recording again replaces it. On iOS only the
// UDID identifies (two simulators can share a name).
export function recordSession(entry: SessionEntry, env: Env = process.env, lock: SessionLockOptions = {}): SessionEntry[] {
  return withSessionLock(env, () => {
    const rest = loadSession(env).filter(
      (e) =>
        !(
          e.platform === entry.platform &&
          (e.serial === entry.serial || (entry.platform === 'android' && e.avd === entry.avd))
        ),
    );
    const entries = [...rest, Object.freeze({ ...entry })];
    saveSession(entries, env);
    return entries;
  }, lock);
}

// Rewrites the matching entries; returns the new ones (empty = nothing written).
export function updateSession(
  match: (e: SessionEntry) => boolean,
  update: (e: SessionEntry) => SessionEntry,
  env: Env = process.env,
  lock: SessionLockOptions = {},
): SessionEntry[] {
  return withSessionLock(env, () => {
    const all = loadSession(env);
    const changed: SessionEntry[] = [];
    const entries = all.map((e) => {
      if (!match(e)) return e;
      const next = Object.freeze({ ...update(e) });
      changed.push(next);
      return next;
    });
    if (changed.length > 0) saveSession(entries, env);
    return changed;
  }, lock);
}

export function removeSession(match: (e: SessionEntry) => boolean, env: Env = process.env, lock: SessionLockOptions = {}): SessionEntry[] {
  return withSessionLock(env, () => {
    const all = loadSession(env);
    const removed = all.filter(match);
    if (removed.length > 0) saveSession(all.filter((e) => !match(e)), env);
    return removed;
  }, lock);
}

// ---------------------------------------------------------------------------
// One-device-at-a-time guard (RESOURCE-POLICY).

export type BootedSimulator = Readonly<{ udid: string; name: string; runtime: string }>;

export async function runningEmulators(adb: Adb): Promise<AdbDevice[]> {
  return (await adb.listDevices()).filter((d) => d.serial.startsWith('emulator-'));
}

// Waits for the emulator to exit: the serial leaves adb and the AVD `*.lock` files go away.
// Returns the locks still left at the deadline (the caller decides).
export async function waitForExit(opts: {
  adb: Adb;
  serial: string;
  avdDir: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{ waitedMs: number; lingeringLocks: string[] }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? 1000;
  const start = opts.now();
  await opts.adb.waitForGone(opts.serial, { timeoutMs, pollMs });
  for (;;) {
    const locks = runningLocks(opts.avdDir);
    if (locks.length === 0 || opts.now() - start >= timeoutMs) return { waitedMs: opts.now() - start, lingeringLocks: locks };
    await opts.sleep(pollMs);
  }
}

// Serial of the emulator running AVD `avd` (via `adb emu avd name`), or null.
export async function findAvdSerial(adb: Adb, avd: string): Promise<string | null> {
  for (const dev of await runningEmulators(adb)) {
    if ((await adb.avdName(dev.serial)) === avd) return dev.serial;
  }
  return null;
}

export function parseSimctlBooted(json: string): BootedSimulator[] {
  const data = JSON.parse(json) as { devices?: Record<string, { udid?: string; name?: string; state?: string }[]> };
  const out: BootedSimulator[] = [];
  for (const [runtime, list] of Object.entries(data.devices ?? {})) {
    for (const d of list ?? []) {
      if (d.state === 'Booted' && d.udid) out.push(Object.freeze({ udid: d.udid, name: d.name ?? d.udid, runtime }));
    }
  }
  return out;
}

// xcrun failure (no Xcode, odd JSON) = empty list.
export async function bootedSimulators(exec: Exec): Promise<BootedSimulator[]> {
  try {
    const res = await exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { timeoutMs: 30_000 });
    if (res.code !== 0) return [];
    return parseSimctlBooted(res.stdout);
  } catch {
    return [];
  }
}

export type DeviceCensus = Readonly<{ emulators: readonly AdbDevice[]; simulators: readonly BootedSimulator[] }>;

// `adb: null` = no Android SDK on the machine (no emulator to count).
// `exceptUdid`: the target simulator, if already booted, does not count against itself.
export async function assertSingleDevice(opts: {
  adb: Adb | null;
  exec: Exec;
  force?: boolean;
  action: string;
  exceptUdid?: string;
}): Promise<DeviceCensus> {
  const emulators = opts.adb === null ? [] : await runningEmulators(opts.adb);
  const except = opts.exceptUdid?.toUpperCase();
  const simulators = (await bootedSimulators(opts.exec)).filter((s) => s.udid.toUpperCase() !== except);
  if (!opts.force && (emulators.length > 0 || simulators.length > 0)) {
    const what = [
      ...emulators.map((e) => `emulator ${e.serial} (${e.state})`),
      ...simulators.map((s) => `simulator ${s.name} ${s.udid}`),
    ];
    throw new DevslimError(`${opts.action} refused: a device is already running: ${what.join(', ')} (one at a time; --force to ignore)`);
  }
  return Object.freeze({ emulators: Object.freeze(emulators), simulators: Object.freeze(simulators) });
}

// ---------------------------------------------------------------------------
// Swap warning (non-blocking). Thresholds and parser live in ../swap.ts; `up`,
// `bake` and `ios up` use swapGate from there, which also refuses above the threshold.

export { parseSwapUsage, type SwapUsage } from '../swap.ts';
export const SWAP_WARN_RATIO = SWAP_WARN_PERCENT / 100;

export async function swapWarning(opts: { exec: Exec; stderr: (t: string) => void }): Promise<SwapUsage | null> {
  let usage: SwapUsage | null = null;
  try {
    const res = await opts.exec('sysctl', ['-n', 'vm.swapusage'], { timeoutMs: 10_000 });
    if (res.code === 0) usage = parseSwapUsage(res.stdout);
  } catch {
    return null;
  }
  if (usage !== null && usage.ratio !== null && usage.ratio > SWAP_WARN_RATIO) {
    const gb = (mb: number) => (mb / 1024).toFixed(1);
    opts.stderr(
      `devslim: warning: swap at ${Math.round(usage.ratio * 100)}% (${gb(usage.usedMb)} of ${gb(usage.totalMb)} GB); close something before starting a device\n`,
    );
  }
  return usage;
}
