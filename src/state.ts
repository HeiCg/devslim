import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DevslimError } from './errors.ts';
import { writeFileAtomic } from './fsAtomic.ts';
import type { AndroidProfile } from './android/profile.ts';
import type { SavedSetting } from './android/slim.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type StateOptions = { env?: Env };
export type Platform = 'android' | 'ios';

const ID_RE = /^[A-Za-z0-9._-]+$/;

export function devslimHome(env: Env = process.env): string {
  const home = env.DEVSLIM_HOME;
  return home !== undefined && home !== '' ? home : join(homedir(), '.devslim');
}

export function statePath(platform: Platform, id: string, opts: StateOptions = {}): string {
  if (platform !== 'android' && platform !== 'ios') throw new DevslimError(`plataforma invalida: ${platform}`);
  if (!ID_RE.test(id) || id === '.' || id === '..') throw new DevslimError(`id de state invalido: ${id}`);
  return join(devslimHome(opts.env), 'state', platform, `${id}.json`);
}

export function saveState(platform: Platform, id: string, data: unknown, opts: StateOptions = {}): string {
  const path = statePath(platform, id, opts);
  mkdirSync(join(devslimHome(opts.env), 'state', platform), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return path;
}

export function loadState<T = unknown>(platform: Platform, id: string, opts: StateOptions = {}): T | null {
  const path = statePath(platform, id, opts);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DevslimError(`state corrompido (JSON invalido): ${path}`);
  }
}

// Ids com state gravado para a plataforma (nomes de AVD ou UDIDs), ordenados.
export function listStates(platform: Platform, opts: StateOptions = {}): string[] {
  if (platform !== 'android' && platform !== 'ios') throw new DevslimError(`plataforma invalida: ${platform}`);
  let names: string[];
  try {
    names = readdirSync(join(devslimHome(opts.env), 'state', platform));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter((id) => ID_RE.test(id) && id !== '.' && id !== '..')
    .sort();
}

export function clearState(platform: Platform, id: string, opts: StateOptions = {}): boolean {
  const path = statePath(platform, id, opts);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

// State de um AVD tunado. `originalConfigIni` e o texto integral do config.ini
// antes do primeiro tune; restore devolve esses bytes (conferidos pelo sha256).
export type AndroidState = {
  version: 1;
  platform: 'android';
  avd: string;
  avdDir: string;
  originalConfigIni: string;
  originalConfigSha256: string;
  originalSavedAt: string;
  updatedAt: string;
  profile: AndroidProfile;
  // Pacotes que NOS desligamos no guest (bake) e o valor anterior de cada
  // setting que mudamos (previous null = ausente: restore faz delete).
  disabledPackages: string[];
  settings?: SavedSetting[];
  bakedAt?: string;
  // O que o ultimo `up`/`bake` passou ao emulador (-memory e -lowram). Pode
  // diferir do perfil (`up --ram X` sem tune); e o "pedido" que se compara com a
  // RAM efetiva do hardware-qemu.ini. Ausente em state antigo.
  lastLaunch?: AndroidLaunchRecord;
};

export type AndroidLaunchRecord = { ramMb: number; lowRam: boolean; at: string };

// Grava o state do tune. Se ja existe state para o AVD, o original salvo e o
// do primeiro tune e nunca e sobrescrito (re-tune mantem o primeiro backup).
// `dropLastLaunch`: o tune reescreve o config.ini e apaga o hardware-qemu.ini
// daquele lancamento, entao o lastLaunch deixa de valer; sem isso ele fica.
export function recordAndroidTune(
  avd: string,
  input: {
    avdDir: string;
    originalConfigIni: string;
    originalConfigSha256: string;
    profile: AndroidProfile;
    now?: Date;
    dropLastLaunch?: boolean;
  },
  opts: StateOptions = {},
): { state: AndroidState; preservedOriginal: boolean; path: string } {
  const now = (input.now ?? new Date()).toISOString();
  const prev = loadState<AndroidState>('android', avd, opts);
  const preservedOriginal = prev !== null && typeof prev.originalConfigIni === 'string';
  const state: AndroidState = {
    version: 1,
    platform: 'android',
    avd,
    avdDir: input.avdDir,
    originalConfigIni: preservedOriginal ? prev.originalConfigIni : input.originalConfigIni,
    originalConfigSha256: preservedOriginal ? prev.originalConfigSha256 : input.originalConfigSha256,
    originalSavedAt: preservedOriginal ? prev.originalSavedAt : now,
    updatedAt: now,
    profile: input.profile,
    disabledPackages: prev?.disabledPackages ?? [],
  };
  if (prev?.settings !== undefined) state.settings = prev.settings;
  if (prev?.bakedAt !== undefined) state.bakedAt = prev.bakedAt;
  if (prev?.lastLaunch !== undefined && input.dropLastLaunch !== true) state.lastLaunch = prev.lastLaunch;
  const path = saveState('android', avd, state, opts);
  return { state, preservedOriginal, path };
}

// Registra o lancamento (up/bake) no state do AVD. Sem state (AVD nunca
// tunado) nada e criado: devolve null e quem compara cai no config.ini.
export function recordAndroidLaunch(avd: string, launch: AndroidLaunchRecord, opts: StateOptions = {}): string | null {
  const prev = loadState<AndroidState>('android', avd, opts);
  if (prev === null) return null;
  return saveState('android', avd, { ...prev, lastLaunch: { ramMb: launch.ramMb, lowRam: launch.lowRam, at: launch.at } }, opts);
}

// RAM "pedida" para comparar com a efetiva: a do ultimo up/bake quando o state
// tem lastLaunch; senao a do perfil do tune; null sem nenhuma das duas.
export function requestedRamMb(st: Pick<AndroidState, 'profile' | 'lastLaunch'> | null | undefined): number | null {
  const launched = st?.lastLaunch?.ramMb;
  if (typeof launched === 'number' && Number.isFinite(launched)) return launched;
  const profile = st?.profile?.ramMb;
  return typeof profile === 'number' && Number.isFinite(profile) ? profile : null;
}

export function launchedRamMb(st: Pick<AndroidState, 'lastLaunch'> | null | undefined): number | null {
  const launched = st?.lastLaunch?.ramMb;
  return typeof launched === 'number' && Number.isFinite(launched) ? launched : null;
}

// State de um simulador iOS enxugado. `backup` tem o valor que cada label
// gerido tinha no disabled.plist ANTES do primeiro `up` que o mexeu
// (true/false; null = chave ausente). `off` devolve esses valores.
export type IosProfileRecord = {
  capabilities: string[];
  except: string[];
  keep: string[];
  labels: number;
};

export type IosState = {
  version: 1;
  platform: 'ios';
  udid: string;
  name: string;
  runtimeId: string;
  backup: Record<string, boolean | null>;
  backupSavedAt: string;
  updatedAt: string;
  profile: IosProfileRecord;
};

// Acrescenta ao backup so labels que ainda nao estao nele: primeiro backup vence.
export function recordIosBackup(
  udid: string,
  input: {
    name: string;
    runtimeId: string;
    previous: ReadonlyMap<string, boolean | undefined>;
    profile: IosProfileRecord;
    now?: Date;
  },
  opts: StateOptions = {},
): { state: IosState; added: string[]; path: string } {
  const now = (input.now ?? new Date()).toISOString();
  const prev = loadState<IosState>('ios', udid, opts);
  const backup: Record<string, boolean | null> = { ...(prev?.backup ?? {}) };
  const added: string[] = [];
  for (const [label, value] of input.previous) {
    if (Object.hasOwn(backup, label)) continue;
    backup[label] = value === undefined ? null : value;
    added.push(label);
  }
  const state: IosState = {
    version: 1,
    platform: 'ios',
    udid,
    name: input.name,
    runtimeId: input.runtimeId,
    backup,
    backupSavedAt: prev?.backupSavedAt ?? now,
    updatedAt: now,
    profile: input.profile,
  };
  const path = saveState('ios', udid, state, opts);
  return { state, added, path };
}

// Grava o que esta no guest agora (depois do bake ou de um restore parcial).
// Exige state de tune ja existente.
export function recordAndroidGuest(
  avd: string,
  input: { disabledPackages: readonly string[]; settings: readonly SavedSetting[]; bakedAt?: Date; now?: Date },
  opts: StateOptions = {},
): { state: AndroidState; path: string } {
  const prev = loadState<AndroidState>('android', avd, opts);
  if (prev === null) throw new DevslimError(`sem state de tune para o AVD ${avd}`);
  const state: AndroidState = {
    ...prev,
    updatedAt: (input.now ?? new Date()).toISOString(),
    disabledPackages: [...input.disabledPackages],
    settings: [...input.settings],
  };
  if (input.bakedAt !== undefined) state.bakedAt = input.bakedAt.toISOString();
  const path = saveState('android', avd, state, opts);
  return { state, path };
}
