import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { DevslimError } from './errors.ts';

// The ONLY place in the lib that creates processes. Every module that needs adb,
// emulator, xcrun etc. takes an `Exec` parameter, and tests inject
// a fake (see createFakeExec).

export type ExecOptions = {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  input?: string;
  timeoutMs?: number;
};

export type ExecResult = Readonly<{
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}>;

export type Exec = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

// Real implementation: no shell, arguments passed as a list.
export const nodeExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env as Record<string, string> | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') reject(new DevslimError(`command not found: ${cmd}`));
      else reject(err);
    });
    child.on('close', (code, signal) => resolve(Object.freeze({ code, signal, stdout, stderr })));
    child.stdin.on('error', () => { /* the process may exit before reading stdin */ });
    child.stdin.end(opts.input ?? '');
  });

export type SpawnDetachedOptions = {
  logFile: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

// Process that outlives devslim (the emulator): its own session, stdout and
// stderr appended to the log, no stdin, and `unref()` so Node can exit.
export type SpawnDetached = (cmd: string, args: readonly string[], opts: SpawnDetachedOptions) => Promise<{ pid: number }>;

export const nodeSpawnDetached: SpawnDetached = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const fd = openSync(opts.logFile, 'a', 0o644);
    const child = (() => {
      try {
        return spawn(cmd, [...args], {
          cwd: opts.cwd,
          env: opts.env as Record<string, string> | undefined,
          detached: true,
          stdio: ['ignore', fd, fd],
        });
      } finally {
        closeSync(fd); // the child already inherited the descriptor
      }
    })();
    child.once('error', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') reject(new DevslimError(`command not found: ${cmd}`));
      else reject(err);
    });
    child.once('spawn', () => {
      child.unref();
      if (child.pid === undefined) reject(new DevslimError(`spawn of ${cmd} without a pid`));
      else resolve({ pid: child.pid });
    });
  });

// Signal to an existing process (the idle-down watcher). "No such
// process" (ESRCH) is ignored; an invalid pid (<= 1) is never signaled.
export type SignalPid = (pid: number, signal: 'SIGTERM') => void;

export const nodeSignalPid: SignalPid = (pid, signal) => {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ESRCH') throw err;
  }
};

export type FakeCall = { cmd: string; args: string[]; opts: ExecOptions };
export type FakeHandler = (call: FakeCall) => Partial<ExecResult> | undefined;

// Test exec: records each call and answers through the handler. A handler that
// returns undefined = unexpected command, and the fake fails loudly.
export function createFakeExec(handler: FakeHandler): Exec & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const exec = (async (cmd: string, args: readonly string[], opts: ExecOptions = {}) => {
    const call = { cmd, args: [...args], opts };
    calls.push(call);
    const res = handler(call);
    if (res === undefined) throw new Error(`fake exec: unexpected call: ${cmd} ${args.join(' ')}`);
    return Object.freeze({ code: 0, signal: null, stdout: '', stderr: '', ...res });
  }) as Exec & { calls: FakeCall[] };
  exec.calls = calls;
  return exec;
}

export type FakeSpawnCall = { cmd: string; args: string[]; opts: SpawnDetachedOptions };

// Test spawnDetached: records the call and returns increasing pids starting at `firstPid`.
export function createFakeSpawnDetached(firstPid = 40000): SpawnDetached & { calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = [];
  let next = firstPid;
  const fn = (async (cmd: string, args: readonly string[], opts: SpawnDetachedOptions) => {
    calls.push({ cmd, args: [...args], opts });
    return { pid: next++ };
  }) as SpawnDetached & { calls: FakeSpawnCall[] };
  fn.calls = calls;
  return fn;
}
