import { DevslimError } from './errors.ts';
import type { Exec } from './exec.ts';

// Swap do macOS: fonte unica dos limites usados por `doctor`, `android up`,
// `android bake` e `ios up`. Acima de SWAP_WARN_PERCENT avisa; acima de
// SWAP_FAIL_PERCENT o doctor da fail e os comandos que bootam recusam sem --force.

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
    default: return n; // M (ou sem sufixo)
  }
}

// `total = 18432.00M  used = 17704.94M  free = 727.06M  (encrypted)`; aceita virgula decimal.
export function parseSwapUsage(text: string): SwapUsage | null {
  const field = (name: string) => new RegExp(`${name}\\s*=\\s*(\\d+(?:[.,]\\d+)?)\\s*([KMGT]?)`, 'i').exec(text);
  const total = field('total');
  const used = field('used');
  if (!total || !used) return null;
  const totalMb = toMb(total[1], total[2]);
  const usedMb = toMb(used[1], used[2]);
  return Object.freeze({ totalMb, usedMb, ratio: totalMb > 0 ? usedMb / totalMb : null });
}

export type SwapStatus = Readonly<{ usedMb: number | null; totalMb: number | null; percent: number | null }>;

// `sysctl -n vm.swapusage`; qualquer falha = campos null, nunca erro.
export async function readSwap(exec: Exec): Promise<SwapStatus> {
  try {
    const res = await exec('sysctl', ['-n', 'vm.swapusage'], { timeoutMs: 10_000 });
    const u = res.code === 0 ? parseSwapUsage(res.stdout) : null;
    if (u !== null) {
      return Object.freeze({ usedMb: round1(u.usedMb), totalMb: round1(u.totalMb), percent: u.ratio === null ? null : round1(u.ratio * 100) });
    }
  } catch {
    // cai no nulo
  }
  return Object.freeze({ usedMb: null, totalMb: null, percent: null });
}

export type SwapLevel = 'ok' | 'warn' | 'fail';
export type SwapAssessment = Readonly<{ level: SwapLevel; message: string; fix?: string }>;

export const SWAP_FAIL_FIX = 'feche apps, sessoes e devices ociosos antes de subir device';
export const SWAP_WARN_FIX = 'feche algo antes de subir device';

// Mesmo texto no doctor e na recusa do boot. `percent` null = nao lido (warn).
export function assessSwap(s: SwapStatus): SwapAssessment {
  if (s.percent === null) return Object.freeze({ level: 'warn', message: 'sysctl vm.swapusage nao lido' });
  const text = `swap em ${s.percent}% (${s.usedMb} de ${s.totalMb} MB)`;
  if (s.percent > SWAP_FAIL_PERCENT) return Object.freeze({ level: 'fail', message: `${text}: nao boote device agora`, fix: SWAP_FAIL_FIX });
  if (s.percent > SWAP_WARN_PERCENT) return Object.freeze({ level: 'warn', message: `${text}: acima de ${SWAP_WARN_PERCENT}%`, fix: SWAP_WARN_FIX });
  return Object.freeze({ level: 'ok', message: text });
}

// Antes de bootar: fail sem --force = erro; fail com --force e warn = aviso em
// stderr; swap nao lido segue em silencio (o doctor e quem aponta).
export async function swapGate(opts: { exec: Exec; stderr: (t: string) => void; force: boolean; action: string }): Promise<SwapStatus> {
  const s = await readSwap(opts.exec);
  if (s.percent === null) return s;
  const a = assessSwap(s);
  if (a.level === 'fail' && !opts.force) {
    throw new DevslimError(`${opts.action} recusado: ${a.message}; ${a.fix} (--force para bootar mesmo assim)`);
  }
  if (a.level !== 'ok') opts.stderr(`devslim: aviso: ${a.message}${a.level === 'fail' ? ' (--force: bootando mesmo assim)' : ''}\n`);
  return s;
}
