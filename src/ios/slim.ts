import { existsSync } from 'node:fs';
import type { Capability } from '../capabilities.ts';
import { sortCapabilities } from '../capabilities.ts';
import { DevslimError } from '../errors.ts';
import type { Adb } from '../android/adb.ts';
import { resolveRuntime, type Runtime, type RuntimeContext } from '../android/deps.ts';
import { assertSingleDevice, loadSession, recordSession, removeSession, type SessionEntry } from '../android/session.ts';
import { swapGate } from '../swap.ts';
import { stopIdleWatcher } from '../idle.ts';
import { clearState, loadState, recordIosBackup, statePath as stateFile, type IosProfileRecord, type IosState } from '../state.ts';
import { mergeStore, readStore, storePath, type StoreOptions } from './disabledStore.ts';
import { labelsToDisable, managedSet, repairSet, touchableSet, validateExcept, validateKeep } from './labels.ts';
import {
  createSimctl,
  LAUNCHD_RETRY_DELAYS_MS,
  parseRuntimeId,
  resolveDevice,
  type SimDevice,
  type Simctl,
} from './simctl.ts';

// Enxugar um simulador iOS: marcar labels launchd geridos como desligados no
// disabled.plist do device (com ele desligado), bootar e conferir com
// `launchctl print-disabled`. Runtime compartilhado nunca e tocado.
// Invariante: todo diff, leitura comparada e escrita considera so
// managedSet() (desligar/devolver) e repairSet() (religar/devolver); nada fora
// de touchableSet() e tocado, e nenhum label de repairSet() recebe disable.

export const MIN_IOS_VERSION = Object.freeze([18, 5] as const);
export const FALLBACK_POOL = 8;
export const FALLBACK_PASSES = 3;

// `storeBase`: base do disabled.plist (padrao /private/var/tmp).
// bootTimeoutMs -> bootstatus; exitTimeoutMs -> espera do shutdown; pollMs -> poll do shutdown.
export type IosContext = RuntimeContext & { storeBase?: string };

export type IosSlimOptions = {
  capabilities?: readonly Capability[];
  except?: readonly string[];
  keep?: readonly string[];
};

type IosRuntime = { rt: Runtime; simctl: Simctl; store: StoreOptions };

function iosRuntime(ctx: IosContext): IosRuntime {
  const rt = resolveRuntime(ctx);
  const simctl = createSimctl({
    exec: rt.exec,
    sleep: rt.sleep,
    now: rt.now,
    bootstatusTimeoutMs: rt.bootTimeoutMs,
    shutdownTimeoutMs: rt.exitTimeoutMs,
    pollMs: rt.pollMs,
  });
  return { rt, simctl, store: { base: ctx.storeBase, exec: rt.exec } };
}

export type RuntimeInfo = Readonly<{ identifier: string; platform: string; version: string }>;

export function compareVersion(a: string, min: readonly number[]): number {
  const parts = a.split('.').map((p) => Number(p));
  for (let i = 0; i < min.length; i++) {
    const v = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (v !== min[i]) return v - min[i];
  }
  return 0;
}

// Gate: so iOS, e so >= 18.5 (antes disso o launchd_sim nao persiste overrides).
export function checkIosRuntime(runtime: RuntimeInfo): RuntimeInfo {
  if (runtime.platform !== 'iOS') {
    throw new DevslimError(`runtime ${runtime.platform} ${runtime.version} fora de escopo: devslim ios so trata simulador iOS`);
  }
  if (!/^\d+(\.\d+)*$/.test(runtime.version) || compareVersion(runtime.version, MIN_IOS_VERSION) < 0) {
    throw new DevslimError(
      `iOS ${runtime.version} nao suportado: exige iOS ${MIN_IOS_VERSION.join('.')} ou mais novo (versoes antigas nao guardam os overrides do launchd entre boots)`,
    );
  }
  return runtime;
}

async function runtimeOf(simctl: Simctl, device: SimDevice): Promise<RuntimeInfo> {
  let found: RuntimeInfo | undefined;
  try {
    found = (await simctl.listRuntimes()).find((r) => r.identifier === device.runtimeId);
  } catch {
    found = undefined; // cai no parse do identificador
  }
  if (found !== undefined) return Object.freeze({ identifier: found.identifier, platform: found.platform, version: found.version });
  const parsed = parseRuntimeId(device.runtimeId);
  if (parsed === null) throw new DevslimError(`runtime desconhecido para ${device.name}: ${device.runtimeId}`);
  return Object.freeze({ identifier: device.runtimeId, ...parsed });
}

function iosStatePath(udid: string, rt: Runtime): string {
  return stateFile('ios', udid, { env: rt.env });
}

function assertManaged(labels: Iterable<string>, managed: ReadonlySet<string>): void {
  for (const l of labels) {
    if (!managed.has(l)) throw new DevslimError(`interno: label fora da lista gerida: ${l}`);
  }
}

// Labels de repairSet() que o store traz desligados (true): o `up` grava false.
function needsRepair(current: ReadonlyMap<string, boolean>): string[] {
  return [...repairSet()].filter((l) => current.get(l) === true).sort();
}

// Alvo do store/launchd: labels do perfil -> true; labels que nos mexemos antes
// (backup) e que o perfil nao desliga mais -> valor salvo (ausente = false).
function targetMap(desired: readonly string[], backup: IosState['backup'] | undefined, managed: ReadonlySet<string>): Map<string, boolean> {
  const target = new Map<string, boolean>();
  for (const l of desired) target.set(l, true);
  for (const [l, v] of Object.entries(backup ?? {})) {
    if (!managed.has(l) || target.has(l)) continue;
    target.set(l, v === true);
  }
  return target;
}

// O que o launchd vivo ainda nao reflete do alvo (so labels de touchableSet()).
function mismatches(live: ReadonlyMap<string, boolean>, target: ReadonlyMap<string, boolean>, touchable: ReadonlySet<string>) {
  const toDisable: string[] = [];
  const toEnable: string[] = [];
  for (const [label, want] of target) {
    if (!touchable.has(label)) continue;
    const got = live.get(label) === true;
    if (want && !got) toDisable.push(label);
    if (!want && got) toEnable.push(label);
  }
  return { toDisable: toDisable.sort(), toEnable: toEnable.sort() };
}

// Pool de `limit` workers; devolve os itens cujo fn falhou (false ou excecao).
export async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<boolean>): Promise<T[]> {
  const failed: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      let ok = false;
      try {
        ok = await fn(item);
      } catch {
        ok = false;
      }
      if (!ok) failed.push(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return failed;
}

function profileRecord(opts: IosSlimOptions, labels: number): IosProfileRecord {
  return {
    capabilities: sortCapabilities(opts.capabilities ?? []),
    except: validateExcept(opts.except),
    keep: validateKeep(opts.keep),
    labels,
  };
}

// ---------------------------------------------------------------------------
// plan (sem efeitos: so simctl list e leitura do store)

export type SimPlan = Readonly<{
  udid: string;
  name: string;
  state: string;
  runtime: RuntimeInfo;
  profile: IosProfileRecord;
  labels: readonly string[];
  managedTotal: number;
  alreadyInStore: number;
  repair: readonly string[]; // ALWAYS_ENABLED desligados no store que o up religa
  storePath: string;
  storeExists: boolean;
  hasState: boolean;
}>;

export async function planSim(query: string, opts: IosSlimOptions = {}, ctx: IosContext = {}): Promise<SimPlan> {
  const { rt, simctl, store } = iosRuntime(ctx);
  const device = await simctl.findDevice(query);
  const runtime = checkIosRuntime(await runtimeOf(simctl, device));
  const labels = labelsToDisable(opts);
  const current = await readStore(device.udid, store);
  const path = storePath(device.udid, store);
  return Object.freeze({
    udid: device.udid,
    name: device.name,
    state: device.state,
    runtime,
    profile: profileRecord(opts, labels.length),
    labels: Object.freeze(labels),
    managedTotal: managedSet().size,
    alreadyInStore: labels.filter((l) => current.get(l) === true).length,
    repair: Object.freeze(needsRepair(current)),
    storePath: path,
    storeExists: existsSync(path),
    hasState: loadState('ios', device.udid, { env: rt.env }) !== null,
  });
}

// ---------------------------------------------------------------------------
// up

export type FallbackReport = Readonly<{ used: boolean; passes: number; failed: readonly string[]; rebooted: boolean }>;

export type UpSimResult = Readonly<{
  udid: string;
  name: string;
  runtime: RuntimeInfo;
  profile: IosProfileRecord;
  alreadySlim: boolean;
  wasBooted: boolean;
  shutdownFirst: boolean;
  labels: number;
  storeChanges: number; // entradas do disabled.plist que mudaram
  backupAdded: number; // labels novos no backup do state (primeiro backup vence)
  restored: readonly string[]; // geridos que o perfil nao desliga mais, devolvidos ao valor salvo
  repaired: readonly string[]; // ALWAYS_ENABLED que estavam desligados no store e foram gravados ligados
  fallback: FallbackReport;
  notApplied: readonly string[]; // deviam estar desligados e nao estao
  notRestored: readonly string[]; // deviam estar ligados e nao estao
  windowOpened: boolean;
  statePath: string | null;
  bootMs: number | null;
}>;

async function guardAdb(rt: Runtime): Promise<Adb | null> {
  try {
    return rt.adb();
  } catch (err) {
    if (err instanceof DevslimError) return null; // sem SDK Android: nenhum emulador a contar
    throw err;
  }
}

async function bootAndWait(simctl: Simctl, udid: string): Promise<void> {
  await simctl.boot(udid);
  await simctl.bootstatus(udid);
}

export async function upSim(query: string, opts: IosSlimOptions = {}, ctx: IosContext & { force?: boolean } = {}): Promise<UpSimResult> {
  const { rt, simctl, store } = iosRuntime(ctx);
  const device = await simctl.findDevice(query);
  const udid = device.udid;
  const runtime = checkIosRuntime(await runtimeOf(simctl, device));
  const desired = labelsToDisable(opts);
  const managed = managedSet();
  const touchable = touchableSet();
  assertManaged(desired, managed);
  const profile = profileRecord(opts, desired.length);
  const caps = profile.capabilities;

  await assertSingleDevice({ adb: await guardAdb(rt), exec: rt.exec, force: ctx.force === true, action: 'ios up', exceptUdid: udid });

  const prevState = loadState<IosState>('ios', udid, { env: rt.env });
  const target = targetMap(desired, prevState?.backup, managed);
  assertManaged(target.keys(), managed);
  const restored = [...target].filter(([l, v]) => !v && !desired.includes(l)).map(([l]) => l).sort();
  // Conferencia: alem do alvo, todo ALWAYS_ENABLED tem de aparecer ligado.
  const verify = new Map(target);
  for (const l of repairSet()) verify.set(l, false);
  const noFallback: FallbackReport = Object.freeze({ used: false, passes: 0, failed: Object.freeze([]), rebooted: false });

  const wasBooted = device.state === 'Booted';
  let shutdownFirst = false;
  if (wasBooted) {
    await simctl.bootstatus(udid); // `Booted` aparece no inicio do boot; espera o launchd
    const live = await simctl.printDisabled(udid);
    const mm = mismatches(live, verify, touchable);
    if (mm.toDisable.length === 0 && mm.toEnable.length === 0) {
      const windowOpened = caps.includes('window') ? await openSimulatorApp(rt) : false;
      return Object.freeze({
        udid,
        name: device.name,
        runtime,
        profile,
        alreadySlim: true,
        wasBooted,
        shutdownFirst,
        labels: desired.length,
        storeChanges: 0,
        backupAdded: 0,
        restored: Object.freeze([]),
        repaired: Object.freeze([]),
        fallback: noFallback,
        notApplied: Object.freeze([]),
        notRestored: Object.freeze([]),
        windowOpened,
        statePath: null,
        bootMs: null,
      });
    }
    // Vai rebootar: conta como boot para a guarda de swap.
    await swapGate({ exec: rt.exec, stderr: rt.stderr, force: ctx.force === true, action: 'ios up' });
    // Override so vale no proximo boot: desliga antes de escrever o store.
    await simctl.shutdown(udid);
    shutdownFirst = true;
  } else if (device.state !== 'Shutdown') {
    throw new DevslimError(`simulador ${device.name} (${udid}) em estado "${device.state}"; espere ficar Booted ou Shutdown`);
  } else {
    await swapGate({ exec: rt.exec, stderr: rt.stderr, force: ctx.force === true, action: 'ios up' });
  }

  // Backup antes de escrever: valor atual no store de cada label que o perfil
  // desliga e de cada ALWAYS_ENABLED que vai ser reparado (estava true).
  const current = await readStore(udid, store);
  const repaired = needsRepair(current);
  const previous = new Map<string, boolean | undefined>(desired.map((l) => [l, current.get(l)]));
  for (const l of repaired) previous.set(l, current.get(l));
  const rec = recordIosBackup(udid, { name: device.name, runtimeId: device.runtimeId, previous, profile, now: rt.date() }, { env: rt.env });

  const writes = new Map(target);
  for (const l of repaired) writes.set(l, false);
  assertManaged([...writes].filter(([, v]) => v).map(([l]) => l), managed); // true so em gerido
  assertManaged([...writes.keys()], touchable);
  const before = await mergeStore(udid, writes, store);
  const storeChanges = [...writes].filter(([l, v]) => before.get(l) !== v).length;

  const t0 = rt.now();
  await simctl.boot(udid);
  // Este up bootou (do zero ou reboot para aplicar o perfil): o device e do
  // devslim, entao `ios down` e `--idle-down` valem. Registra logo apos o boot:
  // se o bootstatus falhar, `ios down` ainda acha. Reboot de device que ja
  // estava na sessao mantem a entrada (e o registro do watcher dela).
  const inSession = wasBooted && loadSession(rt.env).some((e) => e.platform === 'ios' && e.serial.toUpperCase() === udid.toUpperCase());
  if (!inSession) {
    recordSession({ platform: 'ios', avd: device.name, serial: udid, pid: 0, port: 0, startedAt: rt.date().toISOString() }, rt.env);
  }
  await simctl.bootstatus(udid);
  const bootMs = rt.now() - t0;

  let mm = mismatches(await simctl.printDisabled(udid), verify, touchable);
  let fallback = noFallback;
  if (mm.toDisable.length > 0 || mm.toEnable.length > 0) {
    // Store offline nao pegou (todo ou parte): launchctl por label, depois reboot.
    type T = { verb: 'disable' | 'enable'; label: string };
    let pending: T[] = [
      ...mm.toDisable.map((label): T => ({ verb: 'disable', label })),
      ...mm.toEnable.map((label): T => ({ verb: 'enable', label })),
    ];
    let passes = 0;
    for (let pass = 1; pass <= FALLBACK_PASSES && pending.length > 0; pass++) {
      if (pass > 1) await rt.sleep(LAUNCHD_RETRY_DELAYS_MS[Math.min(pass - 2, LAUNCHD_RETRY_DELAYS_MS.length - 1)]);
      passes = pass;
      pending = await runPool(pending, FALLBACK_POOL, async (t) => {
        assertManaged([t.label], t.verb === 'disable' ? managed : touchable);
        const r = t.verb === 'disable' ? await simctl.launchctlDisable(udid, t.label) : await simctl.launchctlEnable(udid, t.label);
        return r.ok;
      });
    }
    await simctl.shutdown(udid);
    await bootAndWait(simctl, udid);
    mm = mismatches(await simctl.printDisabled(udid), verify, touchable);
    fallback = Object.freeze({ used: true, passes, failed: Object.freeze(pending.map((t) => t.label).sort()), rebooted: true });
  }

  const windowOpened = caps.includes('window') ? await openSimulatorApp(rt) : false;

  return Object.freeze({
    udid,
    name: device.name,
    runtime,
    profile,
    alreadySlim: false,
    wasBooted,
    shutdownFirst,
    labels: desired.length,
    storeChanges,
    backupAdded: rec.added.length,
    restored: Object.freeze(restored),
    repaired: Object.freeze(repaired),
    fallback,
    notApplied: Object.freeze(mm.toDisable),
    notRestored: Object.freeze(mm.toEnable),
    windowOpened,
    statePath: rec.path,
    bootMs,
  });
}

async function openSimulatorApp(rt: Runtime): Promise<boolean> {
  try {
    const res = await rt.exec('open', ['-a', 'Simulator'], { timeoutMs: 30_000 });
    if (res.code === 0) return true;
    rt.stderr(`devslim: aviso: open -a Simulator falhou (exit ${res.code})\n`);
  } catch (err) {
    rt.stderr(`devslim: aviso: open -a Simulator falhou (${(err as Error).message})\n`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// off

export type OffSimResult = Readonly<{
  udid: string;
  name: string;
  restored: number; // labels devolvidos ao valor salvo
  wasBooted: boolean;
  rebooted: boolean;
  ignored: readonly string[]; // entradas do state fora de touchableSet (nao tocadas)
  notRestored: readonly string[]; // conferido apos reboot (so se estava bootado)
  statePath: string;
}>;

export async function offSim(query: string, ctx: IosContext = {}): Promise<OffSimResult> {
  const { rt, simctl, store } = iosRuntime(ctx);
  const device = await simctl.findDevice(query);
  const udid = device.udid;
  const state = loadState<IosState>('ios', udid, { env: rt.env });
  if (state === null || state.backup === null || typeof state.backup !== 'object') {
    throw new DevslimError(`sem state para ${device.name} (${udid}); nada a desfazer (devslim ios up nao foi aplicado aqui)`);
  }
  const touchable = touchableSet();
  const changes = new Map<string, boolean>();
  const ignored: string[] = [];
  for (const [label, v] of Object.entries(state.backup)) {
    if (!touchable.has(label)) {
      ignored.push(label);
      continue;
    }
    if (v !== null && typeof v !== 'boolean') throw new DevslimError(`state corrompido: valor de ${label} nao e booleano nem null`);
    changes.set(label, v === true); // ausente antes = false: remover a chave nao reabilita com seguranca
  }

  const wasBooted = device.state === 'Booted';
  if (wasBooted) await simctl.shutdown(udid);
  else if (device.state !== 'Shutdown') {
    throw new DevslimError(`simulador ${device.name} (${udid}) em estado "${device.state}"; espere ficar Booted ou Shutdown`);
  }

  await mergeStore(udid, changes, store);
  const statePath = iosStatePath(udid, rt);
  clearState('ios', udid, { env: rt.env });

  let notRestored: string[] = [];
  if (wasBooted) {
    await bootAndWait(simctl, udid);
    const mm = mismatches(await simctl.printDisabled(udid), changes, touchable);
    notRestored = [...mm.toDisable, ...mm.toEnable].sort();
  }
  return Object.freeze({
    udid,
    name: device.name,
    restored: changes.size,
    wasBooted,
    rebooted: wasBooted,
    ignored: Object.freeze(ignored.sort()),
    notRestored: Object.freeze(notRestored),
    statePath,
  });
}

// ---------------------------------------------------------------------------
// down

export type DownSimOutcome = Readonly<{
  udid: string;
  name: string;
  registered: boolean;
  result: 'shutdown' | 'stale' | 'failed';
  detail?: string;
}>;

// Desliga o que a sessao subiu (`ios up` que bootou ou rebootou o device). Com nome/UDID
// fora da sessao exige --force; sem argumento e com --force, desliga tambem
// todo simulador bootado.
export async function downSim(query: string | undefined, ctx: IosContext & { force?: boolean } = {}): Promise<DownSimOutcome[]> {
  const { rt, simctl } = iosRuntime(ctx);
  const force = ctx.force === true;
  const session = loadSession(rt.env).filter((e) => e.platform === 'ios');
  const devices = await simctl.listDevices();

  type Target = { udid: string; name: string; registered: boolean; entry?: SessionEntry };
  const targets: Target[] = [];
  if (query !== undefined) {
    const dev = resolveDevice(devices, query);
    const entry = session.find((e) => e.serial === dev.udid);
    if (entry === undefined && !force) {
      throw new DevslimError(`simulador ${dev.name} (${dev.udid}) nao foi subido pelo devslim (nada na sessao); --force para desligar mesmo assim`);
    }
    targets.push({ udid: dev.udid, name: dev.name, registered: entry !== undefined, ...(entry === undefined ? {} : { entry }) });
  } else {
    for (const e of session) targets.push({ udid: e.serial, name: e.avd, registered: true, entry: e });
    if (force) {
      for (const d of devices) {
        if (d.state === 'Booted' && !targets.some((t) => t.udid === d.udid)) targets.push({ udid: d.udid, name: d.name, registered: false });
      }
    }
  }

  const out: DownSimOutcome[] = [];
  for (const { entry, ...t } of targets) {
    const drop = () => removeSession((e) => e.platform === 'ios' && e.serial === t.udid, rt.env);
    // Auto-desligar: o watcher sai antes do device (e o campo da sessao junto).
    if (entry !== undefined) await stopIdleWatcher(entry, rt);
    const dev = devices.find((d) => d.udid === t.udid);
    if (dev === undefined || dev.state === 'Shutdown') {
      drop();
      out.push(Object.freeze({ ...t, result: 'stale', detail: dev === undefined ? 'simulador nao existe mais' : 'ja estava desligado' }));
      continue;
    }
    try {
      await simctl.shutdown(t.udid);
      drop();
      out.push(Object.freeze({ ...t, result: 'shutdown' }));
    } catch (err) {
      out.push(Object.freeze({ ...t, result: 'failed', detail: (err as Error).message }));
    }
  }
  return out;
}
