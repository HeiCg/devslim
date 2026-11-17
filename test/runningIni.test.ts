import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { findRunningEntry, isAdvertised, nodePidAlive, parseRunningIni, readRunningEntries, runningDir, scanRunning } from '../src/android/runningIni.ts';

// Real format of avd/running/pid_<pid>.ini (relevant keys); fake token.
const FIXTURE = readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8');
const RUNNING_INI = (o: { avd?: string; serial?: number; grpc?: number | null; token?: string | null } = {}) =>
  [
    `avd.name=${o.avd ?? 'bench-api35'}`,
    'avd.id=bench-api35',
    'avd.dir=/Users/x/.android/avd/bench-api35.avd',
    `port.serial=${o.serial ?? 5554}`,
    `port.adb=${(o.serial ?? 5554) + 1}`,
    o.grpc === null ? null : `grpc.port=${o.grpc ?? 8554}`,
    o.token === null ? null : `grpc.token=${o.token ?? 'abc123'}`,
    'cmdline="/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64" "-avd" "bench-api35" "-grpc" "8554" "-grpc-use-token"',
    '',
  ].filter((l) => l !== null).join('\n');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devslim-running-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('runningDir: macOS at ~/Library/Caches/TemporaryItems/avd/running; Linux at $XDG_RUNTIME_DIR; others null', () => {
  assert.equal(runningDir({ env: { HOME: '/h' }, platform: 'darwin' }), '/h/Library/Caches/TemporaryItems/avd/running');
  assert.equal(runningDir({ env: { XDG_RUNTIME_DIR: '/run/user/501' }, platform: 'linux' }), '/run/user/501/avd/running');
  assert.equal(runningDir({ env: {}, platform: 'linux' }), null);
  assert.equal(runningDir({ env: { HOME: '/h' }, platform: 'win32' }), null);
});

test('parseRunningIni: realistic fixture; token becomes just a boolean', () => {
  assert.deepEqual(parseRunningIni(FIXTURE, 73808), parseRunningIni(RUNNING_INI(), 73808));
  const e = parseRunningIni(RUNNING_INI(), 73808);
  assert.deepEqual(e, { pid: 73808, avdName: 'bench-api35', serialPort: 5554, adbPort: 5555, grpcPort: 8554, hasGrpcToken: true });
  assert.ok(!JSON.stringify(e).includes('abc123'));
  assert.equal(isAdvertised(e), true);
  const noToken = parseRunningIni(RUNNING_INI({ token: null }), 1)!;
  assert.equal(noToken.hasGrpcToken, false);
  assert.equal(isAdvertised(noToken), false);
  assert.equal(parseRunningIni(RUNNING_INI({ token: '' }), 1)!.hasGrpcToken, false);
  const noGrpc = parseRunningIni(RUNNING_INI({ grpc: null }), 1)!;
  assert.equal(noGrpc.grpcPort, null);
  assert.equal(isAdvertised(noGrpc), false);
  assert.equal(parseRunningIni('avd.name = x\r\nport.serial = 5556\r\n', 2)!.serialPort, 5556, 'spaces and CRLF');
});

test('parseRunningIni: malformed = null', () => {
  assert.equal(parseRunningIni('', 1), null);
  assert.equal(parseRunningIni('binary garbage \u0000\u0001', 1), null);
  assert.equal(parseRunningIni('port.serial=5554\n', 1), null, 'no avd.name');
  assert.equal(parseRunningIni('avd.name=x\nport.serial=abc\n', 1), null, 'non-numeric port');
  assert.equal(parseRunningIni('avd.name=x\nport.serial=99999\n', 1), null, 'port outside 1..65535');
});

test('readRunningEntries: reads pid_*.ini, ignores malformed, unreadable and other names; sorts by pid', () => {
  writeFileSync(join(dir, 'pid_900.ini'), RUNNING_INI({ avd: 'b', serial: 5556, grpc: 8556 }));
  writeFileSync(join(dir, 'pid_100.ini'), RUNNING_INI());
  writeFileSync(join(dir, 'pid_200.ini'), 'nothing here\n');
  writeFileSync(join(dir, 'pid_x.ini'), RUNNING_INI());
  writeFileSync(join(dir, 'other.ini'), RUNNING_INI());
  mkdirSync(join(dir, 'pid_300.ini')); // directory with a file name: unreadable
  writeFileSync(join(dir, 'pid_400.ini'), RUNNING_INI({ avd: 'c' }));
  chmodSync(join(dir, 'pid_400.ini'), 0o000);
  const list = readRunningEntries(dir);
  const readable = process.getuid?.() === 0 ? ['bench-api35', 'c', 'b'] : ['bench-api35', 'b'];
  assert.deepEqual(list.map((e) => e.avdName), readable);
  assert.deepEqual(list.map((e) => e.pid).filter((p) => p !== 400), [100, 900]);
  assert.ok(!JSON.stringify(list).includes('abc123'));
});

test('readRunningEntries: missing directory or null = empty list', () => {
  assert.deepEqual(readRunningEntries(join(dir, 'does-not-exist')), []);
  assert.deepEqual(readRunningEntries(null), []);
});

test('findRunningEntry: by avd and console port; prefers the advertised one', () => {
  const entries = [
    parseRunningIni(RUNNING_INI({ avd: 'a', serial: 5554, grpc: null }), 1)!,
    parseRunningIni(RUNNING_INI({ avd: 'a', serial: 5554 }), 2)!,
    parseRunningIni(RUNNING_INI({ avd: 'b', serial: 5556, grpc: 8556 }), 3)!,
  ];
  assert.equal(findRunningEntry(entries, 'a')!.pid, 2);
  assert.equal(findRunningEntry(entries, 'a', 5554)!.pid, 2);
  assert.equal(findRunningEntry(entries, 'a', 5556), null);
  assert.equal(findRunningEntry(entries, 'b', null)!.grpcPort, 8556);
  assert.equal(findRunningEntry(entries, 'z'), null);
});

test('scanRunning: live pid = live and advertised; dead pid = stale, not advertised, file intact', () => {
  writeFileSync(join(dir, 'pid_100.ini'), RUNNING_INI());
  writeFileSync(join(dir, 'pid_200.ini'), RUNNING_INI({ avd: 'b', serial: 5556, grpc: 8556 }));
  const alive = (pid: number) => pid === 100;
  const live = scanRunning(dir, alive);
  assert.deepEqual(live.live.map((e) => e.pid), [100]);
  assert.deepEqual(live.stale.map((e) => e.pid), [200]);
  assert.equal(isAdvertised(findRunningEntry(live.live, 'bench-api35')), true, 'live advertised');
  assert.equal(findRunningEntry(live.live, 'b'), null, 'dead does not match');
  assert.equal(isAdvertised(findRunningEntry(live.live, 'b')), false);
  assert.ok(readFileSync(join(dir, 'pid_200.ini'), 'utf8').includes('avd.name=b'), 'stale is not deleted');
  assert.deepEqual(scanRunning(null, alive), { live: [], stale: [] });
});

test('scanRunning: same AVD with a dead advertised entry and a live entry = the live one stays', () => {
  writeFileSync(join(dir, 'pid_100.ini'), RUNNING_INI({ serial: 5554, grpc: 8554 })); // old, advertised, dead
  writeFileSync(join(dir, 'pid_300.ini'), RUNNING_INI({ serial: 5556, grpc: 8556 })); // current
  const { live, stale } = scanRunning(dir, (pid) => pid === 300);
  const e = findRunningEntry(live, 'bench-api35')!;
  assert.deepEqual([e.pid, e.serialPort, e.grpcPort, isAdvertised(e)], [300, 5556, 8556, true]);
  assert.deepEqual(stale.map((x) => x.pid), [100]);
  // Both alive: old behavior (prefers the advertised one, lowest pid first).
  assert.equal(findRunningEntry(scanRunning(dir, () => true).live, 'bench-api35')!.pid, 100);
  // Only the dead advertised one and a live one without token: the live one wins, not advertised.
  writeFileSync(join(dir, 'pid_300.ini'), RUNNING_INI({ serial: 5556, grpc: 8556, token: null }));
  const only = findRunningEntry(scanRunning(dir, (pid) => pid === 300).live, 'bench-api35')!;
  assert.deepEqual([only.pid, isAdvertised(only)], [300, false]);
});

test('nodePidAlive: own process is alive; invalid pid or 0 = dead (no group signal)', () => {
  assert.equal(nodePidAlive(process.pid), true);
  assert.equal(nodePidAlive(0), false);
  assert.equal(nodePidAlive(-1), false);
  assert.equal(nodePidAlive(1.5), false);
  assert.equal(nodePidAlive(2 ** 22 + 12345), false, 'above the default macOS/Linux pid_max');
});
