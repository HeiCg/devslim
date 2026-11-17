import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dirSize, type DirSize } from '../dirSize.ts';
import { DevslimError } from '../errors.ts';
import { writeFileAtomic } from '../fsAtomic.ts';
import { clearState, loadState, recordAndroidGuest, recordAndroidTune, statePath, type AndroidState } from '../state.ts';
import { existingRegenerated, findAvd, runningLocks, type AvdInfo } from './avd.ts';
import { applyProfile, parseIni, serializeIni, type IniChange } from './configIni.ts';
import { resolveRuntime, type RuntimeContext } from './deps.ts';
import { buildLaunchArgs, SLIM_SNAPSHOT } from './launchArgs.ts';
import { planRestore } from './packages.ts';
import type { AndroidProfile } from './profile.ts';
import { findAvdSerial, removeSession, waitForExit } from './session.ts';
import { unslimRunningDevice, type UnslimReport } from './slim.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type TuneContext = { env?: Env; now?: Date };

export type TunePlan = Readonly<{
  avd: AvdInfo;
  profile: AndroidProfile;
  changes: readonly IniChange[];
  emulatorArgs: readonly string[];
  // O que `tune` apagaria (so quando o config.ini muda).
  wouldRemove: readonly string[];
  // Tamanho de snapshots/ quando ele esta em wouldRemove; senao null.
  snapshotsSize: DirSize | null;
  runningLocks: readonly string[];
  configBefore: string;
  configAfter: string;
}>;

export type TuneResult = TunePlan & Readonly<{
  wroteConfig: boolean;
  removed: readonly string[];
  preservedOriginal: boolean;
  statePath: string;
}>;

export type RestoreResult = Readonly<{
  avd: AvdInfo;
  bytes: number;
  sha256: string;
  statePath: string;
  clearedState: boolean;
  removedSnapshot: boolean;
  unslim: UnslimReport | null;
  warnings: readonly string[];
}>;

function sha256(buf: Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

// O texto guardado no state tem que reproduzir os bytes exatos do arquivo.
function readUtf8Exact(path: string): string {
  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    throw new DevslimError(`${path} nao e UTF-8 valido; nao da para garantir restore byte a byte`);
  }
  return text;
}

function refuseIfRunning(avd: AvdInfo, action: string): void {
  const locks = runningLocks(avd.dir);
  if (locks.length > 0) {
    throw new DevslimError(`AVD ${avd.name} parece estar rodando (${locks.join(', ')} em ${avd.dir}); desligue antes de ${action}`);
  }
}

// Somente leitura: calcula as mudancas e a linha de comando.
export function planTune(avdName: string, profile: AndroidProfile, ctx: TuneContext = {}): TunePlan {
  const avd = findAvd(avdName, { env: ctx.env });
  const configBefore = readUtf8Exact(avd.configPath);
  const { doc, changes } = applyProfile(parseIni(configBefore), profile);
  const wouldRemove = changes.length > 0 ? existingRegenerated(avd.dir) : [];
  return Object.freeze({
    avd,
    profile,
    changes: Object.freeze(changes),
    emulatorArgs: Object.freeze(buildLaunchArgs(avd.name, profile)),
    wouldRemove: Object.freeze(wouldRemove),
    snapshotsSize: wouldRemove.includes('snapshots') ? dirSize(join(avd.dir, 'snapshots')) : null,
    runningLocks: Object.freeze(runningLocks(avd.dir)),
    configBefore,
    configAfter: serializeIni(doc),
  });
}

// Backup no state, config.ini atomico, depois apaga artefatos regenerados.
export function tuneAvd(avdName: string, profile: AndroidProfile, ctx: TuneContext = {}): TuneResult {
  const plan = planTune(avdName, profile, ctx);
  refuseIfRunning(plan.avd, 'tunar');

  const rec = recordAndroidTune(
    plan.avd.name,
    {
      avdDir: plan.avd.dir,
      originalConfigIni: plan.configBefore,
      originalConfigSha256: sha256(plan.configBefore),
      profile,
      now: ctx.now,
      dropLastLaunch: plan.changes.length > 0,
    },
    { env: ctx.env },
  );

  const wroteConfig = plan.changes.length > 0;
  const removed: string[] = [];
  if (wroteConfig) {
    writeFileAtomic(plan.avd.configPath, plan.configAfter);
    for (const name of plan.wouldRemove) {
      rmSync(join(plan.avd.dir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  return Object.freeze({
    ...plan,
    wroteConfig,
    removed: Object.freeze(removed),
    preservedOriginal: rec.preservedOriginal,
    statePath: rec.path,
  });
}

export type RestoreOptions = RuntimeContext & { configOnly?: boolean };

// Devolve o guest (pacotes e settings do state) e o config.ini byte a byte,
// apaga snapshots/slim_base (gravado com o perfil tunado) e limpa o state.
// - pendencia no guest + AVD rodando: unslim, emu kill, espera sair, config.ini.
// - pendencia + AVD desligado: erro, salvo --config-only (so config.ini; a
//   pendencia fica no state).
export async function restoreAvd(avdName: string, ctx: RestoreOptions = {}): Promise<RestoreResult> {
  const rt = resolveRuntime(ctx);
  const env = rt.env;
  const avd = findAvd(avdName, { env });
  const state = loadState<AndroidState>('android', avd.name, { env });
  if (state === null || typeof state.originalConfigIni !== 'string') {
    throw new DevslimError(`sem state de tune para o AVD ${avd.name}; nada a restaurar`);
  }
  const hash = sha256(state.originalConfigIni);
  if (state.originalConfigSha256 && hash !== state.originalConfigSha256) {
    throw new DevslimError(`state de ${avd.name} corrompido (sha256 do config.ini original nao confere)`);
  }

  const pendingPackages = planRestore(state.disabledPackages ?? []);
  const pendingSettings = state.settings ?? [];
  const hasPending = pendingPackages.length > 0 || pendingSettings.length > 0;
  const pendingText = `${pendingPackages.length} pacote(s) desligado(s) e ${pendingSettings.length} setting(s) alterado(s) no guest`;
  const warnings: string[] = [];
  let unslim: UnslimReport | null = null;
  let keptPending = false;

  if (!hasPending) {
    refuseIfRunning(avd, 'restaurar');
  } else if (ctx.configOnly) {
    refuseIfRunning(avd, 'restaurar');
    keptPending = true;
    warnings.push(`--config-only: ${pendingText} continuam no state; para desfazer: devslim android up ${avd.name} e depois devslim android restore ${avd.name}`);
  } else {
    const adb = rt.adb();
    const serial = await findAvdSerial(adb, avd.name);
    if (serial === null) {
      throw new DevslimError(
        `AVD ${avd.name} tem ${pendingText} e esta desligado; rode antes devslim android up ${avd.name} (e repita o restore) ou passe --config-only`,
      );
    }
    unslim = await unslimRunningDevice(serial, { adb, saved: { disabledPackages: pendingPackages, settings: pendingSettings } });
    const left = unslim.remaining;
    recordAndroidGuest(avd.name, { disabledPackages: left.disabledPackages, settings: left.settings, now: rt.date() }, { env });
    if (left.disabledPackages.length > 0 || left.settings.length > 0) {
      const what = [...unslim.failedPackages.map((f) => f.pkg), ...unslim.failedSettings.map((s) => `${s.ns}/${s.key}`)];
      throw new DevslimError(`restore parcial de ${avd.name}: falhou ${what.join(', ')}; state guarda o que falta, emulador ${serial} segue rodando`);
    }
    await adb.emuKill(serial);
    const exit = await waitForExit({ adb, serial, avdDir: avd.dir, sleep: rt.sleep, now: rt.now, timeoutMs: rt.exitTimeoutMs, pollMs: rt.pollMs });
    removeSession((e) => e.platform === 'android' && e.serial === serial, env);
    if (exit.lingeringLocks.length > 0) {
      throw new DevslimError(`guest de ${avd.name} restaurado, mas o emulador ainda segura ${exit.lingeringLocks.join(', ')}; repita o restore quando sair`);
    }
  }

  writeFileAtomic(avd.configPath, state.originalConfigIni);
  const snapDir = join(avd.dir, 'snapshots', SLIM_SNAPSHOT);
  const removedSnapshot = existsSync(snapDir);
  if (removedSnapshot) rmSync(snapDir, { recursive: true, force: true });
  const path = statePath('android', avd.name, { env });
  if (!keptPending) clearState('android', avd.name, { env });
  return Object.freeze({
    avd,
    bytes: Buffer.byteLength(state.originalConfigIni, 'utf8'),
    sha256: hash,
    statePath: path,
    clearedState: !keptPending,
    removedSnapshot,
    unslim,
    warnings: Object.freeze(warnings),
  });
}
