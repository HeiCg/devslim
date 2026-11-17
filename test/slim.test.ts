import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdb } from '../src/android/adb.ts';
import { createFakeAndroid, type FakeEmulatorInit } from '../src/android/fakeAndroid.ts';
import { slimRunningDevice, unslimRunningDevice } from '../src/android/slim.ts';

const SERIAL = 'emulator-5554';

function world(init: Partial<FakeEmulatorInit> = {}) {
  const fake = createFakeAndroid({ emulators: [{ avd: 'slim-api35', port: 5554, ...init }] });
  const adb = createAdb({ adbPath: fake.tools.adb, exec: fake.exec, sleep: fake.sleep, now: fake.now });
  return { fake, adb, emu: fake.emulators.get(SERIAL)! };
}

const INSTALLED = [
  'com.google.android.youtube',
  'com.google.android.apps.photos',
  'com.android.printspooler',
  'com.google.android.bluetooth',
  'com.android.chrome',
  'com.google.android.gms',
  'com.example.meuapp',
];

const SETTINGS_ORDER = [
  'global/window_animation_scale',
  'global/transition_animation_scale',
  'global/animator_duration_scale',
  'global/auto_sync',
  'secure/stylus_handwriting_enabled',
  'secure/user_setup_complete',
  'global/device_provisioned',
  'global/activity_manager_constants',
];

test('command order: settings (get/put), pm list, pm list -d, disables, dexopt, am kill-all', async () => {
  const { fake, adb } = world({ installed: INSTALLED, disabled: ['com.android.printspooler'] });
  await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  const expected: string[] = [];
  for (const id of SETTINGS_ORDER) {
    const [ns, key] = id.split('/');
    const value = { window_animation_scale: '0', transition_animation_scale: '0', animator_duration_scale: '0', auto_sync: '0', stylus_handwriting_enabled: '0', user_setup_complete: '1', device_provisioned: '1', activity_manager_constants: 'max_cached_processes=8' }[key]!;
    expected.push(`shell settings get ${ns} ${key}`, `shell settings put ${ns} ${key} ${value}`);
  }
  expected.push(
    'shell pm list packages',
    'shell pm list packages -d',
    'shell pm disable-user --user 0 com.google.android.apps.photos',
    'shell pm disable-user --user 0 com.google.android.youtube',
    'shell cmd package bg-dexopt-job',
    'shell am kill-all',
  );
  assert.deepEqual(fake.deviceCommands(), expected);
  const dexopt = fake.exec.calls.find((c) => c.args.includes('bg-dexopt-job'))!;
  assert.equal(dexopt.opts.timeoutMs, 300_000, 'dexopt with a 5 min timeout');
});

test('previous value saved for each setting, including absent (null)', async () => {
  const { adb, emu } = world({
    installed: [],
    settings: { 'global/window_animation_scale': '1.0', 'global/auto_sync': '1', 'secure/user_setup_complete': '1', 'global/transition_animation_scale': '' },
  });
  const r = await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  assert.deepEqual(
    r.savedSettings.map((s) => [`${s.ns}/${s.key}`, s.previous]),
    [
      ['global/window_animation_scale', '1.0'],
      ['global/transition_animation_scale', null], // empty = absent
      ['global/animator_duration_scale', null],
      ['global/auto_sync', '1'],
      ['secure/stylus_handwriting_enabled', null],
      ['secure/user_setup_complete', '1'],
      ['global/device_provisioned', null],
      ['global/activity_manager_constants', null],
    ],
  );
  assert.equal(emu.settings.get('global/window_animation_scale'), '0');
  assert.equal(emu.settings.get('global/activity_manager_constants'), 'max_cached_processes=8');
  assert.equal(emu.settings.get('secure/stylus_handwriting_enabled'), '0');
});

test('preexisting activity_manager_constants is not overwritten and is reported', async () => {
  const { fake, adb, emu } = world({ settings: { 'global/activity_manager_constants': 'max_cached_processes=32' } });
  const r = await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  assert.equal(emu.settings.get('global/activity_manager_constants'), 'max_cached_processes=32');
  assert.ok(!fake.deviceCommands().some((c) => c.startsWith('shell settings put global activity_manager_constants')));
  const out = r.settings.find((s) => s.key === 'activity_manager_constants')!;
  assert.equal(out.status, 'skipped');
  assert.match(out.note!, /max_cached_processes=32/);
  assert.ok(!r.savedSettings.some((s) => s.key === 'activity_manager_constants'), 'does not go into the state');
});

test('a package already disabled before us does not go into the state; not installed is ignored', async () => {
  const { adb } = world({ installed: INSTALLED, disabled: ['com.google.android.youtube'] });
  const r = await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  assert.deepEqual(r.alreadyDisabled, ['com.google.android.youtube']);
  assert.deepEqual(r.disabledPackages, ['com.google.android.apps.photos', 'com.android.printspooler']);
  assert.ok(!r.disabledPackages.includes('com.google.android.youtube'));
});

test('failures do not abort: package, setting and dexopt reported; the rest continues', async () => {
  const { fake, adb } = world({
    installed: INSTALLED,
    failPackages: ['com.google.android.youtube'],
    failSettings: ['global/auto_sync'],
    dexoptFails: true,
  });
  const r = await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  assert.deepEqual(r.failedPackages.map((f) => f.pkg), ['com.google.android.youtube']);
  assert.deepEqual(r.disabledPackages, ['com.google.android.apps.photos', 'com.android.printspooler']);
  assert.equal(r.settings.find((s) => s.key === 'auto_sync')!.status, 'failed');
  assert.ok(!r.savedSettings.some((s) => s.key === 'auto_sync'), 'unchanged: nothing to restore');
  assert.equal(r.dexopt.ok, false);
  assert.equal(r.killAll.ok, true);
  assert.equal(fake.deviceCommands().at(-1), 'shell am kill-all');
});

test('no issued command mentions the bluetooth APK, bluetooth/location settings, background_process_limit or chrome', async () => {
  const { fake, adb } = world({
    installed: [...INSTALLED, 'com.android.bluetoothmidiservice', 'com.android.vending', 'com.google.android.setupwizard'],
  });
  const r = await slimRunningDevice(SERIAL, { adb, level: 'aggressive', capabilities: ['camera', 'location', 'weblogin'] });
  await unslimRunningDevice(SERIAL, { adb, saved: { disabledPackages: r.disabledPackages, settings: r.savedSettings } });
  const cmds = fake.deviceCommands();
  assert.ok(!cmds.some((c) => /location|gps/i.test(c)), 'slim never touches location, with or without the capability');
  assert.ok(cmds.length > 20);
  for (const c of cmds) {
    assert.doesNotMatch(c, /com\.android\.chrome/, c);
    assert.doesNotMatch(c, /com\.google\.android\.bluetooth\b/, c);
    assert.doesNotMatch(c, /settings \w+ \w+ \S*(bluetooth|location)/i, c);
    assert.doesNotMatch(c, /background_process_limit/, c);
  }
  // The only mention of "bluetooth": the MIDI service from the T1 managed list.
  const bt = [...new Set(cmds.filter((c) => /bluetooth/i.test(c)))];
  assert.deepEqual(bt, [
    'shell pm disable-user --user 0 com.android.bluetoothmidiservice',
    'shell pm enable com.android.bluetoothmidiservice',
  ]);
});

test('unslim re-enables only what is in the state and deletes the setting that was absent', async () => {
  const { fake, adb, emu } = world({
    installed: INSTALLED,
    disabled: ['com.google.android.youtube', 'com.google.android.apps.photos'],
    settings: { 'global/window_animation_scale': '0', 'global/auto_sync': '0', 'global/device_provisioned': '1' },
  });
  const r = await unslimRunningDevice(SERIAL, {
    adb,
    saved: {
      disabledPackages: ['com.google.android.apps.photos', 'com.example.not-in-list'],
      settings: [
        { ns: 'global', key: 'window_animation_scale', previous: '1.0' },
        { ns: 'global', key: 'device_provisioned', previous: null },
      ],
    },
  });
  assert.deepEqual(fake.deviceCommands(), [
    'shell pm enable com.google.android.apps.photos',
    'shell settings delete global device_provisioned',
    'shell settings put global window_animation_scale 1.0',
  ]);
  assert.deepEqual(r.enabled, ['com.google.android.apps.photos']);
  assert.ok(emu.disabled.has('com.google.android.youtube'), 'package outside the state stays disabled');
  assert.equal(emu.settings.get('global/window_animation_scale'), '1.0');
  assert.equal(emu.settings.has('global/device_provisioned'), false);
  assert.equal(emu.settings.get('global/auto_sync'), '0', 'setting outside the state untouched');
  assert.deepEqual(r.remaining, { disabledPackages: [], settings: [] });
});

test('unslim: failure stays in remaining for another attempt', async () => {
  const { adb } = world({ installed: INSTALLED, failPackages: ['com.android.printspooler'], failSettings: ['global/auto_sync'] });
  const r = await unslimRunningDevice(SERIAL, {
    adb,
    saved: {
      disabledPackages: ['com.android.printspooler', 'com.google.android.youtube'],
      settings: [{ ns: 'global', key: 'auto_sync', previous: '1' }, { ns: 'global', key: 'window_animation_scale', previous: null }],
    },
  });
  assert.deepEqual(r.remaining.disabledPackages, ['com.android.printspooler']);
  assert.deepEqual(r.remaining.settings, [{ ns: 'global', key: 'auto_sync', previous: '1' }]);
});

test('re-bake: what was already ours stays ours; previous stays the one from before the first bake', async () => {
  const { adb, emu } = world({ installed: INSTALLED });
  const first = await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  assert.ok(emu.disabled.has('com.google.android.youtube'));
  const second = await slimRunningDevice(SERIAL, {
    adb,
    level: 'standard',
    prior: { disabledPackages: first.disabledPackages, settings: first.savedSettings },
  });
  assert.deepEqual([...second.disabledPackages].sort(), [...first.disabledPackages].sort());
  assert.deepEqual(second.alreadyDisabled, []);
  assert.deepEqual(second.newlyDisabled, []);
  assert.deepEqual(second.savedSettings, first.savedSettings, 'previous does not become the 0 we wrote ourselves');
  assert.equal(second.settings.find((s) => s.key === 'activity_manager_constants')!.status, 'set');
});

test('re-bake with a new capability re-enables what left the plan', async () => {
  const { adb, emu } = world({ installed: [...INSTALLED, 'com.android.camera2'] });
  const first = await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  assert.ok(first.disabledPackages.includes('com.android.camera2'));
  const second = await slimRunningDevice(SERIAL, {
    adb,
    level: 'standard',
    capabilities: ['camera'],
    prior: { disabledPackages: first.disabledPackages, settings: first.savedSettings },
  });
  assert.deepEqual(second.reenabled, ['com.android.camera2']);
  assert.ok(!second.disabledPackages.includes('com.android.camera2'));
  assert.ok(!emu.disabled.has('com.android.camera2'));
});

test('Gboard: standard bake leaves it; aggressive disables it; re-bake with keyboard re-enables it; unslim restores it', async () => {
  const GBOARD = 'com.google.android.inputmethod.latin';
  const { adb, emu } = world({ installed: [...INSTALLED, GBOARD] });
  const std = await slimRunningDevice(SERIAL, { adb, level: 'standard' });
  assert.ok(!std.plannedPackages.includes(GBOARD));
  assert.ok(!emu.disabled.has(GBOARD));

  const agg = await slimRunningDevice(SERIAL, { adb, level: 'aggressive', prior: { disabledPackages: std.disabledPackages, settings: std.savedSettings } });
  assert.ok(agg.disabledPackages.includes(GBOARD));
  assert.ok(emu.disabled.has(GBOARD));

  const kept = await slimRunningDevice(SERIAL, {
    adb,
    level: 'aggressive',
    capabilities: ['keyboard'],
    prior: { disabledPackages: agg.disabledPackages, settings: agg.savedSettings },
  });
  assert.deepEqual(kept.reenabled, [GBOARD]);
  assert.ok(!emu.disabled.has(GBOARD));

  // unslim with the aggressive bake state re-enables Gboard
  emu.disabled.add(GBOARD);
  const un = await unslimRunningDevice(SERIAL, { adb, saved: { disabledPackages: agg.disabledPackages, settings: [] } });
  assert.ok(un.enabled.includes(GBOARD));
  assert.ok(!emu.disabled.has(GBOARD));
});
