import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { loadSession } from '../src/android/session.ts';
import { main } from '../src/cli.ts';
import { loadState, type AndroidState } from '../src/state.ts';

// State gravado de verdade pelo devslim antes deste ticket (2026-11-16,
// bench-api35 tunado e rodando). Copiado de ~/.devslim e do AVD, sem os campos
// novos. Tem que continuar carregando; status, down e restore funcionam sobre ele.
const FIX = (name: string) => new URL(`./fixtures/real-state/${name}`, import.meta.url);
const STATE = readFileSync(FIX('bench-api35.json'));
const SESSION_EMPTY = readFileSync(FIX('session.json'));
const SESSION_WITH_ENTRY = readFileSync(FIX('session-with-entry.json'));
const CONFIG = readFileSync(FIX('bench-api35.config.ini'));
const HW_QEMU = readFileSync(FIX('bench-api35.hardware-qemu.ini'));
const AVD = 'bench-api35';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let root: string;
let avdHome: string;
let home: string;
let avdDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-realstate-'));
  avdHome = join(root, 'avd');
  home = join(root, 'devslim-home');
  avdDir = join(avdHome, `${AVD}.avd`);
  mkdirSync(avdDir, { recursive: true });
  writeFileSync(join(avdHome, `${AVD}.ini`), `path=${avdDir}\n`);
  writeFileSync(join(avdDir, 'config.ini'), CONFIG);
  writeFileSync(join(avdDir, 'multiinstance.lock'), '');
  mkdirSync(join(home, 'state', 'android'), { recursive: true });
  copyFileSync(FIX('bench-api35.json'), join(home, 'state', 'android', `${AVD}.json`));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function cli(opts: FakeAndroidOptions = {}) {
  const fake = createFakeAndroid({ avdHome, avdDir: (n) => join(avdHome, `${n}.avd`), ...opts });
  const env = { PATH: '/usr/bin:/bin', HOME: root, ANDROID_HOME: fake.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: home };
  const call = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      env,
      cwd: root,
      runtime: { exec: fake.exec, spawnDetached: fake.spawnDetached, sleep: fake.sleep, now: fake.now, date: fake.date, fileExists: fake.fileExists },
    });
    return { code, stdout, stderr };
  };
  return { fake, env, call };
}

test('state real antigo carrega: formato atual, sem campos novos, sha256 do original confere', () => {
  const st = loadState<AndroidState>('android', AVD, { env: { DEVSLIM_HOME: home } })!;
  assert.equal(st.version, 1);
  assert.equal(st.avd, AVD);
  assert.deepEqual(st.profile, { ramMb: 2048, heapMb: 256, cores: 2, gpu: 'host', vulkan: false, lowRam: false, screen: 'keep', port: null, capabilities: [] });
  assert.deepEqual(st.disabledPackages, []);
  assert.equal(st.settings, undefined);
  assert.equal(st.bakedAt, undefined);
  assert.equal(sha(st.originalConfigIni), st.originalConfigSha256);
  assert.equal(JSON.parse(SESSION_EMPTY.toString()).version, 1);
});

test('status sobre o state real + hardware-qemu.ini real: pedida 2048, efetiva 2560 (emulador elevou)', async () => {
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), HW_QEMU);
  const { call } = cli({ host: { pgrep: '73808\n' } });
  const t = await call(['status']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^android bench-api35: tunado \(ram pedida 2048 MB, efetiva 2560 MB \(emulador elevou\), gpu host\), baked nao, rodando \(pgrep pid 73808\) sem anuncio gRPC$/m);
  const j = JSON.parse((await call(['status', '--json'])).stdout);
  const a = j.android[0];
  assert.deepEqual([a.ramMb, a.ramRequestedMb, a.ramEffectiveMb, a.ramFloored, a.gpu, a.gpuEffective], [2048, 2048, 2560, true, 'host', 'host']);
});

test('down sobre a sessao real: entrada viva e desligada; sessao vazia real = nada a desligar', async () => {
  writeFileSync(join(home, 'state', 'session.json'), SESSION_WITH_ENTRY);
  const live = cli({ emulators: [{ avd: 'qa-tablet-api35', port: 5554, pid: 7887 }], host: { pgrep: '7887\n' } });
  const r = await live.call(['down']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^android qa-tablet-api35 emulator-5554: killed$/m);
  assert.deepEqual(loadSession(live.env), []);
  assert.equal(live.fake.emulators.size, 0);

  writeFileSync(join(home, 'state', 'session.json'), SESSION_WITH_ENTRY);
  const dead = cli(); // nada roda: entrada morta sai sem comando no device
  const d = await dead.call(['down', '--json']);
  assert.equal(d.code, 0, d.stderr);
  assert.deepEqual(JSON.parse(d.stdout).map((x: { result: string }) => x.result), ['stale']);
  assert.ok(!dead.fake.exec.calls.some((c) => c.args.includes('kill')));

  writeFileSync(join(home, 'state', 'session.json'), SESSION_EMPTY);
  const empty = await cli().call(['down']);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, 'nada a desligar (sessao vazia)\n');
});

test('restore --config-only sobre o state real devolve o config.ini original byte a byte e limpa o state', async () => {
  const st = JSON.parse(STATE.toString()) as AndroidState;
  const { call, fake } = cli();
  const r = await call(['android', 'restore', AVD, '--config-only']);
  assert.equal(r.code, 0, r.stderr);
  const restored = readFileSync(join(avdDir, 'config.ini'));
  assert.equal(restored.toString('utf8'), st.originalConfigIni);
  assert.equal(sha(restored), st.originalConfigSha256);
  assert.match(r.stdout, new RegExp(`sha256 ${st.originalConfigSha256}`));
  assert.ok(!existsSync(join(home, 'state', 'android', `${AVD}.json`)), 'sem pendencia no guest: state removido');
  assert.equal(fake.exec.calls.length, 0, 'nao fala com adb');
});

test('up sobre o state real herda -memory 2048 -gpu host e responde ramEffectiveMb e hint', async () => {
  const { call, fake } = cli();
  const r = await call(['android', 'up', AVD, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(fake.spawnCalls[0].args.slice(0, 8), ['-avd', AVD, '-gpu', 'host', '-memory', '2048', '-cores', '2']);
  assert.equal(j.ramEffectiveMb, null);
  assert.match(j.hint, /devslim android bake bench-api35/);
});

test('plan/tune sobre o state real herdam o perfil gravado; backup original intacto', async () => {
  const st = JSON.parse(STATE.toString()) as AndroidState;
  const { call } = cli();
  const p = await call(['android', 'plan', AVD, '--screen', '720x1600@320']);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^perfil herdado do tune anterior$/m);
  assert.match(p.stdout, /emulator -avd bench-api35 -gpu host -memory 2048 -cores 2 /);
  const t = await call(['android', 'tune', AVD, '--need', 'location', '--json']);
  assert.equal(t.code, 0, t.stderr);
  assert.equal(JSON.parse(t.stdout).inheritedProfile, true);
  const after = loadState<AndroidState>('android', AVD, { env: { DEVSLIM_HOME: home } })!;
  assert.deepEqual(after.profile.capabilities, ['location']);
  assert.equal(after.originalConfigSha256, st.originalConfigSha256);
  assert.equal(after.originalConfigIni, st.originalConfigIni);
});

test('status sobre o state real com o emulador lancado pelo argent: launcher argent e sufixo', async () => {
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), HW_QEMU);
  const line = `/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd ${AVD} -no-snapshot-load -gpu auto -feature -Vulkan -noaudio -no-boot-anim -netfast -no-metrics -crash-report-mode never`;
  const { call, fake } = cli({ host: { pgrep: '9421\n', cmdline: line } });
  const t = await call(['status']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^android bench-api35: .*rodando \(pgrep pid 9421\) lancado por argent sem anuncio gRPC$/m);
  assert.equal(JSON.parse((await call(['status', '--json'])).stdout).android[0].launcher, 'argent');
  assert.ok(!fake.exec.calls.some((c) => c.cmd === fake.tools.adb), 'status sem adb');
});

test('state real antigo (sem profile.grpc) = grpc ligado implicito em plan e up; state nao e reescrito', async () => {
  const before = readFileSync(join(home, 'state', 'android', `${AVD}.json`));
  assert.ok(!('grpc' in JSON.parse(before.toString()).profile), 'fixture e anterior ao campo');
  const { fake, call } = cli();
  const plan = await call(['android', 'plan', AVD, '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  const p = JSON.parse(plan.stdout);
  assert.equal(p.profile.grpc, true);
  assert.equal(p.inheritedProfile, true);
  assert.deepEqual(p.emulatorArgs.slice(p.emulatorArgs.indexOf('-grpc'), p.emulatorArgs.indexOf('-grpc') + 3), ['-grpc', '8554', '-grpc-use-token']);
  const up = await call(['android', 'up', AVD, '--json']);
  assert.equal(up.code, 0, up.stderr);
  const args: string[] = fake.spawnCalls[0].args;
  assert.deepEqual(args.slice(args.indexOf('-port'), args.indexOf('-port') + 5), ['-port', '5554', '-grpc', '8554', '-grpc-use-token']);
  assert.match(up.stderr, /emulador nao se anunciou em /, 'fake nao grava running ini: aviso');
  // O up so acrescenta o lastLaunch (o -memory deste lancamento); o perfil
  // antigo continua sem o campo grpc.
  const after = JSON.parse(readFileSync(join(home, 'state', 'android', `${AVD}.json`), 'utf8'));
  assert.ok(!('grpc' in after.profile), 'perfil nao ganha grpc');
  assert.equal(after.lastLaunch.ramMb, p.profile.ramMb);
  delete after.lastLaunch;
  assert.deepEqual(after, JSON.parse(before.toString()));
});
