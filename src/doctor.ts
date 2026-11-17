import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { avdHome, findAvd, listAvds, type AvdInfo } from './android/avd.ts';
import { applyProfile, getValue, parseIni, type IniDoc } from './android/configIni.ts';
import { CAPABILITIES, sortCapabilities, type Capability } from './capabilities.ts';
import type { AndroidProfile } from './android/profile.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { loadSession } from './android/session.ts';
import { findSdkRoot, sdkCandidates, sdkToolPath, type SdkTool } from './android/sdk.ts';
import { readStore, storePath } from './ios/disabledStore.ts';
import { ALWAYS_ENABLED } from './ios/labels.ts';
import { parseRuntimesJson } from './ios/simctl.ts';
import { compareVersion, MIN_IOS_VERSION, type IosContext } from './ios/slim.ts';
import { listSimDevices, sessionStatus } from './status.ts';
import { assessSwap, readSwap } from './swap.ts';
import { dirSize, sizeText } from './dirSize.ts';
import { isSoftwareGpu, parseRamMb, readEffectiveHardware } from './android/hardwareQemu.ts';
import { classifyLauncher, launcherText, listQemuProcesses } from './android/launcher.ts';
import { findRunningEntry, isAdvertised, scanRunning } from './android/runningIni.ts';
import { launchedRamMb, listStates, loadState, type AndroidState } from './state.ts';
import { DEFAULT_API, imageTag, isAtdTag, isGoogleApisTag } from './android/images.ts';
import { formatDuration } from './idle.ts';
import { androidOrphans, iosOrphans } from './orphans.ts';

// `devslim doctor`: read-only. Never calls adb, never runs argent,
// never deletes anything. Per-AVD/device checks: avd-gpu and avd-ram give one line
// per AVD (last boot); profile-drift, avd-image, running-off-profile, emulator-advertised,
// default-boot-snapshot, orphan-images, ios-always-enabled and orphan-state give
// one line per occurrence (or a single ok).

export type CheckLevel = 'ok' | 'warn' | 'fail';
export type Check = Readonly<{ id: string; level: CheckLevel; message: string; fix?: string }>;

export type DoctorContext = IosContext & { nodeVersion?: string };

export const MIN_NODE_MAJOR = 25;
export const MIN_EMULATOR_REVISION = Object.freeze([37, 2, 13] as const);
// Single source in hardwareQemu.ts (also used by status and up).
export { SOFTWARE_GPU_MODES, isSoftwareGpu } from './android/hardwareQemu.ts';
export const RAM_WARN_MB = 3072;
// Swap thresholds: single source in swap.ts (the same as up/bake/ios up).
export { SWAP_WARN_PERCENT, SWAP_FAIL_PERCENT } from './swap.ts';

const check = (id: string, level: CheckLevel, message: string, fix?: string): Check =>
  Object.freeze(fix === undefined ? { id, level, message } : { id, level, message, fix });


// Directory size: moved to dirSize.ts (also used by plan/tune).
export { dirSize, type DirSize } from './dirSize.ts';

// ---------------------------------------------------------------------------
// helpers

function readIni(path: string): ReturnType<typeof parseIni> | null {
  try {
    return parseIni(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export { parseRamMb } from './android/hardwareQemu.ts';

function avds(env: Runtime['env']): AvdInfo[] {
  const out: AvdInfo[] = [];
  for (const name of listAvds(env)) {
    try {
      out.push(findAvd(name, { env }));
    } catch {
      // .ini without a directory: nothing to check
    }
  }
  return out;
}

function onPath(cmd: string, env: Runtime['env']): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const p = join(dir, cmd);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// checks

function checkNode(version: string): Check {
  const v = version.replace(/^v/, '');
  const major = Number(v.split('.')[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR
    ? check('node', 'ok', `node ${v}`)
    : check('node', 'fail', `node ${v}: devslim requires ${MIN_NODE_MAJOR} or newer (native type stripping)`, `install node ${MIN_NODE_MAJOR}+`);
}

async function checkXcode(rt: Runtime): Promise<Check> {
  let xcode: string;
  try {
    const res = await rt.exec('xcodebuild', ['-version'], { timeoutMs: 30_000 });
    if (res.code !== 0) throw new Error(res.stderr.trim());
    xcode = res.stdout.split(/\r?\n/)[0].trim() || 'Xcode';
  } catch {
    return check('xcode', 'warn', 'xcodebuild -version did not respond: without Xcode, devslim ios is unavailable', 'install Xcode and run sudo xcode-select -s /Applications/Xcode.app');
  }
  let runtimes;
  try {
    const res = await rt.exec('xcrun', ['simctl', 'list', 'runtimes', '-j'], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim());
    runtimes = parseRuntimesJson(res.stdout);
  } catch (err) {
    return check('xcode', 'fail', `${xcode}, but xcrun simctl list runtimes -j failed (${(err as Error).message || 'no output'})`, 'sudo xcode-select -s /Applications/Xcode.app');
  }
  const ios = runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable && /^\d+(\.\d+)*$/.test(r.version));
  const good = ios.filter((r) => compareVersion(r.version, MIN_IOS_VERSION) >= 0).map((r) => r.version);
  const min = MIN_IOS_VERSION.join('.');
  if (good.length > 0) return check('xcode', 'ok', `${xcode}; runtime iOS ${good.join(', ')}`);
  if (ios.length === 0) return check('xcode', 'warn', `${xcode}, no iOS runtime installed`, 'Xcode > Settings > Components: install an iOS runtime');
  return check('xcode', 'warn', `${xcode}; only old iOS runtimes (${ios.map((r) => r.version).join(', ')}); devslim ios requires ${min}+`, `install an iOS runtime ${min} or newer`);
}

const TOOLS: readonly SdkTool[] = Object.freeze(['emulator', 'adb', 'avdmanager']);

function checkAndroidSdk(env: Runtime['env'], root: string | null): Check {
  if (root === null) {
    return check('android-sdk', 'warn', `Android SDK not found (looked in ${sdkCandidates(env).join(', ')}); devslim android is unavailable`, 'set ANDROID_HOME');
  }
  const missing = TOOLS.filter((t) => !existsSync(sdkToolPath(root, t)));
  if (missing.length > 0) {
    const what = missing.map((t) => `${t} (${relative(root, sdkToolPath(root, t))})`).join(', ');
    return check('android-sdk', 'fail', `SDK at ${root} missing: ${what}`, 'sdkmanager "emulator" "platform-tools" "cmdline-tools;latest"');
  }
  return check('android-sdk', 'ok', `SDK at ${root} with emulator, adb and avdmanager`);
}

function checkEmulatorVersion(root: string | null): Check {
  if (root === null) return check('emulator-version', 'ok', 'no Android SDK; not applicable');
  const path = join(root, 'emulator', 'source.properties');
  const props = readIni(path);
  const rev = props === null ? undefined : getValue(props, 'Pkg.Revision');
  if (rev === undefined || !/^\d+(\.\d+)*$/.test(rev.trim())) {
    return check('emulator-version', 'warn', `could not read emulator version (${path})`);
  }
  const v = rev.trim();
  const min = MIN_EMULATOR_REVISION.join('.');
  if (compareVersion(v, MIN_EMULATOR_REVISION) < 0) {
    return check('emulator-version', 'warn', `emulator ${v} < ${min}: version without the host GLES memory leak fix`, `update the SDK emulator package to ${min} or newer (sdkmanager "emulator")`);
  }
  return check('emulator-version', 'ok', `emulator ${v}`);
}

function checkAvdGpu(list: readonly AvdInfo[], home: string): Check[] {
  if (list.length === 0) return [check('avd-gpu', 'ok', `no AVD in ${home}`)];
  return list.map((a) => {
    const hq = readIni(join(a.dir, 'hardware-qemu.ini'));
    const mode = hq === null ? undefined : getValue(hq, 'hw.gpu.mode');
    if (mode === undefined) return check('avd-gpu', 'ok', `${a.name}: no hardware-qemu.ini with hw.gpu.mode (not booted since the last tune)`);
    if (isSoftwareGpu(mode)) {
      return check('avd-gpu', 'warn', `${a.name}: last boot with hw.gpu.mode ${mode.trim()} (software rendering, high CPU and RAM)`, `devslim android tune ${a.name}`);
    }
    return check('avd-gpu', 'ok', `${a.name}: hw.gpu.mode ${mode.trim()}`);
  });
}

// Requested = -memory of the last up/bake (lastLaunch in the state) when present; else the
// config.ini hw.ramSize (old state or AVD without state).
function checkAvdRam(list: readonly AvdInfo[], home: string, env: Runtime['env']): Check[] {
  if (list.length === 0) return [check('avd-ram', 'ok', `no AVD in ${home}`)];
  return list.map((a) => {
    const hq = readIni(join(a.dir, 'hardware-qemu.ini'));
    const runtime = hq === null ? null : parseRamMb(getValue(hq, 'hw.ramSize'));
    let launched: number | null = null;
    try {
      launched = launchedRamMb(loadState<AndroidState>('android', a.name, { env }));
    } catch {
      launched = null; // unreadable state: config.ini
    }
    let asked = launched;
    if (asked === null) {
      const cfg = readIni(a.configPath);
      asked = cfg === null ? null : parseRamMb(getValue(cfg, 'hw.ramSize'));
    }
    const askedText = launched !== null ? 'requested at the last up/bake' : 'from config.ini';
    if (runtime === null) return check('avd-ram', 'ok', `${a.name}: no hw.ramSize in hardware-qemu.ini (not booted since the last tune)`);
    const why: string[] = [];
    const raised = asked !== null && runtime > asked;
    if (raised) why.push(`above the ${asked} MB ${askedText} (emulator raised it)`);
    if (runtime > RAM_WARN_MB) why.push(`above ${RAM_WARN_MB} MB`);
    if (why.length > 0) {
      // Raised: the emulator ignores -memory below its floor without lowram; a smaller screen does not help (measured).
      const fix = raised
        ? `devslim android tune ${a.name} --lowram (with the AVD shut down; the emulator ignores -memory below its floor without lowram; lowram changes app behavior: the guest reports itself as a low-RAM device)`
        : `devslim android tune ${a.name} (and start it with devslim android up, which passes -memory)`;
      return check('avd-ram', 'warn', `${a.name}: last boot used ${runtime} MB, ${why.join(' and ')}`, fix);
    }
    const askedNote = asked === null ? '' : launched !== null ? ` (requested at the last up/bake ${asked} MB)` : ` (config.ini ${asked} MB)`;
    return check('avd-ram', 'ok', `${a.name}: ${runtime} MB${askedNote}`);
  });
}

// config.ini of each AVD with state vs what the saved profile would produce (same
// applyProfile as plan/tune: no separate mapping here). The capability that
// explains the drift comes from toggling each one in the profile and seeing which keys
// start to match. Missing AVD, unreadable config.ini or state without profile: skipped.
// Read-only.
function driftCapabilities(doc: IniDoc, profile: AndroidProfile, keys: ReadonlySet<string>): { caps: Capability[]; added: Capability[]; removed: Capability[] } {
  const added: Capability[] = [];
  const removed: Capability[] = [];
  for (const cap of CAPABILITIES) {
    const has = profile.capabilities.includes(cap);
    const caps = has ? profile.capabilities.filter((c) => c !== cap) : [...profile.capabilities, cap];
    const alt = applyProfile(doc, { ...profile, capabilities: sortCapabilities(caps) }).changes;
    // Explains it if some drifted key stops changing with the capability toggled.
    const explains = [...keys].some((k) => !alt.some((c) => c.key === k)) && alt.every((c) => keys.has(c.key));
    if (explains) (has ? removed : added).push(cap);
  }
  const caps = sortCapabilities([...profile.capabilities.filter((c) => !removed.includes(c)), ...added]);
  return { caps, added, removed };
}

function checkProfileDrift(env: Runtime['env']): Check[] {
  const names = listStates('android', { env });
  if (names.length === 0) return [check('profile-drift', 'ok', 'no AVD with devslim state')];
  const out: Check[] = [];
  let clean = 0;
  let skipped = 0;
  for (const name of names) {
    let profile: AndroidProfile | undefined;
    let doc: IniDoc | null = null;
    let changes: ReturnType<typeof applyProfile>['changes'] = [];
    try {
      profile = loadState<AndroidState>('android', name, { env })?.profile;
      if (profile === undefined || !Array.isArray(profile.capabilities)) throw new Error('state without profile');
      doc = readIni(findAvd(name, { env }).configPath);
      if (doc === null) throw new Error('unreadable config.ini');
      changes = applyProfile(doc, profile).changes;
    } catch {
      skipped++;
      continue;
    }
    if (changes.length === 0) {
      clean++;
      continue;
    }
    const list = changes.map((c) => `${c.key}: current=${c.from ?? '(absent)'} expected=${c.to}`).join('; ');
    const hint = driftCapabilities(doc, profile, new Set(changes.map((c) => c.key)));
    let fix = `devslim android tune ${name}`;
    if (hint.added.length > 0 || hint.removed.length > 0) {
      const why = [
        ...(hint.added.length > 0 ? [`needs ${hint.added.join(',')}`] : []),
        ...(hint.removed.length > 0 ? [`drops ${hint.removed.join(',')}`] : []),
      ].join(' and ');
      const need = hint.caps.length > 0 ? hint.caps.join(',') : 'none';
      fix = `devslim android tune ${name} --need ${need} (the current config.ini ${why})\nor devslim android tune ${name} to return to the saved profile`;
    }
    out.push(check('profile-drift', 'warn', `${name}: config.ini differs from the saved profile in ${changes.length} key(s): ${list}`, fix));
  }
  if (out.length > 0) return out;
  const skip = skipped > 0 ? `; ${skipped} skipped (missing AVD or unreadable config.ini)` : '';
  return [check('profile-drift', 'ok', `${clean} AVD(s) with config.ini matching the saved profile${skip}`)];
}

// System image tag of each AVD with state vs capabilities that depend on
// Google services. google_apis (or playstore) with none of them: ok note
// suggesting ATD, with the measured number. ATD/default with any of them: warn.
// Missing AVD, unreadable config.ini or no tag: skipped. Read-only.
export const GOOGLE_SERVICE_CAPABILITIES: readonly Capability[] = Object.freeze(['push', 'weblogin', 'store']);
// Measured 2026-11-17 (API 35, pixel_7, 2 min idle, one measurement each):
// qemu phys_footprint with the devslim default profile on aosp_atd vs google_apis.
export const ATD_FOOTPRINT_MB = 3660;
export const GOOGLE_APIS_FOOTPRINT_MB = 4343;

const TAG_TEXT: Readonly<Record<string, string>> = Object.freeze({
  aosp_atd: 'no Google services',
  default: 'no Google services',
  google_atd: 'reduced Google services',
});

function checkAvdImage(env: Runtime['env']): Check[] {
  const names = listStates('android', { env });
  if (names.length === 0) return [check('avd-image', 'ok', 'no AVD with devslim state')];
  const out: Check[] = [];
  let fine = 0;
  let skipped = 0;
  for (const name of names) {
    let caps: readonly string[];
    let cfg: IniDoc | null;
    try {
      const profile = loadState<AndroidState>('android', name, { env })?.profile;
      if (profile === undefined || !Array.isArray(profile.capabilities)) throw new Error('state without profile');
      caps = profile.capabilities;
      cfg = readIni(findAvd(name, { env }).configPath);
    } catch {
      skipped++;
      continue;
    }
    const sysdir = cfg === null ? undefined : getValue(cfg, 'image.sysdir.1');
    const tag = cfg === null ? null : imageTag({ tagId: getValue(cfg, 'tag.id'), sysdir });
    if (tag === null) {
      skipped++;
      continue;
    }
    const api = /(?:^|\/)android-(\d+)(?:\/|$)/.exec((sysdir ?? '').replace(/\\/g, '/'))?.[1];
    const apiFlag = api !== undefined && Number(api) !== DEFAULT_API ? ` --api ${api}` : '';
    const needs = GOOGLE_SERVICE_CAPABILITIES.filter((c) => caps.includes(c));
    if (isGoogleApisTag(tag) && needs.length === 0) {
      out.push(check(
        'avd-image',
        'ok',
        `${name}: image ${tag} (full Google services) and the profile does not need push, weblogin or store; ` +
          `an ATD image is lighter (measured with aosp_atd: ${ATD_FOOTPRINT_MB} MB vs ${GOOGLE_APIS_FOOTPRINT_MB} MB of host phys_footprint, 2 min idle, one measurement each)`,
        `devslim android create ${name}-atd --image aosp_atd${apiFlag}`,
      ));
    } else if (isAtdTag(tag) && needs.length > 0) {
      const verdict = tag === 'google_atd' ? 'may not work' : 'does not work';
      out.push(check(
        'avd-image',
        'warn',
        `${name}: image ${tag} (${TAG_TEXT[tag]}) and the profile needs ${needs.join(',')}: ${verdict} on this image`,
        `devslim android create ${name}-gapis --image google_apis${apiFlag}`,
      ));
    } else {
      fine++;
    }
  }
  if (out.length > 0) return out;
  const skip = skipped > 0 ? `; ${skipped} skipped (missing AVD, unreadable config.ini or no image tag)` : '';
  return [check('avd-image', 'ok', `${fine} AVD(s) with an image compatible with the profile capabilities${skip}`)];
}

// Emulator running right now outside the profile: effective software GPU, or a tuned
// AVD launched by something else (argent, Studio). Facts from the qemu command line
// (pgrep -fl) and this boot's hardware-qemu.ini; never adb.
async function checkRunningOffProfile(rt: Runtime): Promise<Check[]> {
  const procs = await listQemuProcesses(rt.exec);
  if (procs.length === 0) return [check('running-off-profile', 'ok', 'no emulator running')];
  let session: ReturnType<typeof loadSession> = [];
  try {
    session = loadSession(rt.env);
  } catch {
    session = []; // corrupt session: only the signature decides
  }
  const out: Check[] = [];
  for (const p of procs) {
    let st: AndroidState | null = null;
    try {
      st = loadState<AndroidState>('android', p.avd, { env: rt.env });
    } catch {
      st = null;
    }
    let dir: string | null = null;
    try {
      dir = findAvd(p.avd, { env: rt.env }).dir;
    } catch {
      dir = null;
    }
    const hw = dir === null ? null : readEffectiveHardware(dir);
    const launcher = classifyLauncher(p.cmdline, session.some((e) => e.platform === 'android' && e.avd === p.avd));
    const tuned = typeof st?.originalConfigIni === 'string';
    const soft = hw?.gpu != null && isSoftwareGpu(hw.gpu);
    if (!soft && !(tuned && launcher !== 'devslim')) continue;
    const facts = [launcherText(launcher)];
    if (hw?.gpu != null) facts.push(`effective gpu ${hw.gpu}${soft ? ' (software rendering)' : ''}`);
    if (hw?.ramMb != null) facts.push(`effective ram ${hw.ramMb} MB`);
    const profile = tuned && st?.profile !== undefined ? `; tune profile: gpu ${st.profile.gpu}, ${st.profile.ramMb} MB` : '';
    out.push(check(
      'running-off-profile',
      'warn',
      `${p.avd} (pid ${p.pid}) running now: ${facts.join(', ')}${profile}`,
      `stop the emulator and start it with: devslim android up ${p.avd}\nor export ARGENT_EMULATOR_GPU_MODE=host in the argent environment`,
    ));
  }
  return out.length > 0 ? out : [check('running-off-profile', 'ok', `${procs.length} emulator(s) running on the profile`)];
}

// Emulator running without an entry with grpc.port + grpc.token in avd/running:
// argent (simulator-server) cannot see it for screenshot/describe/tap. Reads only
// the directory; the token value never leaves runningIni.ts. An entry for a dead pid
// does not count as advertised; when present, it becomes an informational ok line
// (the file belongs to the emulator/SDK, nothing is deleted).
async function checkEmulatorAdvertised(rt: Runtime): Promise<Check[]> {
  const procs = await listQemuProcesses(rt.exec);
  const dir = rt.runningDir;
  const scan = scanRunning(dir, rt.pidAlive);
  const staleNote = scan.stale.length === 0 ? [] : [check(
    'emulator-advertised',
    'ok',
    `${scan.stale.length} dead emulator entry(ies) in ${dir} ignored: ${scan.stale.map((e) => `pid_${e.pid}.ini (${e.avdName})`).join(', ')}; emulator files, nothing deleted`,
  )];
  if (procs.length === 0) return [check('emulator-advertised', 'ok', 'no emulator running'), ...staleNote];
  if (dir === null) {
    return [check('emulator-advertised', 'warn', `${procs.length} emulator(s) running; advertisement not checked (avd/running directory unknown on this platform)`)];
  }
  const out: Check[] = [];
  for (const p of procs) {
    const e = findRunningEntry(scan.live, p.avd);
    if (isAdvertised(e)) continue;
    const what = e === null ? `with no entry in ${dir}` : `with an entry in ${dir} lacking ${e.grpcPort === null ? 'grpc.port' : 'grpc.token'}`;
    out.push(check(
      'emulator-advertised',
      'warn',
      `${p.avd} (pid ${p.pid}) running ${what}: tools that rely on gRPC (argent screenshot/tap) cannot see it; adb works normally`,
      `devslim android down ${p.avd} and devslim android up ${p.avd} (launches with -grpc <port> -grpc-use-token)`,
    ));
  }
  return [...(out.length > 0 ? out : [check('emulator-advertised', 'ok', `${procs.length} emulator(s) running, all advertised in ${dir}`)]), ...staleNote];
}

function checkArgentGpu(env: Runtime['env']): Check {
  const path = onPath('argent', env);
  if (path === null) return check('argent-gpu', 'ok', 'argent is not on PATH; not applicable');
  const mode = env.ARGENT_EMULATOR_GPU_MODE;
  if (mode === 'host') return check('argent-gpu', 'ok', `argent at ${path} with ARGENT_EMULATOR_GPU_MODE=host`);
  return check(
    'argent-gpu',
    'warn',
    `argent at ${path} and ARGENT_EMULATOR_GPU_MODE=${mode ?? '(absent)'}: when argent boots an AVD on its own it uses -gpu auto, which can fall back to software rendering (lavapipe/swiftshader); set the variable in the argent tool-server environment`,
    'export ARGENT_EMULATOR_GPU_MODE=host',
  );
}

function checkDefaultBootSnapshot(list: readonly AvdInfo[]): Check[] {
  const out: Check[] = [];
  for (const a of list) {
    const dir = join(a.dir, 'snapshots', 'default_boot');
    if (!existsSync(join(dir, 'ram.bin'))) continue;
    out.push(check(
      'default-boot-snapshot',
      'warn',
      `${a.name}: snapshots/default_boot holds ${sizeText(dirSize(dir))} (ram.bin rewritten on every argent cold boot; devslim uses slim_base)`,
    ));
  }
  return out.length > 0 ? out : [check('default-boot-snapshot', 'ok', 'no AVD with snapshots/default_boot/ram.bin')];
}

const normSysdir = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');

function checkOrphanImages(root: string | null, list: readonly AvdInfo[]): Check[] {
  if (root === null) return [check('orphan-images', 'ok', 'no Android SDK; not applicable')];
  const base = join(root, 'system-images');
  const referenced = new Set<string>();
  for (const a of list) {
    const cfg = readIni(a.configPath);
    const v = cfg === null ? undefined : getValue(cfg, 'image.sysdir.1');
    if (v === undefined || v.trim() === '') continue;
    const p = normSysdir(v);
    referenced.add(isAbsolute(p) ? normSysdir(relative(root, p)) : p);
  }
  const dirs = (p: string) => {
    try {
      return readdirSync(p).filter((n) => {
        try {
          return statSync(join(p, n)).isDirectory();
        } catch {
          return false;
        }
      }).sort();
    } catch {
      return [];
    }
  };
  const out: Check[] = [];
  for (const api of dirs(base)) {
    for (const tag of dirs(join(base, api))) {
      for (const abi of dirs(join(base, api, tag))) {
        const rel = `system-images/${api}/${tag}/${abi}`;
        if (referenced.has(rel)) continue;
        out.push(check(
          'orphan-images',
          'warn',
          `${rel}: no AVD config.ini references this image; takes ${sizeText(dirSize(join(base, api, tag, abi)))} (reported only, nothing deleted)`,
          `sdkmanager --uninstall "${['system-images', api, tag, abi].join(';')}" if you will not use it`,
        ));
      }
    }
  }
  return out.length > 0 ? out : [check('orphan-images', 'ok', 'every installed system image is used by some AVD')];
}

async function checkSwap(rt: Runtime): Promise<Check> {
  const a = assessSwap(await readSwap(rt.exec));
  return check('swap', a.level, a.message, a.fix);
}

async function checkIosAlwaysEnabled(rt: Runtime, ctx: IosContext): Promise<Check[]> {
  const devices = await listSimDevices(rt);
  if (devices === null) return [check('ios-always-enabled', 'warn', 'not checked: xcrun simctl list devices -j failed')];
  const out: Check[] = [];
  for (const d of devices) {
    if (!existsSync(storePath(d.udid, { base: ctx.storeBase }))) continue;
    let store;
    try {
      store = await readStore(d.udid, { base: ctx.storeBase, exec: rt.exec });
    } catch (err) {
      out.push(check('ios-always-enabled', 'warn', `${d.name} (${d.udid}): unreadable store (${(err as Error).message})`));
      continue;
    }
    const off = ALWAYS_ENABLED.filter((l) => store.get(l) === true);
    if (off.length === 0) continue;
    const ambiguous = devices.filter((x) => x.name === d.name).length > 1;
    out.push(check(
      'ios-always-enabled',
      'warn',
      `${d.name} (${d.udid}): store disables ${off.join(', ')}, which must always stay enabled`,
      `devslim ios up ${ambiguous ? d.udid : d.name}`,
    ));
  }
  return out.length > 0 ? out : [check('ios-always-enabled', 'ok', 'no simulator store disables assistantd, gamed or sharingd')];
}

// Dead session entries; and, for a live device with idle-down registered,
// a watcher whose pid died (the device will no longer shut down on its own).
async function checkStaleSession(rt: Runtime): Promise<Check[]> {
  const entries = loadSession(rt.env);
  if (entries.length === 0) return [check('stale-session', 'ok', 'empty session')];
  const devices = entries.some((e) => e.platform === 'ios') ? await listSimDevices(rt) : [];
  const st = await sessionStatus(entries, { exec: rt.exec, env: rt.env, devices, pidAlive: rt.pidAlive });
  const stale = st.filter((e) => e.stale);
  const out: Check[] = [
    stale.length === 0
      ? check('stale-session', 'ok', `${entries.length} session entry(ies), all alive`)
      : check(
          'stale-session',
          'warn',
          `${stale.length} dead session entry(ies): ${stale.map((e) => `${e.platform} ${e.name} ${e.id}`).join(', ')}`,
          'devslim down',
        ),
  ];
  for (const e of st) {
    if (e.stale || e.idleDown === null || e.idleDown.watcherAlive) continue;
    const id = e.platform === 'android' ? e.name : e.id;
    out.push(check(
      'stale-session',
      'warn',
      `${e.platform} ${e.name} ${e.id}: idle-down watcher (pid ${e.idleDown.watcherPid}) died while the device was running; it will not shut down on its own (reason in log idle-${id}.log)`,
      `devslim ${e.platform} up ${id} --idle-down ${formatDuration(e.idleDown.ms)}\nor devslim down`,
    ));
  }
  return out;
}

// devslim state whose AVD or simulator no longer exists. Read-only; the fix is
// `forget`, which deletes the record without touching any device. Without simctl,
// iOS states are reported as not checked.
async function checkOrphanState(rt: Runtime): Promise<Check[]> {
  const out: Check[] = androidOrphans(rt.env).map((o) =>
    check('orphan-state', 'warn', `${o.path}: AVD ${o.name} no longer exists (orphan state)`, o.forget),
  );
  const iosIds = listStates('ios', { env: rt.env });
  if (iosIds.length > 0) {
    const ios = iosOrphans(rt.env, await listSimDevices(rt));
    if (ios === null) {
      out.push(check('orphan-state', 'warn', `${iosIds.length} iOS state(s) not checked: xcrun simctl list devices -j failed`));
    } else {
      for (const o of ios) out.push(check('orphan-state', 'warn', `${o.path}: simulator ${o.name} (${o.id}) no longer exists (orphan state)`, o.forget));
    }
  }
  return out.length > 0 ? out : [check('orphan-state', 'ok', 'no orphan state (every state points to an existing AVD or simulator)')];
}

export async function runDoctor(ctx: DoctorContext = {}): Promise<Check[]> {
  const rt = resolveRuntime(ctx);
  const root = findSdkRoot(rt.env);
  const list = avds(rt.env);
  const home = avdHome(rt.env);
  return [
    checkNode(ctx.nodeVersion ?? process.version),
    await checkXcode(rt),
    checkAndroidSdk(rt.env, root),
    checkEmulatorVersion(root),
    ...checkAvdGpu(list, home),
    ...checkAvdRam(list, home, rt.env),
    ...checkProfileDrift(rt.env),
    ...checkAvdImage(rt.env),
    ...(await checkRunningOffProfile(rt)),
    ...(await checkEmulatorAdvertised(rt)),
    checkArgentGpu(rt.env),
    ...checkDefaultBootSnapshot(list),
    ...checkOrphanImages(root, list),
    await checkSwap(rt),
    ...(await checkIosAlwaysEnabled(rt, ctx)),
    ...(await checkStaleSession(rt)),
    ...(await checkOrphanState(rt)),
  ];
}

export function doctorExitCode(checks: readonly Check[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

export function doctorText(checks: readonly Check[]): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    const tag = `[${c.level}]`.padEnd(6);
    lines.push(`${tag} ${c.id}: ${c.message}`);
    // multi-line fix: continuation aligned after "fix: ".
    if (c.fix !== undefined) lines.push(`${' '.repeat(7)}fix: ${c.fix.split('\n').join(`\n${' '.repeat(12)}`)}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(`${fails} fail, ${warns} warn`);
  return lines;
}
