import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createAdb } from '../src/android/adb.ts';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import {
  assertSingleDevice,
  bootedSimulators,
  findAvdSerial,
  loadSession,
  parseSimctlBooted,
  parseSwapUsage,
  recordSession,
  removeSession,
  sessionPath,
  swapWarning,
  waitForExit,
} from '../src/android/session.ts';
import { DevslimError } from '../src/errors.ts';
import { createFakeExec } from '../src/exec.ts';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'devslim-session-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function world(opts: FakeAndroidOptions = {}) {
  const fake = createFakeAndroid(opts);
  const adb = createAdb({ adbPath: fake.tools.adb, exec: fake.exec, sleep: fake.sleep, now: fake.now });
  return { fake, adb };
}

test('guard refuses with an emulator running and lists what is running', async () => {
  const { fake, adb } = world({ emulators: [{ avd: 'bench-api35', port: 5556, state: 'offline' }] });
  await assert.rejects(assertSingleDevice({ adb, exec: fake.exec, action: 'up' }), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.match(err.message, /^up refused: a device is already running: emulator emulator-5556 \(offline\)/);
    assert.match(err.message, /--force/);
    return true;
  });
});

test('guard refuses with an iOS simulator booted', async () => {
  const { fake, adb } = world({ simulators: [{ udid: 'AAAA-1111', name: 'iPhone 17' }] });
  await assert.rejects(assertSingleDevice({ adb, exec: fake.exec, action: 'bake' }), /bake refused: .*simulator iPhone 17 AAAA-1111/);
  assert.ok(fake.exec.calls.some((c) => c.cmd === 'xcrun' && c.args.join(' ') === 'simctl list devices booted -j'));
});

test('guard passes with --force and returns the census', async () => {
  const { fake, adb } = world({ emulators: [{ avd: 'x', port: 5554 }], simulators: [{ udid: 'U', name: 'S' }] });
  const c = await assertSingleDevice({ adb, exec: fake.exec, action: 'up', force: true });
  assert.equal(c.emulators.length, 1);
  assert.equal(c.simulators.length, 1);
});

test('guard passes with nothing running; a physical device in adb does not count as an emulator', async () => {
  const clean = world();
  assert.deepEqual(await assertSingleDevice({ adb: clean.adb, exec: clean.fake.exec, action: 'up' }), { emulators: [], simulators: [] });

  const phone = createFakeExec(({ cmd }) =>
    cmd === 'xcrun' ? { stdout: '{"devices":{}}' } : { stdout: 'List of devices attached\nR58M123ABC\tdevice\n' },
  );
  const adb = createAdb({ adbPath: '/sdk/platform-tools/adb', exec: phone });
  assert.deepEqual(await assertSingleDevice({ adb, exec: phone, action: 'up' }), { emulators: [], simulators: [] });
});

test('xcrun failure = empty list', async () => {
  const { fake } = world({ xcrunFails: true });
  assert.deepEqual(await bootedSimulators(fake.exec), []);
  const throwing = async () => { throw new DevslimError('command not found: xcrun'); };
  assert.deepEqual(await bootedSimulators(throwing), []);
  assert.deepEqual(await bootedSimulators(async () => ({ code: 0, signal: null, stdout: 'not json', stderr: '' })), []);
});

test('parseSimctlBooted takes only Booted', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
        { udid: 'A', name: 'iPhone 17', state: 'Booted' },
        { udid: 'B', name: 'iPhone SE', state: 'Shutdown' },
      ],
    },
  });
  assert.deepEqual(parseSimctlBooted(json), [{ udid: 'A', name: 'iPhone 17', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4' }]);
});

test('parseSwapUsage: macOS format, decimal comma and M/G suffixes', () => {
  const a = parseSwapUsage('total = 18432.00M  used = 17704.94M  free = 727.06M  (encrypted)')!;
  assert.equal(a.totalMb, 18432);
  assert.equal(a.usedMb, 17704.94);
  assert.ok(Math.abs(a.ratio! - 0.9605) < 0.001);
  const b = parseSwapUsage('total = 18432,00M  used = 9216,50M  free = 9215,50M  (encrypted)')!;
  assert.equal(b.usedMb, 9216.5);
  assert.ok(Math.abs(b.ratio! - 0.5) < 0.001);
  const g = parseSwapUsage('total = 2,00G  used = 1,75G  free = 0,25G')!;
  assert.equal(g.totalMb, 2048);
  assert.equal(g.usedMb, 1792);
  // macOS with no swap file yet: total 0 is a valid reading, 0%.
  assert.deepEqual(parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)'), { totalMb: 0, usedMb: 0, ratio: 0 });
  assert.equal(parseSwapUsage('garbage'), null);
});

test('swap warning on stderr above 80%, non-blocking; below it, silence', async () => {
  const msgs: string[] = [];
  const high = world({ swap: 'total = 18432.00M  used = 17704.94M  free = 727.06M  (encrypted)' });
  const u = await swapWarning({ exec: high.fake.exec, stderr: (t) => msgs.push(t) });
  assert.ok(u !== null && u.ratio! > 0.8);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /warning: swap at 96% \(17\.3 of 18\.0 GB\)/);
  assert.deepEqual(high.fake.exec.calls.map((c) => [c.cmd, ...c.args]), [['sysctl', '-n', 'vm.swapusage']]);

  const low = world({ swap: 'total = 18432,00M  used = 14745,60M  free = 3686,40M  (encrypted)' }); // exactly 80%
  await swapWarning({ exec: low.fake.exec, stderr: (t) => msgs.push(t) });
  assert.equal(msgs.length, 1);
});

test('session: records, replaces by AVD/serial, removes; file at state/session.json', () => {
  const env = { DEVSLIM_HOME: home };
  assert.deepEqual(loadSession(env), []);
  const e = { platform: 'android' as const, avd: 'a', serial: 'emulator-5554', pid: 1, port: 5554, startedAt: 't' };
  recordSession(e, env);
  recordSession({ ...e, pid: 2 }, env);
  recordSession({ ...e, avd: 'b', serial: 'emulator-5556', port: 5556 }, env);
  assert.deepEqual(loadSession(env).map((x) => [x.avd, x.pid]), [['a', 2], ['b', 1]]);
  assert.equal(sessionPath(env), join(home, 'state', 'session.json'));
  assert.equal(JSON.parse(readFileSync(sessionPath(env), 'utf8')).version, 1);
  assert.deepEqual(removeSession((x) => x.avd === 'a', env).map((x) => x.avd), ['a']);
  assert.deepEqual(loadSession(env).map((x) => x.avd), ['b']);
});

test('findAvdSerial asks each emulator for its name', async () => {
  const { adb } = world({ emulators: [{ avd: 'other', port: 5554 }, { avd: 'slim-api35', port: 5556 }] });
  assert.equal(await findAvdSerial(adb, 'slim-api35'), 'emulator-5556');
  assert.equal(await findAvdSerial(adb, 'not-running'), null);
});

test('waitForExit: serial and locks disappear; a stubborn lock comes back as lingering', async () => {
  const { fake, adb } = world({ emulators: [{ avd: 'a', port: 5554 }] });
  const avdDir = join(home, 'a.avd');
  mkdirSync(join(avdDir, 'hardware-qemu.ini.lock'), { recursive: true });
  fake.emulators.delete('emulator-5554');
  const r = await waitForExit({ adb, serial: 'emulator-5554', avdDir, sleep: fake.sleep, now: fake.now, timeoutMs: 5000, pollMs: 1000 });
  assert.deepEqual(r.lingeringLocks, ['hardware-qemu.ini.lock']);
  rmSync(join(avdDir, 'hardware-qemu.ini.lock'), { recursive: true });
  const ok = await waitForExit({ adb, serial: 'emulator-5554', avdDir, sleep: fake.sleep, now: fake.now });
  assert.deepEqual(ok.lingeringLocks, []);
});
