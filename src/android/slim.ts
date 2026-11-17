import type { Capability } from '../capabilities.ts';
import { isSafeSettingValue, type Adb, type PackageFailure, type SettingsNamespace } from './adb.ts';
import { planDisable, planRestore, type BloatLevel } from './packages.ts';

// Guest debloat with the device already booted. Everything is reversible: the previous
// value of each setting and the packages WE disabled are kept in the state.
// Never touches bluetooth, location or background_process_limit.

export type SavedSetting = Readonly<{ ns: SettingsNamespace; key: string; previous: string | null }>;

type SettingSpec = Readonly<{ ns: SettingsNamespace; key: string; value: string; onlyIfAbsent?: boolean }>;

export const SLIM_SETTINGS: readonly SettingSpec[] = Object.freeze([
  { ns: 'global', key: 'window_animation_scale', value: '0' },
  { ns: 'global', key: 'transition_animation_scale', value: '0' },
  { ns: 'global', key: 'animator_duration_scale', value: '0' },
  { ns: 'global', key: 'auto_sync', value: '0' },
  // The "Try out your stylus" screen covers the app on tablet AVDs.
  { ns: 'secure', key: 'stylus_handwriting_enabled', value: '0' },
  { ns: 'secure', key: 'user_setup_complete', value: '1' },
  { ns: 'global', key: 'device_provisioned', value: '1' },
  // Only when absent/empty: a preexisting value belongs to someone else.
  { ns: 'global', key: 'activity_manager_constants', value: 'max_cached_processes=8', onlyIfAbsent: true },
].map((s) => Object.freeze(s)) as SettingSpec[]);

export const DEXOPT_TIMEOUT_MS = 300_000;

export type SettingOutcome = Readonly<{
  ns: SettingsNamespace;
  key: string;
  value: string;
  previous: string | null;
  status: 'set' | 'skipped' | 'failed';
  note?: string;
}>;

export type StepOutcome = Readonly<{ ok: boolean; detail?: string }>;

export type SlimPrior = { disabledPackages?: readonly string[]; settings?: readonly SavedSetting[] };

export type SlimOptions = {
  adb: Adb;
  level: BloatLevel;
  capabilities?: readonly Capability[];
  // State from a previous bake: what was already ours stays ours, and the "previous"
  // value of each setting is the one from before the first bake.
  prior?: SlimPrior;
};

export type SlimReport = Readonly<{
  serial: string;
  level: BloatLevel;
  capabilities: readonly Capability[];
  settings: readonly SettingOutcome[];
  savedSettings: readonly SavedSetting[];
  plannedPackages: readonly string[];
  disabledPackages: readonly string[]; // ours (go to the state)
  newlyDisabled: readonly string[];
  alreadyDisabled: readonly string[]; // already disabled before us: not in the state
  reenabled: readonly string[]; // previously ours that left the plan
  failedPackages: readonly PackageFailure[];
  packagesError: string | null;
  dexopt: StepOutcome;
  killAll: StepOutcome;
}>;

const settingId = (s: { ns: string; key: string }) => `${s.ns}/${s.key}`;
const errMsg = (err: unknown) => (err as Error)?.message ?? String(err);

async function shellStep(adb: Adb, serial: string, args: string[], timeoutMs?: number): Promise<StepOutcome> {
  try {
    const res = await adb.shell(serial, args, timeoutMs);
    const out = (res.stdout + '\n' + res.stderr).trim();
    if (res.code !== 0 || /Failure|Exception/.test(out)) {
      const why = res.code === null ? `signal ${res.signal ?? '?'} (timeout?)` : `exit ${res.code}`;
      return Object.freeze({ ok: false, detail: `${why}${out ? `: ${out.split(/\r?\n/).slice(-1)[0]}` : ''}` });
    }
    return Object.freeze({ ok: true });
  } catch (err) {
    return Object.freeze({ ok: false, detail: errMsg(err) });
  }
}

export async function slimRunningDevice(serial: string, opts: SlimOptions): Promise<SlimReport> {
  const { adb, level } = opts;
  const capabilities = [...(opts.capabilities ?? [])];
  const priorSettings = new Map((opts.prior?.settings ?? []).map((s) => [settingId(s), s]));
  const priorOwned = new Set(opts.prior?.disabledPackages ?? []);

  // 1. Settings.
  const settings: SettingOutcome[] = [];
  const savedSettings: SavedSetting[] = [];
  for (const spec of SLIM_SETTINGS) {
    const base = { ns: spec.ns, key: spec.key, value: spec.value };
    const prior = priorSettings.get(settingId(spec));
    let current: string | null;
    try {
      const got = await adb.getSetting(serial, spec.ns, spec.key);
      current = got === '' ? null : got; // empty cannot be restored via adb shell: treated as absent
    } catch (err) {
      settings.push(Object.freeze({ ...base, previous: prior?.previous ?? null, status: 'failed', note: errMsg(err) }));
      if (prior !== undefined) savedSettings.push(prior);
      continue;
    }
    const previous = prior !== undefined ? prior.previous : current;

    if (spec.onlyIfAbsent && prior === undefined && current !== null) {
      settings.push(Object.freeze({ ...base, previous, status: 'skipped', note: `already had a value (${current}); left alone` }));
      continue;
    }
    if (previous !== null && !isSafeSettingValue(previous)) {
      settings.push(Object.freeze({ ...base, previous, status: 'skipped', note: 'previous value not restorable via adb shell; left alone' }));
      continue;
    }
    try {
      await adb.putSetting(serial, spec.ns, spec.key, spec.value);
    } catch (err) {
      settings.push(Object.freeze({ ...base, previous, status: 'failed', note: errMsg(err) }));
      if (prior !== undefined) savedSettings.push(prior); // still pending from the previous bake
      continue;
    }
    settings.push(Object.freeze({ ...base, previous, status: 'set' }));
    savedSettings.push(Object.freeze({ ns: spec.ns, key: spec.key, previous }));
  }
  // Settings from a previous bake that this list no longer covers stay pending.
  const covered = new Set(SLIM_SETTINGS.map(settingId));
  for (const s of priorSettings.values()) if (!covered.has(settingId(s))) savedSettings.push(s);

  // 2. Packages.
  let plannedPackages: string[] = [];
  const newlyDisabled: string[] = [];
  const alreadyDisabled: string[] = [];
  const keptOwned: string[] = [];
  const reenabled: string[] = [];
  const failedPackages: PackageFailure[] = [];
  let packagesError: string | null = null;
  try {
    const installed = await adb.listPackages(serial);
    const disabledBefore = new Set(await adb.listDisabledPackages(serial));
    plannedPackages = planDisable({ installed, level, capabilities });
    const planned = new Set(plannedPackages);

    // Previously ours that the current plan no longer wants disabled (e.g. new capability).
    const drop = planRestore([...priorOwned]).filter((p) => !planned.has(p));
    if (drop.length > 0) {
      const res = await adb.enablePackages(serial, drop);
      reenabled.push(...res.done);
      failedPackages.push(...res.failed);
      keptOwned.push(...res.failed.map((f) => f.pkg)); // stays disabled and ours
    }

    const toDisable: string[] = [];
    for (const p of plannedPackages) {
      if (!disabledBefore.has(p)) toDisable.push(p);
      else if (priorOwned.has(p)) keptOwned.push(p);
      else alreadyDisabled.push(p);
    }
    const res = await adb.disablePackages(serial, toDisable);
    newlyDisabled.push(...res.done);
    failedPackages.push(...res.failed);
  } catch (err) {
    packagesError = errMsg(err);
    keptOwned.push(...priorOwned); // without a device read, nothing from the previous state is lost
  }
  const disabledPackages = [...new Set([...keptOwned, ...newlyDisabled])];

  // 3. Batch dexopt (slow, non-fatal). 4. Kill cached processes.
  const dexopt = await shellStep(adb, serial, ['cmd', 'package', 'bg-dexopt-job'], DEXOPT_TIMEOUT_MS);
  const killAll = await shellStep(adb, serial, ['am', 'kill-all']);

  return Object.freeze({
    serial,
    level,
    capabilities: Object.freeze(capabilities),
    settings: Object.freeze(settings),
    savedSettings: Object.freeze(savedSettings),
    plannedPackages: Object.freeze(plannedPackages),
    disabledPackages: Object.freeze(disabledPackages),
    newlyDisabled: Object.freeze(newlyDisabled),
    alreadyDisabled: Object.freeze(alreadyDisabled),
    reenabled: Object.freeze(reenabled),
    failedPackages: Object.freeze(failedPackages),
    packagesError,
    dexopt,
    killAll,
  });
}

export type SlimSaved = { disabledPackages?: readonly string[]; settings?: readonly SavedSetting[] };

export type UnslimReport = Readonly<{
  serial: string;
  enabled: readonly string[];
  failedPackages: readonly PackageFailure[];
  restoredSettings: readonly SavedSetting[];
  failedSettings: readonly (SavedSetting & { error: string })[];
  // What was not restored: stays in the state for another attempt.
  remaining: Readonly<{ disabledPackages: readonly string[]; settings: readonly SavedSetting[] }>;
}>;

// Re-enables only the state packages and returns each setting to its saved value
// (absent = `settings delete`).
export async function unslimRunningDevice(serial: string, opts: { adb: Adb; saved: SlimSaved }): Promise<UnslimReport> {
  const { adb, saved } = opts;
  const pkgs = await adb.enablePackages(serial, planRestore(saved.disabledPackages ?? []));

  const restoredSettings: SavedSetting[] = [];
  const failedSettings: (SavedSetting & { error: string })[] = [];
  for (const s of [...(saved.settings ?? [])].reverse()) {
    try {
      if (s.previous === null) await adb.deleteSetting(serial, s.ns, s.key);
      else await adb.putSetting(serial, s.ns, s.key, s.previous);
      restoredSettings.push(s);
    } catch (err) {
      failedSettings.push(Object.freeze({ ...s, error: errMsg(err) }));
    }
  }
  return Object.freeze({
    serial,
    enabled: pkgs.done,
    failedPackages: pkgs.failed,
    restoredSettings: Object.freeze(restoredSettings),
    failedSettings: Object.freeze(failedSettings),
    remaining: Object.freeze({
      disabledPackages: Object.freeze(pkgs.failed.map((f) => f.pkg)),
      settings: Object.freeze(failedSettings.map(({ ns, key, previous }) => Object.freeze({ ns, key, previous }))),
    }),
  });
}
