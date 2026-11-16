import { DevslimError } from './errors.ts';
import type { Exec } from './exec.ts';
import type { Adb } from './android/adb.ts';
import { findAvd } from './android/avd.ts';
import { resolveRuntime, type RuntimeContext } from './android/deps.ts';
import { findAvdSerial, loadSession } from './android/session.ts';
import { createSimctl } from './ios/simctl.ts';

// Medicao. Qualquer fonte pode falhar: o campo vira null, nunca erro.

const round1 = (n: number) => Math.round(n * 10) / 10;
const kbToMb = (kb: number) => round1(kb / 1024);

const UNIT_TO_MB: Readonly<Record<string, number>> = Object.freeze({ B: 1 / (1024 * 1024), KB: 1 / 1024, MB: 1, GB: 1024 });

const unitMb = (num: string, unit: string): number | null => {
  const n = Number(num.replace(/,/g, ''));
  return Number.isFinite(n) ? round1(n * UNIT_TO_MB[unit]) : null;
};

// `footprint -p <pid>` traz dois numeros que divergem em processo com
// Hypervisor.framework (qemu): o cabecalho "<proc> [pid]: 64-bit  Footprint: N MB"
// e a linha "phys_footprint: N MB" do bloco Auxiliary data. Medido no qemu:
// cabecalho 3000 MB, phys_footprint 5582 MB. Cada parser le so a sua linha.
export function parsePhysFootprintMb(text: string): number | null {
  const m = /^\s*phys_footprint:\s*([\d.,]+)\s*(B|KB|MB|GB)\b/m.exec(text);
  return m ? unitMb(m[1], m[2]) : null;
}

export function parseFootprintHeaderMb(text: string): number | null {
  const m = /\[\d+\]:.*?\bFootprint:\s*([\d.,]+)\s*(B|KB|MB|GB)\b/.exec(text);
  return m ? unitMb(m[1], m[2]) : null;
}

// Compatibilidade: phys_footprint e, sem ele, o cabecalho. O `measure` usa os
// dois parsers acima em campos separados.
export function parseFootprintMb(text: string): number | null {
  const m =
    /^\s*phys_footprint:\s*([\d.,]+)\s*(B|KB|MB|GB)\b/m.exec(text) ??
    /\bFootprint:\s*([\d.,]+)\s*(B|KB|MB|GB)\b/.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? round1(n * UNIT_TO_MB[m[2]]) : null;
}

// `ps -o rss= -p <pid>`: KB.
export function parseRssMb(text: string): number | null {
  const t = text.trim();
  return /^\d+$/.test(t) ? kbToMb(Number(t)) : null;
}

// /proc/meminfo: valores em kB.
export function parseProcMeminfo(text: string): { memTotalMb: number | null; memAvailableMb: number | null } {
  const field = (name: string) => {
    const m = new RegExp(`^${name}:\\s*(\\d+)\\s*kB`, 'm').exec(text);
    return m ? kbToMb(Number(m[1])) : null;
  };
  return { memTotalMb: field('MemTotal'), memAvailableMb: field('MemAvailable') };
}

// `ps -A`: linhas nao vazias menos o cabecalho.
export function countPsProcesses(text: string): number | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0 || !/\bPID\b/.test(lines[0])) return null;
  return lines.length - 1;
}

// `dumpsys meminfo`: " Used RAM: 1,234,567K (...)" e " Free RAM: ...".
export function parseDumpsysMeminfo(text: string): { usedRamMb: number | null; freeRamMb: number | null } {
  const field = (name: string) => {
    const m = new RegExp(`^\\s*${name} RAM:\\s*([\\d,.]+)\\s*([KMG])B?\\b`, 'm').exec(text);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const kb = m[2] === 'K' ? n : m[2] === 'M' ? n * 1024 : n * 1024 * 1024;
    return kbToMb(kb);
  };
  return { usedRamMb: field('Used'), freeRamMb: field('Free') };
}

// footprintMb = phys_footprint; footprintHeaderMb = cabecalho do footprint.
// Comparacao antes/depois deve usar sempre o mesmo campo.
export type HostMeasure = Readonly<{ footprintMb: number | null; footprintHeaderMb: number | null; rssMb: number | null }>;
export type GuestMeasure = Readonly<{
  memTotalMb: number | null;
  memAvailableMb: number | null;
  processes: number | null;
  usedRamMb: number | null;
  freeRamMb: number | null;
}>;

async function stdoutOf(run: () => Promise<{ code: number | null; stdout: string }>): Promise<string | null> {
  try {
    const res = await run();
    return res.code === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

export async function measureAndroidHost(pid: number, opts: { exec: Exec }): Promise<HostMeasure> {
  const fp = await stdoutOf(() => opts.exec('footprint', ['-p', String(pid)], { timeoutMs: 60_000 }));
  const ps = await stdoutOf(() => opts.exec('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs: 10_000 }));
  return Object.freeze({
    footprintMb: fp === null ? null : parsePhysFootprintMb(fp),
    footprintHeaderMb: fp === null ? null : parseFootprintHeaderMb(fp),
    rssMb: ps === null ? null : parseRssMb(ps),
  });
}

export async function measureAndroidGuest(serial: string, opts: { adb: Adb }): Promise<GuestMeasure> {
  const { adb } = opts;
  const meminfo = await stdoutOf(() => adb.shell(serial, ['cat', '/proc/meminfo']));
  const ps = await stdoutOf(() => adb.shell(serial, ['ps', '-A']));
  const dumpsys = await stdoutOf(() => adb.shell(serial, ['dumpsys', 'meminfo'], 120_000));
  const mem = meminfo === null ? { memTotalMb: null, memAvailableMb: null } : parseProcMeminfo(meminfo);
  const dm = dumpsys === null ? { usedRamMb: null, freeRamMb: null } : parseDumpsysMeminfo(dumpsys);
  return Object.freeze({ ...mem, processes: ps === null ? null : countPsProcesses(ps), ...dm });
}

// pid do qemu do AVD: `pgrep -f "qemu-system.*-avd <nome>( |$)"`; senao o pid salvo na sessao.
export async function findQemuPid(avd: string, opts: { exec: Exec; sessionPid?: number | null }): Promise<number | null> {
  const out = await stdoutOf(() => opts.exec('pgrep', ['-f', `qemu-system.*-avd ${avd}( |$)`], { timeoutMs: 10_000 }));
  const pid = out
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d+$/.test(l));
  if (pid !== undefined) return Number(pid);
  return opts.sessionPid ?? null;
}

// Contrato estavel do `measure --json`.
export type AndroidMeasurement = Readonly<{
  platform: 'android';
  avd: string;
  serial: string;
  pid: number | null;
  host: HostMeasure;
  guest: GuestMeasure;
  at: string;
}>;

// ---------------------------------------------------------------------------
// iOS: soma phys_footprint e %cpu da arvore do launchd_sim do device.

const TOP_UNIT_TO_MB: Readonly<Record<string, number>> = Object.freeze({ B: 1 / (1024 * 1024), K: 1 / 1024, M: 1, G: 1024 });

// `top -l 1 -stats pid,mem`: linhas "1234  56M+" (sufixos B/K/M/G e o +/- que
// o top anexa). Devolve pid -> MB. Cabecalho e linhas de resumo sao ignorados.
export function parseTopMem(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMG])?[+-]?\s*$/.exec(line);
    if (!m) continue;
    out.set(Number(m[1]), Number(m[2]) * TOP_UNIT_TO_MB[m[3] ?? 'B']);
  }
  return out;
}

export type PsEntry = Readonly<{ pid: number; ppid: number; cpu: number; comm: string }>;

// `ps -axo pid,ppid,%cpu,comm` (comm pode ter espaco no caminho).
export function parsePsTable(text: string): Map<number, PsEntry> {
  const out = new Map<number, PsEntry>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    out.set(pid, Object.freeze({ pid, ppid: Number(m[2]), cpu: Number(m[3].replace(',', '.')), comm: m[4] }));
  }
  return out;
}

// pids alcancaveis a partir de `root` pelos filhos; quem nao descende da raiz
// (orfao reparentado no launchd do host, outro simulador) fica de fora.
export function processTree(root: number, table: ReadonlyMap<number, PsEntry>): number[] {
  const children = new Map<number, number[]>();
  for (const e of table.values()) {
    if (e.pid === e.ppid) continue;
    const list = children.get(e.ppid) ?? [];
    list.push(e.pid);
    children.set(e.ppid, list);
  }
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return [...seen].sort((a, b) => a - b);
}

// Contrato estavel do `ios measure --json`.
export type IosMeasurement = Readonly<{
  platform: 'ios';
  udid: string;
  name: string;
  processes: number;
  footprintMb: number;
  cpuPercent: number;
  at: string;
}>;

export async function measureSim(query: string, ctx: RuntimeContext = {}): Promise<IosMeasurement> {
  const rt = resolveRuntime(ctx);
  const simctl = createSimctl({ exec: rt.exec, sleep: rt.sleep, now: rt.now });
  const device = await simctl.findDevice(query);
  if (device.state !== 'Booted') {
    throw new DevslimError(`simulador ${device.name} (${device.udid}) nao esta bootado (estado ${device.state}); nada a medir`);
  }
  const pat = `${device.udid}/data/var/run/launchd_bootstrap`;
  const pg = await stdoutOf(() => rt.exec('pgrep', ['-f', pat], { timeoutMs: 10_000 }));
  const rootLine = pg?.split(/\r?\n/).map((l) => l.trim()).find((l) => /^\d+$/.test(l));
  if (rootLine === undefined) {
    throw new DevslimError(`launchd_sim de ${device.name} (${device.udid}) nao encontrado (pgrep -f "${pat}"); o simulador terminou de bootar?`);
  }
  const ps = await stdoutOf(() => rt.exec('ps', ['-axo', 'pid,ppid,%cpu,comm'], { timeoutMs: 30_000 }));
  if (ps === null) throw new DevslimError('ps -axo pid,ppid,%cpu,comm falhou');
  const top = await stdoutOf(() => rt.exec('top', ['-l', '1', '-stats', 'pid,mem'], { timeoutMs: 60_000 }));
  if (top === null) throw new DevslimError('top -l 1 -stats pid,mem falhou');
  const table = parsePsTable(ps);
  const mem = parseTopMem(top);
  const pids = processTree(Number(rootLine), table);
  let footprint = 0;
  let cpu = 0;
  for (const pid of pids) {
    footprint += mem.get(pid) ?? 0;
    cpu += table.get(pid)?.cpu ?? 0;
  }
  return Object.freeze({
    platform: 'ios',
    udid: device.udid,
    name: device.name,
    processes: pids.length,
    footprintMb: round1(footprint),
    cpuPercent: round1(cpu),
    at: rt.date().toISOString(),
  });
}

export async function measureAvd(avdName: string, ctx: RuntimeContext = {}): Promise<AndroidMeasurement> {
  const rt = resolveRuntime(ctx);
  const avd = findAvd(avdName, { env: rt.env });
  const adb = rt.adb();
  const serial = await findAvdSerial(adb, avd.name);
  if (serial === null) throw new DevslimError(`AVD ${avd.name} nao esta rodando (nenhum emulador no adb responde com esse nome)`);
  const entry = loadSession(rt.env).find((e) => e.platform === 'android' && e.serial === serial && e.avd === avd.name);
  const pid = await findQemuPid(avd.name, { exec: rt.exec, sessionPid: entry?.pid ?? null });
  const host = pid === null ? Object.freeze({ footprintMb: null, footprintHeaderMb: null, rssMb: null }) : await measureAndroidHost(pid, { exec: rt.exec });
  const guest = await measureAndroidGuest(serial, { adb });
  return Object.freeze({ platform: 'android', avd: avd.name, serial, pid, host, guest, at: rt.date().toISOString() });
}
