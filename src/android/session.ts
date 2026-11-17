import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DevslimError } from '../errors.ts';
import type { Exec } from '../exec.ts';
import { writeFileAtomic } from '../fsAtomic.ts';
import { devslimHome } from '../state.ts';
import { DEFAULT_EXIT_TIMEOUT_MS, type Adb, type AdbDevice } from './adb.ts';
import { runningLocks } from './avd.ts';
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

function saveSession(entries: readonly SessionEntry[], env: Env): void {
  const path = sessionPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const data: SessionFile = { version: 1, entries: [...entries] };
  writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// Uma entrada por AVD e por serial: registrar de novo substitui. No iOS so o
// UDID identifica (dois simuladores podem ter o mesmo nome).
export function recordSession(entry: SessionEntry, env: Env = process.env): SessionEntry[] {
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
}

// Reescreve as entradas que casam; devolve as novas (vazio = nada gravado).
export function updateSession(
  match: (e: SessionEntry) => boolean,
  update: (e: SessionEntry) => SessionEntry,
  env: Env = process.env,
): SessionEntry[] {
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
}

export function removeSession(match: (e: SessionEntry) => boolean, env: Env = process.env): SessionEntry[] {
  const all = loadSession(env);
  const removed = all.filter(match);
  if (removed.length > 0) saveSession(all.filter((e) => !match(e)), env);
  return removed;
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
