import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { DevslimError } from './errors.ts';

// UNICO ponto da lib que cria processo. Todo modulo que precisa de adb,
// emulator, xcrun etc. recebe um `Exec` por parametro, e os testes injetam
// um fake (ver createFakeExec).

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

// Implementacao real: sem shell, argumentos passados como lista.
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
      if (err.code === 'ENOENT') reject(new DevslimError(`comando nao encontrado: ${cmd}`));
      else reject(err);
    });
    child.on('close', (code, signal) => resolve(Object.freeze({ code, signal, stdout, stderr })));
    child.stdin.on('error', () => { /* processo pode sair antes de ler stdin */ });
    child.stdin.end(opts.input ?? '');
  });

export type SpawnDetachedOptions = {
  logFile: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

// Processo que sobrevive ao devslim (o emulador): sessao propria, stdout e
// stderr anexados ao log, sem stdin, e `unref()` para o Node poder sair.
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
        closeSync(fd); // o filho ja herdou o descritor
      }
    })();
    child.once('error', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') reject(new DevslimError(`comando nao encontrado: ${cmd}`));
      else reject(err);
    });
    child.once('spawn', () => {
      child.unref();
      if (child.pid === undefined) reject(new DevslimError(`spawn de ${cmd} sem pid`));
      else resolve({ pid: child.pid });
    });
  });

// Sinal para um processo ja existente (o watcher do auto-desligar). "No such
// process" (ESRCH) e ignorado; pid invalido (<= 1) nunca e sinalizado.
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

// Exec de teste: grava cada chamada e responde pelo handler. Handler que
// devolve undefined = comando inesperado, e o fake falha alto.
export function createFakeExec(handler: FakeHandler): Exec & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const exec = (async (cmd: string, args: readonly string[], opts: ExecOptions = {}) => {
    const call = { cmd, args: [...args], opts };
    calls.push(call);
    const res = handler(call);
    if (res === undefined) throw new Error(`fake exec: chamada inesperada: ${cmd} ${args.join(' ')}`);
    return Object.freeze({ code: 0, signal: null, stdout: '', stderr: '', ...res });
  }) as Exec & { calls: FakeCall[] };
  exec.calls = calls;
  return exec;
}

export type FakeSpawnCall = { cmd: string; args: string[]; opts: SpawnDetachedOptions };

// spawnDetached de teste: grava a chamada e devolve pids crescentes a partir de `firstPid`.
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
