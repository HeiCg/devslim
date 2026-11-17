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
  // What `tune` would delete (only when config.ini changes).
  wouldRemove: readonly string[];
  // Size of snapshots/ when it is in wouldRemove; else null.
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

// The text kept in the state must reproduce the exact file bytes.
function readUtf8Exact(path: string): string {
  const buf = readFileSync(path);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    throw new DevslimError(`${path} is not valid UTF-8; cannot guarantee a byte-for-byte restore`);
  }
  return text;
}

function refuseIfRunning(avd: AvdInfo, action: string): void {
  const locks = runningLocks(avd.dir);
  if (locks.length > 0) {
    throw new DevslimError(`AVD ${avd.name} seems to be running (${locks.join(', ')} in ${avd.dir}); shut it down before ${action}`);
  }
}

// Read-only: computes the changes and the command line.
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

// Backup in the state, atomic config.ini, then deletes regenerated artifacts.
export function tuneAvd(avdName: string, profile: AndroidProfile, ctx: TuneContext = {}): TuneResult {
  const plan = planTune(avdName, profile, ctx);
  refuseIfRunning(plan.avd, 'tuning');

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

// Restores the guest (state packages and settings) and config.ini byte for byte,
// deletes snapshots/slim_base (saved with the tuned profile) and clears the state.
// - pending guest changes + AVD running: unslim, emu kill, wait for exit, config.ini.
// - pending + AVD shut down: error, unless --config-only (config.ini only; the
//   pending changes stay in the state).
export async function restoreAvd(avdName: string, ctx: RestoreOptions = {}): Promise<RestoreResult> {
  const rt = resolveRuntime(ctx);
  const env = rt.env;
  const avd = findAvd(avdName, { env });
  const state = loadState<AndroidState>('android', avd.name, { env });
  if (state === null || typeof state.originalConfigIni !== 'string') {
    throw new DevslimError(`no tune state for AVD ${avd.name}; nothing to restore`);
  }
  const hash = sha256(state.originalConfigIni);
  if (state.originalConfigSha256 && hash !== state.originalConfigSha256) {
    throw new DevslimError(`state of ${avd.name} is corrupt (original config.ini sha256 does not match)`);
  }

  const pendingPackages = planRestore(state.disabledPackages ?? []);
  const pendingSettings = state.settings ?? [];
  const hasPending = pendingPackages.length > 0 || pendingSettings.length > 0;
  const pendingText = `${pendingPackages.length} disabled package(s) and ${pendingSettings.length} changed setting(s) in the guest`;
  const warnings: string[] = [];
  let unslim: UnslimReport | null = null;
  let keptPending = false;

  if (!hasPending) {
    refuseIfRunning(avd, 'restoring');
  } else if (ctx.configOnly) {
    refuseIfRunning(avd, 'restoring');
    keptPending = true;
    warnings.push(`--config-only: ${pendingText} remain in the state; to undo them: devslim android up ${avd.name} and then devslim android restore ${avd.name}`);
  } else {
    const adb = rt.adb();
    const serial = await findAvdSerial(adb, avd.name);
    if (serial === null) {
      throw new DevslimError(
        `AVD ${avd.name} has ${pendingText} and is shut down; first run devslim android up ${avd.name} (and repeat the restore) or pass --config-only`,
      );
    }
    unslim = await unslimRunningDevice(serial, { adb, saved: { disabledPackages: pendingPackages, settings: pendingSettings } });
    const left = unslim.remaining;
    recordAndroidGuest(avd.name, { disabledPackages: left.disabledPackages, settings: left.settings, now: rt.date() }, { env });
    if (left.disabledPackages.length > 0 || left.settings.length > 0) {
      const what = [...unslim.failedPackages.map((f) => f.pkg), ...unslim.failedSettings.map((s) => `${s.ns}/${s.key}`)];
      throw new DevslimError(`partial restore of ${avd.name}: failed ${what.join(', ')}; the state keeps what is left, emulator ${serial} is still running`);
    }
    await adb.emuKill(serial);
    const exit = await waitForExit({ adb, serial, avdDir: avd.dir, sleep: rt.sleep, now: rt.now, timeoutMs: rt.exitTimeoutMs, pollMs: rt.pollMs });
    removeSession((e) => e.platform === 'android' && e.serial === serial, env);
    if (exit.lingeringLocks.length > 0) {
      throw new DevslimError(`guest of ${avd.name} restored, but the emulator still holds ${exit.lingeringLocks.join(', ')}; repeat the restore once it exits`);
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
