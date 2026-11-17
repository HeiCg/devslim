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
// Registro do que ESTA lib subiu, para o `down`. Fica em
// $DEVSLIM_HOME/state/session.json (fora de state/android/ para nao colidir
// com um AVD chamado "session").
// iOS usa o mesmo formato: `avd` = nome do simulador, `serial` = UDID,
// `pid` e `port` = 0 (sem processo nem porta proprios).

// Watcher do auto-desligar (`up --idle-down`): ms parado ate desligar, pid do
// processo `devslim _idle-watch` e quando subiu. Ausente = sem auto-desligar.
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
    throw new DevslimError(`state de sessao corrompido (JSON invalido): ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Lock consultivo da sessao. `up`, `down` e o watcher do auto-desligar sao
// processos separados que fazem read-modify-write de session.json; toda escrita
// passa por withSessionLock (leitura, mudanca e gravacao numa secao critica).
// O lock e `session.json.lock`, criado com `wx` e com o pid dono e a hora.
// Mais velho que SESSION_LOCK_STALE_MS ou de pid morto = abandonado: e apagado
// (se ainda for o mesmo arquivo) e a tomada recomeca. Leitura nao trava: a
// gravacao e atomica (fsAtomic), quem le ve a sessao inteira antiga ou nova.

export const SESSION_LOCK_TIMEOUT_MS = 5_000;
export const SESSION_LOCK_STALE_MS = 30_000;
export const SESSION_LOCK_STEP_MS = 50;

// Sincrono de proposito: as funcoes de escrita da sessao sao sincronas e o
// processo nao tem o que fazer enquanto espera o lock.
export type SessionLockOptions = {
  sleep?: (ms: number) => void;
  now?: () => number;
  pidAlive?: PidAlive;
  pid?: number; // dono gravado no lock; padrao process.pid
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

// null = sem arquivo. Conteudo ilegivel (dono acabou de criar e ainda nao
// escreveu) vem com pid/atMs null; a idade sai do mtime.
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
    return null; // sumiu: a proxima volta tenta criar
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
    if (held === null) continue; // soltaram entre o open e a leitura
    const age = lockAgeMs(path, held, now());
    const stale = (age !== null && age > staleMs) || (held.pid !== null && !pidAlive(held.pid));
    if (stale) {
      // So apaga se ainda e o mesmo lock abandonado (outro pode ter tomado).
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
        `sessao ocupada: timeout de ${timeoutMs / 1000} s esperando o lock ${path} (dono pid ${held.pid ?? '?'}); ` +
          'se esse processo travou, encerre-o ou apague o arquivo',
      );
    }
    sleep(stepMs);
  }

  try {
    return fn();
  } finally {
    // Solta so o proprio lock: se alguem o julgou abandonado e pos o dele, fica.
    if (readLock(path)?.token === token) {
      try {
        unlinkSync(path);
      } catch {
        // ja saiu
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

// Uma entrada por AVD e por serial: registrar de novo substitui. No iOS so o
// UDID identifica (dois simuladores podem ter o mesmo nome).
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

// Reescreve as entradas que casam; devolve as novas (vazio = nada gravado).
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
// Guarda de um device por vez (RESOURCE-POLICY).

export type BootedSimulator = Readonly<{ udid: string; name: string; runtime: string }>;

export async function runningEmulators(adb: Adb): Promise<AdbDevice[]> {
  return (await adb.listDevices()).filter((d) => d.serial.startsWith('emulator-'));
}

// Espera o emulador sair: serial some do adb e os `*.lock` do AVD somem.
// Devolve os locks que ainda restarem no fim do prazo (quem chama decide).
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

// Serial do emulador que esta rodando o AVD `avd` (via `adb emu avd name`), ou null.
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

// Falha do xcrun (sem Xcode, JSON estranho) = lista vazia.
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

// `adb: null` = sem SDK Android na maquina (nenhum emulador a contar).
// `exceptUdid`: o simulador alvo, se ja bootado, nao conta contra si mesmo.
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
      ...emulators.map((e) => `emulador ${e.serial} (${e.state})`),
      ...simulators.map((s) => `simulador ${s.name} ${s.udid}`),
    ];
    throw new DevslimError(`${opts.action} recusado: ja ha device rodando: ${what.join(', ')} (um por vez; --force para ignorar)`);
  }
  return Object.freeze({ emulators: Object.freeze(emulators), simulators: Object.freeze(simulators) });
}

// ---------------------------------------------------------------------------
// Aviso de swap (nao bloqueia). Limites e parser vivem em ../swap.ts; `up`,
// `bake` e `ios up` usam swapGate de la, que tambem recusa acima do limite.

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
      `devslim: aviso: swap em ${Math.round(usage.ratio * 100)}% (${gb(usage.usedMb)} de ${gb(usage.totalMb)} GB); feche algo antes de subir device\n`,
    );
  }
  return usage;
}
