import { DevslimError } from './errors.ts';
import type { Exec } from './exec.ts';

// macOS swap: single source of the thresholds used by `doctor`, `android up`,
// `android bake` and `ios up`. Above SWAP_WARN_PERCENT it warns; above
// SWAP_FAIL_PERCENT doctor fails and the commands that boot refuse without --force.

export const SWAP_WARN_PERCENT = 80;
export const SWAP_FAIL_PERCENT = 95;

const round1 = (n: number) => Math.round(n * 10) / 10;

export type SwapUsage = Readonly<{ totalMb: number; usedMb: number; ratio: number | null }>;

function toMb(num: string, unit: string): number {
  const n = Number(num.replace(',', '.'));
  switch (unit.toUpperCase()) {
    case 'K': return n / 1024;
    case 'G': return n * 1024;
    case 'T': return n * 1024 * 1024;
    default: return n; // M (or no suffix)
  }
}

// `total = 18432.00M  used = 17704.94M  free = 727.06M  (encrypted)`; accepts a decimal comma.
// With no swap file yet macOS reports `total = 0.00M  used = 0.00M`:
// valid reading, ratio 0. Total 0 with usage above 0 makes no sense: ratio null.
export function parseSwapUsage(text: string): SwapUsage | null {
  const field = (name: string) => new RegExp(`${name}\\s*=\\s*(\\d+(?:[.,]\\d+)?)\\s*([KMGT]?)`, 'i').exec(text);
  const total = field('total');
  const used = field('used');
  if (!total || !used) return null;
  const totalMb = toMb(total[1], total[2]);
  const usedMb = toMb(used[1], used[2]);
  const ratio = totalMb > 0 ? usedMb / totalMb : usedMb === 0 ? 0 : null;
  return Object.freeze({ totalMb, usedMb, ratio });
}

export type SwapStatus = Readonly<{ usedMb: number | null; totalMb: number | null; percent: number | null }>;

// `sysctl -n vm.swapusage`; any failure = null fields, never an error.
export async function readSwap(exec: Exec): Promise<SwapStatus> {
  try {
    const res = await exec('sysctl', ['-n', 'vm.swapusage'], { timeoutMs: 10_000 });
    const u = res.code === 0 ? parseSwapUsage(res.stdout) : null;
    if (u !== null) {
      return Object.freeze({ usedMb: round1(u.usedMb), totalMb: round1(u.totalMb), percent: u.ratio === null ? null : round1(u.ratio * 100) });
    }
  } catch {
    // fall through to null
  }
  return Object.freeze({ usedMb: null, totalMb: null, percent: null });
}

export type SwapLevel = 'ok' | 'warn' | 'fail';
export type SwapAssessment = Readonly<{ level: SwapLevel; message: string; fix?: string }>;

export const SWAP_FAIL_FIX = 'close idle apps, sessions and devices before starting a device';
export const SWAP_WARN_FIX = 'close something before starting a device';

// No swap file (total 0): nothing in use.
export const NO_SWAP_FILE_TEXT = '0 MB in use (no swap file)';

// Same text in doctor and in the boot refusal. `percent` null = not read (warn).
export function assessSwap(s: SwapStatus): SwapAssessment {
  if (s.percent === null) return Object.freeze({ level: 'warn', message: 'sysctl vm.swapusage not read' });
  if (s.totalMb === 0) return Object.freeze({ level: 'ok', message: `swap with ${NO_SWAP_FILE_TEXT}` });
  const text = `swap at ${s.percent}% (${s.usedMb} of ${s.totalMb} MB)`;
  if (s.percent > SWAP_FAIL_PERCENT) return Object.freeze({ level: 'fail', message: `${text}: do not boot a device now`, fix: SWAP_FAIL_FIX });
  if (s.percent > SWAP_WARN_PERCENT) return Object.freeze({ level: 'warn', message: `${text}: above ${SWAP_WARN_PERCENT}%`, fix: SWAP_WARN_FIX });
  return Object.freeze({ level: 'ok', message: text });
}

// Before booting: fail without --force = error; fail with --force and warn = warning on
// stderr; unread swap proceeds silently (doctor is the one that reports it).
export async function swapGate(opts: { exec: Exec; stderr: (t: string) => void; force: boolean; action: string }): Promise<SwapStatus> {
  const s = await readSwap(opts.exec);
  if (s.percent === null) return s;
  const a = assessSwap(s);
  if (a.level === 'fail' && !opts.force) {
    throw new DevslimError(`${opts.action} refused: ${a.message}; ${a.fix} (--force to boot anyway)`);
  }
  if (a.level !== 'ok') opts.stderr(`devslim: warning: ${a.message}${a.level === 'fail' ? ' (--force: booting anyway)' : ''}\n`);
  return s;
}
