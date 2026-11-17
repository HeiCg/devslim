import { nodeExec, nodeSpawnDetached, type Exec, type SpawnDetached } from '../exec.ts';
import { createAdb, realSleep, type Adb, type Sleep } from './adb.ts';
import { nodePidAlive, runningDir, type PidAlive } from './runningIni.ts';
import { findSdkTool, type SdkTool } from './sdk.ts';

type Env = Readonly<Record<string, string | undefined>>;

// Tudo que fala com processo, relogio ou SDK entra por aqui; os testes
// injetam exec/spawn/sleep/relogio falsos.
export type RuntimeContext = {
  env?: Env;
  exec?: Exec;
  spawnDetached?: SpawnDetached;
  sleep?: Sleep;
  now?: () => number; // ms, para timeouts e tempos por etapa
  date?: () => Date; // carimbo de hora gravado no state
  fileExists?: (path: string) => boolean; // localizar binarios do SDK
  stderr?: (text: string) => void; // avisos
  bootTimeoutMs?: number;
  exitTimeoutMs?: number;
  pollMs?: number;
  // Diretorio avd/running onde o emulador se anuncia; ausente = padrao da
  // plataforma (runningIni.ts), null = nao conferir.
  runningDir?: string | null;
  // Pid do pid_<pid>.ini ainda vivo? Ausente = process.kill(pid, 0).
  pidAlive?: PidAlive;
};

export type Runtime = Readonly<{
  env: Env;
  exec: Exec;
  spawnDetached: SpawnDetached;
  sleep: Sleep;
  now: () => number;
  date: () => Date;
  stderr: (text: string) => void;
  bootTimeoutMs: number | undefined;
  exitTimeoutMs: number | undefined;
  pollMs: number | undefined;
  runningDir: string | null;
  pidAlive: PidAlive;
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
    bootTimeoutMs: ctx.bootTimeoutMs,
    exitTimeoutMs: ctx.exitTimeoutMs,
    pollMs: ctx.pollMs,
    runningDir: ctx.runningDir !== undefined ? ctx.runningDir : runningDir({ env }),
    pidAlive: ctx.pidAlive ?? nodePidAlive,
    tool,
    adb: () => (adb ??= createAdb({ adbPath: tool('adb'), exec, env, sleep, now })),
  });
}
