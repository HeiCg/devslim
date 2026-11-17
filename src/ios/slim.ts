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

// Slimming an iOS simulator: mark managed launchd labels as disabled in the
// device disabled.plist (with it shut down), boot and verify with
// `launchctl print-disabled`. The shared runtime is never touched.
// Invariant: every diff, compared read and write considers only
// managedSet() (disable/restore) and repairSet() (re-enable/restore); nothing outside
// touchableSet() is touched, and no repairSet() label is ever disabled.

export const MIN_IOS_VERSION = Object.freeze([18, 5] as const);
export const FALLBACK_POOL = 8;
export const FALLBACK_PASSES = 3;

// `storeBase`: disabled.plist base (default /private/var/tmp).
// bootTimeoutMs -> bootstatus; exitTimeoutMs -> shutdown wait; pollMs -> shutdown poll.
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

// Gate: iOS only, and only >= 18.5 (before that launchd_sim does not persist overrides).
export function checkIosRuntime(runtime: RuntimeInfo): RuntimeInfo {
  if (runtime.platform !== 'iOS') {
    throw new DevslimError(`runtime ${runtime.platform} ${runtime.version} out of scope: devslim ios only handles iOS simulators`);
  }
  if (!/^\d+(\.\d+)*$/.test(runtime.version) || compareVersion(runtime.version, MIN_IOS_VERSION) < 0) {
    throw new DevslimError(
      `iOS ${runtime.version} not supported: requires iOS ${MIN_IOS_VERSION.join('.')} or newer (older versions do not keep launchd overrides across boots)`,
    );
  }
  return runtime;
}

async function runtimeOf(simctl: Simctl, device: SimDevice): Promise<RuntimeInfo> {
  let found: RuntimeInfo | undefined;
  try {
    found = (await simctl.listRuntimes()).find((r) => r.identifier === device.runtimeId);
  } catch {
    found = undefined; // fall back to parsing the identifier
  }
  if (found !== undefined) return Object.freeze({ identifier: found.identifier, platform: found.platform, version: found.version });
  const parsed = parseRuntimeId(device.runtimeId);
  if (parsed === null) throw new DevslimError(`unknown runtime for ${device.name}: ${device.runtimeId}`);
  return Object.freeze({ identifier: device.runtimeId, ...parsed });
}

function iosStatePath(udid: string, rt: Runtime): string {
  return stateFile('ios', udid, { env: rt.env });
}

function assertManaged(labels: Iterable<string>, managed: ReadonlySet<string>): void {
  for (const l of labels) {
    if (!managed.has(l)) throw new DevslimError(`internal: label outside the managed list: ${l}`);
  }
}

// repairSet() labels the store has disabled (true): `up` writes false.
function needsRepair(current: ReadonlyMap<string, boolean>): string[] {
  return [...repairSet()].filter((l) => current.get(l) === true).sort();
}

// Store/launchd target: profile labels -> true; labels we touched before
// (backup) that the profile no longer disables -> saved value (absent = false).
function targetMap(desired: readonly string[], backup: IosState['backup'] | undefined, managed: ReadonlySet<string>): Map<string, boolean> {
  const target = new Map<string, boolean>();
  for (const l of desired) target.set(l, true);
  for (const [l, v] of Object.entries(backup ?? {})) {
    if (!managed.has(l) || target.has(l)) continue;
    target.set(l, v === true);
  }
  return target;
}

// What the live launchd does not reflect from the target yet (touchableSet() labels only).
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

// Pool of `limit` workers; returns the items whose fn failed (false or exception).
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
// plan (no side effects: only simctl list and a store read)

export type SimPlan = Readonly<{
  udid: string;
  name: string;
  state: string;
  runtime: RuntimeInfo;
  profile: IosProfileRecord;
  labels: readonly string[];
  managedTotal: number;
  alreadyInStore: number;
  repair: readonly string[]; // ALWAYS_ENABLED disabled in the store that up re-enables
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
  storeChanges: number; // disabled.plist entries that changed
  backupAdded: number; // new labels in the state backup (first backup wins)
  restored: readonly string[]; // managed labels the profile no longer disables, returned to the saved value
  repaired: readonly string[]; // ALWAYS_ENABLED that were disabled in the store and were written as enabled
  fallback: FallbackReport;
  notApplied: readonly string[]; // should be disabled and are not
  notRestored: readonly string[]; // should be enabled and are not
  windowOpened: boolean;
  statePath: string | null;
  bootMs: number | null;
}>;

async function guardAdb(rt: Runtime): Promise<Adb | null> {
  try {
    return rt.adb();
  } catch (err) {
    if (err instanceof DevslimError) return null; // no Android SDK: no emulator to count
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
  // Verification: besides the target, every ALWAYS_ENABLED must show as enabled.
  const verify = new Map(target);
  for (const l of repairSet()) verify.set(l, false);
  const noFallback: FallbackReport = Object.freeze({ used: false, passes: 0, failed: Object.freeze([]), rebooted: false });

  const wasBooted = device.state === 'Booted';
  let shutdownFirst = false;
  if (wasBooted) {
    await simctl.bootstatus(udid); // `Booted` shows up early in the boot; wait for launchd
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
    // About to reboot: counts as a boot for the swap guard.
    await swapGate({ exec: rt.exec, stderr: rt.stderr, force: ctx.force === true, action: 'ios up' });
    // Overrides only apply on the next boot: shut down before writing the store.
    await simctl.shutdown(udid);
    shutdownFirst = true;
  } else if (device.state !== 'Shutdown') {
    throw new DevslimError(`simulator ${device.name} (${udid}) in state "${device.state}"; wait until it is Booted or Shutdown`);
  } else {
    await swapGate({ exec: rt.exec, stderr: rt.stderr, force: ctx.force === true, action: 'ios up' });
  }

  // Backup before writing: current store value of each label the profile
  // disables and of each ALWAYS_ENABLED about to be repaired (was true).
  const current = await readStore(udid, store);
  const repaired = needsRepair(current);
  const previous = new Map<string, boolean | undefined>(desired.map((l) => [l, current.get(l)]));
  for (const l of repaired) previous.set(l, current.get(l));
  const rec = recordIosBackup(udid, { name: device.name, runtimeId: device.runtimeId, previous, profile, now: rt.date() }, { env: rt.env });

  const writes = new Map(target);
  for (const l of repaired) writes.set(l, false);
  assertManaged([...writes].filter(([, v]) => v).map(([l]) => l), managed); // true only for managed
  assertManaged([...writes.keys()], touchable);
  const before = await mergeStore(udid, writes, store);
  const storeChanges = [...writes].filter(([l, v]) => before.get(l) !== v).length;

  const t0 = rt.now();
  await simctl.boot(udid);
  // This up booted (from scratch or a reboot to apply the profile): the device belongs to
  // devslim, so `ios down` and `--idle-down` apply. Records right after boot:
  // if bootstatus fails, `ios down` still finds it. Rebooting a device already
  // in the session keeps the entry (and its watcher record).
  const inSession = wasBooted && loadSession(rt.env).some((e) => e.platform === 'ios' && e.serial.toUpperCase() === udid.toUpperCase());
  if (!inSession) {
    recordSession({ platform: 'ios', avd: device.name, serial: udid, pid: 0, port: 0, startedAt: rt.date().toISOString() }, rt.env);
  }
  await simctl.bootstatus(udid);
  const bootMs = rt.now() - t0;

  let mm = mismatches(await simctl.printDisabled(udid), verify, touchable);
  let fallback = noFallback;
  if (mm.toDisable.length > 0 || mm.toEnable.length > 0) {
    // The offline store did not take (fully or partly): launchctl per label, then reboot.
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
    rt.stderr(`devslim: warning: open -a Simulator failed (exit ${res.code})\n`);
  } catch (err) {
    rt.stderr(`devslim: warning: open -a Simulator failed (${(err as Error).message})\n`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// off

export type OffSimResult = Readonly<{
  udid: string;
  name: string;
  restored: number; // labels returned to the saved value
  wasBooted: boolean;
  rebooted: boolean;
  ignored: readonly string[]; // state entries outside touchableSet (not touched)
  notRestored: readonly string[]; // checked after reboot (only if it was booted)
  statePath: string;
}>;

export async function offSim(query: string, ctx: IosContext = {}): Promise<OffSimResult> {
  const { rt, simctl, store } = iosRuntime(ctx);
  const device = await simctl.findDevice(query);
  const udid = device.udid;
  const state = loadState<IosState>('ios', udid, { env: rt.env });
  if (state === null || state.backup === null || typeof state.backup !== 'object') {
    throw new DevslimError(`no state for ${device.name} (${udid}); nothing to undo (devslim ios up was not applied here)`);
  }
  const touchable = touchableSet();
  const changes = new Map<string, boolean>();
  const ignored: string[] = [];
  for (const [label, v] of Object.entries(state.backup)) {
    if (!touchable.has(label)) {
      ignored.push(label);
      continue;
    }
    if (v !== null && typeof v !== 'boolean') throw new DevslimError(`corrupt state: value of ${label} is neither boolean nor null`);
    changes.set(label, v === true); // absent before = false: removing the key does not reliably re-enable
  }

  const wasBooted = device.state === 'Booted';
  if (wasBooted) await simctl.shutdown(udid);
  else if (device.state !== 'Shutdown') {
    throw new DevslimError(`simulator ${device.name} (${udid}) in state "${device.state}"; wait until it is Booted or Shutdown`);
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

// Shuts down what the session started (`ios up` that booted or rebooted the device). A name/UDID
// outside the session requires --force; with no argument and --force, also shuts down
// every booted simulator.
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
      throw new DevslimError(`simulator ${dev.name} (${dev.udid}) was not started by devslim (nothing in the session); --force to shut it down anyway`);
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
    // Idle-down: the watcher goes before the device (along with the session field).
    if (entry !== undefined) await stopIdleWatcher(entry, rt);
    const dev = devices.find((d) => d.udid === t.udid);
    if (dev === undefined || dev.state === 'Shutdown') {
      drop();
      out.push(Object.freeze({ ...t, result: 'stale', detail: dev === undefined ? 'simulator no longer exists' : 'was already shut down' }));
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
