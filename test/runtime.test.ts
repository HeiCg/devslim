import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { bakeAvd, createAvd, downAvd, pickFreePort, upAvd } from '../src/android/runtime.ts';
import { loadSession, recordSession } from '../src/android/session.ts';
import { tuneAvd } from '../src/android/tune.ts';
import { DevslimError } from '../src/errors.ts';
import { loadState, type AndroidState } from '../src/state.ts';

const PHONE = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url));
const AVD = 'slim-api35';

let root: string;
let avdHome: string;
let devslimHome: string;
let avdDir: string;
let stderr: string[];
let running: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-runtime-'));
  avdHome = join(root, 'avd');
  devslimHome = join(root, 'devslim-home');
  avdDir = join(avdHome, `${AVD}.avd`);
  mkdirSync(avdDir, { recursive: true });
  writeFileSync(join(avdHome, `${AVD}.ini`), `path=${avdDir}\n`);
  writeFileSync(join(avdDir, 'config.ini'), PHONE);
  stderr = [];
  running = join(root, 'avd-running'); // does not exist until the test creates it
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function world(opts: FakeAndroidOptions = {}) {
  const fake = createFakeAndroid({ avdHome, avdDir: (name) => join(avdHome, `${name}.avd`), ...opts });
  const env = { ANDROID_HOME: fake.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: devslimHome, HOME: root };
  const ctx = {
    env,
    exec: fake.exec,
    spawnDetached: fake.spawnDetached,
    sleep: fake.sleep,
    now: fake.now,
    date: fake.date,
    fileExists: fake.fileExists,
    dirExists: fake.dirExists,
    arch: fake.arch,
    stderr: (t: string) => { stderr.push(t); },
    runningDir: running,
    pidAlive: (_pid: number) => true, // pid_<pid>.ini in the advertisement tests = live emulator
  };
  return { fake, env, ctx };
}

const BASE_ARGS = [
  '-avd', AVD, '-gpu', 'host', '-memory', '2048', '-cores', '2', '-port', '5554', '-grpc', '8554', '-grpc-use-token',
  '-no-window', '-no-audio', '-camera-back', 'none', '-camera-front', 'none', '-feature', '-Vulkan',
  '-no-boot-anim', '-no-metrics',
];

const INSTALLED = ['com.google.android.youtube', 'com.google.android.apps.photos', 'com.android.chrome', 'com.example.app'];

test('up without slim_base: -no-snapshot, -port always, log in $DEVSLIM_HOME/logs, session recorded', async () => {
  const { fake, ctx, env } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(fake.spawnCalls.length, 1);
  const call = fake.spawnCalls[0];
  assert.equal(call.cmd, fake.tools.emulator);
  assert.deepEqual(call.args, [...BASE_ARGS, '-no-snapshot']);
  assert.equal(call.opts.logFile, join(devslimHome, 'logs', `${AVD}.log`));
  assert.ok(existsSync(join(devslimHome, 'logs')));
  assert.equal(r.serial, 'emulator-5554');
  assert.equal(r.port, 5554);
  assert.equal(r.fromSnapshot, false);
  assert.equal(r.alreadyRunning, false);
  assert.equal(r.pid, fake.emulators.get('emulator-5554')!.pid);
  assert.deepEqual(loadSession(env).map((e) => [e.platform, e.avd, e.serial, e.pid, e.port]), [['android', AVD, 'emulator-5554', r.pid, 5554]]);
  assert.ok(fake.exec.calls.some((c) => c.args.join(' ') === '-s emulator-5554 shell getprop sys.boot_completed'), 'waited for boot');
  assert.ok(fake.exec.calls.some((c) => c.cmd === 'sysctl'), 'checked swap');
});

test('up with snapshots/slim_base: -snapshot slim_base -no-snapshot-save, -port present', async () => {
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile({ port: 5558 }), ctx);
  const expected = [...BASE_ARGS, '-snapshot', 'slim_base', '-no-snapshot-save'];
  expected[expected.indexOf('-port') + 1] = '5558';
  expected[expected.indexOf('-grpc') + 1] = '8558';
  assert.deepEqual(fake.spawnCalls[0].args, expected);
  assert.equal(r.fromSnapshot, true);
  assert.equal(r.serial, 'emulator-5558');
});

test('pickFreePort: first free even port from 5554 on', () => {
  assert.equal(pickFreePort([]), 5554);
  assert.equal(pickFreePort([{ serial: 'emulator-5554', state: 'device' }, { serial: 'emulator-5556', state: 'offline' }]), 5558);
  assert.equal(pickFreePort([{ serial: 'emulator-5556', state: 'device' }, { serial: 'R58M', state: 'device' }]), 5554);
  assert.equal(pickFreePort([{ serial: 'emulator-5555', state: 'device' }]), 5556, 'odd port takes the pair');
});

test('up with --force picks a free port according to adb devices', async () => {
  const { fake, ctx } = world({ emulators: [{ avd: 'other', port: 5554 }, { avd: 'one-more', port: 5556 }] });
  const r = await upAvd(AVD, buildAndroidProfile(), { ...ctx, force: true });
  assert.equal(r.port, 5558);
  const args = fake.spawnCalls[0].args;
  assert.equal(args[args.indexOf('-port') + 1], '5558');
});

test('up refuses with another emulator running (guard) and starts nothing', async () => {
  const { fake, ctx } = world({ emulators: [{ avd: 'other', port: 5554 }] });
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), ctx), /up refused: .*emulator-5554/);
  assert.equal(fake.spawnCalls.length, 0);
});

test('up with an explicit busy port errors', async () => {
  const { ctx } = world({ emulators: [{ avd: 'other', port: 5556 }] });
  await assert.rejects(upAvd(AVD, buildAndroidProfile({ port: 5556 }), { ...ctx, force: true }), /port 5556 already in use/);
});

test('up with the AVD already running: does not start another, returns the existing one', async () => {
  const { fake, ctx, env } = world({ emulators: [{ avd: AVD, port: 5556, pid: 777 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5556', pid: 777, port: 5556, startedAt: 'x' }, env);
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(fake.spawnCalls.length, 0);
  assert.deepEqual(
    { serial: r.serial, pid: r.pid, port: r.port, alreadyRunning: r.alreadyRunning, fromSnapshot: r.fromSnapshot },
    { serial: 'emulator-5556', pid: 777, port: 5556, alreadyRunning: true, fromSnapshot: null },
  );
});

test('up: a boot that never finishes becomes an error with log and down hint; session stays recorded', async () => {
  const { ctx, env } = world({ spawned: { neverBoots: true } });
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), { ...ctx, bootTimeoutMs: 6000, pollMs: 2000 }), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.match(err.message, /did not finish booting within 6 s/);
    assert.match(err.message, /logs\/slim-api35\.log/);
    assert.match(err.message, /devslim android down slim-api35/);
    return true;
  });
  assert.equal(loadSession(env).length, 1);
});

const swapAt = (pct: number) => `total = 1000.00M  used = ${pct * 10}.00M  free = ${1000 - pct * 10}.00M  (encrypted)`;

test('swap on up: 79% no warning; 85% warns and boots', async () => {
  const low = world({ swap: swapAt(79) });
  await upAvd(AVD, buildAndroidProfile(), low.ctx);
  assert.equal(low.fake.spawnCalls.length, 1);
  assert.doesNotMatch(stderr.join(''), /swap/);

  const mid = world({ swap: swapAt(85) });
  await upAvd(AVD, buildAndroidProfile(), mid.ctx);
  assert.equal(mid.fake.spawnCalls.length, 1);
  assert.match(stderr.join(''), /^devslim: warning: swap at 85% \(850 of 1000 MB\): above 80%$/m);
});

test('swap on up: 96% refuses without --force (nothing starts, empty session); with --force boots and warns', async () => {
  const hi = world({ swap: swapAt(96) });
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), hi.ctx), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.equal(err.message, 'up refused: swap at 96% (960 of 1000 MB): do not boot a device now; close idle apps, sessions and devices before starting a device (--force to boot anyway)');
    return true;
  });
  assert.equal(hi.fake.spawnCalls.length, 0);
  assert.deepEqual(loadSession(hi.env), []);

  const forced = world({ swap: swapAt(96) });
  const r = await upAvd(AVD, buildAndroidProfile(), { ...forced.ctx, force: true });
  assert.equal(r.alreadyRunning, false);
  assert.equal(forced.fake.spawnCalls.length, 1);
  assert.match(stderr.join(''), /warning: swap at 96% .*--force: booting anyway/);
});

test('swap on up: AVD already running at 96% is not blocked', async () => {
  const { fake, ctx } = world({ swap: swapAt(96), emulators: [{ avd: AVD, port: 5554 }] });
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.alreadyRunning, true);
  assert.equal(fake.spawnCalls.length, 0);
});

test('swap on bake: 96% refuses without --force with the same message', async () => {
  const { fake, ctx, env } = world({ swap: swapAt(96) });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), ctx), /^DevslimError: bake refused: swap at 96% \(960 of 1000 MB\): do not boot a device now; .*--force to boot anyway/);
  assert.equal(fake.spawnCalls.length, 0);
});

test('bake without tune state errors telling you to run tune', async () => {
  const { fake, ctx } = world();
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), ctx), /has not been tuned yet; run first: devslim android tune slim-api35/);
  assert.equal(fake.spawnCalls.length, 0);
});

test('bake refuses a running AVD', async () => {
  const { ctx, env } = world({ emulators: [{ avd: AVD, port: 5554 }] });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), ctx), /is running \(emulator-5554\); shut it down before bake/);
});

test('up writes lastLaunch {ramMb, lowRam, at} to the tuned AVD state; an AVD without state gets none', async () => {
  const { ctx, env } = world();
  tuneAvd(AVD, buildAndroidProfile(), { env }); // profile 2048
  await upAvd(AVD, buildAndroidProfile({ ramMb: 4096 }), ctx); // up --ram 4096 without tune
  const st = loadState<AndroidState>('android', AVD, { env })!;
  assert.deepEqual(st.lastLaunch, { ramMb: 4096, lowRam: false, at: '2026-11-16T12:00:00.000Z' });
  assert.equal(st.profile.ramMb, 2048, 'tune profile intact');
  assert.equal(typeof st.originalConfigIni, 'string');

  const other = world();
  const fresh = join(avdHome, 'fresh-api35.avd');
  mkdirSync(fresh, { recursive: true });
  writeFileSync(join(avdHome, 'fresh-api35.ini'), `path=${fresh}\n`);
  writeFileSync(join(fresh, 'config.ini'), PHONE);
  await downAvd(undefined, ctx);
  await upAvd('fresh-api35', buildAndroidProfile(), other.ctx);
  assert.equal(loadState('android', 'fresh-api35', { env: other.env }), null);
});

test('bake writes lastLaunch; a re-tune that rewrites config.ini drops it, a re-tune without changes keeps it', async () => {
  const { ctx, env } = world();
  tuneAvd(AVD, buildAndroidProfile(), { env });
  await bakeAvd(AVD, buildAndroidProfile({ lowRam: true }), ctx);
  const baked = loadState<AndroidState>('android', AVD, { env })!;
  assert.deepEqual(baked.lastLaunch, { ramMb: 2048, lowRam: true, at: '2026-11-16T12:00:00.000Z' });
  assert.equal(baked.bakedAt, '2026-11-16T12:00:00.000Z', 'bake state along with it');

  tuneAvd(AVD, buildAndroidProfile(), { env }); // same profile: nothing written
  assert.deepEqual(loadState<AndroidState>('android', AVD, { env })!.lastLaunch, baked.lastLaunch);
  tuneAvd(AVD, buildAndroidProfile({ ramMb: 3072 }), { env }); // rewrites and deletes hardware-qemu.ini
  assert.equal(loadState<AndroidState>('android', AVD, { env })!.lastLaunch, undefined);
});

test('bake: starts without snapshot, slims, writes state, slim_base snapshot, emu kill, waits for exit', async () => {
  const { fake, ctx, env } = world({
    spawned: { installed: INSTALLED, disabled: ['com.google.android.youtube'], bootSteps: 2, settings: { 'global/auto_sync': '1' } },
  });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true }); // old snapshot: bake ignores it
  const r = await bakeAvd(AVD, buildAndroidProfile(), ctx);

  assert.deepEqual(fake.spawnCalls[0].args, [...BASE_ARGS, '-no-snapshot'], 'bake never loads a snapshot');
  const cmds = fake.deviceCommands();
  const idx = (s: string) => cmds.indexOf(s);
  assert.ok(idx('shell getprop sys.boot_completed') < idx('shell settings get global window_animation_scale'));
  assert.ok(idx('shell settings get global window_animation_scale') < idx('shell pm list packages'));
  assert.ok(idx('shell pm disable-user --user 0 com.google.android.apps.photos') < idx('shell cmd package bg-dexopt-job'));
  assert.ok(idx('shell am kill-all') < idx('emu avd snapshot save slim_base'));
  assert.equal(cmds.at(-1), 'emu kill');
  assert.equal(fake.emulators.size, 0, 'emulator shut down');

  const state = loadState<AndroidState>('android', AVD, { env })!;
  assert.deepEqual(state.disabledPackages, ['com.google.android.apps.photos'], 'youtube was already disabled: not in the state');
  assert.equal(state.settings!.find((s) => s.key === 'auto_sync')!.previous, '1');
  assert.equal(state.settings!.find((s) => s.key === 'window_animation_scale')!.previous, null);
  assert.equal(state.bakedAt, '2026-11-16T12:00:00.000Z');
  assert.equal(typeof state.originalConfigIni, 'string', 'tune backup intact');

  assert.deepEqual(loadSession(env), [], 'bake session cleaned');
  assert.ok(existsSync(join(avdDir, 'snapshots', 'slim_base', 'ram.bin')));
  assert.equal(r.snapshot, 'slim_base');
  assert.equal(r.level, 'standard');
  for (const k of ['bootMs', 'slimMs', 'snapshotMs', 'shutdownMs', 'totalMs'] as const) assert.equal(typeof r.timings[k], 'number', k);
  assert.ok(r.timings.bootMs >= 2000, 'boot with 2 polls of 2 s on the fake clock');
});

test('bake: a snapshot failure takes the emulator down and propagates the error; state already written', async () => {
  const { fake, ctx, env } = world({ spawned: { installed: INSTALLED } });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  const original = fake.exec;
  const failing = Object.assign(
    async (cmd: string, args: readonly string[], o?: object) =>
      args.includes('snapshot') ? { code: 0, signal: null, stdout: 'KO: snapshot save failed\r\n', stderr: '' } : original(cmd, args, o),
    { calls: original.calls },
  );
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), { ...ctx, exec: failing }), /snapshot save slim_base .*failed/);
  assert.equal(fake.emulators.size, 0, 'bake emulator does not stay alive');
  assert.deepEqual(loadState<AndroidState>('android', AVD, { env })!.disabledPackages, [
    'com.google.android.apps.photos',
    'com.google.android.youtube',
  ]);
});

test('down without argument: only kills what is recorded in the session', async () => {
  const { fake, ctx, env } = world({ emulators: [{ avd: AVD, port: 5554 }, { avd: 'owners', port: 5556 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5554', pid: 1, port: 5554, startedAt: 'x' }, env);
  const r = await downAvd(undefined, ctx);
  assert.deepEqual(r.map((x) => [x.avd, x.result]), [[AVD, 'killed']]);
  assert.deepEqual([...fake.emulators.keys()], ['emulator-5556'], 'owner emulator untouched');
  assert.ok(!fake.exec.calls.some((c) => c.args.join(' ') === '-s emulator-5556 emu kill'));
  assert.deepEqual(loadSession(env), []);
});

test('down <avd> not recorded: refuses without --force; with --force kills', async () => {
  const { fake, ctx } = world({ emulators: [{ avd: 'owners', port: 5556 }] });
  await assert.rejects(downAvd('owners', ctx), /was not started by devslim .*--force/);
  assert.equal(fake.emulators.size, 1);
  const r = await downAvd('owners', { ...ctx, force: true });
  assert.deepEqual(r.map((x) => [x.avd, x.serial, x.registered, x.result]), [['owners', 'emulator-5556', false, 'killed']]);
  assert.equal(fake.emulators.size, 0);
});

test('down: old entry (serial gone) and a serial reused by another AVD kill nothing', async () => {
  const { fake, ctx, env } = world({ emulators: [{ avd: 'owners', port: 5556 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5554', pid: 1, port: 5554, startedAt: 'x' }, env);
  recordSession({ platform: 'android', avd: 'old', serial: 'emulator-5556', pid: 2, port: 5556, startedAt: 'x' }, env);
  const r = await downAvd(undefined, ctx);
  assert.deepEqual(r.map((x) => [x.avd, x.result]), [[AVD, 'stale'], ['old', 'skipped']]);
  assert.equal(fake.emulators.size, 1, 'emulator-5556 runs owners: untouched');
  assert.deepEqual(loadSession(env), []);
});

test('down with nothing in the session: empty list', async () => {
  const { ctx } = world();
  assert.deepEqual(await downAvd(undefined, ctx), []);
});

test('create refuses an existing name without calling avdmanager', async () => {
  const { fake, ctx } = world();
  await assert.rejects(createAvd(AVD, ctx), /AVD slim-api35 already exists/);
  assert.equal(fake.exec.calls.length, 0);
});

test('create: avdmanager with exact args and "no" on stdin; applies tune with 720x1600@320; does not boot', async () => {
  const { fake, ctx, env } = world();
  const r = await createAvd('new-api35', ctx);
  assert.deepEqual(fake.exec.calls.map((c) => [c.cmd, ...c.args]), [
    [fake.tools.avdmanager, 'create', 'avd', '-n', 'new-api35', '-k', 'system-images;android-35;google_apis;arm64-v8a', '-d', 'pixel_7'],
  ]);
  assert.equal(fake.exec.calls[0].opts.input, 'no\n');
  assert.equal(fake.spawnCalls.length, 0, 'does not boot');
  const config = readFileSync(join(avdHome, 'new-api35.avd', 'config.ini'), 'utf8');
  assert.match(config, /^hw\.lcd\.width=720$/m);
  assert.match(config, /^hw\.lcd\.height=1600$/m);
  assert.match(config, /^hw\.lcd\.density=320$/m);
  assert.match(config, /^hw\.ramSize=2048$/m);
  assert.equal(r.image, 'system-images;android-35;google_apis;arm64-v8a');
  const state = loadState<AndroidState>('android', 'new-api35', { env })!;
  assert.match(state.originalConfigIni, /hw\.lcd\.width=1080/);
});

test('create with --image/--device and avdmanager failure', async () => {
  const { fake, ctx } = world({ avdmanagerFails: true, systemImages: ['system-images;android-34;google_apis;arm64-v8a'] });
  await assert.rejects(createAvd('x-api34', { ...ctx, image: 'system-images;android-34;google_apis;arm64-v8a', device: 'pixel_6' }), /avdmanager create avd x-api34 failed \(exit 1\)/);
  assert.deepEqual(fake.exec.calls[0].args.slice(-4), ['-k', 'system-images;android-34;google_apis;arm64-v8a', '-d', 'pixel_6']);
});

test('create with shortcut: --image aosp_atd/google_atd/default and --api expand with the host ABI', async () => {
  const images = ['system-images;android-35;aosp_atd;arm64-v8a', 'system-images;android-34;google_atd;arm64-v8a', 'system-images;android-35;default;x86_64'];
  const { fake, ctx } = world({ systemImages: images });
  const a = await createAvd('atd-api35', { ...ctx, image: 'aosp_atd' });
  assert.equal(a.image, 'system-images;android-35;aosp_atd;arm64-v8a');
  const g = await createAvd('gatd-api34', { ...ctx, image: 'google_atd', api: 34 });
  assert.equal(g.image, 'system-images;android-34;google_atd;arm64-v8a');
  const d = await createAvd('def-x86', { ...ctx, image: 'default', arch: 'x64' });
  assert.equal(d.image, 'system-images;android-35;default;x86_64');
  assert.deepEqual(fake.exec.calls.map((c) => c.args[c.args.indexOf('-k') + 1]), images);
  assert.match(readFileSync(join(avdHome, 'atd-api35.avd', 'config.ini'), 'utf8'), /^tag\.id=aosp_atd$/m);
});

test('create without image on an x86_64 host: google_apis x86_64', async () => {
  const { fake, ctx } = world();
  const r = await createAvd('x86-api35', { ...ctx, arch: 'x64' });
  assert.equal(r.image, 'system-images;android-35;google_apis;x86_64');
  assert.equal(fake.exec.calls[0].args[fake.exec.calls[0].args.indexOf('-k') + 1], 'system-images;android-35;google_apis;x86_64');
});

test('create with an image not installed: error with the exact sdkmanager command, without calling avdmanager or downloading', async () => {
  const { fake, ctx } = world({ systemImages: [] });
  await assert.rejects(
    createAvd('atd-api35', { ...ctx, image: 'aosp_atd' }),
    (e: Error) =>
      e.message.includes('image system-images;android-35;aosp_atd;arm64-v8a not installed') &&
      e.message.includes(join(fake.sdk, 'system-images', 'android-35', 'aosp_atd', 'arm64-v8a')) &&
      e.message.includes('sdkmanager "system-images;android-35;aosp_atd;arm64-v8a"'),
  );
  // a full id is checked too
  await assert.rejects(createAvd('full', { ...ctx, image: 'system-images;android-33;google_apis;arm64-v8a' }), /sdkmanager "system-images;android-33;google_apis;arm64-v8a"/);
  assert.equal(fake.exec.calls.length, 0, 'neither avdmanager nor sdkmanager');
  assert.ok(!existsSync(join(avdHome, 'atd-api35.avd')));
});

test('missing SDK: error saying which binary and where it looked', async () => {
  const { ctx } = world();
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), { ...ctx, fileExists: () => false }), /adb not found; looked in: .*platform-tools\/adb/);
});

// Fake emulator that, on "start", writes what the real one writes: hardware-qemu.ini and/or log.
function emulatorWrites(ctx: ReturnType<typeof world>['ctx'], w: { hwIni?: string; log?: string }) {
  return {
    ...ctx,
    spawnDetached: async (cmd: string, args: readonly string[], o: { logFile: string; env?: Readonly<Record<string, string | undefined>> }) => {
      if (w.hwIni !== undefined) writeFileSync(join(avdDir, 'hardware-qemu.ini'), w.hwIni);
      if (w.log !== undefined) appendFileSync(o.logFile, w.log);
      return ctx.spawnDetached(cmd, args, o);
    },
  };
}

test('up: effective RAM from hardware-qemu.ini above the requested one warns on stderr with both values and suggests --lowram', async () => {
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2560\nhw.gpu.mode = host\nvm.heapSize = 576\n' }));
  assert.equal(r.ramEffectiveMb, 2560);
  const err = stderr.join('');
  assert.match(err, /warning: RAM requested 2048 MB, effective 2560 MB \(emulator raised it; -memory 2048 does not win\)\. /);
  assert.doesNotMatch(err, /log: /, 'no log line, nothing quoted');
  assert.match(err, /The emulator ignores -memory below its floor unless lowram is on\. With the AVD shut down: devslim android tune slim-api35 --lowram \(lowram changes app behavior: the guest reports itself as a low-RAM device\)$/m);
  assert.doesNotMatch(err, /--screen|smaller screen/, 'a smaller screen does not lower the floor (measured)');
});

test('up: RAM raised even with lowram = warning without suggesting --lowram again', async () => {
  const { ctx } = world();
  await upAvd(AVD, buildAndroidProfile({ lowRam: true }), emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2560\n' }));
  const err = stderr.join('');
  assert.match(err, /effective 2560 MB \(emulator raised it even with lowram; -memory 2048 does not win\)/);
  assert.doesNotMatch(err, /tune slim-api35 --lowram/);
});

test('up: RAM warning quotes this boot log line when present', async () => {
  const { ctx } = world();
  const r = await upAvd(
    AVD,
    buildAndroidProfile(),
    emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2560\n', log: 'INFO         | Increasing RAM size to 2560MB\n' }),
  );
  assert.equal(r.ramEffectiveMb, 2560);
  assert.match(stderr.join(''), /\(emulator raised it; -memory 2048 does not win\); log: "INFO \| Increasing RAM size to 2560MB"\. The emulator ignores/);
});

const ARGENT_LINE = '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd slim-api35 -no-snapshot-load -gpu auto -feature -Vulkan -noaudio -no-boot-anim -netfast -no-metrics -crash-report-mode never';

test('up with the AVD already running outside the profile (argent, lavapipe): warns on stderr, does not kill, returns launcher and gpuEffective', async () => {
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\nhw.gpu.mode = lavapipe\n');
  const { fake, ctx } = world({ emulators: [{ avd: AVD, port: 5554, pid: 9421 }], host: { pgrep: '9421\n', cmdline: ARGENT_LINE } });
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.alreadyRunning, true);
  assert.equal(r.launcher, 'argent');
  assert.equal(r.gpuEffective, 'lavapipe');
  assert.equal(r.ramEffectiveMb, 4096);
  assert.equal(fake.spawnCalls.length, 0);
  assert.equal(fake.emulators.size, 1, 'never kills on its own');
  assert.ok(!fake.deviceCommands().includes('emu kill'));
  const err = stderr.join('');
  assert.match(err, /^devslim: warning: AVD slim-api35 is already running outside the profile \(pid 9421, launched by argent, effective gpu lavapipe \(software\), effective ram 4096 MB\); /m);
  assert.match(err, /nothing started, nothing shut down\. To start it on the profile: devslim android down slim-api35 --force and then devslim android up slim-api35/);
  assert.ok(fake.exec.calls.some((c) => c.cmd === 'ps' && c.args.join(' ') === '-o command= -p 9421'), 'command line via ps, no adb');
});

test('up with the AVD already running via devslim (session, gpu host): no warning, devslim launcher', async () => {
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 2048\nhw.gpu.mode = host\n');
  const { ctx, env } = world({ emulators: [{ avd: AVD, port: 5556, pid: 777 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5556', pid: 777, port: 5556, startedAt: 'x' }, env);
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.deepEqual([r.alreadyRunning, r.launcher, r.gpuEffective, r.pid], [true, 'devslim', 'host', 777]);
  assert.doesNotMatch(stderr.join(''), /outside the profile/);
});

test('up starts: devslim launcher and gpuEffective in the result', async () => {
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2048\nhw.gpu.mode = host\n' }));
  assert.deepEqual([r.alreadyRunning, r.launcher, r.gpuEffective], [false, 'devslim', 'host']);
});

test('up: effective RAM equal to requested does not warn', async () => {
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2048\n' }));
  assert.equal(r.ramEffectiveMb, 2048);
  assert.doesNotMatch(stderr.join(''), /raised it/);
});

test('up: without hardware-qemu.ini, effective RAM comes from this boot log line (ignores earlier boots)', async () => {
  const { ctx } = world();
  mkdirSync(join(devslimHome, 'logs'), { recursive: true });
  writeFileSync(join(devslimHome, 'logs', `${AVD}.log`), 'INFO         | Increasing RAM size to 4096MB\n'); // old boot
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { log: 'INFO         | Android emulator version 36.1\nINFO         | Increasing RAM size to 2560MB\n' }));
  assert.equal(r.ramEffectiveMb, 2560);
  assert.match(stderr.join(''), /RAM requested 2048 MB, effective 2560 MB .*; log: "INFO \| Increasing RAM size to 2560MB"/);
  assert.doesNotMatch(stderr.join(''), /4096/, 'old boot line is not quoted');

  stderr = [];
  const again = world();
  rmSync(join(devslimHome, 'logs'), { recursive: true, force: true });
  const none = await upAvd(AVD, buildAndroidProfile(), again.ctx);
  assert.equal(none.ramEffectiveMb, null, 'neither ini nor log line: unknown');
  assert.doesNotMatch(stderr.join(''), /raised/);
});

test('up: bake tip only when started without slim_base', async () => {
  const cold = world();
  const r = await upAvd(AVD, buildAndroidProfile(), cold.ctx);
  assert.equal(r.fromSnapshot, false);
  assert.equal(r.hint, 'tip: started without the slim_base snapshot; run devslim android bake slim-api35 once (with the AVD shut down) so later ups start from an already slim guest');

  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  const warm = world();
  const w = await upAvd(AVD, buildAndroidProfile(), warm.ctx);
  assert.equal(w.fromSnapshot, true);
  assert.ok(!('hint' in w));

  const running = world({ emulators: [{ avd: AVD, port: 5556 }] });
  rmSync(join(avdDir, 'snapshots'), { recursive: true });
  const a = await upAvd(AVD, buildAndroidProfile(), running.ctx);
  assert.equal(a.alreadyRunning, true);
  assert.ok(!('hint' in a), 'already running: no tip');
});

// ---------------------------------------------------------------------------
// advertisement (avd/running/pid_<pid>.ini)

const RUNNING_FIXTURE = readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8');

function announce(o: { pid?: number; avd?: string; serial?: number; grpc?: number | null; token?: boolean } = {}): void {
  mkdirSync(running, { recursive: true });
  let text = RUNNING_FIXTURE.replace('avd.name=bench-api35', `avd.name=${o.avd ?? AVD}`)
    .replace('port.serial=5554', `port.serial=${o.serial ?? 5554}`)
    .replace('grpc.port=8554', o.grpc === null ? '' : `grpc.port=${o.grpc ?? 8554}`);
  if (o.token === false) text = text.replace('grpc.token=abc123', '');
  writeFileSync(join(running, `pid_${o.pid ?? 61000}.ini`), text);
}

const noLeak = (r: unknown) => {
  assert.ok(!JSON.stringify(r).includes('abc123'), 'token not in the result');
  assert.ok(!stderr.join('').includes('abc123'), 'token fora do stderr');
};

test('up advertised: advertised true, grpcPort 8554, no warning, no waiting', async () => {
  announce();
  const { fake, ctx } = world();
  const before = fake.sleeps.length;
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.advertised, true);
  assert.equal(r.grpcPort, 8554);
  assert.ok(!stderr.join('').includes('did not advertise itself'));
  assert.ok(fake.sleeps.slice(before).every((ms) => ms !== 500), 'no advertisement poll');
  noLeak(r);
});

test('up advertised on the instance port: 5556 -> matches the port.serial 5556 entry', async () => {
  announce({ serial: 5554, grpc: 8554, pid: 1 }); // another old instance of the same AVD
  announce({ serial: 5556, grpc: 8556, pid: 2 });
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile({ port: 5556 }), ctx);
  const args = fake.spawnCalls[0].args;
  assert.deepEqual(args.slice(args.indexOf('-grpc'), args.indexOf('-grpc') + 3), ['-grpc', '8556', '-grpc-use-token']);
  assert.deepEqual([r.advertised, r.grpcPort], [true, 8556]);
});

test('up not advertised: waits up to 10 s, warns on stderr with the directory, not an error', async () => {
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.advertised, false);
  assert.equal(r.grpcPort, null);
  assert.equal(r.serial, 'emulator-5554', 'started normally');
  const polls = fake.sleeps.filter((ms) => ms === 500);
  assert.ok(polls.length >= 19 && polls.length <= 21, `poll of ~10 s (${polls.length} x 500 ms)`);
  const err = stderr.join('');
  assert.equal(
    err.split('\n').find((l) => l.includes('did not advertise itself')),
    `devslim: warning: emulator did not advertise itself in ${running}: tools that rely on gRPC (argent screenshot/tap) will not see it; adb works normally`,
  );
});

test('up with an entry without token (or without grpc.port) counts as not advertised', async () => {
  announce({ token: false });
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.deepEqual([r.advertised, r.grpcPort], [false, 8554]);
  assert.match(stderr.join(''), /did not advertise itself/);
  noLeak(r);
});

test('up --no-grpc (profile grpc false): no -grpc in the line, no wait, no warning', async () => {
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile({ grpc: false }), ctx);
  assert.ok(!fake.spawnCalls[0].args.includes('-grpc') && !fake.spawnCalls[0].args.includes('-grpc-use-token'));
  assert.equal(r.advertised, false);
  assert.ok(!stderr.join('').includes('did not advertise itself'));
  assert.equal(fake.sleeps.filter((ms) => ms === 500).length, 0);
});

test('up with runningDir null (platform without a known directory): does not wait, warns without a path', async () => {
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), { ...ctx, runningDir: null });
  assert.equal(r.advertised, false);
  assert.equal(fake.sleeps.filter((ms) => ms === 500).length, 0);
  assert.match(stderr.join(''), /did not advertise itself in \(advertisement directory unknown on this platform\)/);
});

test('up with the AVD already running: reads the advertisement once, no warning', async () => {
  announce({ serial: 5556, grpc: 8556 });
  const { ctx, env } = world({ emulators: [{ avd: AVD, port: 5556, pid: 777 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5556', pid: 777, port: 5556, startedAt: 'x' }, env);
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.deepEqual([r.alreadyRunning, r.advertised, r.grpcPort], [true, true, 8556]);
  assert.equal(stderr.join(''), '');
  noLeak(r);
});

test('up: an advertised pid_<pid>.ini of a dead emulator does not count; waits and warns', async () => {
  announce({ pid: 61000 });
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), { ...ctx, pidAlive: (pid) => pid !== 61000 });
  assert.deepEqual([r.advertised, r.grpcPort], [false, null]);
  assert.ok(fake.sleeps.filter((ms) => ms === 500).length >= 19, 'waited for the advertisement');
  assert.match(stderr.join(''), /did not advertise itself/);
  assert.ok(existsSync(join(running, 'pid_61000.ini')), 'emulator file intact');
});
