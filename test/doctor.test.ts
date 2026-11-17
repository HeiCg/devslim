import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { applyProfile, parseIni, serializeIni, setValue } from '../src/android/configIni.ts';
import { buildAndroidProfile, type AndroidProfileOptions } from '../src/android/profile.ts';
import { recordSession } from '../src/android/session.ts';
import { loadState, recordAndroidTune, saveState, type AndroidState } from '../src/state.ts';
import { main } from '../src/cli.ts';
import { dirSize, doctorExitCode, runDoctor, type Check, type DoctorContext } from '../src/doctor.ts';
import { createFakeExec, type FakeCall } from '../src/exec.ts';
import { serializeStorePlist, storePath } from '../src/ios/disabledStore.ts';
import { SWAP_FAIL_PERCENT as DOCTOR_FAIL, SWAP_WARN_PERCENT as DOCTOR_WARN } from '../src/doctor.ts';
import { SWAP_FAIL_PERCENT, SWAP_WARN_PERCENT, swapGate } from '../src/swap.ts';

const UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
const MB = 1024 * 1024;

let root: string;
let sdk: string;
let avdHome: string;
let bin: string;
let storeBase: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-doctor-'));
  sdk = join(root, 'sdk');
  avdHome = join(root, 'avd');
  bin = join(root, 'bin');
  storeBase = join(root, 'var-tmp');
  for (const d of [avdHome, bin, storeBase]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type World = {
  sdk?: { bins?: readonly string[]; revision?: string | null; images?: readonly string[] } | null;
  xcode?: 'ok' | 'missing' | 'simctl-fails';
  runtimes?: readonly string[]; // versoes iOS
  sims?: readonly { udid: string; name: string; state?: string }[];
  swap?: string;
  env?: Record<string, string>;
  nodeVersion?: string;
  qemu?: Record<string, string>; // pid -> command line of the running qemu
  alive?: (pid: number) => boolean; // avd/running pid alive; default: all
};

const SWAP_OK = 'total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)';

function makeSdk(o: NonNullable<World['sdk']>): void {
  const all = ['emulator/emulator', 'platform-tools/adb', 'cmdline-tools/latest/bin/avdmanager'];
  for (const rel of o.bins ?? all) {
    mkdirSync(join(sdk, rel, '..'), { recursive: true });
    writeFileSync(join(sdk, rel), '#!/bin/sh\n');
  }
  mkdirSync(join(sdk, 'emulator'), { recursive: true });
  if (o.revision !== null) {
    writeFileSync(join(sdk, 'emulator', 'source.properties'), `Pkg.UserSrc=false\nPkg.Revision=${o.revision ?? '37.2.13'}\nPkg.Path=emulator\n`);
  }
  for (const img of o.images ?? []) {
    mkdirSync(join(sdk, 'system-images', img), { recursive: true });
    writeFileSync(join(sdk, 'system-images', img, 'system.img'), Buffer.alloc(2 * MB));
  }
}

function makeAvd(name: string, o: { config?: string; hq?: string | null; defaultBootMb?: number } = {}): string {
  const dir = join(avdHome, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `path=${dir}\n`);
  writeFileSync(join(dir, 'config.ini'), o.config ?? 'hw.ramSize=2048\nimage.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n');
  if (o.hq !== null && o.hq !== undefined) writeFileSync(join(dir, 'hardware-qemu.ini'), o.hq);
  if (o.defaultBootMb !== undefined) {
    mkdirSync(join(dir, 'snapshots', 'default_boot'), { recursive: true });
    writeFileSync(join(dir, 'snapshots', 'default_boot', 'ram.bin'), Buffer.alloc(o.defaultBootMb * MB));
  }
  return dir;
}

function setup(w: World = {}) {
  if (w.sdk !== null) makeSdk(w.sdk ?? {});
  const runtimes = (w.runtimes ?? ['26.4']).map((v) => ({
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${v.replace(/\./g, '-')}`,
    platform: 'iOS',
    version: v,
    isAvailable: true,
  }));
  const exec = createFakeExec((c: FakeCall) => {
    const line = `${c.cmd} ${c.args.join(' ')}`;
    if (line === 'xcodebuild -version') {
      if (w.xcode === 'missing') throw new Error('command not found: xcodebuild');
      return { stdout: 'Xcode 26.4\nBuild version 17E192\n' };
    }
    if (line === 'xcrun simctl list runtimes -j') {
      if (w.xcode === 'simctl-fails') return { code: 72, stderr: 'xcrun: error: unable to find utility "simctl"' };
      return { stdout: JSON.stringify({ runtimes }) };
    }
    if (line === 'xcrun simctl list devices -j') {
      if (w.xcode === 'missing' || w.xcode === 'simctl-fails') return { code: 72, stderr: 'xcrun: error' };
      const devices = { [RUNTIME]: (w.sims ?? []).map((s) => ({ state: 'Shutdown', ...s, isAvailable: true })) };
      return { stdout: JSON.stringify({ devices }) };
    }
    if (line === 'sysctl -n vm.swapusage') return { stdout: `${w.swap ?? SWAP_OK}\n` };
    if (line === 'pgrep -fl qemu-system') {
      const lines = Object.entries(w.qemu ?? {}).map(([pid, cmd]) => `${pid} ${cmd}\n`);
      return lines.length === 0 ? { code: 1 } : { stdout: lines.join('') };
    }
    if (c.cmd === 'ps' && c.args.slice(0, 3).join(' ') === '-o command= -p') {
      const cmd = w.qemu?.[c.args[3]];
      return cmd === undefined ? { code: 1 } : { stdout: `${cmd}\n` };
    }
    if (c.cmd === 'pgrep') return { code: 1 };
    return undefined;
  });
  const env = {
    HOME: root,
    ANDROID_HOME: sdk,
    ANDROID_AVD_HOME: avdHome,
    DEVSLIM_HOME: join(root, 'home'),
    PATH: bin,
    ...w.env,
  };
  const ctx: DoctorContext = { env, exec, storeBase, nodeVersion: w.nodeVersion ?? 'v25.9.0', pidAlive: w.alive ?? (() => true) };
  return { exec, ctx, env };
}

const only = (checks: readonly Check[], id: string) => checks.filter((c) => c.id === id);
const levels = (checks: readonly Check[], id: string) => only(checks, id).map((c) => c.level);
const noAdb = (calls: FakeCall[]) => {
  for (const c of calls) assert.doesNotMatch(`${c.cmd} ${c.args.join(' ')}`, /\badb\b/, 'doctor does not call adb');
};

test('order and ids: all checks show up, clean environment = only ok, exit 0', async () => {
  const { ctx, exec } = setup();
  const checks = await runDoctor(ctx);
  const ids = [...new Set(checks.map((c) => c.id))];
  assert.deepEqual(ids, [
    'node', 'xcode', 'android-sdk', 'emulator-version', 'avd-gpu', 'avd-ram', 'profile-drift', 'avd-image', 'running-off-profile', 'emulator-advertised', 'argent-gpu',
    'default-boot-snapshot', 'orphan-images', 'swap', 'ios-always-enabled', 'stale-session', 'orphan-state',
  ]);
  assert.deepEqual(checks.filter((c) => c.level !== 'ok'), []);
  assert.equal(doctorExitCode(checks), 0);
  for (const c of checks) assert.deepEqual(Object.keys(c).filter((k) => k !== 'fix'), ['id', 'level', 'message']);
  noAdb(exec.calls);
});

test('node: >= 25 ok; lower = fail', async () => {
  assert.deepEqual(levels(await runDoctor(setup({ nodeVersion: 'v25.0.0' }).ctx), 'node'), ['ok']);
  const c = only(await runDoctor(setup({ nodeVersion: 'v24.11.1' }).ctx), 'node');
  assert.equal(c[0].level, 'fail');
  assert.match(c[0].message, /24\.11\.1/);
});

test('xcode: iOS runtime >= 18.5 ok; only older = warn; no Xcode = warn; broken simctl = fail', async () => {
  const ok = only(await runDoctor(setup().ctx), 'xcode')[0];
  assert.equal(ok.level, 'ok');
  assert.match(ok.message, /Xcode 26\.4.*iOS 26\.4/);
  const old = only(await runDoctor(setup({ runtimes: ['17.5', '18.4'] }).ctx), 'xcode')[0];
  assert.equal(old.level, 'warn');
  assert.match(old.message, /18\.5/);
  assert.deepEqual(levels(await runDoctor(setup({ xcode: 'missing' }).ctx), 'xcode'), ['warn']);
  assert.deepEqual(levels(await runDoctor(setup({ xcode: 'simctl-fails' }).ctx), 'xcode'), ['fail']);
});

test('android-sdk: complete ok; no SDK warn; SDK missing a binary fail', async () => {
  assert.deepEqual(levels(await runDoctor(setup().ctx), 'android-sdk'), ['ok']);
  rmSync(sdk, { recursive: true, force: true });
  const none = only(await runDoctor(setup({ sdk: null }).ctx), 'android-sdk')[0];
  assert.equal(none.level, 'warn');
  assert.ok(none.fix);
  const partial = await runDoctor(setup({ sdk: { bins: ['emulator/emulator'] } }).ctx);
  const c = only(partial, 'android-sdk')[0];
  assert.equal(c.level, 'fail');
  assert.match(c.message, /adb/);
  assert.match(c.message, /avdmanager/);
  assert.equal(doctorExitCode(partial), 1);
});

test('emulator-version: < 37.2.13 warn with the GLES fix message; >= ok', async () => {
  const old = only(await runDoctor(setup({ sdk: { revision: '37.1.11' } }).ctx), 'emulator-version')[0];
  assert.equal(old.level, 'warn');
  assert.match(old.message, /37\.1\.11/);
  assert.match(old.message, /version without the host GLES memory leak fix/);
  rmSync(sdk, { recursive: true, force: true });
  assert.deepEqual(levels(await runDoctor(setup({ sdk: { revision: '37.2.13' } }).ctx), 'emulator-version'), ['ok']);
  rmSync(sdk, { recursive: true, force: true });
  assert.deepEqual(levels(await runDoctor(setup({ sdk: { revision: '38.0.1' } }).ctx), 'emulator-version'), ['ok']);
});

test('avd-gpu: lavapipe/swiftshader/software/guest = warn with tune fix; host ok; no hardware-qemu.ini ok', async () => {
  makeAvd('lava', { hq: 'hw.gpu.enabled = yes\nhw.gpu.mode = lavapipe\n' });
  makeAvd('swift', { hq: 'hw.gpu.mode = swiftshader_indirect\n' });
  makeAvd('soft', { hq: 'hw.gpu.mode = software\n' });
  makeAvd('guest', { hq: 'hw.gpu.mode = guest\n' });
  makeAvd('host', { hq: 'hw.gpu.mode = host\n' });
  makeAvd('fresh');
  const c = only(await runDoctor(setup().ctx), 'avd-gpu');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.deepEqual(Object.keys(by).sort(), ['fresh', 'guest', 'host', 'lava', 'soft', 'swift']);
  for (const n of ['lava', 'swift', 'soft', 'guest']) {
    assert.equal(by[n].level, 'warn', n);
    assert.equal(by[n].fix, `devslim android tune ${n}`);
  }
  assert.equal(by.host.level, 'ok');
  assert.equal(by.fresh.level, 'ok');
});

test('avd-ram: runtime above config.ini or above 3072 = warn; equal = ok', async () => {
  makeAvd('floor', { config: 'hw.ramSize=2G\n', hq: 'hw.ramSize = 2560\n' });
  makeAvd('big', { config: 'hw.ramSize=4096\n', hq: 'hw.ramSize = 4096\n' });
  makeAvd('right', { config: 'hw.ramSize=2048M\n', hq: 'hw.ramSize = 2048\n' });
  const c = only(await runDoctor(setup().ctx), 'avd-ram');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.equal(by.floor.level, 'warn');
  assert.match(by.floor.message, /2560 MB.*2048 MB/);
  assert.match(by.floor.message, /above the 2048 MB from config\.ini \(emulator raised it\)/);
  assert.doesNotMatch(by.floor.message, /floor applied/);
  assert.match(by.floor.fix, /^devslim android tune floor --lowram \(with the AVD shut down; the emulator ignores -memory below its floor without lowram; lowram changes app behavior: the guest reports itself as a low-RAM device\)$/);
  assert.equal(by.big.level, 'warn');
  assert.match(by.big.message, /3072/);
  assert.match(by.big.fix, /^devslim android tune big \(and start it with devslim android up, which passes -memory\)$/, 'no raise: the usual fix');
  assert.equal(by.right.level, 'ok');
});

test('avd-ram: compares with the last up/bake RAM (lastLaunch) when present; without the field, config.ini', async () => {
  const { env, ctx } = setup();
  const launched = (name: string, dir: string, ramMb: number) => {
    const profile = buildAndroidProfile({});
    recordAndroidTune(name, { avdDir: dir, originalConfigIni: 'x', originalConfigSha256: 'y', profile }, { env });
    const st = loadState<AndroidState>('android', name, { env })!;
    saveState('android', name, { ...st, lastLaunch: { ramMb, lowRam: false, at: '2026-11-17T09:00:00.000Z' } }, { env });
  };
  // up --ram 3072 without tune: config.ini stays 2048, emulator used 3072 = request honored.
  launched('override', makeAvd('override', { config: 'hw.ramSize=2048\n', hq: 'hw.ramSize = 3072\n' }), 3072);
  // last up requested 2048 and the emulator raised it to 2560: still warn.
  launched('raised', makeAvd('raised', { config: 'hw.ramSize=2048\n', hq: 'hw.ramSize = 2560\n' }), 2048);
  const c = only(await runDoctor(ctx), 'avd-ram');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.equal(by.override.level, 'ok');
  assert.equal(by.override.message, 'override: 3072 MB (requested at the last up/bake 3072 MB)');
  assert.equal(by.raised.level, 'warn');
  assert.match(by.raised.message, /last boot used 2560 MB, above the 2048 MB requested at the last up\/bake \(emulator raised it\)/);
  assert.match(by.raised.fix!, /--lowram/);
});

test('argent-gpu: argent on PATH without the variable = warn with export; host = ok; no argent = ok', async () => {
  const exe = join(bin, 'argent');
  writeFileSync(exe, '#!/bin/sh\nexit 99\n');
  chmodSync(exe, 0o755);
  const w = only(await runDoctor(setup().ctx), 'argent-gpu')[0];
  assert.equal(w.level, 'warn');
  assert.equal(w.fix, 'export ARGENT_EMULATOR_GPU_MODE=host');
  assert.match(w.message, /-gpu auto/);
  assert.deepEqual(levels(await runDoctor(setup({ env: { ARGENT_EMULATOR_GPU_MODE: 'host' } }).ctx), 'argent-gpu'), ['ok']);
  rmSync(exe);
  assert.deepEqual(levels(await runDoctor(setup().ctx), 'argent-gpu'), ['ok']);
  writeFileSync(exe, '#!/bin/sh\nexit 99\n');
  chmodSync(exe, 0o755);
  const s = setup();
  await runDoctor(s.ctx);
  assert.ok(!s.exec.calls.some((c) => c.cmd.endsWith('argent')), 'argent is never executed');
});

test('default-boot-snapshot: ram.bin present = warn with size in MB; absent = ok', async () => {
  makeAvd('cold', { defaultBootMb: 3 });
  makeAvd('clean');
  const c = only(await runDoctor(setup().ctx), 'default-boot-snapshot');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.match(c[0].message, /^cold: .*3 MB/);
  rmSync(join(avdHome, 'cold.avd', 'snapshots'), { recursive: true });
  assert.deepEqual(levels(await runDoctor(setup().ctx), 'default-boot-snapshot'), ['ok']);
});

test('orphan-images: image without a config.ini referencing it = warn with size; never deletes', async () => {
  const used = 'android-35/google_apis/arm64-v8a';
  const orphan = 'android-36.1/google_apis/arm64-v8a';
  makeAvd('a35');
  const { ctx } = setup({ sdk: { images: [used, orphan] } });
  const c = only(await runDoctor(ctx), 'orphan-images');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.match(c[0].message, /system-images\/android-36\.1\/google_apis\/arm64-v8a.*2 MB/);
  assert.ok(existsSync(join(sdk, 'system-images', orphan, 'system.img')), 'only reports');
  assert.ok(existsSync(join(sdk, 'system-images', used, 'system.img')));
  rmSync(join(sdk, 'system-images', orphan), { recursive: true });
  assert.deepEqual(levels(await runDoctor(ctx), 'orphan-images'), ['ok']);
});

test('swap: up to 80% ok, above warn, above 95% fail and exit 1', async () => {
  const at = (used: number) => `total = 1000.00M  used = ${used}.00M  free = 0.00M  (encrypted)`;
  assert.deepEqual(levels(await runDoctor(setup({ swap: at(800) }).ctx), 'swap'), ['ok']);
  assert.deepEqual(levels(await runDoctor(setup({ swap: at(850) }).ctx), 'swap'), ['warn']);
  const high = await runDoctor(setup({ swap: at(961) }).ctx);
  const c = only(high, 'swap')[0];
  assert.equal(c.level, 'fail');
  assert.match(c.message, /do not boot a device now/);
  assert.equal(doctorExitCode(high), 1);
});

test('swap: no swap file (total 0) = ok with 0 MB in use, not "not read"; garbage = warn not read', async () => {
  const zero = only(await runDoctor(setup({ swap: 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)' }).ctx), 'swap');
  assert.deepEqual(zero.map((c) => [c.level, c.message]), [['ok', 'swap with 0 MB in use (no swap file)']]);
  const junk = only(await runDoctor(setup({ swap: 'garbage' }).ctx), 'swap');
  assert.deepEqual(junk.map((c) => [c.level, c.message]), [['warn', 'sysctl vm.swapusage not read']]);
});

test('swap: doctor and up agree on the thresholds (same src/swap.ts constant) and the message', async () => {
  assert.equal(DOCTOR_WARN, SWAP_WARN_PERCENT);
  assert.equal(DOCTOR_FAIL, SWAP_FAIL_PERCENT);
  // Used in tenths of MB out of a 1000 MB total: exact percent.
  const at = (pct: number) => `total = 1000.00M  used = ${(pct * 10).toFixed(2)}M  free = 0.00M  (encrypted)`;
  const cases: Array<[number, 'ok' | 'warn' | 'fail']> = [
    [SWAP_WARN_PERCENT, 'ok'],
    [SWAP_WARN_PERCENT + 0.1, 'warn'],
    [SWAP_FAIL_PERCENT, 'warn'],
    [SWAP_FAIL_PERCENT + 0.1, 'fail'],
  ];
  for (const [pct, expected] of cases) {
    const checks = await runDoctor(setup({ swap: at(pct) }).ctx);
    const doc = only(checks, 'swap')[0];
    assert.equal(doc.level, expected, `doctor at ${pct}%`);
    const gateExec = createFakeExec((c: FakeCall) => (c.cmd === 'sysctl' ? { stdout: `${at(pct)}\n` } : undefined));
    const err: string[] = [];
    let refused: string | null = null;
    try {
      await swapGate({ exec: gateExec, stderr: (t) => { err.push(t); }, force: false, action: 'up' });
    } catch (e) {
      refused = (e as Error).message;
    }
    assert.equal(refused !== null, expected === 'fail', `up refuses at ${pct}%`);
    assert.equal(err.length > 0, expected === 'warn', `up warns at ${pct}%`);
    if (refused !== null) assert.ok(refused.includes(doc.message) && refused.includes(doc.fix!), 'same message and fix as doctor');
    if (err.length > 0) assert.ok(err[0].includes(doc.message), 'same doctor text in the warning');
  }
});

test('ios-always-enabled: store with ALWAYS_ENABLED disabled = warn with ios up fix; clean = ok', async () => {
  const p = storePath(UDID, { base: storeBase });
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, serializeStorePlist(new Map([['com.apple.assistantd', true], ['com.apple.gamed', true], ['com.apple.sharingd', false]])));
  const sims = [{ udid: UDID, name: 'QA-iPhone17' }];
  const c = only(await runDoctor(setup({ sims }).ctx), 'ios-always-enabled')[0];
  assert.equal(c.level, 'warn');
  assert.match(c.message, /QA-iPhone17.*com\.apple\.assistantd, com\.apple\.gamed/);
  assert.doesNotMatch(c.message, /sharingd/);
  assert.equal(c.fix, 'devslim ios up QA-iPhone17');
  writeFileSync(p, serializeStorePlist(new Map([['com.apple.gamed', false]])));
  assert.deepEqual(levels(await runDoctor(setup({ sims }).ctx), 'ios-always-enabled'), ['ok']);
});

test('stale-session: dead entry = warn with devslim down fix; empty session ok', async () => {
  const { ctx, env } = setup();
  assert.deepEqual(levels(await runDoctor(ctx), 'stale-session'), ['ok']);
  recordSession({ platform: 'android', avd: 'dead', serial: 'emulator-5554', pid: 1, port: 5554, startedAt: 'x' }, env);
  const c = only(await runDoctor(ctx), 'stale-session')[0];
  assert.equal(c.level, 'warn');
  assert.match(c.message, /android dead emulator-5554/);
  assert.equal(c.fix, 'devslim down');
});

test('dirSize: recursive sum; depth and file limits set truncated', () => {
  const d = join(root, 'tree');
  mkdirSync(join(d, 'a', 'b', 'c'), { recursive: true });
  writeFileSync(join(d, 'x'), Buffer.alloc(100));
  writeFileSync(join(d, 'a', 'y'), Buffer.alloc(200));
  writeFileSync(join(d, 'a', 'b', 'c', 'z'), Buffer.alloc(300));
  assert.deepEqual(dirSize(d), { bytes: 600, files: 3, truncated: false });
  assert.deepEqual(dirSize(d, { maxDepth: 1 }), { bytes: 300, files: 2, truncated: true });
  assert.equal(dirSize(d, { maxFiles: 1 }).truncated, true);
  assert.deepEqual(dirSize(join(root, 'does-not-exist')), { bytes: 0, files: 0, truncated: false });
});

test('cli doctor: text with level per line, --json and exit code', async () => {
  makeAvd('lava', { hq: 'hw.gpu.mode = lavapipe\n' });
  const { ctx, exec } = setup({ swap: 'total = 1000.00M  used = 990.00M  free = 10.00M  (encrypted)' });
  const run = async (args: string[]) => {
    let stdout = '';
    const code = await main(args, {
      stdout: (t) => { stdout += t; },
      stderr: () => {},
      env: ctx.env!,
      cwd: root,
      runtime: { exec, storeBase },
    });
    return { code, stdout };
  };
  const t = await run(['doctor']);
  assert.equal(t.code, 1);
  assert.match(t.stdout, /^\[warn\] avd-gpu: lava: /m);
  assert.match(t.stdout, /^ {7}fix: devslim android tune lava$/m);
  assert.match(t.stdout, /^\[fail\] swap: /m);
  const j = await run(['doctor', '--json']);
  assert.equal(j.code, 1);
  const arr = JSON.parse(j.stdout);
  assert.ok(Array.isArray(arr));
  assert.ok(arr.some((c: Check) => c.id === 'swap' && c.level === 'fail'));
  noAdb(exec.calls);
});

// Real lines (2026-11-16): argent launches with -gpu auto and -netfast, without -memory/-cores.
const QEMU = '/opt/homebrew/share/android-commandlinetools/emulator/qemu/darwin-aarch64/qemu-system-aarch64';
const argentLine = (avd: string) => `${QEMU} -avd ${avd} -no-snapshot-load -gpu auto -feature -Vulkan -noaudio -no-boot-anim -netfast -no-metrics -crash-report-mode never`;
const devslimLine = (avd: string) => `${QEMU} -avd ${avd} -gpu host -memory 2048 -cores 2 -port 5554 -no-window -no-audio -camera-back none -camera-front none -feature -Vulkan -no-boot-anim -no-metrics -no-snapshot`;
const studioLine = (avd: string) => `${QEMU} -netdelay none -netspeed full -avd ${avd} -qt-hide-window`;

function tuned(name: string, dir: string, env: Record<string, string>) {
  recordAndroidTune(name, { avdDir: dir, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
}

test('running-off-profile: nothing running = one ok; does not call ps or adb', async () => {
  const { ctx, exec } = setup();
  const c = only(await runDoctor(ctx), 'running-off-profile');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', 'no emulator running']]);
  assert.ok(!exec.calls.some((x) => x.cmd === 'ps'));
  noAdb(exec.calls);
});

test('running-off-profile: tuned AVD launched by argent on lavapipe = warn with facts and a two-line fix; avd-gpu stays (last boot)', async () => {
  const dir = makeAvd('qa-tablet-api35', { hq: 'hw.ramSize = 4096\nhw.gpu.mode = lavapipe\n' });
  const { ctx, exec, env } = setup({ qemu: { 9421: argentLine('qa-tablet-api35') } });
  tuned('qa-tablet-api35', dir, env);
  const checks = await runDoctor(ctx);
  const c = only(checks, 'running-off-profile');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.equal(
    c[0].message,
    'qa-tablet-api35 (pid 9421) running now: launched by argent, effective gpu lavapipe (software rendering), effective ram 4096 MB; tune profile: gpu host, 2048 MB',
  );
  assert.equal(c[0].fix, 'stop the emulator and start it with: devslim android up qa-tablet-api35\nor export ARGENT_EMULATOR_GPU_MODE=host in the argent environment');
  const gpu = only(checks, 'avd-gpu')[0];
  assert.equal(gpu.level, 'warn');
  assert.match(gpu.message, /last boot/);
  noAdb(exec.calls);
});

test('running-off-profile: foreign launcher on a tuned AVD with gpu host = warn; same launcher on an AVD without state = ok', async () => {
  const dir = makeAvd('tuned-avd', { hq: 'hw.ramSize = 2048\nhw.gpu.mode = host\n' });
  makeAvd('free', { hq: 'hw.ramSize = 2048\nhw.gpu.mode = host\n' });
  const { ctx, env } = setup({ qemu: { 100: studioLine('tuned-avd'), 200: argentLine('free') } });
  tuned('tuned-avd', dir, env);
  const c = only(await runDoctor(ctx), 'running-off-profile');
  assert.deepEqual(c.map((x) => [x.level, x.message.split(' ')[0]]), [['warn', 'tuned-avd']]);
  assert.match(c[0].message, /^tuned-avd \(pid 100\) running now: launched outside devslim, effective gpu host, effective ram 2048 MB; tune profile: gpu host, 2048 MB$/);
});

test('running-off-profile: software GPU without state = warn; devslim with gpu host = ok', async () => {
  makeAvd('soft', { hq: 'hw.gpu.mode = swiftshader_indirect\n' });
  const { ctx } = setup({ qemu: { 300: studioLine('soft') } });
  const w = only(await runDoctor(ctx), 'running-off-profile');
  assert.deepEqual(w.map((x) => x.level), ['warn']);
  assert.match(w[0].message, /^soft \(pid 300\) running now: launched outside devslim, effective gpu swiftshader_indirect \(software rendering\)$/);

  rmSync(join(avdHome, 'soft.avd'), { recursive: true });
  rmSync(join(avdHome, 'soft.ini'));
  const dir = makeAvd('bench-api35', { hq: 'hw.ramSize = 2560\nhw.gpu.mode = host\n' });
  const ok = setup({ qemu: { 73808: devslimLine('bench-api35') } });
  tuned('bench-api35', dir, ok.env);
  const c = only(await runDoctor(ok.ctx), 'running-off-profile');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '1 emulator(s) running on the profile']]);
});

test('cli doctor: a two-line fix comes out indented in the text', async () => {
  const dir = makeAvd('qa-tablet-api35', { hq: 'hw.gpu.mode = lavapipe\n' });
  const { ctx, exec, env } = setup({ qemu: { 9421: argentLine('qa-tablet-api35') } });
  tuned('qa-tablet-api35', dir, env);
  let stdout = '';
  await main(['doctor'], { stdout: (t) => { stdout += t; }, stderr: () => {}, env: ctx.env!, cwd: root, runtime: { exec, storeBase, pidAlive: ctx.pidAlive } });
  assert.match(stdout, /^\[warn\] running-off-profile: qa-tablet-api35 \(pid 9421\) running now: /m);
  assert.match(stdout, /^ {7}fix: stop the emulator and start it with: devslim android up qa-tablet-api35\n {12}or export ARGENT_EMULATOR_GPU_MODE=host in the argent environment$/m);
  noAdb(exec.calls);
});

// ---------------------------------------------------------------------------
// emulator-advertised: avd/running/pid_<pid>.ini (HOME=root no env do setup)

const RUNNING_FIXTURE = readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8');
const runningDirOf = () => join(root, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
function announce(text: string, pid = 73900): void {
  mkdirSync(runningDirOf(), { recursive: true });
  writeFileSync(join(runningDirOf(), `pid_${pid}.ini`), text);
}

test('emulator-advertised: nothing running = ok; running without entry = warn with fix; does not call adb', async () => {
  assert.deepEqual(only(await runDoctor(setup().ctx), 'emulator-advertised').map((c) => [c.level, c.message]), [['ok', 'no emulator running']]);
  makeAvd('bench-api35', { hq: 'hw.gpu.mode = host\n' });
  const { ctx, exec } = setup({ qemu: { 73808: devslimLine('bench-api35') } });
  const c = only(await runDoctor(ctx), 'emulator-advertised');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.equal(
    c[0].message,
    `bench-api35 (pid 73808) running with no entry in ${runningDirOf()}: tools that rely on gRPC (argent screenshot/tap) cannot see it; adb works normally`,
  );
  assert.equal(c[0].fix, 'devslim android down bench-api35 and devslim android up bench-api35 (launches with -grpc <port> -grpc-use-token)');
  noAdb(exec.calls);
});

test('emulator-advertised: entry with grpc.port and token = ok; no token = warn; token never shows; running-off-profile unchanged', async () => {
  const dir = makeAvd('bench-api35', { hq: 'hw.ramSize = 2560\nhw.gpu.mode = host\n' });
  announce(RUNNING_FIXTURE);
  const { ctx, exec, env } = setup({ qemu: { 73808: devslimLine('bench-api35') } });
  tuned('bench-api35', dir, env);
  const checks = await runDoctor(ctx);
  assert.deepEqual(only(checks, 'emulator-advertised').map((c) => [c.level, c.message]), [['ok', `1 emulator(s) running, all advertised in ${runningDirOf()}`]]);
  assert.deepEqual(levels(checks, 'running-off-profile'), ['ok']);
  assert.ok(!JSON.stringify(checks).includes('abc123'));

  announce(RUNNING_FIXTURE.replace('grpc.token=abc123', ''));
  const w = only(await runDoctor(ctx), 'emulator-advertised');
  assert.deepEqual(w.map((c) => c.level), ['warn']);
  assert.match(w[0].message, /^bench-api35 \(pid 73808\) running with an entry in .* lacking grpc\.token: /);
  assert.ok(!JSON.stringify(w).includes('abc123'));
  noAdb(exec.calls);
});

test('cli doctor --json and text: emulator-advertised without token in the output', async () => {
  makeAvd('bench-api35', { hq: 'hw.gpu.mode = host\n' });
  announce(RUNNING_FIXTURE);
  const { ctx, exec } = setup({ qemu: { 73808: devslimLine('bench-api35'), 9421: argentLine('qa-tablet-api35') } });
  let stdout = '';
  await main(['doctor'], { stdout: (t) => { stdout += t; }, stderr: () => {}, env: ctx.env!, cwd: root, runtime: { exec, storeBase, pidAlive: ctx.pidAlive } });
  await main(['doctor', '--json'], { stdout: (t) => { stdout += t; }, stderr: () => {}, env: ctx.env!, cwd: root, runtime: { exec, storeBase, pidAlive: ctx.pidAlive } });
  assert.match(stdout, /^\[warn\] emulator-advertised: qa-tablet-api35 \(pid 9421\) running with no entry in /m);
  assert.doesNotMatch(stdout, /emulator-advertised: bench-api35/);
  assert.ok(!stdout.includes('abc123'));
  noAdb(exec.calls);
});

test('emulator-advertised: a dead pid entry does not count; an ok line reports the count; nothing deleted', async () => {
  makeAvd('bench-api35', { hq: 'hw.gpu.mode = host\n' });
  announce(RUNNING_FIXTURE, 73900); // earlier boot that crashed
  const { ctx, exec } = setup({ qemu: { 73808: devslimLine('bench-api35') }, alive: (pid) => pid !== 73900 });
  const c = only(await runDoctor(ctx), 'emulator-advertised');
  assert.deepEqual(c.map((x) => x.level), ['warn', 'ok']);
  assert.match(c[0].message, /^bench-api35 \(pid 73808\) running with no entry in /);
  assert.equal(c[1].message, `1 dead emulator entry(ies) in ${runningDirOf()} ignored: pid_73900.ini (bench-api35); emulator files, nothing deleted`);
  assert.ok(existsSync(join(runningDirOf(), 'pid_73900.ini')), 'stale stays on disk');
  assert.ok(!JSON.stringify(c).includes('abc123'));
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0, 'stale does not fail');

  // Live + dead of the same AVD: the live one advertises, the dead one only shows in the count.
  announce(RUNNING_FIXTURE, 73808);
  const both = only(await runDoctor(ctx), 'emulator-advertised');
  assert.deepEqual(both.map((x) => [x.level, x.message.split(':')[0]]), [
    ['ok', `1 emulator(s) running, all advertised in ${runningDirOf()}`],
    ['ok', `1 dead emulator entry(ies) in ${runningDirOf()} ignored`],
  ]);

  // Nothing running: only the leftover.
  const idle = only(await runDoctor(setup({ alive: () => false }).ctx), 'emulator-advertised');
  assert.deepEqual(idle.map((x) => x.level), ['ok', 'ok']);
  assert.equal(idle[0].message, 'no emulator running');
  assert.match(idle[1].message, /^2 dead emulator entry\(ies\) in .* ignored: pid_73808\.ini \(bench-api35\), pid_73900\.ini \(bench-api35\); /);
  noAdb(exec.calls);
});

// ---------------------------------------------------------------------------
// profile-drift: current config.ini vs what the profile saved in the state would produce

const PHONE_INI = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url), 'utf8');

// AVD tuned with the profile: config.ini = applyProfile output over the fixture.
function tunedAvd(name: string, env: Record<string, string>, opts: AndroidProfileOptions = {}): { dir: string; config: string } {
  const profile = buildAndroidProfile(opts);
  const config = serializeIni(applyProfile(parseIni(PHONE_INI), profile).doc);
  const dir = makeAvd(name, { config });
  recordAndroidTune(name, { avdDir: dir, originalConfigIni: PHONE_INI, originalConfigSha256: 'y', profile }, { env });
  return { dir, config };
}

const editIni = (dir: string, edits: Record<string, string>) => {
  let doc = parseIni(readFileSync(join(dir, 'config.ini'), 'utf8'));
  for (const [k, v] of Object.entries(edits)) doc = setValue(doc, k, v);
  writeFileSync(join(dir, 'config.ini'), serializeIni(doc));
};

test('profile-drift: no state = ok; config.ini matching the saved profile = ok; read-only', async () => {
  assert.deepEqual(only(await runDoctor(setup().ctx), 'profile-drift').map((c) => [c.level, c.message]), [['ok', 'no AVD with devslim state']]);
  const { ctx, env } = setup();
  const { dir, config } = tunedAvd('bench-api35', env, { capabilities: ['camera'] });
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '1 AVD(s) with config.ini matching the saved profile']]);
  assert.equal(readFileSync(join(dir, 'config.ini'), 'utf8'), config, 'doctor does not write');
});

test('profile-drift: hw.gps=yes without location in the profile = warn with --need adding to the saved capabilities', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('bench-api35', env, { capabilities: ['camera'] });
  editIni(dir, { 'hw.gps': 'yes' });
  const before = readFileSync(join(dir, 'config.ini'), 'utf8');
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.equal(c[0].message, 'bench-api35: config.ini differs from the saved profile in 1 key(s): hw.gps: current=yes expected=no');
  assert.equal(
    c[0].fix,
    'devslim android tune bench-api35 --need camera,location (the current config.ini needs location)\nor devslim android tune bench-api35 to return to the saved profile',
  );
  assert.equal(readFileSync(join(dir, 'config.ini'), 'utf8'), before, 'read-only');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0, 'drift is warn, not fail');
});

test('profile-drift: generic drift lists each key (absent included); fix is just tune', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('bench-api35', env);
  editIni(dir, { 'hw.ramSize': '4096', 'hw.gpu.mode': 'auto' });
  writeFileSync(join(dir, 'config.ini'), readFileSync(join(dir, 'config.ini'), 'utf8').replace(/^showDeviceFrame=no\r?\n/m, ''));
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(c.map((x) => x.level), ['warn']);
  assert.equal(
    c[0].message,
    'bench-api35: config.ini differs from the saved profile in 3 key(s): hw.ramSize: current=4096 expected=2048; hw.gpu.mode: current=auto expected=host; showDeviceFrame: current=(absent) expected=no',
  );
  assert.equal(c[0].fix, 'devslim android tune bench-api35');
});

test('profile-drift: AVD with state but missing, or unreadable config.ini, is skipped without failing', async () => {
  const { ctx, env } = setup();
  recordAndroidTune('removed-api35', { avdDir: join(avdHome, 'removed-api35.avd'), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  const only1 = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(only1.map((x) => [x.level, x.message]), [['ok', '0 AVD(s) with config.ini matching the saved profile; 1 skipped (missing AVD or unreadable config.ini)']]);

  const { dir } = tunedAvd('bench-api35', env, { capabilities: ['location'] });
  const broken = makeAvd('broken-api35');
  recordAndroidTune('broken-api35', { avdDir: broken, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  rmSync(join(broken, 'config.ini'));
  mkdirSync(join(broken, 'config.ini')); // directory in place of the file
  editIni(dir, { 'hw.gps': 'no' });
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(c.map((x) => x.level), ['warn']);
  assert.equal(c[0].message, 'bench-api35: config.ini differs from the saved profile in 1 key(s): hw.gps: current=no expected=yes');
  assert.equal(c[0].fix, 'devslim android tune bench-api35 --need none (the current config.ini drops location)\nor devslim android tune bench-api35 to return to the saved profile');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0);
});

// ---------------------------------------------------------------------------
// avd-image: system image tag vs capabilities that require Google services

const ATD = (tag: string, api = 35) => ({ 'tag.id': tag, 'tag.ids': tag, 'image.sysdir.1': `system-images/android-${api}/${tag}/arm64-v8a/` });

test('avd-image: no state = ok', async () => {
  assert.deepEqual(only(await runDoctor(setup().ctx), 'avd-image').map((c) => [c.level, c.message]), [['ok', 'no AVD with devslim state']]);
});

test('avd-image: google_apis without push/weblogin/store = non-blocking note suggesting ATD with the measured number', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('bench-api35', env, { capabilities: ['camera', 'keyboard'] });
  const before = readFileSync(join(dir, 'config.ini'), 'utf8');
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => x.level), ['ok']);
  assert.match(c[0].message, /^bench-api35: image google_apis \(full Google services\) and the profile does not need push, weblogin or store; /);
  assert.match(c[0].message, /3660 MB vs 4343 MB of host phys_footprint, 2 min idle, one measurement/);
  assert.equal(c[0].fix, 'devslim android create bench-api35-atd --image aosp_atd');
  assert.equal(readFileSync(join(dir, 'config.ini'), 'utf8'), before, 'read-only');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0);
});

test('avd-image: playstore and API other than 35 = note with --api', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('loja-api34', env);
  editIni(dir, ATD('google_apis_playstore', 34));
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => x.level), ['ok']);
  assert.equal(c[0].fix, 'devslim android create loja-api34-atd --image aosp_atd --api 34');
});

test('avd-image: ATD or default with push/weblogin/store = warn saying it does not work', async () => {
  const { ctx, env } = setup();
  const a = tunedAvd('atd-api35', env, { capabilities: ['push', 'weblogin'] });
  editIni(a.dir, ATD('aosp_atd'));
  const d = tunedAvd('def-api35', env, { capabilities: ['store'] });
  editIni(d.dir, ATD('default'));
  const g = tunedAvd('gatd-api35', env, { capabilities: ['push'] });
  editIni(g.dir, ATD('google_atd'));
  const c = only(await runDoctor(ctx), 'avd-image');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.deepEqual(c.map((x) => x.level), ['warn', 'warn', 'warn']);
  assert.match(by['atd-api35'].message, /image aosp_atd \(no Google services\) and the profile needs push,weblogin: does not work on this image/);
  assert.match(by['def-api35'].message, /image default \(no Google services\) and the profile needs store: does not work on this image/);
  assert.match(by['gatd-api35'].message, /image google_atd \(reduced Google services\) and the profile needs push: may not work on this image/);
  assert.equal(by['atd-api35'].fix, 'devslim android create atd-api35-gapis --image google_apis');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0, 'warn does not break the exit');
});

test('avd-image: google_apis with a Google capability and ATD without it = ok; tag only from image.sysdir.1 also works', async () => {
  const { ctx, env } = setup();
  tunedAvd('login-api35', env, { capabilities: ['weblogin'] });
  const a = tunedAvd('ui-api35', env, { capabilities: ['camera'] });
  editIni(a.dir, ATD('aosp_atd'));
  const b = tunedAvd('notag-api35', env, { capabilities: ['push'] });
  let doc = parseIni(readFileSync(join(b.dir, 'config.ini'), 'utf8'));
  doc = setValue(doc, 'tag.id', '');
  doc = setValue(doc, 'image.sysdir.1', 'system-images/android-35/google_apis/arm64-v8a/');
  writeFileSync(join(b.dir, 'config.ini'), serializeIni(doc));
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '3 AVD(s) with an image compatible with the profile capabilities']]);
});

test('avd-image: missing AVD, unreadable config.ini or no tag = skipped', async () => {
  const { ctx, env } = setup();
  recordAndroidTune('removed-api35', { avdDir: join(avdHome, 'removed-api35.avd'), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  const broken = makeAvd('broken-api35');
  recordAndroidTune('broken-api35', { avdDir: broken, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  rmSync(join(broken, 'config.ini'));
  mkdirSync(join(broken, 'config.ini'));
  const notag = makeAvd('notag-api35', { config: 'hw.ramSize=2048\n' });
  recordAndroidTune('notag-api35', { avdDir: notag, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '0 AVD(s) with an image compatible with the profile capabilities; 3 skipped (missing AVD, unreadable config.ini or no image tag)']]);
});
