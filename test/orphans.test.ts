import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid } from '../src/android/fakeAndroid.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { loadSession, recordSession } from '../src/android/session.ts';
import { HELP, main } from '../src/cli.ts';
import { runDoctor } from '../src/doctor.ts';
import { DevslimError } from '../src/errors.ts';
import type { Exec, ExecOptions, FakeCall } from '../src/exec.ts';
import { createFakeIos, type FakeIosOptions } from '../src/ios/fakeIos.ts';
import { androidOrphans, forgetAvd, forgetSim, iosOrphans } from '../src/orphans.ts';
import { recordAndroidTune, recordIosBackup, statePath } from '../src/state.ts';
import { collectStatus, statusText } from '../src/status.ts';
import { pruneSession } from '../src/topLevel.ts';

// Orphan state (AVD or simulator that no longer exists), `forget` and `prune`.
// Nothing here may send a command to a device: the fake exec fails loudly on adb and
// records everything; the tests check there was no emu kill, shutdown or signal.

const UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';
const GONE = '71DA7575-EE5E-4B6A-82B4-54084F780EA9';
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';

let root: string;
let avdHome: string;
let home: string;
let storeBase: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-orphans-'));
  avdHome = join(root, 'avd');
  home = join(root, 'home');
  storeBase = join(root, 'var-tmp');
  mkdirSync(storeBase, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeAvd(name: string, o: { lock?: boolean } = {}): string {
  const dir = join(avdHome, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `path=${dir}\n`);
  writeFileSync(join(dir, 'config.ini'), 'hw.ramSize=2048\n');
  if (o.lock) mkdirSync(join(dir, 'hardware-qemu.ini.lock'));
  return dir;
}

function world(o: { ios?: Partial<FakeIosOptions>; simctlFails?: boolean; qemu?: Record<string, number> } = {}) {
  const android = createFakeAndroid({ avdHome });
  const ios = createFakeIos({ storeBase, ...o.ios });
  const calls: FakeCall[] = [];
  const signals: number[] = [];
  const exec: Exec = async (cmd: string, args: readonly string[], opts: ExecOptions = {}) => {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === 'pgrep') {
      const m = /^qemu-system\.\*-avd (.+)\( \|\$\)$/.exec(args[1] ?? '');
      const pid = m ? o.qemu?.[m[1]] : undefined;
      return Object.freeze({ code: pid === undefined ? 1 : 0, signal: null, stdout: pid === undefined ? '' : `${pid}\n`, stderr: '' });
    }
    if (cmd === 'xcrun' && o.simctlFails) return Object.freeze({ code: 72, signal: null, stdout: '', stderr: 'xcrun: error' });
    if (cmd === 'xcrun' || cmd === 'plutil') return ios.exec(cmd, args, opts);
    if (cmd === 'sysctl') return Object.freeze({ code: 0, signal: null, stdout: 'total = 2048.00M  used = 1024.00M  free = 1024.00M\n', stderr: '' });
    throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
  };
  const env = { HOME: root, ANDROID_HOME: android.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: home, PATH: '/usr/bin:/bin' };
  const runtime = {
    exec,
    sleep: android.sleep,
    now: android.now,
    date: android.date,
    fileExists: android.fileExists,
    storeBase,
    pidAlive: () => true,
    signalPid: (pid: number) => { signals.push(pid); },
  };
  const ctx = { ...runtime, env, stderr: () => {} };
  const call = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, env, cwd: root, runtime });
    return { code, stdout, stderr };
  };
  // No command that touches a device.
  const assertUntouched = () => {
    for (const c of calls) {
      const line = `${c.cmd} ${c.args.join(' ')}`;
      assert.doesNotMatch(line, /\badb\b|emu kill|simctl (shutdown|boot|erase|delete)/, line);
    }
    assert.deepEqual(signals, [], 'no signal sent');
  };
  return { ios, calls, signals, env, ctx, call, assertUntouched };
}

const tuneState = (env: Record<string, string>, name: string) =>
  recordAndroidTune(name, { avdDir: join(avdHome, `${name}.avd`), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile({}) }, { env });

const iosState = (env: Record<string, string>, udid: string, name: string) =>
  recordIosBackup(udid, { name, runtimeId: RUNTIME, previous: new Map(), profile: { capabilities: [], except: [], keep: [], labels: 0 } }, { env });

// ---------------------------------------------------------------------------
// detection

test('orphans: AVD without directory and UDID missing from simctl; existing ones do not count; failing simctl = not checked', async () => {
  const w = world({ ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17' }] } });
  makeAvd('alive-api35');
  tuneState(w.env, 'alive-api35');
  tuneState(w.env, 'gone-api35');
  iosState(w.env, UDID, 'QA-iPhone17');
  iosState(w.env, GONE, 'Deleted');

  assert.deepEqual(androidOrphans(w.env).map((o) => [o.id, o.path, o.forget]), [
    ['gone-api35', statePath('android', 'gone-api35', { env: w.env }), 'devslim android forget gone-api35'],
  ]);
  const devices = [{ udid: UDID, name: 'QA-iPhone17', state: 'Shutdown', runtimeId: RUNTIME, isAvailable: true }];
  assert.deepEqual(iosOrphans(w.env, devices)!.map((o) => [o.id, o.name, o.forget]), [[GONE, 'Deleted', `devslim ios forget ${GONE}`]]);
  assert.equal(iosOrphans(w.env, null), null, 'without simctl we cannot tell');
});

test('status: AVD not found and missing simulator get the forget hint', async () => {
  const w = world({ ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17' }] } });
  tuneState(w.env, 'gone-api35');
  iosState(w.env, GONE, 'Deleted');
  const lines = statusText(await collectStatus(w.ctx));
  assert.ok(lines.some((l) => /^android gone-api35: AVD not found \(.*gone-api35\.avd\); orphan state: devslim android forget gone-api35, baked no, stopped$/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`ios Deleted (${GONE}) missing: `) && l.endsWith(`simulator no longer exists; orphan state: devslim ios forget ${GONE}`)), lines.join('\n'));
  w.assertUntouched();
});

test('doctor orphan-state: warn per orphan state with its forget; ok when none; read-only', async () => {
  const clean = world();
  const ok = (await runDoctor({ ...clean.ctx, nodeVersion: 'v25.9.0' })).filter((c) => c.id === 'orphan-state');
  assert.deepEqual(ok.map((c) => c.level), ['ok']);

  const w = world({ ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17' }] } });
  makeAvd('alive-api35');
  tuneState(w.env, 'alive-api35');
  tuneState(w.env, 'gone-api35');
  iosState(w.env, UDID, 'QA-iPhone17');
  iosState(w.env, GONE, 'Deleted');
  const checks = (await runDoctor({ ...w.ctx, nodeVersion: 'v25.9.0' })).filter((c) => c.id === 'orphan-state');
  assert.deepEqual(checks.map((c) => [c.level, c.fix]), [
    ['warn', 'devslim android forget gone-api35'],
    ['warn', `devslim ios forget ${GONE}`],
  ]);
  assert.ok(checks[0].message.includes(statePath('android', 'gone-api35', { env: w.env })));
  assert.match(checks[0].message, /AVD gone-api35 no longer exists/);
  assert.match(checks[1].message, new RegExp(`simulator Deleted \\(${GONE}\\) no longer exists`));
  assert.ok(existsSync(statePath('android', 'gone-api35', { env: w.env })), 'doctor does not delete');

  // Same DEVSLIM_HOME: the Android orphan remains; the 2 iOS states get no verdict.
  const blind = world({ simctlFails: true });
  const b = (await runDoctor({ ...blind.ctx, nodeVersion: 'v25.9.0' })).filter((c) => c.id === 'orphan-state');
  assert.deepEqual(b.map((c) => [c.level, c.fix ?? null]), [['warn', 'devslim android forget gone-api35'], ['warn', null]]);
  assert.match(b[1].message, /^2 iOS state\(s\) not checked: xcrun simctl list devices -j failed$/);
});

// ---------------------------------------------------------------------------
// forget

test('android forget: existing AVD = refuses pointing to restore; --force removes state and session; never touches the device', async () => {
  const w = world();
  makeAvd('alive-api35', { lock: true });
  tuneState(w.env, 'alive-api35');
  recordSession({ platform: 'android', avd: 'alive-api35', serial: 'emulator-5554', pid: 4000, port: 5554, startedAt: 'a' }, w.env);

  assert.throws(() => forgetAvd('alive-api35', { env: w.env }), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.match(err.message, /AVD alive-api35 still exists/);
    assert.match(err.message, /devslim android restore alive-api35/);
    assert.match(err.message, /--force/);
    return true;
  });
  assert.ok(existsSync(statePath('android', 'alive-api35', { env: w.env })));

  const r = await w.call(['android', 'forget', 'alive-api35', '--force']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^state removed: .*alive-api35\.json$/m);
  assert.match(r.stdout, /^session: entry emulator-5554 removed$/m);
  assert.match(r.stdout, /AVD alive-api35 still exists; only the devslim records were removed \(--force\), the AVD was not touched/);
  assert.equal(existsSync(statePath('android', 'alive-api35', { env: w.env })), false);
  assert.deepEqual(loadSession(w.env), []);
  assert.ok(existsSync(join(avdHome, 'alive-api35.avd', 'config.ini')), 'AVD intact');
  w.assertUntouched();
});

test('android forget: orphan state goes without --force; session too; nothing to forget = error; --json', async () => {
  const w = world();
  tuneState(w.env, 'gone-api35');
  recordSession({ platform: 'android', avd: 'gone-api35', serial: 'emulator-5556', pid: 4001, port: 5556, startedAt: 'b' }, w.env);
  recordSession({ platform: 'android', avd: 'other-api35', serial: 'emulator-5558', pid: 4002, port: 5558, startedAt: 'c' }, w.env);
  const r = await w.call(['android', 'forget', 'gone-api35', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(
    [j.platform, j.id, j.deviceExists, j.removedState, j.removedSession.map((e: { serial: string }) => e.serial)],
    ['android', 'gone-api35', false, true, ['emulator-5556']],
  );
  assert.deepEqual(loadSession(w.env).map((e) => e.avd), ['other-api35']);
  const again = await w.call(['android', 'forget', 'gone-api35']);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /nothing to forget/);
  assert.equal((await w.call(['android', 'forget'])).code, 2);
  w.assertUntouched();
});

test('ios forget: existing simulator = refuses pointing to ios off; --force removes; missing one goes by UDID or saved name', async () => {
  const w = world({ ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted' }] } });
  iosState(w.env, UDID, 'QA-iPhone17');
  iosState(w.env, GONE, 'Deleted');
  recordSession({ platform: 'ios', avd: 'Deleted', serial: GONE, pid: 0, port: 0, startedAt: 'd' }, w.env);

  await assert.rejects(forgetSim('QA-iPhone17', w.ctx), /simulator QA-iPhone17 \(DBF8B093-58A2-4B57-812A-60D6CF8594BD\) still exists.*devslim ios off DBF8B093/);
  const forced = await w.call(['ios', 'forget', 'QA-iPhone17', '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /^state removed: .*DBF8B093-58A2-4B57-812A-60D6CF8594BD\.json$/m);
  assert.equal(w.ios.sims.get(UDID)!.state, 'Booted', 'device intact');

  const byName = await forgetSim('Deleted', w.ctx);
  assert.deepEqual([byName.id, byName.deviceExists, byName.removedState, byName.removedSession.length], [GONE, false, true, 1]);
  assert.deepEqual(loadSession(w.env), []);
  await assert.rejects(forgetSim(GONE.toLowerCase(), w.ctx), /nothing to forget/);
  w.assertUntouched();
});

test('ios forget: without simctl we cannot check = refuses without --force; with --force removes', async () => {
  const w = world({ simctlFails: true });
  iosState(w.env, GONE, 'Deleted');
  await assert.rejects(forgetSim(GONE, w.ctx), /could not check whether simulator Deleted .* exists.*--force/);
  const r = await forgetSim(GONE, { ...w.ctx, force: true });
  assert.deepEqual([r.deviceExists, r.removedState], [null, true]);
  w.assertUntouched();
});

// ---------------------------------------------------------------------------
// prune

test('prune: removes only entries of devices no longer running (and their idle-down); never shuts down or signals', async () => {
  makeAvd('alive-api35', { lock: true });
  makeAvd('stopped-api35');
  const w = world({
    ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted' }, { udid: GONE, name: 'Off', state: 'Shutdown' }] },
    qemu: {},
  });
  const idleDown = { ms: 120_000, watcherPid: 777, startedAt: 'w' };
  recordSession({ platform: 'android', avd: 'alive-api35', serial: 'emulator-5554', pid: 4000, port: 5554, startedAt: 'a' }, w.env);
  recordSession({ platform: 'android', avd: 'stopped-api35', serial: 'emulator-5556', pid: 4001, port: 5556, startedAt: 'b', idleDown }, w.env);
  recordSession({ platform: 'ios', avd: 'QA-iPhone17', serial: UDID, pid: 0, port: 0, startedAt: 'c' }, w.env);
  recordSession({ platform: 'ios', avd: 'Off', serial: GONE, pid: 0, port: 0, startedAt: 'd' }, w.env);

  const res = await pruneSession(w.ctx);
  assert.deepEqual(res.map((r) => [r.platform, r.name, r.id, r.idleDown?.watcherPid ?? null]), [
    ['android', 'stopped-api35', 'emulator-5556', 777],
    ['ios', 'Off', GONE, null],
  ]);
  assert.deepEqual(loadSession(w.env).map((e) => e.avd), ['alive-api35', 'QA-iPhone17']);
  assert.equal(w.ios.sims.get(GONE)!.state, 'Shutdown');
  assert.equal(w.ios.sims.get(UDID)!.state, 'Booted');
  w.assertUntouched();
  assert.ok(existsSync(join(avdHome, 'alive-api35.avd', 'hardware-qemu.ini.lock')));
});

test('cli prune: text, --json, nothing to clean up; does not delete state', async () => {
  const w = world({ ios: { simulators: [] } });
  tuneState(w.env, 'gone-api35');
  recordSession({ platform: 'android', avd: 'gone-api35', serial: 'emulator-5556', pid: 4001, port: 5556, startedAt: 'b' }, w.env);
  const t = await w.call(['prune']);
  assert.equal(t.code, 0, t.stderr);
  assert.equal(t.stdout, 'removed from session: android gone-api35 emulator-5556 (no lock and no qemu running)\n');
  assert.ok(existsSync(statePath('android', 'gone-api35', { env: w.env })), 'prune does not touch state');
  const empty = await w.call(['prune']);
  assert.equal(empty.stdout, 'nothing to clean up\n');
  const j = await w.call(['prune', '--json']);
  assert.deepEqual(JSON.parse(j.stdout), { removed: [] });
  assert.equal((await w.call(['prune', 'x'])).code, 2);
  w.assertUntouched();
});

test('help: forget on both platforms, prune, and down vs prune', () => {
  assert.match(HELP, /devslim android forget <avd> \[--force\] \[--json\]/);
  assert.match(HELP, /devslim ios forget <udid\|name> \[--force\] \[--json\]/);
  assert.match(HELP, /devslim prune \[--json\]/);
  assert.match(HELP, /prune only cleans records/);
});
