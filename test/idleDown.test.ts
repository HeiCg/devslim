import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { loadSession, recordSession, updateSession, type SessionEntry } from '../src/android/session.ts';
import { HELP, main } from '../src/cli.ts';
import { runDoctor } from '../src/doctor.ts';
import { createFakeExec, type FakeCall } from '../src/exec.ts';
import { DEVSLIM_BIN } from '../src/idle.ts';
import { createFakeIos, type FakeIosOptions } from '../src/ios/fakeIos.ts';
import { labelsToDisable } from '../src/ios/labels.ts';
import { collectStatus, statusText } from '../src/status.ts';
import { downAll } from '../src/topLevel.ts';

// Idle-down end to end: main() in-process with fake Android and iOS.
// No real process: the "spawned" watcher only gets a pid in the fake.

const PHONE = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url));
const SIM = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';
const DATE = '2026-11-16T12:00:00.000Z';
const THIRD_PARTY = '  topResumedActivity=ActivityRecord{1f2e u0 com.minhaempresa.app/.MainActivity t12}\n';

let root: string;
let avdHome: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-idle-'));
  avdHome = join(root, 'avd');
  home = join(root, 'devslim-home');
  const avdDir = join(avdHome, 'fake-api35.avd');
  mkdirSync(avdDir, { recursive: true });
  writeFileSync(join(avdHome, 'fake-api35.ini'), `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/fake-api35.avd\ntarget=android-35\n`);
  writeFileSync(join(avdDir, 'config.ini'), PHONE);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Io = { code: number; stdout: string; stderr: string };

function android(opts: FakeAndroidOptions = {}, extra: { sleep?: (ms: number) => Promise<void> } = {}) {
  const fake = createFakeAndroid({ avdHome, avdDir: (name) => join(avdHome, `${name}.avd`), ...opts });
  const env = { PATH: process.env.PATH ?? '', HOME: root, ANDROID_HOME: fake.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: home };
  const runtime = {
    exec: fake.exec,
    spawnDetached: fake.spawnDetached,
    sleep: extra.sleep ?? fake.sleep,
    now: fake.now,
    date: fake.date,
    fileExists: fake.fileExists,
    dirExists: fake.dirExists,
    arch: fake.arch,
    pidAlive: fake.pidAlive,
    signalPid: fake.signalPid,
  };
  const call = async (args: string[]): Promise<Io> => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, env, cwd: root, runtime });
    return { code, stdout, stderr };
  };
  return { fake, env, runtime, call };
}

function ios(opts: Partial<FakeIosOptions> = {}) {
  const storeBase = join(root, 'var-tmp');
  mkdirSync(storeBase, { recursive: true });
  const fake = createFakeIos({ storeBase, simulators: [{ udid: SIM, name: 'QA-iPhone17' }], ...opts });
  const env = { PATH: process.env.PATH ?? '', HOME: root, DEVSLIM_HOME: home };
  const runtime = {
    exec: fake.exec,
    spawnDetached: fake.spawnDetached,
    sleep: fake.sleep,
    now: fake.now,
    date: fake.date,
    fileExists: fake.fileExists,
    storeBase,
    pidAlive: fake.pidAlive,
    signalPid: fake.signalPid,
  };
  const call = async (args: string[]): Promise<Io> => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; }, env, cwd: root, runtime });
    return { code, stdout, stderr };
  };
  return { fake, env, runtime, call };
}

const entryOf = (env: Record<string, string>, platform: 'android' | 'ios'): SessionEntry | undefined =>
  loadSession(env).find((e) => e.platform === platform);

// ---------------------------------------------------------------------------
// help and usage

test('help: --idle-down in android up and ios up; _idle-watch not in help', async () => {
  assert.match(HELP, /devslim android up <avd> .*--idle-down D/);
  assert.match(HELP, /devslim ios up <udid\|name> .*--idle-down D/);
  assert.match(HELP, /--idle-down D +android up\/ios up: shuts the device down after D with no third-party app/);
  assert.doesNotMatch(HELP, /_idle-watch|idle-watch|idle-ms/);
  const { call } = android();
  const h = await call(['--help']);
  assert.doesNotMatch(h.stdout, /_idle-watch/);
});

test('up --idle-down: invalid duration or below 2m = usage error before booting; plan/tune do not accept it', async () => {
  const { fake, call } = android();
  for (const v of ['90s', '1', 'abc']) {
    const r = await call(['android', 'up', 'fake-api35', '--idle-down', v]);
    assert.equal(r.code, 2, v);
    assert.match(r.stderr, /^devslim: --idle-down /m);
  }
  assert.equal((await call(['android', 'plan', 'fake-api35', '--idle-down', '30m'])).code, 2);
  assert.equal((await call(['android', 'tune', 'fake-api35', '--idle-down', '30m'])).code, 2);
  assert.equal(fake.spawnCalls.length, 0, 'nothing started');
  const i = ios();
  const r = await i.call(['ios', 'up', 'QA-iPhone17', '--idle-down', '1m']);
  assert.equal(r.code, 2);
  assert.equal(i.fake.sims.get(SIM)!.boots, 0);
});

// ---------------------------------------------------------------------------
// Android: up, second up, down

test('android up --idle-down 30m: spawns the detached watcher, records it in the session and prints the line', async () => {
  const { fake, env, call } = android();
  const r = await call(['android', 'up', 'fake-api35', '--idle-down', '30m']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fake.spawnCalls.length, 2, 'emulator + watcher');
  const w = fake.spawnCalls[1];
  assert.equal(w.cmd, process.execPath);
  assert.deepEqual(w.args, [DEVSLIM_BIN, '_idle-watch', 'android', 'fake-api35', '--idle-ms', '1800000']);
  const logFile = join(home, 'logs', 'idle-fake-api35.log');
  assert.equal(w.opts.logFile, logFile);
  const pid = [...fake.watchers.keys()][0];
  const e = entryOf(env, 'android')!;
  assert.deepEqual(e.idleDown, { ms: 1_800_000, watcherPid: pid, startedAt: DATE });
  assert.ok(r.stdout.trimEnd().endsWith(`idle-down: after 30m with no app in use (watcher pid ${pid}, log ${logFile})`));
  // The tune profile does not keep idle-down.
  assert.doesNotMatch(JSON.stringify(loadSession(env)) + readFileSync(join(home, 'state', 'session.json'), 'utf8'), /idle-down/);
});

test('android up --idle-down --json: idleDown in the object; without the flag, no key', async () => {
  const a = android();
  const j = JSON.parse((await a.call(['android', 'up', 'fake-api35', '--idle-down', '1h', '--json'])).stdout);
  assert.equal(j.idleDown.ms, 3_600_000);
  assert.equal(j.idleDown.logFile, join(home, 'logs', 'idle-fake-api35.log'));
  assert.equal(typeof j.idleDown.watcherPid, 'number');
  const b = android();
  rmSync(join(home, 'state', 'session.json'));
  const plain = JSON.parse((await b.call(['android', 'up', 'fake-api35', '--json'])).stdout);
  assert.ok(!('idleDown' in plain));
});

test('a second up --idle-down of the same AVD replaces the watcher (SIGTERM to the old one first)', async () => {
  const { fake, env, call } = android();
  assert.equal((await call(['android', 'up', 'fake-api35', '--idle-down', '30m'])).code, 0);
  const first = entryOf(env, 'android')!.idleDown!.watcherPid;
  const again = await call(['android', 'up', 'fake-api35', '--idle-down', '10']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /was already running on emulator-5554/);
  assert.match(again.stdout, /idle-down: after 10m with no app in use/);
  assert.deepEqual(fake.signals, [{ pid: first, signal: 'SIGTERM' }]);
  const e = entryOf(env, 'android')!;
  assert.notEqual(e.idleDown!.watcherPid, first);
  assert.equal(e.idleDown!.ms, 600_000);
  assert.deepEqual([...fake.watchers.keys()], [e.idleDown!.watcherPid]);
  assert.equal(fake.spawnCalls.filter((c) => c.args.includes('_idle-watch')).length, 2);
});

test('up --idle-down on an AVD devslim did not start: warning, no watcher', async () => {
  const { fake, env, call } = android({ emulators: [{ avd: 'fake-api35', port: 5554 }] });
  const r = await call(['android', 'up', 'fake-api35', '--idle-down', '30m']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /^devslim: warning: idle-down ignored: AVD fake-api35 was not started by devslim \(nothing in the session\)$/m);
  assert.doesNotMatch(r.stdout, /idle-down:/);
  assert.equal(fake.spawnCalls.length, 0);
  assert.deepEqual(loadSession(env), []);
});

test('android down <avd> and android down: SIGTERM to the watcher and entry removed', async () => {
  for (const args of [['android', 'down', 'fake-api35'], ['android', 'down'], ['down']]) {
    rmSync(home, { recursive: true, force: true });
    const { fake, env, call } = android();
    assert.equal((await call(['android', 'up', 'fake-api35', '--idle-down', '30m'])).code, 0);
    const pid = entryOf(env, 'android')!.idleDown!.watcherPid;
    const r = await call(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.deepEqual(fake.signals, [{ pid, signal: 'SIGTERM' }], args.join(' '));
    assert.equal(fake.watchers.size, 0);
    assert.deepEqual(loadSession(env), []);
  }
});

test('failing android down: watcher terminated and idleDown field cleared even though the entry stays', async () => {
  const { fake, env, runtime, call } = android({ spawned: { ignoresKill: true } });
  assert.equal((await call(['android', 'up', 'fake-api35', '--idle-down', '30m'])).code, 0);
  const pid = entryOf(env, 'android')!.idleDown!.watcherPid;
  const r = await main(['android', 'down', 'fake-api35'], { stdout: () => {}, stderr: () => {}, env, cwd: root, runtime: { ...runtime, exitTimeoutMs: 2000, pollMs: 1000 } });
  assert.equal(r, 1);
  assert.deepEqual(fake.signals, [{ pid, signal: 'SIGTERM' }]);
  const e = entryOf(env, 'android')!;
  assert.ok(e !== undefined, 'entry stays for the next down');
  assert.equal(e.idleDown, undefined);
});

test('down never signals a pid that is not the watcher (reused pid): only clears the field', async () => {
  const { fake, env, call } = android();
  assert.equal((await call(['android', 'up', 'fake-api35', '--idle-down', '30m'])).code, 0);
  const pid = entryOf(env, 'android')!.idleDown!.watcherPid;
  fake.watchers.delete(pid); // died; the pid may belong to another process now
  assert.equal((await call(['android', 'down'])).code, 0);
  assert.deepEqual(fake.signals, []);
  assert.deepEqual(loadSession(env), []);
});

test('top-level down: dead entry with watcher = SIGTERM to the watcher and entry removed', async () => {
  const fake = createFakeAndroid({ avdHome });
  const env = { HOME: root, ANDROID_HOME: fake.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: home, PATH: '/usr/bin:/bin' };
  const { pid } = await fake.spawnDetached(process.execPath, [DEVSLIM_BIN, '_idle-watch', 'android', 'gone-api35', '--idle-ms', '120000'], { logFile: join(root, 'x.log') });
  recordSession({ platform: 'android', avd: 'gone-api35', serial: 'emulator-5558', pid: 4001, port: 5558, startedAt: 'b', idleDown: { ms: 120_000, watcherPid: pid, startedAt: 'b' } }, env);
  const res = await downAll({ env, exec: fake.exec, sleep: fake.sleep, now: fake.now, fileExists: fake.fileExists, signalPid: fake.signalPid, stderr: () => {} });
  assert.deepEqual(res.map((r) => [r.name, r.result]), [['gone-api35', 'stale']]);
  assert.deepEqual(fake.signals, [{ pid, signal: 'SIGTERM' }]);
  assert.deepEqual(loadSession(env), []);
});

// ---------------------------------------------------------------------------
// iOS: up, second up, down

test('ios up --idle-down 1h: watcher with the UDID, session and line in the text; second up replaces it; ios down terminates it', async () => {
  const { fake, env, call } = ios();
  const up = await call(['ios', 'up', 'QA-iPhone17', '--idle-down', '1h']);
  assert.equal(up.code, 0, up.stderr);
  const w = fake.spawnCalls[0];
  assert.equal(w.cmd, process.execPath);
  assert.deepEqual(w.args, [DEVSLIM_BIN, '_idle-watch', 'ios', SIM, '--idle-ms', '3600000']);
  assert.equal(w.opts.logFile, join(home, 'logs', `idle-${SIM}.log`));
  const first = entryOf(env, 'ios')!.idleDown!;
  assert.deepEqual(first, { ms: 3_600_000, watcherPid: [...fake.watchers.keys()][0], startedAt: DATE });
  assert.match(up.stdout, new RegExp(`^idle-down: after 1h with no app in use \\(watcher pid ${first.watcherPid}, log .*idle-${SIM}\\.log\\)$`, 'm'));

  const again = await call(['ios', 'up', 'QA-iPhone17', '--idle-down', '45m', '--json']);
  assert.equal(again.code, 0, again.stderr);
  const j = JSON.parse(again.stdout);
  assert.equal(j.alreadySlim, true);
  assert.equal(j.idleDown.ms, 45 * 60_000);
  assert.deepEqual(fake.signals, [{ pid: first.watcherPid, signal: 'SIGTERM' }]);
  assert.equal(entryOf(env, 'ios')!.idleDown!.watcherPid, j.idleDown.watcherPid);

  const down = await call(['ios', 'down', 'QA-iPhone17']);
  assert.equal(down.code, 0, down.stderr);
  assert.deepEqual(fake.signals.map((s) => s.pid), [first.watcherPid, j.idleDown.watcherPid]);
  assert.equal(fake.watchers.size, 0);
  assert.deepEqual(loadSession(env), []);
  assert.equal(fake.sims.get(SIM)!.state, 'Shutdown');
});

test('ios up --idle-down on a simulator already booted and slim outside the session: warning with the reason, no watcher', async () => {
  const live = Object.fromEntries(labelsToDisable().map((l) => [l, true]));
  const { fake, env, call } = ios({ simulators: [{ udid: SIM, name: 'QA-iPhone17', state: 'Booted', live }] });
  const r = await call(['ios', 'up', 'QA-iPhone17', '--idle-down', '30m']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(
    r.stderr,
    /idle-down ignored: simulator QA-iPhone17 \(DBF8B093-58A2-4B57-812A-60D6CF8594BD\): simulator was already booted and slim; devslim did not start it \(nothing in the session\)/,
  );
  assert.equal(fake.spawnCalls.length, 0);
  assert.deepEqual(loadSession(env), []);
});

test('ios up --idle-down on a simulator already booted outside the profile: the reboot is devslim, watcher starts; ios down without --force', async () => {
  const { fake, env, call } = ios({ simulators: [{ udid: SIM, name: 'QA-iPhone17', state: 'Booted', live: { 'com.apple.apsd': true } }] });
  const r = await call(['ios', 'up', 'QA-iPhone17', '--idle-down', '30m']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /idle-down ignored/);
  assert.equal(fake.spawnCalls.length, 1);
  assert.match(r.stdout, /^idle-down: after 30m with no app in use/m);
  assert.equal(entryOf(env, 'ios')!.idleDown!.ms, 30 * 60_000);
  const down = await call(['ios', 'down', 'QA-iPhone17']);
  assert.equal(down.code, 0, down.stderr);
  assert.equal(fake.sims.get(SIM)!.state, 'Shutdown');
  assert.deepEqual(loadSession(env), []);
});

test('top-level down with iOS: SIGTERM to the simulator watcher', async () => {
  const { fake, env, call } = ios();
  assert.equal((await call(['ios', 'up', SIM, '--idle-down', '30m'])).code, 0);
  const pid = entryOf(env, 'ios')!.idleDown!.watcherPid;
  const r = await call(['down']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fake.signals, [{ pid, signal: 'SIGTERM' }]);
  assert.deepEqual(loadSession(env), []);
});

// ---------------------------------------------------------------------------
// _idle-watch process

// Starts through the CLI and swaps watcherPid for this process pid (the "watcher").
async function upAndOwn(a: ReturnType<typeof android>): Promise<void> {
  assert.equal((await a.call(['android', 'up', 'fake-api35', '--idle-down', '2m'])).code, 0);
  updateSession((e) => e.platform === 'android', (e) => ({ ...e, idleDown: { ...e.idleDown!, watcherPid: process.pid } }), a.env);
}

test('_idle-watch android: launcher the whole time = shuts down via android down, cleans the session and logs with a timestamp', async () => {
  const a = android();
  await upAndOwn(a);
  const t0 = a.fake.now();
  const r = await a.call(['_idle-watch', 'android', 'fake-api35', '--idle-ms', '120000']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(a.fake.emulators.size, 0, 'emulator shut down');
  assert.deepEqual(loadSession(a.env), []);
  assert.equal(a.fake.now() - t0, 120_000);
  assert.match(r.stdout, new RegExp(`^${DATE.replace(/\./g, '\\.')} idle-down: android fake-api35 \\(emulator-5554\\) shut down after 2m with no app in use \\(limit 2m\\)$`, 'm'));
  assert.ok(a.fake.deviceCommands().includes('shell dumpsys activity activities'));
  assert.ok(a.fake.deviceCommands().includes('emu kill'));
});

test('_idle-watch android: a third-party app in the foreground resets the clock', async () => {
  // Only counts the watcher sleeps (up also sleeps waiting for the gRPC advertisement).
  let n: number | null = null;
  const box: { a?: ReturnType<typeof android> } = {};
  const a = android({ spawned: { activities: THIRD_PARTY } }, {
    sleep: async (ms) => {
      await box.a!.fake.sleep(ms);
      if (n !== null && ++n === 4) for (const e of box.a!.fake.emulators.values()) e.activities = '';
    },
  });
  box.a = a;
  await upAndOwn(a);
  n = 0;
  const t0 = a.fake.now();
  const r = await a.call(['_idle-watch', 'android', 'fake-api35', '--idle-ms', '120000']);
  assert.equal(r.code, 0, r.stderr);
  // Use seen at 30, 60 and 90 s; idle (empty output) from 120 s: shuts down at 90 + 120.
  assert.equal(a.fake.now() - t0, 210_000);
  assert.equal(a.fake.emulators.size, 0);
});

test('_idle-watch: watcher record belongs to another pid = exits without shutting down', async () => {
  const a = android();
  assert.equal((await a.call(['android', 'up', 'fake-api35', '--idle-down', '2m'])).code, 0);
  const r = await a.call(['_idle-watch', 'android', 'fake-api35', '--idle-ms', '120000']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /watcher record left the session/);
  assert.equal(a.fake.emulators.size, 1, 'nothing shut down');
  assert.equal(a.fake.deviceCommands().filter((c) => c === 'emu kill').length, 0);
});

test('_idle-watch: session entry from another boot (different pid) = exits without shutting down', async () => {
  const a = android();
  await upAndOwn(a);
  let n = 0;
  let out = '';
  const r = await main(['_idle-watch', 'android', 'fake-api35', '--idle-ms', '120000'], {
    stdout: (t) => { out += t; },
    stderr: () => {},
    env: a.env,
    cwd: root,
    runtime: {
      ...a.runtime,
      sleep: async (ms) => {
        await a.fake.sleep(ms);
        // After the 1st poll, another up records another emulator for the same AVD.
        if (++n === 2) updateSession((e) => e.platform === 'android', (e) => ({ ...e, pid: e.pid + 1 }), a.env);
      },
    },
  });
  assert.equal(r, 0);
  assert.match(out, /session entry belongs to another boot; exiting without shutting down/);
  assert.equal(a.fake.emulators.size, 1);
  assert.equal(a.fake.deviceCommands().filter((c) => c === 'emu kill').length, 0);
});

test('_idle-watch: device stopped or no session entry = exits without shutting down', async () => {
  const a = android();
  await upAndOwn(a);
  a.fake.emulators.clear();
  const gone = await a.call(['_idle-watch', 'android', 'fake-api35', '--idle-ms', '120000']);
  assert.equal(gone.code, 0);
  assert.match(gone.stdout, /device is no longer running; exiting without shutting down/);
  assert.ok(loadSession(a.env).length === 1, 'session is not touched by the watcher');

  const none = await a.call(['_idle-watch', 'android', 'other-avd', '--idle-ms', '120000']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /no session entry; exiting without shutting down/);
});

test('_idle-watch: 3 consecutive probe failures = exits without shutting down, exit 1, log', async () => {
  const a = android();
  await upAndOwn(a);
  for (const e of a.fake.emulators.values()) e.state = 'offline'; // shell fails, serial stays in adb
  const r = await a.call(['_idle-watch', 'android', 'fake-api35', '--idle-ms', '120000']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /probe failed \(3\/3\)/);
  assert.match(r.stdout, /3 consecutive failures probing the device/);
  assert.equal(a.fake.emulators.size, 1);
});

test('_idle-watch: invalid arguments = usage error', async () => {
  const a = android();
  for (const args of [['_idle-watch'], ['_idle-watch', 'windows', 'x', '--idle-ms', '120000'], ['_idle-watch', 'android', 'x'], ['_idle-watch', 'android', 'x', '--idle-ms', '1000']]) {
    assert.equal((await a.call(args)).code, 2, args.join(' '));
  }
});

test('_idle-watch ios: a third-party app keeps it on; only Apple apps afterwards = shuts down 2m after the last use', async () => {
  const i = ios({ simulators: [{ udid: SIM, name: 'QA-iPhone17', launchctlList: 'PID\tStatus\tLabel\n933\t0\tUIKitApplication:com.minhaempresa.app[a1b2][rb-legacy]\n' }] });
  assert.equal((await i.call(['ios', 'up', SIM, '--idle-down', '2m'])).code, 0);
  updateSession((e) => e.platform === 'ios', (e) => ({ ...e, idleDown: { ...e.idleDown!, watcherPid: process.pid } }), i.env);
  let n = 0;
  const t0 = i.fake.now();
  const code = await main(['_idle-watch', 'ios', SIM, '--idle-ms', '120000'], {
    stdout: () => {},
    stderr: () => {},
    env: i.env,
    cwd: root,
    runtime: {
      ...i.runtime,
      sleep: async (ms) => {
        await i.fake.sleep(ms);
        // 10 polls (300 s, more than the limit) with the app open; then only Apple.
        if (++n === 10) i.fake.sims.get(SIM)!.launchctlList = 'PID\tStatus\tLabel\n512\t0\tcom.apple.SpringBoard\n';
      },
    },
  });
  assert.equal(code, 0);
  assert.equal(i.fake.now() - t0, 390_000, 'last use at 270 s + 120 s');
  assert.equal(i.fake.sims.get(SIM)!.state, 'Shutdown');
});

test('_idle-watch ios: only Apple apps = ios down', async () => {
  const i = ios();
  assert.equal((await i.call(['ios', 'up', SIM, '--idle-down', '2m'])).code, 0);
  updateSession((e) => e.platform === 'ios', (e) => ({ ...e, idleDown: { ...e.idleDown!, watcherPid: process.pid } }), i.env);
  const r = await i.call(['_idle-watch', 'ios', SIM, '--idle-ms', '120000']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(i.fake.sims.get(SIM)!.state, 'Shutdown');
  assert.deepEqual(loadSession(i.env), []);
  assert.match(r.stdout, new RegExp(`idle-down: ios QA-iPhone17 \\(${SIM}\\) shut down after 2m with no app in use`));
  assert.ok(i.fake.simctlCommands().includes(`spawn ${SIM} launchctl list`));
});

// ---------------------------------------------------------------------------
// status e doctor

function statusWorld() {
  const avdDir = join(avdHome, 'fake-api35.avd');
  mkdirSync(join(avdDir, 'hardware-qemu.ini.lock'), { recursive: true }); // running by lock
  const env = { HOME: root, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: home, PATH: '/usr/bin:/bin' };
  const exec = createFakeExec((c: FakeCall) => {
    if (c.cmd === 'pgrep') return { code: 1 };
    if (c.cmd === 'xcrun') return { stdout: JSON.stringify({ devices: {} }) };
    if (c.cmd === 'sysctl') return { stdout: 'total = 2048.00M  used = 100.00M  free = 1948.00M  (encrypted)\n' };
    if (c.cmd === 'ps') return { code: 1 };
    if (c.cmd === 'xcodebuild') return { stdout: 'Xcode 26.4\n' };
    return undefined;
  });
  recordSession({ platform: 'android', avd: 'fake-api35', serial: 'emulator-5554', pid: 4000, port: 5554, startedAt: 'a', idleDown: { ms: 1_800_000, watcherPid: 777, startedAt: 'a' } }, env);
  return { env, exec };
}

test('status: idle-down in the text and idleDown {ms, watcherPid, watcherAlive} in the JSON', async () => {
  const { env, exec } = statusWorld();
  const alive = await collectStatus({ env, exec, pidAlive: (p) => p === 777 });
  assert.deepEqual(alive.session[0].idleDown, { ms: 1_800_000, watcherPid: 777, watcherAlive: true });
  assert.ok(statusText(alive).includes('session android fake-api35 emulator-5554: alive, idle-down after 30m with no app in use (watcher pid 777 alive)'));
  const dead = await collectStatus({ env, exec, pidAlive: () => false });
  assert.equal(dead.session[0].idleDown!.watcherAlive, false);
  assert.ok(statusText(dead).some((l) => l.endsWith('(watcher pid 777 DEAD)')));
});

test('doctor stale-session: dead watcher with device running = warn with the fix; alive = just ok', async () => {
  const { env, exec } = statusWorld();
  const bad = (await runDoctor({ env, exec, nodeVersion: 'v25.9.0', pidAlive: () => false })).filter((c) => c.id === 'stale-session');
  assert.deepEqual(bad.map((c) => c.level), ['ok', 'warn']);
  assert.match(bad[1].message, /^android fake-api35 emulator-5554: idle-down watcher \(pid 777\) died while the device was running/);
  assert.equal(bad[1].fix, 'devslim android up fake-api35 --idle-down 30m\nor devslim down');
  const ok = (await runDoctor({ env, exec, nodeVersion: 'v25.9.0', pidAlive: (p) => p === 777 })).filter((c) => c.id === 'stale-session');
  assert.deepEqual(ok.map((c) => c.level), ['ok']);
});
