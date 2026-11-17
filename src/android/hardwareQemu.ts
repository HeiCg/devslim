import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getValue, parseIni } from './configIni.ts';

// What the emulator actually used on the last boot. `hardware-qemu.ini` is written
// by the emulator on every launch; the requested `-memory` can lose to an internal
// floor (measured: -memory 2048 became hw.ramSize = 2560 on a pixel_7 1080x2400@420).

// `2G`, `2048`, `2048M`, `2048MB` -> MB.
export function parseRamMb(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([MG])?B?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2]?.toUpperCase() === 'G' ? n * 1024 : n;
}

export type EffectiveHardware = Readonly<{ ramMb: number | null; gpu: string | null }>;

// null = no readable hardware-qemu.ini (AVD not booted since the last tune).
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

// Observed RAM floors (2026-11-17, API 35): without -lowram the emulator raises
// any -memory below them. These are two observations, not a rule: they only feed
// the plan/tune note, never any decision.
export const OBSERVED_FLOOR_PHONE_MB = 2560;
export const OBSERVED_FLOOR_TABLET_MB = 4096;

export type LastBootRam = Readonly<{ requestedMb: number; effectiveMb: number }>;

// Last boot RAM when the emulator raised the request; null without
// hardware-qemu.ini, without a known request or without a raise.
export function lastBootRaise(avdDir: string, requestedMb: number | null): LastBootRam | null {
  const effectiveMb = readEffectiveHardware(avdDir)?.ramMb ?? null;
  if (effectiveMb === null || requestedMb === null || effectiveMb <= requestedMb) return null;
  return Object.freeze({ requestedMb, effectiveMb });
}

// One line for plan/tune: the request will likely be raised. Only below the phone
// floor and without lowram; with a raise seen on this AVD, cites it instead of the
// generic floors (and stays quiet if the request already exceeds it).
export function ramFloorNote(profile: Readonly<{ ramMb: number; lowRam: boolean }>, lastBoot: LastBootRam | null = null): string | null {
  if (profile.lowRam || profile.ramMb >= OBSERVED_FLOOR_PHONE_MB) return null;
  if (lastBoot !== null && profile.ramMb >= lastBoot.effectiveMb) return null;
  const tail = '; --lowram makes the request stick (the guest then reports itself as a low-RAM device)';
  if (lastBoot !== null) {
    return `note: on this AVD's last boot the emulator raised ${lastBoot.requestedMb} MB to ${lastBoot.effectiveMb} MB; the ${profile.ramMb} MB request will likely be raised again${tail}`;
  }
  return (
    `note: the emulator will likely raise the requested RAM of ${profile.ramMb} MB ` +
    `(observed floors: ${OBSERVED_FLOOR_PHONE_MB} MB on phone, ${OBSERVED_FLOOR_TABLET_MB} MB on a 2560x1600 tablet)${tail}`
  );
}

// Software GPU (high CPU and RAM). Measured: argent's `-gpu auto` fell back to
// lavapipe on an AVD with hw.gpu.mode=host in config.ini.
export const SOFTWARE_GPU_MODES = Object.freeze(['lavapipe', 'software', 'guest'] as const);

export function isSoftwareGpu(mode: string): boolean {
  const m = mode.trim().toLowerCase();
  return m.startsWith('swiftshader') || (SOFTWARE_GPU_MODES as readonly string[]).includes(m);
}

// Emulator log line: `INFO         | Increasing RAM size to 2560MB`.
// Several occurrences (append-only log): the last one wins. `line` comes with
// whitespace collapsed, for quoting in the up warning.
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

// Current file size (0 if missing): marks where this boot's log starts.
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Reads the log from `offset` (what this boot wrote) and applies the parser.
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
