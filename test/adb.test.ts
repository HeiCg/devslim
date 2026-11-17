import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdb, parseAdbDevices, portForSerial, serialForPort } from '../src/android/adb.ts';
import { DevslimError } from '../src/errors.ts';
import { createFakeExec, type FakeHandler } from '../src/exec.ts';

const ADB = '/sdk/platform-tools/adb';

function setup(handler: FakeHandler) {
  const clock = { t: 0 };
  const sleeps: number[] = [];
  const exec = createFakeExec(handler);
  const adb = createAdb({
    adbPath: ADB,
    exec,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
    now: () => clock.t,
  });
  return { adb, exec, sleeps, clock };
}

test('parseAdbDevices: device, offline, unauthorized, daemon and empty', () => {
  const text = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    'emulator-5554\tdevice',
    'emulator-5556\toffline',
    'R58M123ABC\tunauthorized',
    'emulator-5558  device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:3',
    '',
  ].join('\r\n');
  assert.deepEqual(parseAdbDevices(text), [
    { serial: 'emulator-5554', state: 'device' },
    { serial: 'emulator-5556', state: 'offline' },
    { serial: 'R58M123ABC', state: 'unauthorized' },
    { serial: 'emulator-5558', state: 'device' },
  ]);
  assert.deepEqual(parseAdbDevices('List of devices attached\n\n'), []);
  assert.deepEqual(parseAdbDevices(''), []);
});

test('serialForPort / portForSerial', () => {
  assert.equal(serialForPort(5556), 'emulator-5556');
  assert.equal(portForSerial('emulator-5560'), 5560);
  assert.equal(portForSerial('R58M123ABC'), null);
});

test('every device command carries -s <serial>', async () => {
  const { adb, exec } = setup(() => ({ stdout: '0\n' }));
  await adb.getSetting('emulator-5554', 'global', 'auto_sync');
  await adb.putSetting('emulator-5554', 'global', 'auto_sync', '0');
  await adb.deleteSetting('emulator-5554', 'secure', 'x');
  await adb.emuKill('emulator-5554');
  for (const c of exec.calls) {
    assert.equal(c.cmd, ADB);
    assert.deepEqual(c.args.slice(0, 2), ['-s', 'emulator-5554']);
  }
  assert.deepEqual(exec.calls.map((c) => c.args.slice(2).join(' ')), [
    'shell settings get global auto_sync',
    'shell settings put global auto_sync 0',
    'shell settings delete secure x',
    'emu kill',
  ]);
});

test('getSetting: "null" = absent', async () => {
  const { adb } = setup(({ args }) => ({ stdout: args.includes('a') ? 'null\n' : '1.0\r\n' }));
  assert.equal(await adb.getSetting('emulator-5554', 'global', 'a'), null);
  assert.equal(await adb.getSetting('emulator-5554', 'global', 'b'), '1.0');
});

test('putSetting refuses values with spaces or shell metacharacters', async () => {
  const { adb, exec } = setup(() => ({}));
  await assert.rejects(adb.putSetting('emulator-5554', 'global', 'k', 'a b'), DevslimError);
  await assert.rejects(adb.putSetting('emulator-5554', 'global', 'k', 'x;rm -rf /'), DevslimError);
  await assert.rejects(adb.getSetting('emulator-5554', 'global', 'k k'), DevslimError);
  assert.equal(exec.calls.length, 0);
});

test('listPackages and listDisabledPackages strip the package: prefix', async () => {
  const { adb, exec } = setup(({ args }) =>
    args.includes('-d') ? { stdout: 'package:com.b\r\n' } : { stdout: 'package:com.a\npackage:com.b\n\n' },
  );
  assert.deepEqual(await adb.listPackages('emulator-5554'), ['com.a', 'com.b']);
  assert.deepEqual(await adb.listDisabledPackages('emulator-5554'), ['com.b']);
  assert.deepEqual(exec.calls.map((c) => c.args.slice(2).join(' ')), ['shell pm list packages', 'shell pm list packages -d']);
});

test('disablePackages: a failure on one package does not abort the batch; collects and reports', async () => {
  const { adb, exec } = setup(({ args }) => {
    const pkg = args[args.length - 1];
    if (pkg === 'com.ruim') return { code: 255, stderr: "Exception occurred while executing 'disable-user':\njava.lang.IllegalArgumentException: Unknown package: com.ruim" };
    if (pkg === 'com.mentiroso') return { code: 0, stdout: 'Error: java.lang.SecurityException: Shell cannot change component state' };
    return { stdout: `Package ${pkg} new state: disabled-user\n` };
  });
  const res = await adb.disablePackages('emulator-5554', ['com.a', 'com.ruim', 'com.mentiroso', 'com.b']);
  assert.deepEqual(res.done, ['com.a', 'com.b']);
  assert.deepEqual(res.failed.map((f) => f.pkg), ['com.ruim', 'com.mentiroso']);
  assert.match(res.failed[0].error, /Unknown package/);
  assert.deepEqual(exec.calls[0].args.slice(2), ['shell', 'pm', 'disable-user', '--user', '0', 'com.a']);
  assert.equal(exec.calls.length, 4);
});

test('enablePackage = pm enable <pkg>', async () => {
  const { adb, exec } = setup(() => ({ stdout: 'Package com.a new state: enabled\n' }));
  const res = await adb.enablePackages('emulator-5554', ['com.a']);
  assert.deepEqual(res.done, ['com.a']);
  assert.deepEqual(exec.calls[0].args.slice(2), ['shell', 'pm', 'enable', 'com.a']);
});

test('waitForBoot: waits to show up as device and sys.boot_completed=1, with fake sleep', async () => {
  let devicesCalls = 0;
  let getprops = 0;
  const { adb, sleeps } = setup(({ args }) => {
    if (args[0] === 'devices') {
      devicesCalls++;
      if (devicesCalls === 1) return { stdout: 'List of devices attached\n\n' };
      if (devicesCalls === 2) return { stdout: 'List of devices attached\nemulator-5554\toffline\n' };
      return { stdout: 'List of devices attached\nemulator-5554\tdevice\n' };
    }
    getprops++;
    return { stdout: getprops < 2 ? '\n' : '1\n' };
  });
  const res = await adb.waitForBoot('emulator-5554', { pollMs: 500 });
  assert.equal(devicesCalls, 4);
  assert.equal(getprops, 2);
  assert.deepEqual(sleeps, [500, 500, 500]);
  assert.equal(res.waitedMs, 1500);
});

test('waitForBoot: timeout becomes DevslimError with the last state, without really sleeping', async () => {
  const { adb, sleeps } = setup(({ args }) =>
    args[0] === 'devices' ? { stdout: 'List of devices attached\nemulator-5554\tdevice\n' } : { stdout: '0\n' },
  );
  const started = Date.now();
  await assert.rejects(adb.waitForBoot('emulator-5554', { timeoutMs: 10_000, pollMs: 2_000 }), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.match(err.message, /did not finish booting within 10 s/);
    assert.match(err.message, /sys\.boot_completed=0/);
    return true;
  });
  assert.equal(sleeps.length, 5);
  assert.ok(Date.now() - started < 1000);
});

test('waitForBoot: default timeout 180 s', async () => {
  const { adb, clock } = setup(() => ({ stdout: 'List of devices attached\n' }));
  await assert.rejects(adb.waitForBoot('emulator-5554'), /180 s/);
  assert.ok(clock.t >= 180_000 && clock.t < 183_000);
});

test('waitForGone waits for the serial to disappear; timeout errors', async () => {
  let n = 0;
  const { adb } = setup(() => ({ stdout: n++ < 2 ? 'List of devices attached\nemulator-5554\tdevice\n' : 'List of devices attached\n' }));
  assert.equal((await adb.waitForGone('emulator-5554', { pollMs: 1000 })).waitedMs, 2000);

  const stuck = setup(() => ({ stdout: 'List of devices attached\nemulator-5554\tdevice\n' }));
  await assert.rejects(stuck.adb.waitForGone('emulator-5554', { timeoutMs: 3000, pollMs: 1000 }), /still in adb devices/);
});

test('emu: avd name, kill and snapshot save (KO = error)', async () => {
  const { adb, exec } = setup(({ args }) => {
    const what = args.slice(2).join(' ');
    if (what === 'emu avd name') return { stdout: 'slim-api35\r\nOK\r\n' };
    if (what === 'emu avd snapshot save slim_base') return { stdout: 'OK\r\n' };
    if (what === 'emu avd snapshot save bad') return { stdout: 'KO: snapshot save failed\r\n' };
    return { stdout: 'OK: killing emulator, bye bye\r\n' };
  });
  assert.equal(await adb.avdName('emulator-5554'), 'slim-api35');
  await adb.snapshotSave('emulator-5554', 'slim_base');
  await assert.rejects(adb.snapshotSave('emulator-5554', 'bad'), /snapshot save bad .*failed/);
  await adb.emuKill('emulator-5554');
  assert.deepEqual(exec.calls.map((c) => c.args.join(' ')), [
    '-s emulator-5554 emu avd name',
    '-s emulator-5554 emu avd snapshot save slim_base',
    '-s emulator-5554 emu avd snapshot save bad',
    '-s emulator-5554 emu kill',
  ]);
});
