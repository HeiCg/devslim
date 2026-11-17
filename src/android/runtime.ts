import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DevslimError } from '../errors.ts';
import { devslimHome, loadState, recordAndroidGuest, recordAndroidLaunch, type AndroidState } from '../state.ts';
import { portForSerial, serialForPort, type Adb, type AdbDevice } from './adb.ts';
import { avdHome, findAvd, listAvds, runningLocks, type AvdInfo } from './avd.ts';
import { resolveRuntime, type Runtime, type RuntimeContext } from './deps.ts';
import { buildLaunchArgs, SLIM_SNAPSHOT } from './launchArgs.ts';
import { imageDir, resolveImage } from './images.ts';
import { sdkRootOfTool } from './sdk.ts';
import type { BloatLevel } from './packages.ts';
import { buildAndroidProfile, PORT_MAX, PORT_MIN, type AndroidProfile } from './profile.ts';
import {
  assertSingleDevice,
  findAvdSerial,
  loadSession,
  recordSession,
  removeSession,
  runningEmulators,
  waitForExit,
  type SessionEntry,
} from './session.ts';
import { slimRunningDevice, type SlimReport } from './slim.ts';
import { tuneAvd, type TuneResult } from './tune.ts';
import { swapGate } from '../swap.ts';
import { fileSize, isSoftwareGpu, ramIncreaseLineFromLog, readEffectiveHardware } from './hardwareQemu.ts';
import { launcherFor, launcherText, type Launcher } from './launcher.ts';
import { findQemuPid } from '../measure.ts';
import { findRunningEntry, isAdvertised, scanRunning } from './runningIni.ts';
import { stopIdleWatcher } from '../idle.ts';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function slimSnapshotDir(avd: AvdInfo): string {
  return join(avd.dir, 'snapshots', SLIM_SNAPSHOT);
}

export function hasSlimSnapshot(avd: AvdInfo): boolean {
  return isDir(slimSnapshotDir(avd));
}

// First free even port from 5554 on, according to `adb devices`.
export function pickFreePort(devices: readonly AdbDevice[]): number {
  const used = new Set(devices.map((d) => portForSerial(d.serial)).filter((p): p is number => p !== null));
  for (let p = PORT_MIN; p <= PORT_MAX; p += 2) {
    if (!used.has(p) && !used.has(p + 1)) return p;
  }
  throw new DevslimError(`no free port between ${PORT_MIN} and ${PORT_MAX}`);
}

export function logFileFor(avd: string, env: Runtime['env']): string {
  return join(devslimHome(env), 'logs', `${avd}.log`);
}

type Launched = Readonly<{
  avd: string;
  serial: string;
  pid: number;
  port: number;
  fromSnapshot: boolean;
  emulatorArgs: readonly string[];
  logFile: string;
  logOffset: number; // log size before the spawn: the rest belongs to this boot
  bootMs: number;
}>;

// Guard, swap (refuses above the threshold without --force), port, detached spawn, session, waitForBoot.
async function launch(
  rt: Runtime,
  adb: Adb,
  avd: AvdInfo,
  profile: AndroidProfile,
  o: { useSnapshot: boolean; force: boolean; action: string },
): Promise<Launched> {
  const census = await assertSingleDevice({ adb, exec: rt.exec, force: o.force, action: o.action });
  // An already running device never gets here (upAvd returns earlier; bake refuses earlier).
  await swapGate({ exec: rt.exec, stderr: rt.stderr, force: o.force, action: o.action });

  let port: number;
  if (profile.port !== null) {
    port = profile.port;
    if (census.emulators.some((d) => d.serial === serialForPort(port))) {
      throw new DevslimError(`port ${port} already in use (${serialForPort(port)} in adb devices)`);
    }
  } else {
    port = pickFreePort(await adb.listDevices());
  }

  const fromSnapshot = o.useSnapshot && hasSlimSnapshot(avd);
  const emulatorArgs = buildLaunchArgs(avd.name, { ...profile, port }, fromSnapshot ? { snapshot: SLIM_SNAPSHOT } : {});
  const emulator = rt.tool('emulator');
  const logFile = logFileFor(avd.name, rt.env);
  mkdirSync(join(devslimHome(rt.env), 'logs'), { recursive: true, mode: 0o700 });

  const logOffset = fileSize(logFile);
  const t0 = rt.now();
  const { pid } = await rt.spawnDetached(emulator, emulatorArgs, { logFile, env: rt.env });
  const serial = serialForPort(port);
  // Records before boot: if the boot fails, `down` still finds the process.
  recordSession({ platform: 'android', avd: avd.name, serial, pid, port, startedAt: rt.date().toISOString() }, rt.env);
  // The -memory of this launch is the "requested" value status/doctor/plan compare
  // with the effective RAM (may differ from the profile: `up --ram X` without tune).
  try {
    recordAndroidLaunch(avd.name, { ramMb: profile.ramMb, lowRam: profile.lowRam, at: rt.date().toISOString() }, { env: rt.env });
  } catch (err) {
    rt.stderr(`devslim: warning: lastLaunch not written to the state of ${avd.name}: ${(err as Error).message}\n`);
  }
  try {
    await adb.waitForBoot(serial, { timeoutMs: rt.bootTimeoutMs, pollMs: rt.pollMs });
  } catch (err) {
    throw new DevslimError(`${(err as Error).message}; log at ${logFile}; to stop it: devslim android down ${avd.name}`);
  }
  return Object.freeze({
    avd: avd.name,
    serial,
    pid,
    port,
    fromSnapshot,
    emulatorArgs: Object.freeze(emulatorArgs),
    logFile,
    logOffset,
    bootMs: rt.now() - t0,
  });
}

// ---------------------------------------------------------------------------
// up

export type UpOptions = RuntimeContext & { force?: boolean };

export type UpResult = Readonly<{
  avd: string;
  serial: string;
  pid: number | null;
  port: number | null;
  fromSnapshot: boolean | null; // null when it was already running
  alreadyRunning: boolean;
  emulatorArgs: readonly string[];
  logFile: string | null;
  bootMs: number | null;
  // RAM the emulator used (hardware-qemu.ini; else the "Increasing RAM
  // size" line from this boot's log). null = could not tell.
  ramEffectiveMb: number | null;
  // Who launched the emulator (qemu command line; null = could not read it)
  // and the hw.gpu.mode from this boot's hardware-qemu.ini.
  launcher: Launcher | null;
  gpuEffective: string | null;
  // AVD entry in avd/running with grpc.port and grpc.token (what argent
  // requires for screenshot/tap). The token is never read outside runningIni.ts.
  advertised: boolean;
  grpcPort: number | null;
  hint?: string; // only when started without slim_base: suggests bake
}>;

// The emulator silently raises any -memory below its floor, unless
// -lowram is on (measured 2026-11-17: 2560 MB on phone, 4096 MB on a
// 2560x1600 tablet; a smaller screen does not lower the floor). lowram makes the request stick,
// but the guest then reports itself as a low-RAM device.
export function lowRamTuneHint(avd: string): string {
  return `With the AVD shut down: devslim android tune ${avd} --lowram (lowram changes app behavior: the guest reports itself as a low-RAM device)`;
}

export function ramFloorWarning(avd: string, requestedMb: number, effectiveMb: number, logLine: string | null = null, lowRam = false): string {
  const head =
    `devslim: warning: RAM requested ${requestedMb} MB, effective ${effectiveMb} MB (emulator raised it${lowRam ? ' even with lowram' : ''}; -memory ${requestedMb} does not win)` +
    `${logLine === null ? '' : `; log: "${logLine}"`}.`;
  if (lowRam) return `${head}\n`;
  return `${head} The emulator ignores -memory below its floor unless lowram is on. ${lowRamTuneHint(avd)}\n`;
}

// AVD already running, launched by something else (argent, Studio) or with a software GPU.
export function offProfileWarning(
  avd: string,
  o: { pid: number | null; launcher: Launcher | null; gpuEffective: string | null; ramEffectiveMb: number | null },
): string {
  const facts = [`pid ${o.pid ?? '?'}`];
  if (o.launcher !== null) facts.push(launcherText(o.launcher));
  if (o.gpuEffective !== null) facts.push(`effective gpu ${o.gpuEffective}${isSoftwareGpu(o.gpuEffective) ? ' (software)' : ''}`);
  if (o.ramEffectiveMb !== null) facts.push(`effective ram ${o.ramEffectiveMb} MB`);
  return (
    `devslim: warning: AVD ${avd} is already running outside the profile (${facts.join(', ')}); nothing started, nothing shut down. ` +
    `To start it on the profile: devslim android down ${avd} --force and then devslim android up ${avd}\n`
  );
}

// Maximum wait for the running ini after boot; the emulator writes it as soon as the
// gRPC server starts, usually before sys.boot_completed.
export const ADVERTISE_TIMEOUT_MS = 10_000;
export const ADVERTISE_POLL_MS = 500;

export function notAdvertisedWarning(dir: string | null): string {
  return (
    `devslim: warning: emulator did not advertise itself in ${dir ?? '(advertisement directory unknown on this platform)'}: ` +
    'tools that rely on gRPC (argent screenshot/tap) will not see it; adb works normally\n'
  );
}

// Looks up the AVD entry (name + console port). `wait`: up to
// ADVERTISE_TIMEOUT_MS for it to show up advertised; otherwise a single read.
async function findAdvertisement(
  rt: Runtime,
  avd: string,
  port: number | null,
  wait: boolean,
): Promise<{ advertised: boolean; grpcPort: number | null }> {
  const deadline = rt.now() + ADVERTISE_TIMEOUT_MS;
  for (;;) {
    const e = findRunningEntry(scanRunning(rt.runningDir, rt.pidAlive).live, avd, port);
    if (isAdvertised(e) || !wait || rt.runningDir === null || rt.now() >= deadline) {
      return { advertised: isAdvertised(e), grpcPort: e?.grpcPort ?? null };
    }
    await rt.sleep(ADVERTISE_POLL_MS);
  }
}

export function bakeHint(avd: string): string {
  return `tip: started without the slim_base snapshot; run devslim android bake ${avd} once (with the AVD shut down) so later ups start from an already slim guest`;
}

export async function upAvd(avdName: string, profile: AndroidProfile, opts: UpOptions = {}): Promise<UpResult> {
  const rt = resolveRuntime(opts);
  const avd = findAvd(avdName, { env: rt.env });
  const adb = rt.adb();

  const existing = await findAvdSerial(adb, avd.name);
  if (existing !== null) {
    const entry = loadSession(rt.env).find((e) => e.platform === 'android' && e.serial === existing && e.avd === avd.name);
    // Command line without adb: qemu pid (pgrep), else the session one; then ps.
    const qemuPid = await findQemuPid(avd.name, { exec: rt.exec, sessionPid: entry?.pid ?? null });
    const { launcher } = await launcherFor(avd.name, { exec: rt.exec, pid: qemuPid, inSession: entry !== undefined });
    const hw = readEffectiveHardware(avd.dir);
    const gpuEffective = hw?.gpu ?? null;
    const ramEffectiveMb = hw?.ramMb ?? null;
    const pid = entry?.pid ?? qemuPid;
    if ((launcher !== null && launcher !== 'devslim') || (gpuEffective !== null && isSoftwareGpu(gpuEffective))) {
      rt.stderr(offProfileWarning(avd.name, { pid, launcher, gpuEffective, ramEffectiveMb }));
    }
    // Already running: just records what is in the running dir, without waiting or warning.
    const ad = await findAdvertisement(rt, avd.name, portForSerial(existing), false);
    return Object.freeze({
      avd: avd.name,
      serial: existing,
      pid,
      port: portForSerial(existing),
      fromSnapshot: null,
      alreadyRunning: true,
      emulatorArgs: Object.freeze([]),
      logFile: null,
      bootMs: null,
      ramEffectiveMb,
      launcher,
      gpuEffective,
      advertised: ad.advertised,
      grpcPort: ad.grpcPort,
    });
  }
  const locks = runningLocks(avd.dir);
  if (locks.length > 0 && !opts.force) {
    throw new DevslimError(`AVD ${avd.name} has locks (${locks.join(', ')}) but does not show up in adb; check for a stuck emulator (--force to ignore)`);
  }

  const l = await launch(rt, adb, avd, profile, { useSnapshot: true, force: opts.force === true, action: 'up' });
  const hw = readEffectiveHardware(avd.dir);
  const logHit = ramIncreaseLineFromLog(l.logFile, l.logOffset);
  const ramEffectiveMb = hw?.ramMb ?? logHit?.mb ?? null;
  if (ramEffectiveMb !== null && ramEffectiveMb > profile.ramMb) {
    rt.stderr(ramFloorWarning(avd.name, profile.ramMb, ramEffectiveMb, logHit?.line ?? null, profile.lowRam));
  }
  const grpc = profile.grpc !== false;
  const ad = await findAdvertisement(rt, avd.name, l.port, grpc);
  if (grpc && !ad.advertised) rt.stderr(notAdvertisedWarning(rt.runningDir));
  return Object.freeze({
    avd: l.avd,
    serial: l.serial,
    pid: l.pid,
    port: l.port,
    fromSnapshot: l.fromSnapshot,
    alreadyRunning: false,
    emulatorArgs: l.emulatorArgs,
    logFile: l.logFile,
    bootMs: l.bootMs,
    ramEffectiveMb,
    launcher: 'devslim',
    gpuEffective: hw?.gpu ?? null,
    advertised: ad.advertised,
    grpcPort: ad.grpcPort,
    ...(l.fromSnapshot ? {} : { hint: bakeHint(avd.name) }),
  });
}

// ---------------------------------------------------------------------------
// bake

export type BakeOptions = RuntimeContext & { force?: boolean; level?: BloatLevel };

export type BakeResult = Readonly<{
  avd: string;
  serial: string;
  pid: number;
  port: number;
  level: BloatLevel;
  emulatorArgs: readonly string[];
  logFile: string;
  snapshot: string;
  slim: SlimReport;
  statePath: string;
  lingeringLocks: readonly string[];
  timings: Readonly<{ bootMs: number; slimMs: number; snapshotMs: number; shutdownMs: number; totalMs: number }>;
}>;

export async function bakeAvd(avdName: string, profile: AndroidProfile, opts: BakeOptions = {}): Promise<BakeResult> {
  const rt = resolveRuntime(opts);
  const avd = findAvd(avdName, { env: rt.env });
  const state = loadState<AndroidState>('android', avd.name, { env: rt.env });
  if (state === null || typeof state.originalConfigIni !== 'string') {
    throw new DevslimError(`AVD ${avd.name} has not been tuned yet; run first: devslim android tune ${avd.name}`);
  }
  const adb = rt.adb();
  const running = await findAvdSerial(adb, avd.name);
  if (running !== null) {
    throw new DevslimError(`AVD ${avd.name} is running (${running}); shut it down before bake: devslim android down ${avd.name}`);
  }
  const locks = runningLocks(avd.dir);
  if (locks.length > 0) {
    throw new DevslimError(`AVD ${avd.name} seems to be running (${locks.join(', ')}); shut it down before bake`);
  }
  const level = opts.level ?? 'standard';

  const tStart = rt.now();
  const l = await launch(rt, adb, avd, profile, { useSnapshot: false, force: opts.force === true, action: 'bake' });

  let slim: SlimReport;
  let statePath: string;
  let tSlim: number;
  let tSnap: number;
  try {
    const t1 = rt.now();
    slim = await slimRunningDevice(l.serial, {
      adb,
      level,
      capabilities: profile.capabilities,
      prior: { disabledPackages: state.disabledPackages ?? [], settings: state.settings ?? [] },
    });
    tSlim = rt.now() - t1;
    // State before the snapshot: what changed in the guest is recorded right away.
    statePath = recordAndroidGuest(
      avd.name,
      { disabledPackages: slim.disabledPackages, settings: slim.savedSettings, bakedAt: rt.date(), now: rt.date() },
      { env: rt.env },
    ).path;
    const t2 = rt.now();
    await adb.snapshotSave(l.serial, SLIM_SNAPSHOT);
    tSnap = rt.now() - t2;
  } catch (err) {
    // Do not leave the bake emulator alive eating RAM.
    try {
      await adb.emuKill(l.serial);
      removeSession((e) => e.serial === l.serial, rt.env);
    } catch { /* session stays recorded for down */ }
    throw err;
  }

  const t3 = rt.now();
  await adb.emuKill(l.serial);
  const exit = await waitForExit({
    adb,
    serial: l.serial,
    avdDir: avd.dir,
    sleep: rt.sleep,
    now: rt.now,
    timeoutMs: rt.exitTimeoutMs,
    pollMs: rt.pollMs,
  });
  removeSession((e) => e.serial === l.serial, rt.env);
  const tShutdown = rt.now() - t3;

  return Object.freeze({
    avd: avd.name,
    serial: l.serial,
    pid: l.pid,
    port: l.port,
    level,
    emulatorArgs: l.emulatorArgs,
    logFile: l.logFile,
    snapshot: SLIM_SNAPSHOT,
    slim,
    statePath,
    lingeringLocks: Object.freeze(exit.lingeringLocks),
    timings: Object.freeze({ bootMs: l.bootMs, slimMs: tSlim, snapshotMs: tSnap, shutdownMs: tShutdown, totalMs: rt.now() - tStart }),
  });
}

// ---------------------------------------------------------------------------
// down

export type DownOutcome = Readonly<{
  avd: string;
  serial: string;
  registered: boolean;
  result: 'killed' | 'stale' | 'skipped' | 'failed';
  detail?: string;
}>;

export async function downAvd(avdName: string | undefined, opts: RuntimeContext & { force?: boolean } = {}): Promise<DownOutcome[]> {
  const rt = resolveRuntime(opts);
  const force = opts.force === true;
  const adb = rt.adb();
  const session = loadSession(rt.env).filter((e) => e.platform === 'android');

  type Target = { avd: string; serial: string; registered: boolean; entry?: SessionEntry };
  const targets: Target[] = [];
  if (avdName !== undefined) {
    if (!NAME_RE.test(avdName)) throw new DevslimError(`invalid AVD name: ${avdName}`);
    const entry = session.find((e) => e.avd === avdName);
    if (entry !== undefined) targets.push({ avd: entry.avd, serial: entry.serial, registered: true, entry });
    else if (!force) {
      throw new DevslimError(`AVD ${avdName} was not started by devslim (nothing in the session); --force to shut it down anyway`);
    } else {
      const serial = await findAvdSerial(adb, avdName);
      if (serial === null) throw new DevslimError(`AVD ${avdName} is not running`);
      targets.push({ avd: avdName, serial, registered: false });
    }
  } else {
    for (const e of session) targets.push({ avd: e.avd, serial: e.serial, registered: true, entry: e });
    if (force) {
      for (const dev of await runningEmulators(adb)) {
        if (targets.some((t) => t.serial === dev.serial)) continue;
        targets.push({ avd: (await adb.avdName(dev.serial)) ?? '?', serial: dev.serial, registered: false });
      }
    }
  }

  const out: DownOutcome[] = [];
  for (const { entry, ...t } of targets) {
    const drop = () => removeSession((e: SessionEntry) => e.platform === 'android' && e.serial === t.serial, rt.env);
    // Idle-down: the watcher goes before the device (along with the session field).
    if (entry !== undefined) await stopIdleWatcher(entry, rt);
    const present = (await adb.listDevices()).some((d) => d.serial === t.serial);
    if (!present) {
      drop();
      out.push(Object.freeze({ ...t, result: 'stale', detail: 'was no longer in adb devices' }));
      continue;
    }
    if (!force) {
      const name = await adb.avdName(t.serial);
      if (name !== t.avd) {
        drop(); // the serial now belongs to another emulator: not ours
        out.push(Object.freeze({ ...t, result: 'skipped', detail: `${t.serial} now runs ${name ?? '(unknown)'}; left alone` }));
        continue;
      }
    }
    try {
      await adb.emuKill(t.serial);
      await adb.waitForGone(t.serial, { timeoutMs: rt.exitTimeoutMs, pollMs: rt.pollMs });
      drop();
      out.push(Object.freeze({ ...t, result: 'killed' }));
    } catch (err) {
      out.push(Object.freeze({ ...t, result: 'failed', detail: (err as Error).message }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// create

// Id of the default shortcut (google_apis) on an arm64 host; elsewhere the ABI is x86_64.
export const DEFAULT_IMAGE = 'system-images;android-35;google_apis;arm64-v8a';
export const DEFAULT_DEVICE = 'pixel_7';
export const CREATE_SCREEN = '720x1600@320';

export type CreateResult = Readonly<{ avd: string; image: string; device: string; tune: TuneResult }>;

// Creates the AVD (without booting) and applies the default tune with a 720x1600@320 screen.
// `image`: full id or shortcut (google_apis, google_atd, aosp_atd, default)
// expanded with `api` (default 35) and the host ABI. The image must be in the
// SDK; missing = error with the sdkmanager command, never downloads on its own.
export async function createAvd(
  name: string,
  o: RuntimeContext & { image?: string; api?: number; device?: string } = {},
): Promise<CreateResult> {
  const rt = resolveRuntime(o);
  if (!NAME_RE.test(name)) throw new DevslimError(`invalid AVD name: ${name}`);
  const home = avdHome(rt.env);
  if (listAvds(rt.env).includes(name) || existsSync(join(home, `${name}.avd`))) {
    throw new DevslimError(`AVD ${name} already exists in ${home}`);
  }
  const image = resolveImage(o.image, { api: o.api, arch: rt.arch });
  const device = o.device ?? DEFAULT_DEVICE;
  const avdmanager = rt.tool('avdmanager');
  const dir = imageDir(sdkRootOfTool(avdmanager, 'avdmanager'), image);
  if (!rt.dirExists(dir)) {
    throw new DevslimError(`image ${image} not installed (missing ${dir}); install it with: sdkmanager "${image}" and run create again`);
  }
  // Answers "no" to "Do you wish to create a custom hardware profile?".
  const res = await rt.exec(avdmanager, ['create', 'avd', '-n', name, '-k', image, '-d', device], {
    input: 'no\n',
    env: rt.env,
    timeoutMs: 180_000,
  });
  if (res.code !== 0) {
    const why = (res.stderr + '\n' + res.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new DevslimError(`avdmanager create avd ${name} failed (exit ${res.code}): ${why || '(no output)'}`);
  }
  const tune = tuneAvd(name, buildAndroidProfile({ screen: CREATE_SCREEN }), { env: rt.env, now: rt.date() });
  return Object.freeze({ avd: name, image, device, tune });
}
