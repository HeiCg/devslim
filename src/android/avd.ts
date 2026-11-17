import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DevslimError } from '../errors.ts';
import { getValue, parseIni } from './configIni.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type AvdInfo = Readonly<{
  name: string;
  home: string; // directory holding <name>.ini and, by default, <name>.avd
  iniPath: string; // <home>/<name>.ini (may not exist)
  dir: string; // <name>.avd directory
  configPath: string; // <dir>/config.ini
}>;

const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Same precedence as the emulator: ANDROID_AVD_HOME, then
// ANDROID_USER_HOME/avd, then ~/.android/avd.
export function avdHome(env: Env = process.env): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, 'avd');
  return join(env.HOME || homedir(), '.android', 'avd');
}

export function listAvds(env: Env = process.env): string[] {
  const home = avdHome(env);
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.ini'))
    .map((n) => n.slice(0, -'.ini'.length))
    .filter((n) => NAME_RE.test(n))
    .sort();
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Locates the AVD: <home>/<name>.ini points to the directory via `path` (or
// `path.rel`, relative to the parent of <home>); without .ini, falls back to <home>/<name>.avd.
export function findAvd(name: string, opts: { env?: Env } = {}): AvdInfo {
  if (!NAME_RE.test(name)) throw new DevslimError(`invalid AVD name: ${name}`);
  const home = avdHome(opts.env);
  const iniPath = join(home, `${name}.ini`);
  const candidates: string[] = [];

  if (existsSync(iniPath)) {
    const ini = parseIni(readFileSync(iniPath, 'utf8'));
    const abs = getValue(ini, 'path');
    if (abs) candidates.push(abs);
    const rel = getValue(ini, 'path.rel');
    if (rel) candidates.push(isAbsolute(rel) ? rel : resolve(home, '..', rel));
  }
  candidates.push(join(home, `${name}.avd`));

  const dir = candidates.find(isDir);
  if (dir === undefined) {
    const known = listAvds(opts.env);
    const hint = known.length > 0 ? ` (available: ${known.join(', ')})` : '';
    throw new DevslimError(`AVD not found: ${name} in ${home}${hint}`);
  }
  const configPath = join(dir, 'config.ini');
  if (!existsSync(configPath)) throw new DevslimError(`AVD ${name} has no config.ini in ${dir}`);
  return Object.freeze({ name, home, iniPath, dir, configPath });
}

// The emulator creates `*.lock` directories (e.g. hardware-qemu.ini.lock/) while
// running and deletes them on exit. `multiinstance.lock` is an empty file that stays in
// the AVD even with the emulator shut down, so it does not count as a running signal.
export function runningLocks(avdDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(avdDir);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.lock'))
    .filter((n) => n !== 'multiinstance.lock' || isDir(join(avdDir, n)))
    .sort();
}

export function isAvdRunning(avdDir: string): boolean {
  return runningLocks(avdDir).length > 0;
}

// Artifacts the emulator regenerates and that become inconsistent after
// editing config.ini.
export const REGENERATED_ARTIFACTS = Object.freeze(['hardware-qemu.ini', 'snapshots']);

export function existingRegenerated(avdDir: string): string[] {
  return REGENERATED_ARTIFACTS.filter((n) => existsSync(join(avdDir, n)));
}
