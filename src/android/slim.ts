import type { Capability } from '../capabilities.ts';
import { isSafeSettingValue, type Adb, type PackageFailure, type SettingsNamespace } from './adb.ts';
import { planDisable, planRestore, type BloatLevel } from './packages.ts';

// Debloat do guest com o device ja bootado. Tudo e reversivel: o valor
// anterior de cada setting e os pacotes que NOS desligamos voltam no state.
// Nunca toca bluetooth, location nem background_process_limit.

export type SavedSetting = Readonly<{ ns: SettingsNamespace; key: string; previous: string | null }>;

type SettingSpec = Readonly<{ ns: SettingsNamespace; key: string; value: string; onlyIfAbsent?: boolean }>;

export const SLIM_SETTINGS: readonly SettingSpec[] = Object.freeze([
  { ns: 'global', key: 'window_animation_scale', value: '0' },
  { ns: 'global', key: 'transition_animation_scale', value: '0' },
  { ns: 'global', key: 'animator_duration_scale', value: '0' },
  { ns: 'global', key: 'auto_sync', value: '0' },
  // Tela "Teste a stylus" cobre o app em AVD de tablet.
  { ns: 'secure', key: 'stylus_handwriting_enabled', value: '0' },
  { ns: 'secure', key: 'user_setup_complete', value: '1' },
  { ns: 'global', key: 'device_provisioned', value: '1' },
  // So quando ausente/vazio: valor preexistente e de outra pessoa.
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
  // State de um bake anterior: o que ja era nosso continua nosso, e o valor
  // "anterior" de cada setting e o de antes do primeiro bake.
  prior?: SlimPrior;
};

export type SlimReport = Readonly<{
  serial: string;
  level: BloatLevel;
  capabilities: readonly Capability[];
  settings: readonly SettingOutcome[];
  savedSettings: readonly SavedSetting[];
  plannedPackages: readonly string[];
  disabledPackages: readonly string[]; // nossos (vao para o state)
  newlyDisabled: readonly string[];
  alreadyDisabled: readonly string[]; // ja desligados antes de nos: fora do state
  reenabled: readonly string[]; // nossos de antes que sairam do plano
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
      const why = res.code === null ? `sinal ${res.signal ?? '?'} (timeout?)` : `exit ${res.code}`;
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
      current = got === '' ? null : got; // vazio nao volta por adb shell: tratado como ausente
    } catch (err) {
      settings.push(Object.freeze({ ...base, previous: prior?.previous ?? null, status: 'failed', note: errMsg(err) }));
      if (prior !== undefined) savedSettings.push(prior);
      continue;
    }
    const previous = prior !== undefined ? prior.previous : current;

    if (spec.onlyIfAbsent && prior === undefined && current !== null) {
      settings.push(Object.freeze({ ...base, previous, status: 'skipped', note: `ja tinha valor (${current}); nao mexido` }));
      continue;
    }
    if (previous !== null && !isSafeSettingValue(previous)) {
      settings.push(Object.freeze({ ...base, previous, status: 'skipped', note: 'valor anterior nao restauravel via adb shell; nao mexido' }));
      continue;
    }
    try {
      await adb.putSetting(serial, spec.ns, spec.key, spec.value);
    } catch (err) {
      settings.push(Object.freeze({ ...base, previous, status: 'failed', note: errMsg(err) }));
      if (prior !== undefined) savedSettings.push(prior); // continua pendente do bake anterior
      continue;
    }
    settings.push(Object.freeze({ ...base, previous, status: 'set' }));
    savedSettings.push(Object.freeze({ ns: spec.ns, key: spec.key, previous }));
  }
  // Settings de um bake anterior que esta lista nao cobre mais continuam pendentes.
  const covered = new Set(SLIM_SETTINGS.map(settingId));
  for (const s of priorSettings.values()) if (!covered.has(settingId(s))) savedSettings.push(s);

  // 2. Pacotes.
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

    // Nossos de antes que o plano atual nao quer mais desligados (ex. capacidade nova).
    const drop = planRestore([...priorOwned]).filter((p) => !planned.has(p));
    if (drop.length > 0) {
      const res = await adb.enablePackages(serial, drop);
      reenabled.push(...res.done);
      failedPackages.push(...res.failed);
      keptOwned.push(...res.failed.map((f) => f.pkg)); // continua desligado e nosso
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
    keptOwned.push(...priorOwned); // sem leitura do device, nada do state anterior se perde
  }
  const disabledPackages = [...new Set([...keptOwned, ...newlyDisabled])];

  // 3. dexopt em lote (lento, nao fatal). 4. Mata processos em cache.
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
  // O que nao voltou: fica no state para nova tentativa.
  remaining: Readonly<{ disabledPackages: readonly string[]; settings: readonly SavedSetting[] }>;
}>;

// Reabilita so os pacotes do state e devolve cada setting ao valor salvo
// (ausente = `settings delete`).
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
