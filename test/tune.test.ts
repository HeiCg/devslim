import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { loadSession, recordSession } from '../src/android/session.ts';
import { restoreAvd, tuneAvd } from '../src/android/tune.ts';
import { loadState, recordAndroidGuest, type AndroidState } from '../src/state.ts';

const PHONE = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url));
const AVD = 'slim-api35';

let root: string;
let avdHome: string;
let avdDir: string;
let configPath: string;
let env: Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-tune-'));
  avdHome = join(root, 'avd');
  avdDir = join(avdHome, `${AVD}.avd`);
  configPath = join(avdDir, 'config.ini');
  mkdirSync(avdDir, { recursive: true });
  writeFileSync(join(avdHome, `${AVD}.ini`), `path=${avdDir}\n`);
  writeFileSync(configPath, PHONE);
  env = { ANDROID_HOME: '/fake-sdk', ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: join(root, 'home'), HOME: root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function world(opts: FakeAndroidOptions = {}) {
  const fake = createFakeAndroid(opts);
  return {
    fake,
    ctx: { env, exec: fake.exec, spawnDetached: fake.spawnDetached, sleep: fake.sleep, now: fake.now, date: fake.date, fileExists: fake.fileExists },
  };
}

// Tuned AVD + simulated bake: two packages of ours and two changed settings; slim_base snapshot on disk.
function tunedAndBaked() {
  tuneAvd(AVD, buildAndroidProfile(), { env });
  recordAndroidGuest(
    AVD,
    {
      disabledPackages: ['com.google.android.apps.photos', 'com.android.printspooler'],
      settings: [
        { ns: 'global', key: 'auto_sync', previous: '1' },
        { ns: 'global', key: 'window_animation_scale', previous: null },
      ],
    },
    { env },
  );
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  writeFileSync(join(avdDir, 'snapshots', 'slim_base', 'ram.bin'), 'ram');
  mkdirSync(join(avdDir, 'snapshots', 'other'), { recursive: true });
}

test('restore with AVD running: unslim, emu kill, wait for exit, config.ini byte for byte, deletes slim_base', async () => {
  tunedAndBaked();
  const { fake, ctx } = world({
    emulators: [{
      avd: AVD,
      port: 5554,
      installed: ['com.google.android.apps.photos', 'com.android.printspooler', 'com.google.android.youtube'],
      disabled: ['com.google.android.apps.photos', 'com.android.printspooler', 'com.google.android.youtube'],
      settings: { 'global/auto_sync': '0', 'global/window_animation_scale': '0' },
    }],
  });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5554', pid: 9, port: 5554, startedAt: 'x' }, env);
  const emu = fake.emulators.get('emulator-5554')!;
  const r = await restoreAvd(AVD, ctx);

  assert.deepEqual(fake.deviceCommands(), [
    'emu avd name',
    'shell pm enable com.google.android.apps.photos',
    'shell pm enable com.android.printspooler',
    'shell settings delete global window_animation_scale',
    'shell settings put global auto_sync 1',
    'emu kill',
  ]);
  assert.ok(emu.disabled.has('com.google.android.youtube'), 'package outside the state stays disabled');
  assert.equal(emu.settings.get('global/auto_sync'), '1');
  assert.equal(emu.settings.has('global/window_animation_scale'), false);
  assert.equal(fake.emulators.size, 0, 'emulator shut down');
  assert.ok(readFileSync(configPath).equals(PHONE), 'config.ini byte a byte');
  assert.ok(!existsSync(join(avdDir, 'snapshots', 'slim_base')));
  assert.ok(existsSync(join(avdDir, 'snapshots', 'other')), 'only slim_base is deleted');
  assert.equal(loadState('android', AVD, { env }), null);
  assert.deepEqual(loadSession(env), []);
  assert.equal(r.removedSnapshot, true);
  assert.equal(r.clearedState, true);
  assert.deepEqual(r.unslim!.enabled, ['com.google.android.apps.photos', 'com.android.printspooler']);
});

test('restore with pending changes and AVD shut down: clear error, nothing changes', async () => {
  tunedAndBaked();
  const tuned = readFileSync(configPath);
  const { fake, ctx } = world();
  await assert.rejects(restoreAvd(AVD, ctx), (err: Error) => {
    assert.match(err.message, /2 disabled package\(s\) and 2 changed setting\(s\) in the guest and is shut down/);
    assert.match(err.message, /devslim android up slim-api35/);
    assert.match(err.message, /--config-only/);
    return true;
  });
  assert.ok(readFileSync(configPath).equals(tuned));
  assert.ok(existsSync(join(avdDir, 'snapshots', 'slim_base')));
  assert.ok(loadState('android', AVD, { env }) !== null);
  assert.deepEqual(fake.exec.calls.map((c) => c.args.join(' ')), ['devices']);
});

test('restore --config-only: only config.ini and slim_base; pending changes stay in the state with a warning', async () => {
  tunedAndBaked();
  const { fake, ctx } = world();
  const r = await restoreAvd(AVD, { ...ctx, configOnly: true });
  assert.ok(readFileSync(configPath).equals(PHONE));
  assert.ok(!existsSync(join(avdDir, 'snapshots', 'slim_base')));
  const state = loadState<AndroidState>('android', AVD, { env })!;
  assert.deepEqual(state.disabledPackages, ['com.google.android.apps.photos', 'com.android.printspooler']);
  assert.equal(state.settings!.length, 2);
  assert.equal(r.clearedState, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /remain in the state/);
  assert.equal(fake.exec.calls.length, 0, '--config-only does not talk to adb');
});

test('restore --config-only with AVD running (locks) refuses', async () => {
  tunedAndBaked();
  mkdirSync(join(avdDir, 'hardware-qemu.ini.lock'));
  const { ctx } = world();
  await assert.rejects(restoreAvd(AVD, { ...ctx, configOnly: true }), /seems to be running/);
});

test('partial restore: a guest failure keeps only what is left in the state and does not shut down', async () => {
  tunedAndBaked();
  const { fake, ctx } = world({
    emulators: [{
      avd: AVD,
      port: 5554,
      installed: ['com.google.android.apps.photos'],
      disabled: ['com.google.android.apps.photos'],
      settings: { 'global/auto_sync': '0' },
    }],
  });
  await assert.rejects(restoreAvd(AVD, ctx), /partial restore of slim-api35: failed com\.android\.printspooler/);
  const state = loadState<AndroidState>('android', AVD, { env })!;
  assert.deepEqual(state.disabledPackages, ['com.android.printspooler']);
  assert.deepEqual(state.settings, []);
  assert.equal(fake.emulators.size, 1, 'emulator keeps running');
  assert.ok(!readFileSync(configPath).equals(PHONE), 'config.ini only returns once the guest is fully restored');
});

test('restore without pending changes needs neither SDK nor adb', async () => {
  tuneAvd(AVD, buildAndroidProfile(), { env });
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  const r = await restoreAvd(AVD, { env, fileExists: () => false });
  assert.ok(readFileSync(configPath).equals(PHONE));
  assert.equal(r.removedSnapshot, true);
  assert.equal(r.unslim, null);
});
