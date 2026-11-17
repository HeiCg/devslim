import { nodeExec, nodeSignalPid, nodeSpawnDetached, type Exec, type SignalPid, type SpawnDetached } from '../exec.ts';
import { createAdb, realSleep, type Adb, type Sleep } from './adb.ts';
import { nodePidAlive, runningDir, type PidAlive } from './runningIni.ts';
import { defaultDirExists, findSdkTool, type SdkTool } from './sdk.ts';

type Env = Readonly<Record<string, string | undefined>>;

// Everything that talks to processes, the clock or the SDK comes in here; tests
// inject fake exec/spawn/sleep/clock.
export type RuntimeContext = {
  env?: Env;
  exec?: Exec;
  spawnDetached?: SpawnDetached;
  sleep?: Sleep;
  now?: () => number; // ms, for timeouts and per-step timings
  date?: () => Date; // timestamp written to the state
  fileExists?: (path: string) => boolean; // locate SDK binaries
  dirExists?: (path: string) => boolean; // system image installed in the SDK (create)
  arch?: string; // host process.arch: ABI for the create image shortcuts
  stderr?: (text: string) => void; // warnings
  bootTimeoutMs?: number;
  exitTimeoutMs?: number;
  pollMs?: number;
  // avd/running directory where the emulator advertises itself; absent = platform
  // default (runningIni.ts), null = do not check.
  runningDir?: string | null;
  // Is the pid_<pid>.ini pid still alive? Absent = process.kill(pid, 0).
  pidAlive?: PidAlive;
  // SIGTERM to the idle-down watcher. Absent = process.kill.
  signalPid?: SignalPid;
};

export type Runtime = Readonly<{
  env: Env;
  exec: Exec;
  spawnDetached: SpawnDetached;
  sleep: Sleep;
  now: () => number;
  date: () => Date;
  stderr: (text: string) => void;
  dirExists: (path: string) => boolean;
  arch: string;
  bootTimeoutMs: number | undefined;
  exitTimeoutMs: number | undefined;
  pollMs: number | undefined;
  runningDir: string | null;
  pidAlive: PidAlive;
  signalPid: SignalPid;
  tool: (name: SdkTool) => string;
  adb: () => Adb;
}>;

export function resolveRuntime(ctx: RuntimeContext = {}): Runtime {
  const env = ctx.env ?? process.env;
  const exec = ctx.exec ?? nodeExec;
  const sleep = ctx.sleep ?? realSleep;
  const now = ctx.now ?? Date.now;
  const tool = (name: SdkTool) => findSdkTool(name, { env, fileExists: ctx.fileExists });
  let adb: Adb | undefined;
  return Object.freeze({
    env,
    exec,
    spawnDetached: ctx.spawnDetached ?? nodeSpawnDetached,
    sleep,
    now,
    date: ctx.date ?? (() => new Date()),
    stderr: ctx.stderr ?? ((t: string) => { process.stderr.write(t); }),
    dirExists: ctx.dirExists ?? defaultDirExists,
    arch: ctx.arch ?? process.arch,
    bootTimeoutMs: ctx.bootTimeoutMs,
    exitTimeoutMs: ctx.exitTimeoutMs,
    pollMs: ctx.pollMs,
    runningDir: ctx.runningDir !== undefined ? ctx.runningDir : runningDir({ env }),
    pidAlive: ctx.pidAlive ?? nodePidAlive,
    signalPid: ctx.signalPid ?? nodeSignalPid,
    tool,
    adb: () => (adb ??= createAdb({ adbPath: tool('adb'), exec, env, sleep, now })),
  });
}
