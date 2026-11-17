import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { resolveCapabilities } from './capabilities.ts';
import { bytesToMb, sizeText } from './dirSize.ts';
import { DevslimError, UsageError } from './errors.ts';
import { resolveRuntime, type RuntimeContext } from './android/deps.ts';
import { findAvd, type AvdInfo } from './android/avd.ts';
import { getValue, parseIni } from './android/configIni.ts';
import { lastBootRaise, parseRamMb, ramFloorNote } from './android/hardwareQemu.ts';
import { IMAGE_SHORTCUTS } from './android/images.ts';
import { buildAndroidProfile, formatScreen, type AndroidProfile, type AndroidProfileOptions } from './android/profile.ts';
import { grpcPortFor, GRPC_REFERENCE_PORT } from './android/launchArgs.ts';
import { bakeAvd, createAvd, downAvd, upAvd, type BakeResult } from './android/runtime.ts';
import { planTune, restoreAvd, tuneAvd, type TunePlan } from './android/tune.ts';
import { measureAvd, measureSim, type AndroidMeasurement, type IosMeasurement } from './measure.ts';
import { loadState, requestedRamMb, type AndroidState } from './state.ts';
import { ALWAYS_ENABLED, CAPABILITY_KEEPS, CATEGORIES, CATEGORY_BREAKS, CATEGORY_IDS, managedSet } from './ios/labels.ts';
import { downSim, offSim, planSim, upSim, type IosContext, type IosSlimOptions, type SimPlan, type UpSimResult } from './ios/slim.ts';
import { doctorExitCode, doctorText, runDoctor } from './doctor.ts';
import { collectStatus, statusText } from './status.ts';
import { downAll, measureAll, pruneSession, type PruneOutcome } from './topLevel.ts';
import { forgetAvd, forgetSim, type ForgetResult } from './orphans.ts';
import { IDLE_MIN_MS, IDLE_WATCH_CMD, IOS_ALREADY_SLIM_REASON, idleSkippedWarning, idleUpLine, parseIdleDuration, startIdleWatcher, type IdleWatcherInfo } from './idle.ts';
import { runIdleWatch } from './idleWatch.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Env;
  cwd: string;
  // Test injection (exec, spawnDetached, sleep, clock, iOS store base). Absent = real.
  runtime?: Omit<IosContext, 'env' | 'stderr'>;
};

export const HELP = `devslim ${pkg.version}: lean Android emulator and iOS simulator

usage:
  devslim status [--json]                what is booted, applied profile, drift, session and swap (read-only, no adb)
  devslim doctor [--json]                environment checks (Xcode, SDK, emulator, AVDs, argent, swap, orphan state);
                                         exit 1 on any fail
  devslim down [--force] [--json]        shuts down everything the session started (Android and iOS); drops dead entries without killing
  devslim prune [--json]                 drops session entries for devices no longer running (and their idle-down);
                                         shuts nothing down and deletes no state: down stops live devices, prune only cleans records
  devslim measure [--json]               measures every running emulator and simulator (array; empty if nothing runs)

  devslim android plan <avd> [flags]     shows config.ini changes and the emulator command line (writes nothing)
  devslim android tune <avd> [flags]     saves state, rewrites config.ini, deletes hardware-qemu.ini and snapshots/
  devslim android create <name> [--image I] [--api N] [--device D]
                                         creates the AVD (avdmanager) and applies tune with a 720x1600@320 screen; does not boot;
                                         the system image must be installed (otherwise prints the sdkmanager command)
  devslim android up <avd> [flags] [--force] [--idle-down D]
                                         boots from the slim_base snapshot (if any) with lean flags; warns if the
                                         emulator raised the requested RAM, if the AVD already runs outside the profile (argent,
                                         software GPU) and suggests bake when there is no slim_base
  devslim android bake <avd> [--aggressive] [--need a,b] [--for <dir>] [--no-grpc|--grpc]
                         [--lowram|--no-lowram] [--force]
                                         cold boots, slims down via adb, saves the slim_base snapshot and shuts down
  devslim android down [<avd>] [--force] shuts down what devslim started (--force: any emulator)
  devslim android restore <avd> [--config-only]
                                         undoes packages/settings in the guest (AVD running) and restores config.ini
  devslim android measure <avd> [--json] phys_footprint, footprint header and qemu RSS on the host; memory and processes in the guest
  devslim android forget <avd> [--force] [--json]
                                         deletes the state (and the session entry) of an AVD that no longer exists; never touches the
                                         device; existing AVD: use restore (--force deletes the record anyway)

  devslim ios plan <udid|name> [ios flags]
                                         labels that up would disable and how many are already in the store (writes nothing)
  devslim ios up <udid|name> [ios flags] [--force] [--idle-down D]
                                         disables launchd labels in the device disabled.plist and boots; exit 3 if any did not stick
  devslim ios off <udid|name> [--json]   returns each label to its saved value and clears the state (reboots if it was booted)
  devslim ios down [<udid|name>] [--force] [--json]
                                         shuts down what devslim started (--force: any booted simulator)
  devslim ios measure <udid|name> [--json]
                                         processes, phys_footprint and %cpu of the launchd_sim tree
  devslim ios forget <udid|name> [--force] [--json]
                                         deletes the state (and the session entry) of a simulator that no longer exists; never
                                         touches the device; existing simulator: use ios off (--force deletes anyway)
  devslim ios categories [--json]        label categories, label counts and what breaks
  devslim --help | --version

plan/tune/up flags (inherit the tune profile; flags override it):
  --ram N          RAM in MB (1536..8192, default 2048); below the emulator floor (seen: 2560 MB
                   on phone, 4096 MB on tablet) it raises the request silently, unless --lowram
  --aggressive     RAM 1536 + -lowram
  --lowram         passes -lowram without changing RAM: the requested -memory is honored, but the guest
                   reports itself as a low-RAM device (changes app behavior); also applies to bake
  --no-lowram      drops the lowram saved by tune or set by --aggressive; conflicts with --lowram
  --gpu M          GPU mode (default host)
  --vulkan         re-enables Vulkan in the guest (no -feature -Vulkan)
  --screen S       keep (default) or WxH@dpi, e.g. 720x1600@320
  --port N         even port between 5554 and 5682 (serial emulator-N); gRPC on 8554 + (N - 5554)
  --no-grpc        launches without -grpc <port> -grpc-use-token (the emulator does not write the running ini
                   argent uses for screenshot/tap); also applies to bake
  --grpc           re-enables gRPC when tune saved --no-grpc (overrides the saved profile);
                   also applies to bake; conflicts with --no-grpc
  --need a,b       capabilities: audio, camera, keyboard, location, push, store, weblogin, window;
                   replaces the tune ones; --need none clears them; keyboard keeps Gboard in bake --aggressive
                   (without it text still arrives via adb/argent input, but you cannot test layouts that move
                   around the keyboard); keyboard, store and window never come from --for
  --for <dir>      derives capabilities from the app package.json (also replaces the tune ones)
  --reset          plan/tune: ignores the saved profile and starts from the defaults
  --json           JSON output

other flags:
  --force          up/bake/ios up: skips the one-device-at-a-time guard and the refusal at swap above 95%;
                   down: kills what devslim did not start; forget: deletes the record even if the device exists
  --idle-down D    android up/ios up: shuts the device down after D with no third-party app in the foreground
                   (30m, 90s, 1h or minutes; minimum 2m); a detached process checks every 30 s;
                   only for devices devslim started; not saved in the profile
  --aggressive     bake: also disables the aggressive list (Play Store, setup wizards, Gboard)
  --config-only    restore: config.ini only; guest packages/settings stay pending in the state
  --image I        create: shortcut google_apis, google_atd, aosp_atd, default (becomes
                   system-images;android-<api>;<tag>;<abi>, host ABI) or the full id; default google_apis
                   ATD = no Google services (aosp_atd) or reduced services (google_atd): lighter;
                   aosp_atd: no Google sign-in, FCM push or Play Billing purchases. ATD for UI and
                   logic tests; google_apis when the test needs sign-in, push or purchases
  --api N          create: API for the image shortcut (default 35); conflicts with a full id
  --device D       create: default pixel_7

ios flags (plan/up):
  --need a,b       capabilities (push, store, weblogin, camera, location re-enable labels; window opens Simulator.app;
                   audio and keyboard change nothing on iOS)
  --for <dir>      derives capabilities from the app package.json
  --except c,c     keeps whole categories enabled (see ios categories)
  --keep l,l       keeps individual labels enabled
  --json           JSON output
  the default profile breaks push, StoreKit, universal links and Apple ID sign-in; iOS 18.5+ only

environment: ANDROID_HOME/ANDROID_SDK_ROOT (SDK, default ~/Library/Android/sdk),
             ANDROID_AVD_HOME (AVDs), DEVSLIM_HOME (state and logs, default ~/.devslim)
`;

type FlagSpec = Readonly<Record<string, 'value' | 'multi' | 'bool'>>;
type Parsed = { positionals: string[]; values: Record<string, string>; multi: Record<string, string[]>; bools: Set<string> };

const PROFILE_FLAGS: FlagSpec = Object.freeze({
  ram: 'value',
  aggressive: 'bool',
  gpu: 'value',
  vulkan: 'bool',
  screen: 'value',
  port: 'value',
  need: 'multi',
  for: 'value',
  'no-grpc': 'bool',
  grpc: 'bool',
  lowram: 'bool',
  'no-lowram': 'bool',
  json: 'bool',
});
const TUNE_FLAGS: FlagSpec = Object.freeze({ ...PROFILE_FLAGS, reset: 'bool' });
const RESTORE_FLAGS: FlagSpec = Object.freeze({ json: 'bool', 'config-only': 'bool' });
const UP_FLAGS: FlagSpec = Object.freeze({ ...PROFILE_FLAGS, force: 'bool', 'idle-down': 'value' });
const BAKE_FLAGS: FlagSpec = Object.freeze({
  aggressive: 'bool',
  need: 'multi',
  for: 'value',
  'no-grpc': 'bool',
  grpc: 'bool',
  lowram: 'bool',
  'no-lowram': 'bool',
  force: 'bool',
  json: 'bool',
});
const DOWN_FLAGS: FlagSpec = Object.freeze({ force: 'bool', json: 'bool' });
const MEASURE_FLAGS: FlagSpec = Object.freeze({ json: 'bool' });
const CREATE_FLAGS: FlagSpec = Object.freeze({ image: 'value', api: 'value', device: 'value', json: 'bool' });
const FORGET_FLAGS: FlagSpec = Object.freeze({ force: 'bool', json: 'bool' });

// Output of `android forget` / `ios forget`: what was removed, plus a warning when
// the device still exists (--force) or could not be checked.
function forgetText(r: ForgetResult): string[] {
  const kind = r.platform === 'android' ? 'AVD' : 'simulator';
  const what = r.platform === 'android' ? `AVD ${r.name}` : `simulator ${r.name} (${r.id})`;
  const lines = [r.removedState ? `state removed: ${r.statePath}` : `state: none (${r.statePath})`];
  if (r.removedSession.length > 0) lines.push(`session: entry ${r.removedSession.map((e) => e.serial).join(', ')} removed`);
  if (r.deviceExists === true) lines.push(`${what} still exists; only the devslim records were removed (--force), the ${kind} was not touched`);
  else if (r.deviceExists === null) lines.push(`could not check whether ${what} exists; only the devslim records were removed (--force)`);
  return lines;
}

function parseFlags(args: readonly string[], spec: FlagSpec): Parsed {
  const out: Parsed = { positionals: [], values: {}, multi: {}, bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`unknown flag: --${name}`);
    if (kind === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      out.bools.add(name);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else value = args[++i];
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      throw new UsageError(`--${name} requires a value`);
    }
    if (kind === 'multi') (out.multi[name] ??= []).push(value);
    else if (name in out.values) throw new UsageError(`--${name} given more than once`);
    else out.values[name] = value;
  }
  return out;
}

function intFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} requires an integer, got: ${value}`);
  return Number(value);
}

function oneAvd(p: Parsed, sub: string): string {
  if (p.positionals.length === 0) throw new UsageError(`android ${sub}: missing AVD name`);
  if (p.positionals.length > 1) throw new UsageError(`android ${sub}: extra argument: ${p.positionals[1]}`);
  return p.positionals[0];
}

// `--need none` = empty list (clears what tune saved); cannot be combined with others.
function needFlag(p: Parsed): string[] | undefined {
  const need = p.multi.need;
  if (need === undefined) return undefined;
  const list = need.flatMap((v) => v.split(',')).map((s) => s.trim()).filter((s) => s !== '');
  if (!list.includes('none')) return need;
  if (list.length > 1) throw new UsageError('--need none cannot be combined with other capabilities');
  return [];
}

type ResolvedProfile = { profile: AndroidProfile; inherited: boolean };

// Single profile path for plan/tune/up/bake: the tune profile (state) is the base
// and the given flags override it; without state (or with --reset), start from defaults.
// --need and --for REPLACE the saved capabilities (no merge). --grpc and
// --no-grpc override the saved grpc (tune --no-grpc writes false). --lowram and
// --no-lowram override the saved lowram and win over the --aggressive lowram.
function resolveProfile(p: Parsed, io: CliIo, avd: string): ResolvedProfile {
  if (p.bools.has('grpc') && p.bools.has('no-grpc')) throw new UsageError('--grpc and --no-grpc conflict; use only one');
  if (p.bools.has('lowram') && p.bools.has('no-lowram')) throw new UsageError('--lowram and --no-lowram conflict; use only one');
  const state = p.bools.has('reset') ? null : loadState<AndroidState>('android', avd, { env: io.env });
  const base = state?.profile;
  const opts: AndroidProfileOptions =
    base === undefined
      ? {}
      : {
          ramMb: base.ramMb,
          lowRam: base.lowRam,
          gpu: base.gpu,
          vulkan: base.vulkan,
          screen: formatScreen(base.screen),
          port: base.port ?? undefined,
          capabilities: base.capabilities ?? [],
          grpc: base.grpc, // old state without the field = undefined = on
        };
  if (p.bools.has('aggressive')) {
    opts.aggressive = true;
    opts.ramMb = undefined; // --aggressive without --ram = 1536
    opts.lowRam = undefined; // and lowram, unless --no-lowram
  }
  if (p.bools.has('lowram')) opts.lowRam = true;
  if (p.bools.has('no-lowram')) opts.lowRam = false;
  if (p.values.ram !== undefined) opts.ramMb = intFlag('ram', p.values.ram);
  if (p.values.gpu !== undefined) opts.gpu = p.values.gpu;
  if (p.bools.has('vulkan')) opts.vulkan = true;
  if (p.values.screen !== undefined) opts.screen = p.values.screen;
  if (p.values.port !== undefined) opts.port = intFlag('port', p.values.port);
  if (p.bools.has('no-grpc')) opts.grpc = false;
  if (p.bools.has('grpc')) opts.grpc = true;
  const need = needFlag(p);
  if (need !== undefined || p.values.for !== undefined) {
    opts.capabilities = resolveCapabilities({
      need,
      forDir: p.values.for === undefined ? undefined : resolve(io.cwd, p.values.for),
    });
  }
  return { profile: buildAndroidProfile(opts), inherited: base !== undefined };
}

function describeProfile(pr: AndroidProfile): string {
  const caps = pr.capabilities.length > 0 ? pr.capabilities.join(',') : '(none)';
  const parts = [
    `ram ${pr.ramMb} MB${pr.lowRam ? ' (lowram)' : ''}`,
    `heap ${pr.heapMb} MB`,
    `cores ${pr.cores}`,
    `gpu ${pr.gpu}`,
    `vulkan ${pr.vulkan ? 'on' : 'off'}`,
    `grpc ${pr.grpc ? 'on' : 'off'}`,
    `screen ${formatScreen(pr.screen)}`,
  ];
  if (pr.port !== null) parts.push(`port ${pr.port}`);
  parts.push(`capabilities ${caps}`);
  return parts.join(', ');
}

function planText(plan: TunePlan, inherited = false): string[] {
  const lines = [`AVD ${plan.avd.name} (${plan.avd.dir})`, `profile: ${describeProfile(plan.profile)}`];
  if (inherited) lines.push('profile inherited from the previous tune');
  lines.push(`config.ini: ${plan.changes.length} change(s)`);
  for (const c of plan.changes) lines.push(`  ${c.key}: ${c.from ?? '(absent)'} -> ${c.to}`);
  // Without a port in the profile, up picks a free port at launch; the gRPC port follows from it.
  const ref = plan.profile.grpc && plan.profile.port === null ? ` (gRPC ${grpcPortFor(GRPC_REFERENCE_PORT)} for reference; port chosen at up)` : '';
  lines.push('command:', `  emulator ${plan.emulatorArgs.join(' ')}${ref}`);
  return lines;
}

// RAM floor note for plan/tune. Last boot request as in status: the
// -memory of the last up/bake (lastLaunch), else the saved profile one; without state,
// the config.ini hw.ramSize.
function ramNoteFor(avd: AvdInfo, profile: AndroidProfile, io: CliIo): string | null {
  let requested: number | null = null;
  try {
    requested = requestedRamMb(loadState<AndroidState>('android', avd.name, { env: io.env }));
  } catch {
    requested = null; // unreadable state: resolveProfile would already have complained if it needed it
  }
  if (requested === null) {
    try {
      requested = parseRamMb(getValue(parseIni(readFileSync(avd.configPath, 'utf8')), 'hw.ramSize'));
    } catch {
      requested = null;
    }
  }
  return ramFloorNote(profile, lastBootRaise(avd.dir, requested));
}

// "hardware-qemu.ini, snapshots (812.3 MB)": size of snapshots/ only.
function removeList(names: readonly string[], plan: TunePlan): string {
  return names.map((n) => (n === 'snapshots' && plan.snapshotsSize !== null ? `${n} (${sizeText(plan.snapshotsSize)})` : n)).join(', ');
}

function planJson(plan: TunePlan): Record<string, unknown> {
  return {
    avd: plan.avd.name,
    avdDir: plan.avd.dir,
    profile: plan.profile,
    changes: plan.changes,
    emulatorArgs: plan.emulatorArgs,
    wouldRemove: plan.wouldRemove,
    snapshotsMb: plan.snapshotsSize === null ? null : bytesToMb(plan.snapshotsSize.bytes),
    runningLocks: plan.runningLocks,
  };
}

async function runAndroid(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  const out = (lines: string[]) => io.stdout(lines.join('\n') + '\n');
  const json = (obj: unknown) => io.stdout(JSON.stringify(obj, null, 2) + '\n');

  if (sub === 'plan') {
    const p = parseFlags(rest, TUNE_FLAGS);
    const avd = oneAvd(p, sub);
    const { profile, inherited } = resolveProfile(p, io, avd);
    const plan = planTune(avd, profile, { env: io.env });
    const ramNote = ramNoteFor(plan.avd, profile, io);
    if (p.bools.has('json')) {
      json({ ...planJson(plan), inheritedProfile: inherited, ramNote });
      return 0;
    }
    const lines = planText(plan, inherited);
    if (ramNote !== null) lines.push(ramNote);
    if (plan.wouldRemove.length > 0) lines.push(`tune would delete: ${removeList(plan.wouldRemove, plan)}`);
    if (plan.runningLocks.length > 0) lines.push(`warning: AVD seems to be running (${plan.runningLocks.join(', ')}); tune would refuse`);
    out(lines);
    return 0;
  }

  if (sub === 'tune') {
    const p = parseFlags(rest, TUNE_FLAGS);
    const avd = oneAvd(p, sub);
    const { profile, inherited } = resolveProfile(p, io, avd);
    // Before tune: it deletes the hardware-qemu.ini from the last boot.
    const ramNote = ramNoteFor(findAvd(avd, { env: io.env }), profile, io);
    const res = tuneAvd(avd, profile, { env: io.env });
    if (p.bools.has('json')) {
      json({
        ...planJson(res),
        inheritedProfile: inherited,
        ramNote,
        wroteConfig: res.wroteConfig,
        removed: res.removed,
        preservedOriginal: res.preservedOriginal,
        statePath: res.statePath,
      });
      return 0;
    }
    const lines = planText(res, inherited);
    if (ramNote !== null) lines.push(ramNote);
    lines.push(
      res.preservedOriginal
        ? `state: ${res.statePath} (first tune backup kept)`
        : `state: ${res.statePath} (original config.ini backed up)`,
    );
    lines.push(res.wroteConfig ? 'config.ini rewritten' : 'config.ini already matched the profile; nothing written');
    lines.push(res.removed.length > 0 ? `removed: ${removeList(res.removed, res)}` : 'removed: nothing');
    out(lines);
    return 0;
  }

  if (sub === 'restore') {
    const p = parseFlags(rest, RESTORE_FLAGS);
    const avd = oneAvd(p, sub);
    const res = await restoreAvd(avd, { ...rtx(io), configOnly: p.bools.has('config-only') });
    for (const w of res.warnings) io.stderr(`devslim: warning: ${w}\n`);
    if (p.bools.has('json')) {
      json({
        avd: res.avd.name,
        configPath: res.avd.configPath,
        bytes: res.bytes,
        sha256: res.sha256,
        clearedState: res.clearedState ? res.statePath : null,
        removedSnapshot: res.removedSnapshot,
        enabledPackages: res.unslim?.enabled ?? [],
        restoredSettings: res.unslim?.restoredSettings ?? [],
        warnings: res.warnings,
      });
      return 0;
    }
    const lines: string[] = [];
    if (res.unslim !== null) {
      lines.push(`guest: ${res.unslim.enabled.length} package(s) re-enabled, ${res.unslim.restoredSettings.length} setting(s) restored; emulator shut down`);
    }
    lines.push(`config.ini of ${res.avd.name} restored (${res.bytes} bytes, sha256 ${res.sha256})`);
    if (res.removedSnapshot) lines.push('slim_base snapshot removed');
    lines.push(res.clearedState ? `state removed: ${res.statePath}` : `state kept (guest changes pending): ${res.statePath}`);
    out(lines);
    return 0;
  }

  if (sub === 'create') {
    const p = parseFlags(rest, CREATE_FLAGS);
    const name = oneAvd(p, sub);
    const api = intFlag('api', p.values.api);
    if (api !== undefined && p.values.image?.startsWith('system-images;')) {
      throw new UsageError(`--api only applies to an image shortcut (${IMAGE_SHORTCUTS.join(', ')}); the full id already includes the API`);
    }
    const res = await createAvd(name, { ...rtx(io), image: p.values.image, api, device: p.values.device });
    if (p.bools.has('json')) {
      json({ avd: res.avd, image: res.image, device: res.device, ...planJson(res.tune), statePath: res.tune.statePath });
      return 0;
    }
    out([`AVD ${res.avd} created (${res.image}, ${res.device}); not booted`, ...planText(res.tune), `state: ${res.tune.statePath}`]);
    return 0;
  }

  if (sub === 'up') {
    const p = parseFlags(rest, UP_FLAGS);
    const avd = oneAvd(p, sub);
    const idleMs = idleDownFlag(p); // usage error before booting
    const res = await upAvd(avd, resolveProfile(p, io, avd).profile, { ...rtx(io), force: p.bools.has('force') });
    const idle = idleMs === undefined ? undefined : await attachIdleDown('android', res.avd, idleMs, `AVD ${res.avd}`, io);
    if (p.bools.has('json')) {
      json(idle === undefined ? res : { ...res, idleDown: idle });
      return 0;
    }
    const lines: string[] = [];
    if (res.alreadyRunning) {
      lines.push(`AVD ${res.avd} was already running on ${res.serial} (pid ${res.pid ?? '?'}); nothing started`);
    } else {
      lines.push(
        `AVD ${res.avd} ready on ${res.serial} (pid ${res.pid}, ${res.fromSnapshot ? 'slim_base snapshot' : 'cold boot without snapshot'}, boot ${secs(res.bootMs ?? 0)})`,
        `command: emulator ${res.emulatorArgs.join(' ')}`,
        `log: ${res.logFile}`,
      );
      if (res.hint !== undefined) lines.push(res.hint);
    }
    if (idle != null) lines.push(idleUpLine(idle));
    out(lines);
    return 0;
  }

  if (sub === 'bake') {
    const p = parseFlags(rest, BAKE_FLAGS);
    const avd = oneAvd(p, sub);
    // --aggressive in bake is the bloat list level; RAM stays the tune one.
    const forProfile: Parsed = { ...p, bools: new Set([...p.bools].filter((b) => b !== 'aggressive')) };
    const res = await bakeAvd(avd, resolveProfile(forProfile, io, avd).profile, {
      ...rtx(io),
      force: p.bools.has('force'),
      level: p.bools.has('aggressive') ? 'aggressive' : 'standard',
    });
    if (p.bools.has('json')) {
      json(res);
      return 0;
    }
    out(bakeText(res));
    return 0;
  }

  if (sub === 'down') {
    const p = parseFlags(rest, DOWN_FLAGS);
    if (p.positionals.length > 1) throw new UsageError(`android down: extra argument: ${p.positionals[1]}`);
    const res = await downAvd(p.positionals[0], { ...rtx(io), force: p.bools.has('force') });
    if (p.bools.has('json')) {
      json(res);
      return res.some((r) => r.result === 'failed') ? 1 : 0;
    }
    if (res.length === 0) out(['nothing to shut down (empty session)']);
    else out(res.map((r) => `${r.avd} ${r.serial}: ${r.result}${r.detail ? ` (${r.detail})` : ''}`));
    return res.some((r) => r.result === 'failed') ? 1 : 0;
  }

  if (sub === 'forget') {
    const p = parseFlags(rest, FORGET_FLAGS);
    const res = forgetAvd(oneAvd(p, sub), { env: io.env, force: p.bools.has('force') });
    if (p.bools.has('json')) json(res);
    else out(forgetText(res));
    return 0;
  }

  if (sub === 'measure') {
    const p = parseFlags(rest, MEASURE_FLAGS);
    const avd = oneAvd(p, sub);
    const m = await measureAvd(avd, rtx(io));
    if (p.bools.has('json')) {
      json(m);
      return 0;
    }
    out(measureText(m));
    return 0;
  }

  throw new UsageError(sub === undefined ? 'android: missing subcommand' : `android: unknown subcommand: ${sub}`);
}

// ---------------------------------------------------------------------------
// ios

const IOS_PROFILE_FLAGS: FlagSpec = Object.freeze({ need: 'multi', for: 'value', except: 'multi', keep: 'multi', json: 'bool' });
const IOS_UP_FLAGS: FlagSpec = Object.freeze({ ...IOS_PROFILE_FLAGS, force: 'bool', 'idle-down': 'value' });
const JSON_ONLY: FlagSpec = Object.freeze({ json: 'bool' });

// Exit code of `ios up`/`ios off` when some label did not end up at the requested value.
export const EXIT_NOT_APPLIED = 3;

function oneSim(p: Parsed, sub: string): string {
  if (p.positionals.length === 0) throw new UsageError(`ios ${sub}: missing simulator UDID or name`);
  if (p.positionals.length > 1) throw new UsageError(`ios ${sub}: extra argument: ${p.positionals[1]}`);
  return p.positionals[0];
}

const splitList = (values: readonly string[] | undefined) =>
  (values ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter((s) => s !== '');

function iosOptions(p: Parsed, io: CliIo): IosSlimOptions {
  return {
    capabilities: resolveCapabilities({
      need: p.multi.need,
      forDir: p.values.for === undefined ? undefined : resolve(io.cwd, p.values.for),
    }),
    except: splitList(p.multi.except),
    keep: splitList(p.multi.keep),
  };
}

function iosCtx(io: CliIo): IosContext {
  return { ...io.runtime, env: io.env, stderr: io.stderr };
}

const listOr = (list: readonly string[], none: string) => (list.length > 0 ? list.join(',') : none);

function simPlanText(plan: SimPlan): string[] {
  const pr = plan.profile;
  return [
    `simulator ${plan.name} (${plan.udid}), ${plan.runtime.platform} ${plan.runtime.version}, state ${plan.state}`,
    `profile: capabilities ${listOr(pr.capabilities, '(none)')}, except ${listOr(pr.except, '(none)')}, keep ${listOr(pr.keep, '(none)')}`,
    `labels to disable: ${plan.labels.length} of ${plan.managedTotal} managed; ${plan.alreadyInStore} already disabled in the store`,
    `repair (always-enabled labels the store has disabled): ${listOr(plan.repair, '(none)')}`,
    `store: ${plan.storePath} (${plan.storeExists ? 'exists' : 'absent'})`,
    plan.hasState ? 'state: exists (first up backup will be kept)' : 'state: none',
  ];
}

function upSimText(r: UpSimResult): string[] {
  if (r.alreadySlim) {
    return [`${r.name} (${r.udid}) was already booted and slim (${r.labels} labels); nothing done${r.windowOpened ? '; Simulator.app opened' : ''}`];
  }
  const lines = [
    `${r.name} (${r.udid}) ${r.runtime.platform} ${r.runtime.version}: ${r.labels} labels in the profile, ${r.storeChanges} store entry(ies) changed${r.shutdownFirst ? ' (shut down before writing)' : ''}`,
    `boot ${secs(r.bootMs ?? 0)}`,
  ];
  if (r.restored.length > 0) lines.push(`restored to saved value (${r.restored.length}): ${r.restored.join(', ')}`);
  if (r.repaired.length > 0) lines.push(`repaired (always-enabled labels that were disabled in the store): ${r.repaired.join(', ')}`);
  if (r.fallback.used) {
    lines.push(`offline store did not catch everything: launchctl in ${r.fallback.passes} pass(es) and reboot${r.fallback.failed.length > 0 ? `; launchctl failed on: ${r.fallback.failed.join(', ')}` : ''}`);
  }
  if (r.notApplied.length > 0) lines.push(`NOT disabled (${r.notApplied.length}): ${r.notApplied.join(', ')}`);
  if (r.notRestored.length > 0) lines.push(`NOT re-enabled (${r.notRestored.length}): ${r.notRestored.join(', ')}`);
  if (r.windowOpened) lines.push('Simulator.app opened');
  lines.push(`state: ${r.statePath}`);
  return lines;
}

function measureSimText(m: IosMeasurement): string[] {
  return [`${m.name} (${m.udid}) at ${m.at}: ${m.processes} processes, footprint ${m.footprintMb} MB, cpu ${m.cpuPercent}%`];
}

function categoriesData() {
  return {
    managedTotal: managedSet().size,
    alwaysEnabled: [...ALWAYS_ENABLED],
    categories: CATEGORY_IDS.map((id) => ({ id, count: CATEGORIES[id].length, breaks: CATEGORY_BREAKS[id], labels: [...CATEGORIES[id]] })),
    capabilities: Object.fromEntries(Object.entries(CAPABILITY_KEEPS).map(([c, k]) => [c, { categories: [...k.categories], labels: [...k.labels] }])),
  };
}

async function runIos(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  const out = (lines: string[]) => io.stdout(lines.join('\n') + '\n');
  const json = (obj: unknown) => io.stdout(JSON.stringify(obj, null, 2) + '\n');

  if (sub === 'categories') {
    const p = parseFlags(rest, JSON_ONLY);
    if (p.positionals.length > 0) throw new UsageError(`ios categories: extra argument: ${p.positionals[0]}`);
    const data = categoriesData();
    if (p.bools.has('json')) {
      json(data);
      return 0;
    }
    const w = Math.max(...CATEGORY_IDS.map((id) => id.length));
    const lines = data.categories.map((c) => `${c.id.padEnd(w)}  ${String(c.count).padStart(2)} labels  breaks: ${c.breaks}`);
    lines.push(`total managed: ${data.managedTotal} unique labels (categories overlap); never disabled: ${data.alwaysEnabled.join(', ')}`);
    out(lines);
    return 0;
  }

  if (sub === 'plan') {
    const p = parseFlags(rest, IOS_PROFILE_FLAGS);
    const plan = await planSim(oneSim(p, sub), iosOptions(p, io), iosCtx(io));
    if (p.bools.has('json')) json(plan);
    else out(simPlanText(plan));
    return 0;
  }

  if (sub === 'up') {
    const p = parseFlags(rest, IOS_UP_FLAGS);
    const query = oneSim(p, sub);
    const idleMs = idleDownFlag(p); // usage error before booting
    const r = await upSim(query, iosOptions(p, io), { ...iosCtx(io), force: p.bools.has('force') });
    const idle =
      idleMs === undefined
        ? undefined
        : await attachIdleDown('ios', r.udid, idleMs, `simulator ${r.name} (${r.udid})`, io, r.alreadySlim ? IOS_ALREADY_SLIM_REASON : undefined);
    if (p.bools.has('json')) json(idle === undefined ? r : { ...r, idleDown: idle });
    else out(idle == null ? upSimText(r) : [...upSimText(r), idleUpLine(idle)]);
    return r.notApplied.length > 0 || r.notRestored.length > 0 ? EXIT_NOT_APPLIED : 0;
  }

  if (sub === 'off') {
    const p = parseFlags(rest, JSON_ONLY);
    const r = await offSim(oneSim(p, sub), iosCtx(io));
    if (p.bools.has('json')) json(r);
    else {
      const lines = [`${r.name} (${r.udid}): ${r.restored} label(s) returned to saved value; state removed (${r.statePath})`];
      lines.push(r.rebooted ? 'simulator rebooted' : 'simulator was shut down; not booted');
      if (r.ignored.length > 0) lines.push(`ignored (outside the managed list): ${r.ignored.join(', ')}`);
      if (r.notRestored.length > 0) lines.push(`NOT returned to saved value (${r.notRestored.length}): ${r.notRestored.join(', ')}`);
      out(lines);
    }
    return r.notRestored.length > 0 ? EXIT_NOT_APPLIED : 0;
  }

  if (sub === 'down') {
    const p = parseFlags(rest, Object.freeze({ force: 'bool', json: 'bool' }));
    if (p.positionals.length > 1) throw new UsageError(`ios down: extra argument: ${p.positionals[1]}`);
    const res = await downSim(p.positionals[0], { ...iosCtx(io), force: p.bools.has('force') });
    if (p.bools.has('json')) json(res);
    else if (res.length === 0) out(['nothing to shut down (empty session)']);
    else out(res.map((r) => `${r.name} ${r.udid}: ${r.result}${r.detail ? ` (${r.detail})` : ''}`));
    return res.some((r) => r.result === 'failed') ? 1 : 0;
  }

  if (sub === 'forget') {
    const p = parseFlags(rest, FORGET_FLAGS);
    const res = await forgetSim(oneSim(p, sub), { ...iosCtx(io), force: p.bools.has('force') });
    if (p.bools.has('json')) json(res);
    else out(forgetText(res));
    return 0;
  }

  if (sub === 'measure') {
    const p = parseFlags(rest, JSON_ONLY);
    const m = await measureSim(oneSim(p, sub), iosCtx(io));
    if (p.bools.has('json')) json(m);
    else out(measureSimText(m));
    return 0;
  }

  throw new UsageError(sub === undefined ? 'ios: missing subcommand' : `ios: unknown subcommand: ${sub}`);
}

// ---------------------------------------------------------------------------
// top-level commands

const TOP_DOWN_FLAGS: FlagSpec = Object.freeze({ force: 'bool', json: 'bool' });

function pruneLine(r: PruneOutcome): string {
  const idle = r.idleDown === null ? '' : `; idle-down record (watcher pid ${r.idleDown.watcherPid}) removed too`;
  return `removed from session: ${r.platform} ${r.name} ${r.id} (${r.detail})${idle}`;
}

async function runTop(cmd: 'status' | 'doctor' | 'down' | 'prune' | 'measure', args: readonly string[], io: CliIo): Promise<number> {
  const out = (lines: string[]) => io.stdout(lines.join('\n') + '\n');
  const json = (obj: unknown) => io.stdout(JSON.stringify(obj, null, 2) + '\n');
  const p = parseFlags(args, cmd === 'down' ? TOP_DOWN_FLAGS : JSON_ONLY);
  if (p.positionals.length > 0) throw new UsageError(`${cmd}: extra argument: ${p.positionals[0]}`);
  const asJson = p.bools.has('json');

  if (cmd === 'status') {
    const s = await collectStatus(iosCtx(io));
    if (asJson) json(s);
    else out(statusText(s));
    return 0;
  }
  if (cmd === 'doctor') {
    const checks = await runDoctor(iosCtx(io));
    if (asJson) json(checks);
    else out(doctorText(checks));
    return doctorExitCode(checks);
  }
  if (cmd === 'prune') {
    const res = await pruneSession(iosCtx(io));
    if (asJson) json({ removed: res });
    else out(res.length === 0 ? ['nothing to clean up'] : res.map(pruneLine));
    return 0;
  }
  if (cmd === 'down') {
    const res = await downAll({ ...iosCtx(io), force: p.bools.has('force') });
    // A skipped platform was already reported on stderr; the text lists only devices.
    const done = res.filter((r) => r.result !== 'skipped');
    if (asJson) json(res);
    else if (res.length === 0) out(['nothing to shut down (empty session)']);
    else if (done.length === 0) out(['nothing to shut down']);
    else out(done.map((r) => `${r.platform} ${r.name} ${r.id}: ${r.result}${r.detail ? ` (${r.detail})` : ''}`));
    return res.some((r) => r.result === 'failed') ? 1 : 0;
  }
  const res = await measureAll(iosCtx(io));
  if (asJson) json(res);
  else if (res.length === 0) out(['nothing running']);
  else out(res.flatMap((m) => (m.platform === 'android' ? measureText(m) : measureSimText(m))));
  return 0;
}

// ---------------------------------------------------------------------------
// idle-down

function idleDownFlag(p: Parsed): number | undefined {
  const v = p.values['idle-down'];
  return v === undefined ? undefined : parseIdleDuration(v);
}

// Starts the watcher for the session device; outside the session = warning and null.
async function attachIdleDown(
  platform: 'android' | 'ios',
  id: string,
  ms: number,
  what: string,
  io: CliIo,
  why?: string,
): Promise<IdleWatcherInfo | null> {
  const info = await startIdleWatcher(platform, id, ms, resolveRuntime(rtx(io)));
  if (info === null) io.stderr(idleSkippedWarning(what, why));
  return info;
}

const IDLE_WATCH_FLAGS: FlagSpec = Object.freeze({ 'idle-ms': 'value' });

// Internal subcommand (not in --help): the detached idle-down process.
async function runIdleWatchCmd(args: readonly string[], io: CliIo): Promise<number> {
  const p = parseFlags(args, IDLE_WATCH_FLAGS);
  const [platform, id, extra] = p.positionals;
  if (platform !== 'android' && platform !== 'ios') throw new UsageError(`${IDLE_WATCH_CMD}: invalid platform: ${platform ?? '(absent)'}`);
  if (id === undefined || extra !== undefined) throw new UsageError(`${IDLE_WATCH_CMD}: usage: ${IDLE_WATCH_CMD} <android|ios> <id> --idle-ms <n>`);
  const ms = intFlag('idle-ms', p.values['idle-ms']);
  if (ms === undefined || ms < IDLE_MIN_MS) throw new UsageError(`${IDLE_WATCH_CMD}: --idle-ms requires an integer >= ${IDLE_MIN_MS}`);
  const res = await runIdleWatch(platform, id, ms, { ...rtx(io), log: io.stdout });
  return res.reason === 'probe-failed' || res.reason === 'shutdown-failed' ? 1 : 0;
}

function rtx(io: CliIo): RuntimeContext {
  return { ...io.runtime, env: io.env, stderr: io.stderr };
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function bakeText(r: BakeResult): string[] {
  const s = r.slim;
  const set = s.settings.filter((x) => x.status === 'set').length;
  const lines = [
    `bake of ${r.avd} on ${r.serial} (level ${r.level})`,
    `command: emulator ${r.emulatorArgs.join(' ')}`,
    `settings: ${set} changed`,
  ];
  for (const x of s.settings.filter((y) => y.status !== 'set')) lines.push(`  ${x.ns}/${x.key}: ${x.status}${x.note ? ` (${x.note})` : ''}`);
  lines.push(`packages: ${s.newlyDisabled.length} disabled now, ${s.disabledPackages.length} ours in the state, ${s.alreadyDisabled.length} already disabled before (not in the state)`);
  if (s.reenabled.length > 0) lines.push(`  re-enabled (dropped from the plan): ${s.reenabled.join(', ')}`);
  for (const f of s.failedPackages) lines.push(`  failed: ${f.pkg} (${f.error})`);
  if (s.packagesError !== null) lines.push(`  packages not processed: ${s.packagesError}`);
  lines.push(`dexopt: ${s.dexopt.ok ? 'ok' : `failed (${s.dexopt.detail})`}`);
  lines.push(`am kill-all: ${s.killAll.ok ? 'ok' : `failed (${s.killAll.detail})`}`);
  lines.push(`snapshot ${r.snapshot} saved; emulator shut down`);
  if (r.lingeringLocks.length > 0) lines.push(`warning: locks still present: ${r.lingeringLocks.join(', ')}`);
  const t = r.timings;
  lines.push(`timings: boot ${secs(t.bootMs)}, slim ${secs(t.slimMs)}, snapshot ${secs(t.snapshotMs)}, shutdown ${secs(t.shutdownMs)}, total ${secs(t.totalMs)}`);
  lines.push(`state: ${r.statePath}`, `log: ${r.logFile}`);
  return lines;
}

function measureText(m: AndroidMeasurement): string[] {
  const v = (n: number | null, unit = ' MB') => (n === null ? 'n/a' : `${n}${unit}`);
  return [
    `${m.avd} (${m.serial}, pid ${m.pid ?? 'n/a'}) at ${m.at}`,
    `host: phys_footprint ${v(m.host.footprintMb)}, footprint (header) ${v(m.host.footprintHeaderMb)}, rss ${v(m.host.rssMb)}`,
    `guest: MemTotal ${v(m.guest.memTotalMb)}, MemAvailable ${v(m.guest.memAvailableMb)}, processes ${v(m.guest.processes, '')}`,
    `guest dumpsys: Used RAM ${v(m.guest.usedRamMb)}, Free RAM ${v(m.guest.freeRamMb)}`,
  ];
}

function defaultIo(): CliIo {
  return {
    stdout: (t) => { process.stdout.write(t); },
    stderr: (t) => { process.stderr.write(t); },
    env: process.env,
    cwd: process.cwd(),
  };
}

// Returns the exit code. Expected error = one line on stderr, no stack.
export async function main(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      io.stdout(HELP);
      return 0;
    }
    if (cmd === '--version' || cmd === '-v') {
      io.stdout(`${pkg.version}\n`);
      return 0;
    }
    if (cmd === 'status' || cmd === 'doctor' || cmd === 'down' || cmd === 'prune' || cmd === 'measure') return await runTop(cmd, rest, io);
    if (cmd === 'android') return await runAndroid(rest, io);
    if (cmd === 'ios') return await runIos(rest, io);
    if (cmd === IDLE_WATCH_CMD) return await runIdleWatchCmd(rest, io);
    throw new UsageError(cmd === undefined ? 'missing command' : `unknown command: ${cmd}`);
  } catch (err) {
    if (err instanceof DevslimError) {
      io.stderr(`devslim: ${err.message}\n`);
      if (err instanceof UsageError) io.stderr('\n' + HELP);
      return err.exitCode;
    }
    const e = err as Error;
    io.stderr(`devslim: unexpected error: ${e?.message ?? String(err)}\n`);
    if (io.env.DEVSLIM_DEBUG) io.stderr(`${e?.stack ?? ''}\n`);
    return 1;
  }
}
