import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { loadSession, recordSession } from '../src/android/session.ts';
import { main } from '../src/cli.ts';
import { createFakeExec, type FakeCall } from '../src/exec.ts';
import { serializeStorePlist, storePath } from '../src/ios/disabledStore.ts';
import { labelsToDisable } from '../src/ios/labels.ts';
import { loadState, recordAndroidTune, recordIosBackup, saveState, type AndroidState } from '../src/state.ts';
import { collectStatus } from '../src/status.ts';

const UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';
const OTHER = '71DA7575-EE5E-4B6A-82B4-54084F780EA9';
const THIRD = 'EA4002BA-2C6B-412F-9390-99411B12A7D7';
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
const SWAP = 'total = 18432.00M  used = 17722.06M  free = 709.94M  (encrypted)';
const ALL = labelsToDisable();

let root: string;
let avdHome: string;
let home: string;
let storeBase: string;
let env: Record<string, string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-status-'));
  avdHome = join(root, 'avd');
  home = join(root, 'home');
  storeBase = join(root, 'var-tmp');
  mkdirSync(storeBase);
  env = { HOME: root, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: home, PATH: '/usr/bin:/bin' };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeAvd(name: string, opts: { tuned?: boolean; ramMb?: number; gpu?: string; baked?: boolean; lock?: boolean } = {}): string {
  const dir = join(avdHome, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `path=${dir}\n`);
  writeFileSync(join(dir, 'config.ini'), 'hw.ramSize=2G\nhw.gpu.mode=auto\n');
  writeFileSync(join(dir, 'multiinstance.lock'), '');
  if (opts.tuned !== false) {
    const profile = buildAndroidProfile({ ramMb: opts.ramMb, gpu: opts.gpu });
    recordAndroidTune(name, { avdDir: dir, originalConfigIni: 'x', originalConfigSha256: 'y', profile }, { env });
  }
  if (opts.baked) mkdirSync(join(dir, 'snapshots', 'slim_base'), { recursive: true });
  if (opts.lock) mkdirSync(join(dir, 'hardware-qemu.ini.lock'));
  return dir;
}

function seedStore(udid: string, entries: Iterable<[string, boolean]>): void {
  const p = storePath(udid, { base: storeBase });
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, serializeStorePlist(new Map(entries)));
}

function iosState(udid: string, name: string, opts: { capabilities?: string[] } = {}): void {
  const labels = labelsToDisable({ capabilities: opts.capabilities as never });
  recordIosBackup(
    udid,
    {
      name,
      runtimeId: RUNTIME,
      previous: new Map(labels.map((l) => [l, undefined])),
      profile: { capabilities: opts.capabilities ?? [], except: [], keep: [], labels: labels.length },
      now: new Date('2026-11-16T10:00:00.000Z'),
    },
    { env },
  );
}

type Sim = { udid: string; name: string; state: string };

// qemu: pid -> command line, for `pgrep -fl qemu-system` and `ps -o command= -p`.
function fakeExec(o: { sims?: Sim[]; pgrep?: Record<string, string>; simctlFails?: boolean; qemu?: Record<string, string> } = {}) {
  return createFakeExec((c: FakeCall) => {
    if (c.cmd === 'pgrep' && c.args.join(' ') === '-fl qemu-system') {
      const lines = Object.entries(o.qemu ?? {}).map(([pid, line]) => `${pid} ${line}\n`);
      return lines.length === 0 ? { code: 1 } : { stdout: lines.join('') };
    }
    if (c.cmd === 'ps' && c.args.slice(0, 3).join(' ') === '-o command= -p') {
      const line = o.qemu?.[c.args[3]];
      return line === undefined ? { code: 1 } : { stdout: `${line}\n` };
    }
    if (c.cmd === 'xcrun' && c.args.join(' ') === 'simctl list devices -j') {
      if (o.simctlFails) return { code: 72, stderr: 'xcrun: error: unable to find utility "simctl"' };
      const devices = { [RUNTIME]: (o.sims ?? []).map((s) => ({ ...s, isAvailable: true })) };
      return { stdout: JSON.stringify({ devices }) };
    }
    if (c.cmd === 'sysctl' && c.args.join(' ') === '-n vm.swapusage') return { stdout: `${SWAP}\n` };
    if (c.cmd === 'pgrep' && c.args[0] === '-f') {
      const m = /^qemu-system\.\*-avd (.+)\( \|\$\)$/.exec(c.args[1]);
      const hit = m ? o.pgrep?.[m[1]] : undefined;
      return hit === undefined ? { code: 1 } : { stdout: `${hit}\n` };
    }
    return undefined;
  });
}

const noAdb = (calls: FakeCall[]) => {
  for (const c of calls) assert.doesNotMatch(`${c.cmd} ${c.args.join(' ')}`, /\badb\b/, 'status does not call adb');
};

function scenario() {
  makeAvd('tuned-api35', { ramMb: 3072 });
  makeAvd('baked-api35', { baked: true, lock: true });
  makeAvd('pgrep-api35', { gpu: 'swiftshader_indirect' });
  makeAvd('plain-api35', { tuned: false });
  // state of an AVD gone from disk
  recordAndroidTune('removed-api35', { avdDir: join(avdHome, 'removed-api35.avd'), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile({}) }, { env });

  iosState(UDID, 'QA-iPhone17');
  seedStore(UDID, ALL.map((l): [string, boolean] => [l, true]));
  iosState(OTHER, 'QA-iPhone17b', { capabilities: ['push'] });
  seedStore(OTHER, ALL.slice(0, 10).map((l): [string, boolean] => [l, true])); // lost entries (erase)

  recordSession({ platform: 'android', avd: 'pgrep-api35', serial: 'emulator-5556', pid: 4000, port: 5556, startedAt: 'a' }, env);
  recordSession({ platform: 'android', avd: 'gone-api35', serial: 'emulator-5558', pid: 4001, port: 5558, startedAt: 'b' }, env);
  recordSession({ platform: 'ios', avd: 'QA-iPhone17', serial: UDID, pid: 0, port: 0, startedAt: 'c' }, env);
  recordSession({ platform: 'ios', avd: 'QA-iPhone17b', serial: OTHER, pid: 0, port: 0, startedAt: 'd' }, env);

  const exec = fakeExec({
    sims: [
      { udid: UDID, name: 'QA-iPhone17', state: 'Booted' },
      { udid: OTHER, name: 'QA-iPhone17b', state: 'Shutdown' },
      { udid: THIRD, name: 'QA-iPadPro13', state: 'Booted' },
    ],
    pgrep: { 'pgrep-api35': '61234' },
  });
  const ctx = { env, exec, storeBase, date: () => new Date('2026-11-16T12:00:00.000Z') };
  return { exec, ctx };
}

test('status iOS: booted + devices with state; store count and drift', async () => {
  const { ctx, exec } = scenario();
  const s = await collectStatus(ctx);
  assert.deepEqual(
    s.ios.map((d) => [d.name, d.state, d.hasState, d.expected, d.disabledInStore, d.drift]),
    [
      ['QA-iPadPro13', 'Booted', false, null, null, null],
      ['QA-iPhone17', 'Booted', true, 173, 173, false],
      ['QA-iPhone17b', 'Shutdown', true, 172, 10, true],
    ],
  );
  const b = s.ios.find((d) => d.udid === OTHER)!;
  assert.deepEqual(b.profile, { capabilities: ['push'], except: [], keep: [], labels: 172 });
  assert.equal(b.booted, false);
  noAdb(exec.calls);
});

test('status Android: only AVDs with state; tuned/RAM/gpu, baked, running by lock and by pgrep', async () => {
  const { ctx, exec } = scenario();
  const s = await collectStatus(ctx);
  const by = Object.fromEntries(s.android.map((a) => [a.avd, a]));
  assert.deepEqual(Object.keys(by), ['baked-api35', 'pgrep-api35', 'removed-api35', 'tuned-api35']);
  assert.deepEqual(
    [by['tuned-api35'].tuned, by['tuned-api35'].ramMb, by['tuned-api35'].gpu, by['tuned-api35'].baked, by['tuned-api35'].running],
    [true, 3072, 'host', false, false],
  );
  assert.equal(by['baked-api35'].baked, true);
  assert.equal(by['baked-api35'].running, true);
  assert.deepEqual(by['baked-api35'].runningBy, { lock: true, pgrep: false });
  assert.equal(by['pgrep-api35'].running, true);
  assert.deepEqual(by['pgrep-api35'].runningBy, { lock: false, pgrep: true });
  assert.equal(by['pgrep-api35'].pid, 61234);
  assert.equal(by['pgrep-api35'].gpu, 'swiftshader_indirect');
  assert.equal(by['removed-api35'].exists, false);
  assert.equal(by['removed-api35'].running, false);
  const pg = exec.calls.filter((c) => c.cmd === 'pgrep').map((c) => c.args[1]);
  assert.ok(pg.includes('qemu-system.*-avd baked-api35( |$)'));
  noAdb(exec.calls);
});

test('status session: dead entries marked stale; nothing is removed; swap', async () => {
  const { ctx } = scenario();
  const s = await collectStatus(ctx);
  assert.deepEqual(
    s.session.map((e) => [e.platform, e.name, e.id, e.alive, e.stale]),
    [
      ['android', 'pgrep-api35', 'emulator-5556', true, false],
      ['android', 'gone-api35', 'emulator-5558', false, true],
      ['ios', 'QA-iPhone17', UDID, true, false],
      ['ios', 'QA-iPhone17b', OTHER, false, true],
    ],
  );
  assert.equal(loadSession(env).length, 4, 'status is read-only');
  assert.deepEqual(s.swap, { usedMb: 17722.1, totalMb: 18432, percent: 96.1 });
  assert.equal(s.at, '2026-11-16T12:00:00.000Z');
});

test('status without Xcode: iOS comes from the state with state unknown, iOS session does not become stale', async () => {
  iosState(UDID, 'QA-iPhone17');
  recordSession({ platform: 'ios', avd: 'QA-iPhone17', serial: UDID, pid: 0, port: 0, startedAt: 'c' }, env);
  const exec = fakeExec({ simctlFails: true });
  const s = await collectStatus({ env, exec, storeBase });
  assert.deepEqual(s.ios.map((d) => [d.udid, d.state, d.drift]), [[UDID, 'unknown', true]]);
  assert.deepEqual(s.session.map((e) => [e.alive, e.stale]), [[true, false]]);
});

test('cli status --json: exact and stable keys; text one line per device; no adb', async () => {
  const { exec } = scenario();
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      env,
      cwd: root,
      runtime: { exec, storeBase, date: () => new Date('2026-11-16T12:00:00.000Z') },
    });
    return { code, stdout, stderr };
  };
  const j = await run(['status', '--json']);
  assert.equal(j.code, 0, j.stderr);
  const s = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(s), ['ios', 'android', 'session', 'swap', 'at']);
  assert.deepEqual(Object.keys(s.ios[0]), ['udid', 'name', 'state', 'booted', 'hasState', 'profile', 'expected', 'disabledInStore', 'drift']);
  assert.deepEqual(Object.keys(s.android[0]), [
    'avd', 'dir', 'exists', 'tuned', 'ramMb', 'gpu', 'ramRequestedMb', 'ramEffectiveMb', 'ramFloored', 'gpuEffective',
    'baked', 'bakedAt', 'running', 'runningBy', 'pid', 'hasState', 'launcher', 'advertised', 'grpcPort',
  ]);
  assert.deepEqual(Object.keys(s.session[0]), ['platform', 'name', 'id', 'pid', 'startedAt', 'alive', 'stale', 'idleDown']);
  assert.equal(s.session[0].idleDown, null);
  assert.deepEqual(Object.keys(s.swap), ['usedMb', 'totalMb', 'percent']);

  const t = await run(['status']);
  assert.equal(t.code, 0, t.stderr);
  const lines = t.stdout.trimEnd().split('\n');
  assert.equal(lines.filter((l) => l.startsWith('ios ')).length, 3);
  assert.equal(lines.filter((l) => l.startsWith('android ')).length, 4);
  assert.equal(lines.filter((l) => l.startsWith('session ')).length, 4);
  assert.match(t.stdout, /^ios QA-iPhone17b \(71DA7575-EE5E-4B6A-82B4-54084F780EA9\) Shutdown: .*store 10\/172 disabled, DRIFT/m);
  assert.match(t.stdout, /^android baked-api35: .*baked yes, running \(lock\)/m);
  assert.match(t.stdout, /^android pgrep-api35: .*running \(pgrep pid 61234\)/m);
  assert.match(t.stdout, /^session android gone-api35 emulator-5558: STALE/m);
  assert.match(t.stdout, /^swap: 17722\.1 of 18432 MB \(96\.1%\)$/m);
  assert.equal((await run(['status', 'x'])).code, 2);
  noAdb(exec.calls);
});

async function statusOut(ctx: Parameters<typeof collectStatus>[0], exec: ReturnType<typeof fakeExec>) {
  let stdout = '';
  const code = await main(['status'], { stdout: (t) => { stdout += t; }, stderr: () => {}, env, cwd: root, runtime: { exec, storeBase } });
  assert.equal(code, 0);
  return { report: await collectStatus(ctx), stdout };
}

test('status: RAM requested != effective (last boot hardware-qemu.ini) = emulator raised it in the text, ramFloored in the JSON; effective gpu', async () => {
  const dir = makeAvd('bench-api35');
  // Values from real use: -memory 2048 became 2560 (pixel_7 1080x2400@420).
  writeFileSync(join(dir, 'hardware-qemu.ini'), 'hw.cpu.arch = arm64\nhw.ramSize = 2560\nhw.gpu.mode = host\nvm.heapSize = 576\n');
  const exec = fakeExec({ pgrep: { 'bench-api35': '73808' } });
  const { report, stdout } = await statusOut({ env, exec, storeBase }, exec);
  const a = report.android[0];
  assert.deepEqual(
    { ramMb: a.ramMb, ramRequestedMb: a.ramRequestedMb, ramEffectiveMb: a.ramEffectiveMb, ramFloored: a.ramFloored, gpu: a.gpu, gpuEffective: a.gpuEffective },
    { ramMb: 2048, ramRequestedMb: 2048, ramEffectiveMb: 2560, ramFloored: true, gpu: 'host', gpuEffective: 'host' },
  );
  assert.match(stdout, /^android bench-api35: tuned \(ram requested 2048 MB, effective 2560 MB \(emulator raised it\), gpu host\), baked no, running \(pgrep pid 73808\) no gRPC advertisement$/m);
  noAdb(exec.calls);
});

test('status: effective RAM equal to requested; without hardware-qemu.ini only the requested one; a different effective gpu shows up', async () => {
  const same = makeAvd('same-api35');
  writeFileSync(join(same, 'hardware-qemu.ini'), 'hw.ramSize = 2048\nhw.gpu.mode = swiftshader_indirect\n');
  makeAvd('fresh-api35'); // tuned and never booted: no hardware-qemu.ini
  const exec = fakeExec();
  const { report, stdout } = await statusOut({ env, exec, storeBase }, exec);
  const by = Object.fromEntries(report.android.map((a) => [a.avd, a]));
  assert.deepEqual([by['same-api35'].ramEffectiveMb, by['same-api35'].ramFloored, by['same-api35'].gpuEffective], [2048, false, 'swiftshader_indirect']);
  assert.deepEqual([by['fresh-api35'].ramRequestedMb, by['fresh-api35'].ramEffectiveMb, by['fresh-api35'].ramFloored, by['fresh-api35'].gpuEffective], [2048, null, false, null]);
  assert.match(stdout, /^android same-api35: tuned \(ram requested 2048 MB, effective 2048 MB, gpu requested host, effective swiftshader_indirect\), /m);
  assert.match(stdout, /^android fresh-api35: tuned \(ram requested 2048 MB, gpu host\), /m);
  assert.doesNotMatch(stdout, /raised|floor/);
});

// lastLaunch: what the last up/bake actually requested (up --ram without tune).
function lastLaunch(avd: string, ramMb: number, lowRam = false): void {
  const st = loadState<AndroidState>('android', avd, { env })!;
  saveState('android', avd, { ...st, lastLaunch: { ramMb, lowRam, at: '2026-11-17T09:00:00.000Z' } }, { env });
}

test('status: up --ram 4096 without tune (lastLaunch) with effective 4096 does not count as raised', async () => {
  const dir = makeAvd('over-api35'); // tune profile: 2048
  lastLaunch('over-api35', 4096);
  writeFileSync(join(dir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\nhw.gpu.mode = host\n');
  const exec = fakeExec();
  const { report, stdout } = await statusOut({ env, exec, storeBase }, exec);
  const a = report.android[0];
  assert.deepEqual([a.ramRequestedMb, a.ramEffectiveMb, a.ramFloored], [4096, 4096, false]);
  assert.match(stdout, /^android over-api35: tuned \(ram requested 4096 MB, effective 4096 MB, gpu host\), /m);
  assert.doesNotMatch(stdout, /raised/);
});

test('status: lastLaunch 2048 with effective 2560 is still raised; without lastLaunch falls back to the tune profile', async () => {
  const raised = makeAvd('raised-api35', { ramMb: 4096 }); // profile 4096, but the last up requested 2048
  lastLaunch('raised-api35', 2048);
  writeFileSync(join(raised, 'hardware-qemu.ini'), 'hw.ramSize = 2560\n');
  const old = makeAvd('old-api35'); // old state, without the field: profile 2048
  writeFileSync(join(old, 'hardware-qemu.ini'), 'hw.ramSize = 2560\n');
  const exec = fakeExec();
  const { report, stdout } = await statusOut({ env, exec, storeBase }, exec);
  const by = Object.fromEntries(report.android.map((a) => [a.avd, a]));
  assert.deepEqual([by['raised-api35'].ramRequestedMb, by['raised-api35'].ramFloored], [2048, true]);
  assert.deepEqual([by['old-api35'].ramRequestedMb, by['old-api35'].ramFloored], [2048, true]);
  assert.match(stdout, /^android raised-api35: tuned \(ram requested 2048 MB, effective 2560 MB \(emulator raised it\)/m);
});

// Real lines (2026-11-16): argent launches without -memory/-cores and with -netfast.
const QEMU = '/opt/homebrew/share/android-commandlinetools/emulator/qemu/darwin-aarch64/qemu-system-aarch64';
const ARGENT_LINE = `${QEMU} -avd qa-tablet-api35 -no-snapshot-load -gpu auto -feature -Vulkan -noaudio -no-boot-anim -netfast -no-metrics -crash-report-mode never`;
const DEVSLIM_LINE = `${QEMU} -avd bench-api35 -gpu host -memory 2048 -cores 2 -port 5554 -no-window -no-audio -camera-back none -camera-front none -feature -Vulkan -no-boot-anim -no-metrics -no-snapshot`;
const STUDIO_LINE = `${QEMU} -netdelay none -netspeed full -avd Pixel_9_API_35 -qt-hide-window -grpc-use-token`;

async function statusBoth(exec: ReturnType<typeof fakeExec>, pidAlive: (pid: number) => boolean = () => true) {
  let stdout = '';
  const io = (out: (t: string) => void) => ({ stdout: out, stderr: () => {}, env, cwd: root, runtime: { exec, storeBase, pidAlive } });
  assert.equal(await main(['status'], io((t) => { stdout += t; })), 0);
  let js = '';
  assert.equal(await main(['status', '--json'], io((t) => { js += t; })), 0);
  return { stdout, report: JSON.parse(js) as { android: Array<Record<string, unknown>> } };
}

test('status: tuned AVD running via argent (lavapipe, 4096 MB) = suffix in the text and launcher in the JSON; no adb', async () => {
  const dir = makeAvd('qa-tablet-api35');
  writeFileSync(join(dir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\nhw.gpu.mode = lavapipe\n');
  const exec = fakeExec({ pgrep: { 'qa-tablet-api35': '9421' }, qemu: { 9421: ARGENT_LINE } });
  const { stdout, report } = await statusBoth(exec);
  assert.match(
    stdout,
    /^android qa-tablet-api35: tuned \(ram requested 2048 MB, effective 4096 MB \(emulator raised it\), gpu requested host, effective lavapipe\), baked no, running \(pgrep pid 9421\) launched by argent no gRPC advertisement$/m,
  );
  const a = report.android[0];
  assert.deepEqual([a.avd, a.launcher, a.hasState, a.ramFloored, a.gpuEffective], ['qa-tablet-api35', 'argent', true, true, 'lavapipe']);
  noAdb(exec.calls);
});

test('status: AVD running via devslim (signature) without suffix; stopped without launcher', async () => {
  makeAvd('bench-api35');
  makeAvd('stopped-api35');
  const exec = fakeExec({ pgrep: { 'bench-api35': '73808' }, qemu: { 73808: DEVSLIM_LINE } });
  const { stdout, report } = await statusBoth(exec);
  assert.match(stdout, /^android bench-api35: tuned \(ram requested 2048 MB, gpu host\), baked no, running \(pgrep pid 73808\) no gRPC advertisement$/m);
  const by = Object.fromEntries(report.android.map((a) => [a.avd, a]));
  assert.equal(by['bench-api35'].launcher, 'devslim');
  assert.equal(by['stopped-api35'].launcher, null);
  assert.equal(by['stopped-api35'].running, false);
  noAdb(exec.calls);
});

test('status: running AVD without state shows name, pid, launcher, effective gpu and RAM', async () => {
  makeAvd('tuned-api35');
  const studio = makeAvd('Pixel_9_API_35', { tuned: false });
  writeFileSync(join(studio, 'hardware-qemu.ini'), 'hw.ramSize = 2048\nhw.gpu.mode = host\n');
  const exec = fakeExec({ pgrep: { Pixel_9_API_35: '61000' }, qemu: { 61000: STUDIO_LINE } });
  const { stdout, report } = await statusBoth(exec);
  assert.deepEqual(report.android.map((a) => a.avd), ['Pixel_9_API_35', 'tuned-api35']);
  const p = report.android[0];
  assert.deepEqual(
    [p.hasState, p.tuned, p.running, p.pid, p.launcher, p.ramEffectiveMb, p.gpuEffective, p.ramRequestedMb, p.gpu],
    [false, false, true, 61000, 'other', 2048, 'host', null, null],
  );
  assert.match(stdout, /^android Pixel_9_API_35: no devslim state \(effective ram 2048 MB, effective gpu host\), baked no, running \(pgrep pid 61000\) launched outside devslim no gRPC advertisement$/m);
  noAdb(exec.calls);
});

test('status: running AVD without state, hardware-qemu.ini or directory = only name, pid and launcher', async () => {
  const exec = fakeExec({ pgrep: { 'qa-tablet-api35': '9421' }, qemu: { 9421: ARGENT_LINE } });
  const { stdout, report } = await statusBoth(exec);
  const a = report.android[0];
  assert.deepEqual([a.avd, a.exists, a.hasState, a.pid, a.launcher, a.ramEffectiveMb, a.gpuEffective], ['qa-tablet-api35', false, false, 9421, 'argent', null, null]);
  assert.match(stdout, /^android qa-tablet-api35: no devslim state, AVD not found, running \(pgrep pid 9421\) launched by argent no gRPC advertisement$/m);
  assert.doesNotMatch(stdout, /android: no AVD with state/);
});

// Emulator advertisement: avd/running/pid_<pid>.ini (HOME=root in env).
const RUNNING_FIXTURE = readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8');
const DEVSLIM_GRPC_LINE = DEVSLIM_LINE.replace('-port 5554', '-port 5554 -grpc 8554 -grpc-use-token');

function announce(text: string, pid = 73900): void {
  const dir = join(root, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `pid_${pid}.ini`), text);
}

test('status: advertised emulator = advertised true, grpcPort, no suffix; token never shows; no adb', async () => {
  makeAvd('bench-api35');
  makeAvd('stopped-api35');
  announce(RUNNING_FIXTURE);
  announce(RUNNING_FIXTURE.replace('avd.name=bench-api35', 'avd.name=stopped-api35'), 1); // old entry of a stopped AVD
  const exec = fakeExec({ pgrep: { 'bench-api35': '73808' }, qemu: { 73808: DEVSLIM_GRPC_LINE } });
  const { stdout, report } = await statusBoth(exec);
  assert.match(stdout, /^android bench-api35: tuned \(ram requested 2048 MB, gpu host\), baked no, running \(pgrep pid 73808\)$/m);
  const by = Object.fromEntries(report.android.map((a) => [a.avd, a]));
  assert.deepEqual([by['bench-api35'].advertised, by['bench-api35'].grpcPort, by['bench-api35'].launcher], [true, 8554, 'devslim']);
  assert.deepEqual([by['stopped-api35'].advertised, by['stopped-api35'].grpcPort], [null, null], 'stopped: no advertisement');
  assert.ok(!(stdout + JSON.stringify(report)).includes('abc123'), 'token not in the text or the JSON');
  noAdb(exec.calls);
});

test('status: entry without token = not advertised (suffix), grpcPort from the entry; no entry = grpcPort null', async () => {
  makeAvd('bench-api35');
  announce(RUNNING_FIXTURE.replace('grpc.token=abc123', ''));
  const exec = fakeExec({ pgrep: { 'bench-api35': '73808' }, qemu: { 73808: DEVSLIM_GRPC_LINE } });
  const { stdout, report } = await statusBoth(exec);
  assert.match(stdout, /^android bench-api35: .*running \(pgrep pid 73808\) no gRPC advertisement$/m);
  assert.deepEqual([report.android[0].advertised, report.android[0].grpcPort], [false, 8554]);
  rmSync(join(root, 'Library'), { recursive: true });
  const none = await statusBoth(fakeExec({ pgrep: { 'bench-api35': '73808' }, qemu: { 73808: DEVSLIM_GRPC_LINE } }));
  assert.deepEqual([none.report.android[0].advertised, none.report.android[0].grpcPort], [false, null]);
});

test('status: pid_<pid>.ini of a dead emulator does not count as advertisement; file stays', async () => {
  makeAvd('bench-api35');
  announce(RUNNING_FIXTURE, 73900); // leftover from an earlier boot that crashed
  const exec = fakeExec({ pgrep: { 'bench-api35': '73808' }, qemu: { 73808: DEVSLIM_GRPC_LINE } });
  const dead = await statusBoth(exec, (pid) => pid !== 73900);
  assert.deepEqual([dead.report.android[0].advertised, dead.report.android[0].grpcPort], [false, null]);
  assert.match(dead.stdout, /^android bench-api35: .*running \(pgrep pid 73808\) no gRPC advertisement$/m);
  assert.ok(readFileSync(join(root, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running', 'pid_73900.ini'), 'utf8').length > 0);
  const live = await statusBoth(exec, (pid) => pid === 73900);
  assert.deepEqual([live.report.android[0].advertised, live.report.android[0].grpcPort], [true, 8554]);
});
