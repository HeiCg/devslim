import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getValue, parseIni } from './configIni.ts';

// O que o emulador de fato usou no ultimo boot. `hardware-qemu.ini` e escrito
// pelo emulador a cada lancamento; o `-memory` pedido pode perder para um piso
// interno (medido: -memory 2048 virou hw.ramSize = 2560 num pixel_7 1080x2400@420).

// `2G`, `2048`, `2048M`, `2048MB` -> MB.
export function parseRamMb(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([MG])?B?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]?.toUpperCase() === 'G' ? n * 1024 : n;
}

export type EffectiveHardware = Readonly<{ ramMb: number | null; gpu: string | null }>;

// null = sem hardware-qemu.ini legivel (AVD nao bootou desde o ultimo tune).
export function readEffectiveHardware(avdDir: string): EffectiveHardware | null {
  let text: string;
  try {
    text = readFileSync(join(avdDir, 'hardware-qemu.ini'), 'utf8');
  } catch {
    return null;
  }
  const doc = parseIni(text);
  const gpu = getValue(doc, 'hw.gpu.mode')?.trim();
  return Object.freeze({ ramMb: parseRamMb(getValue(doc, 'hw.ramSize')), gpu: gpu === undefined || gpu === '' ? null : gpu });
}

// Pisos de RAM vistos (2026-11-17, API 35): sem -lowram o emulador eleva
// qualquer -memory abaixo deles. Sao duas observacoes, nao regra: servem so
// para a nota do plan/tune, nunca para decidir nada.
export const OBSERVED_FLOOR_PHONE_MB = 2560;
export const OBSERVED_FLOOR_TABLET_MB = 4096;

export type LastBootRam = Readonly<{ requestedMb: number; effectiveMb: number }>;

// RAM do ultimo boot quando o emulador elevou o pedido; null sem
// hardware-qemu.ini, sem pedido conhecido ou sem elevacao.
export function lastBootRaise(avdDir: string, requestedMb: number | null): LastBootRam | null {
  const effectiveMb = readEffectiveHardware(avdDir)?.ramMb ?? null;
  if (effectiveMb === null || requestedMb === null || effectiveMb <= requestedMb) return null;
  return Object.freeze({ requestedMb, effectiveMb });
}

// Uma linha para plan/tune: o pedido deve ser elevado. So abaixo do piso de
// phone e sem lowram; com elevacao vista neste AVD, cita ela no lugar dos
// pisos genericos (e cala se o pedido ja passa dela).
export function ramFloorNote(profile: Readonly<{ ramMb: number; lowRam: boolean }>, lastBoot: LastBootRam | null = null): string | null {
  if (profile.lowRam || profile.ramMb >= OBSERVED_FLOOR_PHONE_MB) return null;
  if (lastBoot !== null && profile.ramMb >= lastBoot.effectiveMb) return null;
  const tail = '; --lowram faz o pedido valer (o guest passa a se declarar aparelho de pouca RAM)';
  if (lastBoot !== null) {
    return `nota: no ultimo boot deste AVD o emulador elevou ${lastBoot.requestedMb} MB para ${lastBoot.effectiveMb} MB; o pedido de ${profile.ramMb} MB deve subir de novo${tail}`;
  }
  return (
    `nota: o emulador deve elevar a RAM pedida de ${profile.ramMb} MB ` +
    `(pisos observados: ${OBSERVED_FLOOR_PHONE_MB} MB em phone, ${OBSERVED_FLOOR_TABLET_MB} MB em tablet 2560x1600)${tail}`
  );
}

// GPU por software (CPU e RAM altas). Medido: `-gpu auto` do argent caiu em
// lavapipe num AVD com hw.gpu.mode=host no config.ini.
export const SOFTWARE_GPU_MODES = Object.freeze(['lavapipe', 'software', 'guest'] as const);

export function isSoftwareGpu(mode: string): boolean {
  const m = mode.trim().toLowerCase();
  return m.startsWith('swiftshader') || (SOFTWARE_GPU_MODES as readonly string[]).includes(m);
}

// Linha do log do emulador: `INFO         | Increasing RAM size to 2560MB`.
// Varias ocorrencias (log em append): vale a ultima. `line` vem com os
// espacos colapsados, para citar no aviso do up.
export function parseRamIncreaseLine(logText: string): { mb: number; line: string } | null {
  let last: { mb: number; line: string } | null = null;
  for (const m of logText.matchAll(/^.*?Increasing RAM size to\s*(\d+)\s*MB.*$/gim)) {
    last = { mb: Number(m[1]), line: m[0].replace(/\s+/g, ' ').trim() };
  }
  return last;
}

export function parseRamIncreaseMb(logText: string): number | null {
  return parseRamIncreaseLine(logText)?.mb ?? null;
}

// Tamanho atual do arquivo (0 se nao existe): marca onde comeca o log deste boot.
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Le o log a partir de `offset` (o que este boot escreveu) e aplica o parser.
export function ramIncreaseLineFromLog(logFile: string, offset = 0): { mb: number; line: string } | null {
  let fd: number;
  try {
    fd = openSync(logFile, 'r');
  } catch {
    return null;
  }
  try {
    const size = statSync(logFile).size;
    if (size <= offset) return null;
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return parseRamIncreaseLine(buf.toString('utf8'));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function ramIncreaseFromLog(logFile: string, offset = 0): number | null {
  return ramIncreaseLineFromLog(logFile, offset)?.mb ?? null;
}
