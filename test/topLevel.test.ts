import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { loadSession, recordSession } from '../src/android/session.ts';
import { main } from '../src/cli.ts';
import type { Exec, ExecOptions, FakeCall } from '../src/exec.ts';
import { createFakeIos, type FakeIosOptions } from '../src/ios/fakeIos.ts';
import { recordAndroidTune } from '../src/state.ts';
import { downAll, measureAll } from '../src/topLevel.ts';

const UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';
const OTHER = '71DA7575-EE5E-4B6A-82B4-54084F780EA9';

let root: string;
let avdHome: string;
let home: string;
let storeBase: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-top-'));
  avdHome = join(root, 'avd');
  home = join(root, 'home');
  storeBase = join(root, 'var-tmp');
  mkdirSync(storeBase, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeAvd(name: string): string {
  const dir = join(avdHome, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `path=${dir}\n`);
  writeFileSync(join(dir, 'config.ini'), 'hw.ramSize=2048\n');
  return dir;
}

// Android e iOS falsos ao mesmo tempo; pgrep do qemu por nome de AVD.
function world(o: { android?: FakeAndroidOptions; ios?: Partial<FakeIosOptions>; qemu?: Record<string, number> } = {}) {
  const android = createFakeAndroid({ avdHome, ...o.android });
  const ios = createFakeIos({ storeBase, ...o.ios });
  const calls: FakeCall[] = [];
  const exec: Exec = async (cmd: string, args: readonly string[], opts: ExecOptions = {}) => {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === 'pgrep') {
      const m = /^qemu-system\.\*-avd (.+)\( \|\$\)$/.exec(args[1]);
      if (m) {
        const pid = o.qemu?.[m[1]];
        return Object.freeze({ code: pid === undefined ? 1 : 0, signal: null, stdout: pid === undefined ? '' : `${pid}\n`, stderr: '' });
      }
      return ios.exec(cmd, args, opts);
    }
    if (cmd === 'xcrun' || cmd === 'plutil' || cmd === 'top' || (cmd === 'ps' && args[0] === '-axo')) return ios.exec(cmd, args, opts);
    return android.exec(cmd, args, opts);
  };
  const env = { HOME: root, ANDROID_HOME: android.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: home, PATH: '/usr/bin:/bin' };
  const ctx = { env, exec, sleep: android.sleep, now: android.now, date: android.date, fileExists: android.fileExists, storeBase, stderr: () => {} };
  const line = (c: FakeCall) => `${c.cmd} ${c.args.join(' ')}`;
  return { android, ios, calls, ctx, env, line };
}

test('down de topo: sessao vazia = nada, sem chamar adb nem simctl', async () => {
  const w = world();
  assert.deepEqual(await downAll(w.ctx), []);
  assert.deepEqual(w.calls, []);
});

test('down de topo: Android + iOS vivos desligados por delegacao; stale removido sem tentar matar', async () => {
  makeAvd('slim-api35');
  const w = world({
    android: { emulators: [{ avd: 'slim-api35', port: 5554 }] },
    ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted' }, { udid: OTHER, name: 'QA-iPhone17b', state: 'Shutdown' }] },
    qemu: { 'slim-api35': 51234 },
  });
  recordSession({ platform: 'android', avd: 'slim-api35', serial: 'emulator-5554', pid: 4000, port: 5554, startedAt: 'a' }, w.env);
  recordSession({ platform: 'android', avd: 'gone-api35', serial: 'emulator-5558', pid: 4001, port: 5558, startedAt: 'b' }, w.env);
  recordSession({ platform: 'ios', avd: 'QA-iPhone17', serial: UDID, pid: 0, port: 0, startedAt: 'c' }, w.env);
  recordSession({ platform: 'ios', avd: 'QA-iPhone17b', serial: OTHER, pid: 0, port: 0, startedAt: 'd' }, w.env);

  const res = await downAll(w.ctx);
  assert.deepEqual(
    res.map((r) => [r.platform, r.name, r.id, r.result]),
    [
      ['android', 'gone-api35', 'emulator-5558', 'stale'],
      ['ios', 'QA-iPhone17b', OTHER, 'stale'],
      ['android', 'slim-api35', 'emulator-5554', 'killed'],
      ['ios', 'QA-iPhone17', UDID, 'shutdown'],
    ],
  );
  const lines = w.calls.map(w.line);
  assert.ok(!lines.some((l) => l.includes('emulator-5558')), 'stale Android: nenhum comando no serial');
  assert.ok(!lines.some((l) => l.includes(`shutdown ${OTHER}`)), 'stale iOS: sem shutdown');
  assert.ok(lines.some((l) => l.endsWith('-s emulator-5554 emu kill')));
  assert.equal(w.android.emulators.size, 0);
  assert.equal(w.ios.sims.get(UDID)!.state, 'Shutdown');
  assert.deepEqual(loadSession(w.env), []);
});

test('measure de topo: nada rodando = array vazio, sem adb', async () => {
  makeAvd('slim-api35');
  const w = world({ ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17' }] } });
  recordAndroidTune('slim-api35', { avdDir: join(avdHome, 'slim-api35.avd'), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile({}) }, { env: w.env });
  assert.deepEqual(await measureAll(w.ctx), []);
  assert.ok(!w.calls.some((c) => /\badb\b/.test(w.line(c))), 'nada rodando: adb nao e chamado');
});

test('measure de topo: um emulador com state e um simulador bootado; objetos iguais aos de android/ios measure', async () => {
  makeAvd('slim-api35');
  const w = world({
    android: {
      emulators: [{ avd: 'slim-api35', port: 5554 }],
      host: { footprint: '    phys_footprint: 2.6 GB\n', rss: '2754560\n' },
      guest: { meminfo: 'MemTotal:        2014388 kB\nMemAvailable:    1061523 kB\n', ps: 'USER PID\nroot 1\n', dumpsys: ' Free RAM: 1,061,523K (x)\n Used RAM:   871,869K (y)\n' },
    },
    ios: {
      simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted' }, { udid: OTHER, name: 'QA-iPhone17b' }],
      measure: { pgrep: '700\n', ps: '  PID  PPID  %CPU COMM\n  700     1   1.0 launchd_sim\n  701   700   2.0 SpringBoard\n', top: 'PID    MEM\n700    10M\n701    90M+\n' },
    },
    qemu: { 'slim-api35': 51234 },
  });
  recordAndroidTune('slim-api35', { avdDir: join(avdHome, 'slim-api35.avd'), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile({}) }, { env: w.env });
  const res = await measureAll(w.ctx);
  assert.deepEqual(res, [
    {
      platform: 'android',
      avd: 'slim-api35',
      serial: 'emulator-5554',
      pid: 51234,
      host: { footprintMb: 2662.4, footprintHeaderMb: null, rssMb: 2690 },
      guest: { memTotalMb: 1967.2, memAvailableMb: 1036.6, processes: 1, usedRamMb: 851.4, freeRamMb: 1036.6 },
      at: '2026-11-16T12:00:00.000Z',
    },
    { platform: 'ios', udid: UDID, name: 'QA-iPhone17', processes: 2, footprintMb: 100, cpuPercent: 3, at: '2026-11-16T12:00:00.000Z' },
  ]);
});

test('cli down e measure de topo: --json, texto e exit 0', async () => {
  const w = world({ ios: { simulators: [{ udid: UDID, name: 'QA-iPhone17' }] } });
  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      env: w.env,
      cwd: root,
      runtime: { exec: w.ctx.exec, sleep: w.ctx.sleep, now: w.ctx.now, date: w.ctx.date, fileExists: w.ctx.fileExists, storeBase },
    });
    return { code, stdout, stderr };
  };
  const m = await run(['measure', '--json']);
  assert.equal(m.code, 0, m.stderr);
  assert.deepEqual(JSON.parse(m.stdout), []);
  assert.equal((await run(['measure'])).stdout, 'nada rodando\n');
  const d = await run(['down', '--json']);
  assert.equal(d.code, 0, d.stderr);
  assert.deepEqual(JSON.parse(d.stdout), []);
  assert.equal((await run(['down'])).stdout, 'nada a desligar (sessao vazia)\n');
  recordSession({ platform: 'ios', avd: 'QA-iPhone17', serial: UDID, pid: 0, port: 0, startedAt: 'c' }, w.env);
  const s = await run(['down']);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.stdout, `ios QA-iPhone17 ${UDID}: stale (simulador desligado ou inexistente)\n`);
  assert.equal((await run(['down', 'x'])).code, 2);
});
