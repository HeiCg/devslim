import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './errors.ts';
import type { Runtime } from './android/deps.ts';
import { loadSession, updateSession, type IdleDownRecord, type SessionEntry } from './android/session.ts';
import { devslimHome } from './state.ts';

// Auto-desligar (`up --idle-down <dur>`): um processo destacado (`devslim
// _idle-watch`) olha o device a cada 30 s e, depois de <dur> sem app de
// terceiro em primeiro plano, desliga pelo mesmo caminho do `down`. Aqui ficam
// as partes puras (duracao, parse do primeiro plano, laco) e o registro do
// watcher na sessao; o processo em si esta em idleWatch.ts.

export const IDLE_MIN_MS = 2 * 60_000;
export const IDLE_POLL_MS = 30_000;
export const MAX_PROBE_FAILURES = 3;
export const IDLE_WATCH_CMD = '_idle-watch';

// bin/devslim deste checkout: o watcher roda o mesmo codigo do `up`.
export const DEVSLIM_BIN = fileURLToPath(new URL('../bin/devslim', import.meta.url));

const DURATION_RE = /^(\d{1,9})([smh]?)$/;
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({ s: 1000, m: 60_000, h: 3_600_000, '': 60_000 });

// `30m`, `90s`, `1h` ou numero puro (minutos). Minimo 2 minutos.
export function parseIdleDuration(text: string): number {
  const m = DURATION_RE.exec(text);
  if (m === null) throw new UsageError(`--idle-down exige duracao como 30m, 90s, 1h ou minutos (numero puro), recebeu: ${text}`);
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  if (ms < IDLE_MIN_MS) throw new UsageError(`--idle-down minimo 2m, recebeu: ${text}`);
  return ms;
}

// 5400000 -> "1h30m"; 150000 -> "2m30s"; arredonda para o segundo.
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', s > 0 ? `${s}s` : ''].join('');
  return parts === '' ? '0s' : parts;
}

// ---------------------------------------------------------------------------
// O que esta em primeiro plano

// Launcher e apps do sistema nao contam como uso.
export function isSystemPackage(pkg: string): boolean {
  return pkg.startsWith('com.android.') || pkg.startsWith('com.google.android.') || pkg.startsWith('android');
}

// Linhas `topResumedActivity=ActivityRecord{<hash> u0 <pkg>/<activity> t5}`
// (Android 10+) e `mResumedActivity: ...`/`ResumedActivity: ...` (por display,
// e grafia antiga) de `dumpsys activity activities`. Vazio ou ilegivel = nada
// em primeiro plano (parado). Mais de um (tela dividida): qualquer terceiro e uso.
const RESUMED_RE = /ResumedActivity\s*[=:]\s*ActivityRecord\{[^\s}]+\s+(?:u\d+\s+)?([A-Za-z][A-Za-z0-9_.]*)\//g;

export function androidForeground(dumpsys: string): { active: boolean; packages: string[] } {
  const packages = [...new Set([...dumpsys.matchAll(RESUMED_RE)].map((m) => m[1]))];
  return { active: packages.some((p) => !isSystemPackage(p)), packages };
}

// `launchctl list` do simulador: `UIKitApplication:<bundle>[...]` e app
// rodando. Bundle fora de `com.apple.` = uso.
const UIKIT_RE = /UIKitApplication:([^\s[]+)/g;

export function iosForeground(launchctlList: string): { active: boolean; apps: string[] } {
  const apps = [...new Set([...launchctlList.matchAll(UIKIT_RE)].map((m) => m[1]))].filter((b) => !b.startsWith('com.apple.'));
  return { active: apps.length > 0, apps };
}

// ---------------------------------------------------------------------------
// Laco do watcher

export type IdleProbe = 'active' | 'idle' | 'gone';
export type IdleOwnership = 'owned' | 'session-gone' | 'session-changed' | 'watcher-removed';
export type IdleStopReason = 'shutdown' | 'shutdown-failed' | 'device-gone' | 'probe-failed' | Exclude<IdleOwnership, 'owned'>;
export type IdleLoopResult = Readonly<{ reason: IdleStopReason; idleForMs: number; detail?: string }>;

export type IdleLoopOptions = {
  idleMs: number;
  pollMs?: number;
  probe: () => Promise<IdleProbe>; // excecao = falha do probe
  owner: () => Promise<IdleOwnership>; // a entrada da sessao ainda e deste watcher?
  shutdown: () => Promise<void>; // excecao = shutdown-failed
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log?: (msg: string) => void;
};

// A cada `pollMs`: confere o dono, sonda o device. Uso zera o relogio; falha
// do probe nao zera nem conta. Desliga so com `idleMs` inteiros parado e o dono
// conferido de novo logo antes. Qualquer outra saida nunca chama shutdown.
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
      o.log?.(`probe falhou (${failures}/${MAX_PROBE_FAILURES}): ${(err as Error).message}`);
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
// Registro do watcher na sessao

export type IdlePlatform = 'android' | 'ios';

const ID_RE = /^[A-Za-z0-9._-]+$/;

// Android: id = nome do AVD. iOS: id = UDID.
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

// O pid ainda e o nosso watcher? Confere a linha de comando (`ps -o command=`)
// para nunca mandar sinal a um processo que herdou o pid.
async function isOurWatcher(pid: number, e: SessionEntry, rt: Runtime): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const res = await rt.exec('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 10_000 });
    return res.code === 0 && res.stdout.includes(`${IDLE_WATCH_CMD} ${e.platform} ${sessionIdOf(e)} `);
  } catch {
    return false;
  }
}

// SIGTERM no watcher registrado na entrada (se for mesmo ele e nao for este
// processo) e tira o campo da sessao. Pid morto ou reaproveitado: so limpa.
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
      rt.stderr(`devslim: aviso: SIGTERM no watcher de auto-desligar (pid ${w.watcherPid}) falhou: ${(err as Error).message}\n`);
    }
  }
  const match = sessionMatcher(e.platform, sessionIdOf(e));
  updateSession((x) => match(x) && x.idleDown?.watcherPid === w.watcherPid, ({ idleDown: _drop, ...rest }) => rest, rt.env);
  return out;
}

export type IdleWatcherInfo = Readonly<{ ms: number; watcherPid: number; startedAt: string; logFile: string }>;

// Sobe o watcher para o device da sessao (substitui o anterior). null = o
// device nao esta na sessao (o devslim nao o subiu): nada e lancado.
export async function startIdleWatcher(platform: IdlePlatform, id: string, ms: number, rt: Runtime): Promise<IdleWatcherInfo | null> {
  if (!ID_RE.test(id)) throw new UsageError(`id invalido para auto-desligar: ${id}`);
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
  return `auto-desligar: apos ${formatDuration(w.ms)} sem app em uso (watcher pid ${w.watcherPid}, log ${w.logFile})`;
}

// `why`: motivo concreto (ex. simulador ja bootado e enxuto, que o up nao reboota).
export function idleSkippedWarning(what: string, why?: string): string {
  if (why !== undefined) return `devslim: aviso: auto-desligar ignorado: ${what}: ${why} (nada na sessao)\n`;
  return `devslim: aviso: auto-desligar ignorado: ${what} nao foi subido pelo devslim (nada na sessao)\n`;
}

export const IOS_ALREADY_SLIM_REASON = 'simulador ja estava bootado e enxuto; devslim nao o subiu';
