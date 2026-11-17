import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { applyProfile, parseIni, serializeIni, setValue } from '../src/android/configIni.ts';
import { buildAndroidProfile, type AndroidProfileOptions } from '../src/android/profile.ts';
import { recordSession } from '../src/android/session.ts';
import { loadState, recordAndroidTune, saveState, type AndroidState } from '../src/state.ts';
import { main } from '../src/cli.ts';
import { dirSize, doctorExitCode, runDoctor, type Check, type DoctorContext } from '../src/doctor.ts';
import { createFakeExec, type FakeCall } from '../src/exec.ts';
import { serializeStorePlist, storePath } from '../src/ios/disabledStore.ts';
import { SWAP_FAIL_PERCENT as DOCTOR_FAIL, SWAP_WARN_PERCENT as DOCTOR_WARN } from '../src/doctor.ts';
import { SWAP_FAIL_PERCENT, SWAP_WARN_PERCENT, swapGate } from '../src/swap.ts';

const UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
const MB = 1024 * 1024;

let root: string;
let sdk: string;
let avdHome: string;
let bin: string;
let storeBase: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-doctor-'));
  sdk = join(root, 'sdk');
  avdHome = join(root, 'avd');
  bin = join(root, 'bin');
  storeBase = join(root, 'var-tmp');
  for (const d of [avdHome, bin, storeBase]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type World = {
  sdk?: { bins?: readonly string[]; revision?: string | null; images?: readonly string[] } | null;
  xcode?: 'ok' | 'missing' | 'simctl-fails';
  runtimes?: readonly string[]; // versoes iOS
  sims?: readonly { udid: string; name: string; state?: string }[];
  swap?: string;
  env?: Record<string, string>;
  nodeVersion?: string;
  qemu?: Record<string, string>; // pid -> linha de comando do qemu rodando
  alive?: (pid: number) => boolean; // pid de avd/running vivo; padrao: todos
};

const SWAP_OK = 'total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)';

function makeSdk(o: NonNullable<World['sdk']>): void {
  const all = ['emulator/emulator', 'platform-tools/adb', 'cmdline-tools/latest/bin/avdmanager'];
  for (const rel of o.bins ?? all) {
    mkdirSync(join(sdk, rel, '..'), { recursive: true });
    writeFileSync(join(sdk, rel), '#!/bin/sh\n');
  }
  mkdirSync(join(sdk, 'emulator'), { recursive: true });
  if (o.revision !== null) {
    writeFileSync(join(sdk, 'emulator', 'source.properties'), `Pkg.UserSrc=false\nPkg.Revision=${o.revision ?? '37.2.13'}\nPkg.Path=emulator\n`);
  }
  for (const img of o.images ?? []) {
    mkdirSync(join(sdk, 'system-images', img), { recursive: true });
    writeFileSync(join(sdk, 'system-images', img, 'system.img'), Buffer.alloc(2 * MB));
  }
}

function makeAvd(name: string, o: { config?: string; hq?: string | null; defaultBootMb?: number } = {}): string {
  const dir = join(avdHome, `${name}.avd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(avdHome, `${name}.ini`), `path=${dir}\n`);
  writeFileSync(join(dir, 'config.ini'), o.config ?? 'hw.ramSize=2048\nimage.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n');
  if (o.hq !== null && o.hq !== undefined) writeFileSync(join(dir, 'hardware-qemu.ini'), o.hq);
  if (o.defaultBootMb !== undefined) {
    mkdirSync(join(dir, 'snapshots', 'default_boot'), { recursive: true });
    writeFileSync(join(dir, 'snapshots', 'default_boot', 'ram.bin'), Buffer.alloc(o.defaultBootMb * MB));
  }
  return dir;
}

function setup(w: World = {}) {
  if (w.sdk !== null) makeSdk(w.sdk ?? {});
  const runtimes = (w.runtimes ?? ['26.4']).map((v) => ({
    identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${v.replace(/\./g, '-')}`,
    platform: 'iOS',
    version: v,
    isAvailable: true,
  }));
  const exec = createFakeExec((c: FakeCall) => {
    const line = `${c.cmd} ${c.args.join(' ')}`;
    if (line === 'xcodebuild -version') {
      if (w.xcode === 'missing') throw new Error('comando nao encontrado: xcodebuild');
      return { stdout: 'Xcode 26.4\nBuild version 17E192\n' };
    }
    if (line === 'xcrun simctl list runtimes -j') {
      if (w.xcode === 'simctl-fails') return { code: 72, stderr: 'xcrun: error: unable to find utility "simctl"' };
      return { stdout: JSON.stringify({ runtimes }) };
    }
    if (line === 'xcrun simctl list devices -j') {
      if (w.xcode === 'missing' || w.xcode === 'simctl-fails') return { code: 72, stderr: 'xcrun: error' };
      const devices = { [RUNTIME]: (w.sims ?? []).map((s) => ({ state: 'Shutdown', ...s, isAvailable: true })) };
      return { stdout: JSON.stringify({ devices }) };
    }
    if (line === 'sysctl -n vm.swapusage') return { stdout: `${w.swap ?? SWAP_OK}\n` };
    if (line === 'pgrep -fl qemu-system') {
      const lines = Object.entries(w.qemu ?? {}).map(([pid, cmd]) => `${pid} ${cmd}\n`);
      return lines.length === 0 ? { code: 1 } : { stdout: lines.join('') };
    }
    if (c.cmd === 'ps' && c.args.slice(0, 3).join(' ') === '-o command= -p') {
      const cmd = w.qemu?.[c.args[3]];
      return cmd === undefined ? { code: 1 } : { stdout: `${cmd}\n` };
    }
    if (c.cmd === 'pgrep') return { code: 1 };
    return undefined;
  });
  const env = {
    HOME: root,
    ANDROID_HOME: sdk,
    ANDROID_AVD_HOME: avdHome,
    DEVSLIM_HOME: join(root, 'home'),
    PATH: bin,
    ...w.env,
  };
  const ctx: DoctorContext = { env, exec, storeBase, nodeVersion: w.nodeVersion ?? 'v25.9.0', pidAlive: w.alive ?? (() => true) };
  return { exec, ctx, env };
}

const only = (checks: readonly Check[], id: string) => checks.filter((c) => c.id === id);
const levels = (checks: readonly Check[], id: string) => only(checks, id).map((c) => c.level);
const noAdb = (calls: FakeCall[]) => {
  for (const c of calls) assert.doesNotMatch(`${c.cmd} ${c.args.join(' ')}`, /\badb\b/, 'doctor nao chama adb');
};

test('ordem e ids: todas as checagens aparecem, ambiente limpo = so ok, exit 0', async () => {
  const { ctx, exec } = setup();
  const checks = await runDoctor(ctx);
  const ids = [...new Set(checks.map((c) => c.id))];
  assert.deepEqual(ids, [
    'node', 'xcode', 'android-sdk', 'emulator-version', 'avd-gpu', 'avd-ram', 'profile-drift', 'avd-image', 'running-off-profile', 'emulator-advertised', 'argent-gpu',
    'default-boot-snapshot', 'orphan-images', 'swap', 'ios-always-enabled', 'stale-session', 'orphan-state',
  ]);
  assert.deepEqual(checks.filter((c) => c.level !== 'ok'), []);
  assert.equal(doctorExitCode(checks), 0);
  for (const c of checks) assert.deepEqual(Object.keys(c).filter((k) => k !== 'fix'), ['id', 'level', 'message']);
  noAdb(exec.calls);
});

test('node: >= 25 ok; menor = fail', async () => {
  assert.deepEqual(levels(await runDoctor(setup({ nodeVersion: 'v25.0.0' }).ctx), 'node'), ['ok']);
  const c = only(await runDoctor(setup({ nodeVersion: 'v24.11.1' }).ctx), 'node');
  assert.equal(c[0].level, 'fail');
  assert.match(c[0].message, /24\.11\.1/);
});

test('xcode: runtime iOS >= 18.5 ok; so menores = warn; sem Xcode = warn; simctl quebrado = fail', async () => {
  const ok = only(await runDoctor(setup().ctx), 'xcode')[0];
  assert.equal(ok.level, 'ok');
  assert.match(ok.message, /Xcode 26\.4.*iOS 26\.4/);
  const old = only(await runDoctor(setup({ runtimes: ['17.5', '18.4'] }).ctx), 'xcode')[0];
  assert.equal(old.level, 'warn');
  assert.match(old.message, /18\.5/);
  assert.deepEqual(levels(await runDoctor(setup({ xcode: 'missing' }).ctx), 'xcode'), ['warn']);
  assert.deepEqual(levels(await runDoctor(setup({ xcode: 'simctl-fails' }).ctx), 'xcode'), ['fail']);
});

test('android-sdk: completo ok; sem SDK warn; SDK sem binario fail', async () => {
  assert.deepEqual(levels(await runDoctor(setup().ctx), 'android-sdk'), ['ok']);
  rmSync(sdk, { recursive: true, force: true });
  const none = only(await runDoctor(setup({ sdk: null }).ctx), 'android-sdk')[0];
  assert.equal(none.level, 'warn');
  assert.ok(none.fix);
  const partial = await runDoctor(setup({ sdk: { bins: ['emulator/emulator'] } }).ctx);
  const c = only(partial, 'android-sdk')[0];
  assert.equal(c.level, 'fail');
  assert.match(c.message, /adb/);
  assert.match(c.message, /avdmanager/);
  assert.equal(doctorExitCode(partial), 1);
});

test('emulator-version: < 37.2.13 warn com a mensagem do fix GLES; >= ok', async () => {
  const old = only(await runDoctor(setup({ sdk: { revision: '37.1.11' } }).ctx), 'emulator-version')[0];
  assert.equal(old.level, 'warn');
  assert.match(old.message, /37\.1\.11/);
  assert.match(old.message, /versao sem o fix de vazamento de memoria GLES do host/);
  rmSync(sdk, { recursive: true, force: true });
  assert.deepEqual(levels(await runDoctor(setup({ sdk: { revision: '37.2.13' } }).ctx), 'emulator-version'), ['ok']);
  rmSync(sdk, { recursive: true, force: true });
  assert.deepEqual(levels(await runDoctor(setup({ sdk: { revision: '38.0.1' } }).ctx), 'emulator-version'), ['ok']);
});

test('avd-gpu: lavapipe/swiftshader/software/guest = warn com fix tune; host ok; sem hardware-qemu.ini ok', async () => {
  makeAvd('lava', { hq: 'hw.gpu.enabled = yes\nhw.gpu.mode = lavapipe\n' });
  makeAvd('swift', { hq: 'hw.gpu.mode = swiftshader_indirect\n' });
  makeAvd('soft', { hq: 'hw.gpu.mode = software\n' });
  makeAvd('guest', { hq: 'hw.gpu.mode = guest\n' });
  makeAvd('host', { hq: 'hw.gpu.mode = host\n' });
  makeAvd('fresh');
  const c = only(await runDoctor(setup().ctx), 'avd-gpu');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.deepEqual(Object.keys(by).sort(), ['fresh', 'guest', 'host', 'lava', 'soft', 'swift']);
  for (const n of ['lava', 'swift', 'soft', 'guest']) {
    assert.equal(by[n].level, 'warn', n);
    assert.equal(by[n].fix, `devslim android tune ${n}`);
  }
  assert.equal(by.host.level, 'ok');
  assert.equal(by.fresh.level, 'ok');
});

test('avd-ram: runtime acima do config.ini ou acima de 3072 = warn; igual = ok', async () => {
  makeAvd('piso', { config: 'hw.ramSize=2G\n', hq: 'hw.ramSize = 2560\n' });
  makeAvd('grande', { config: 'hw.ramSize=4096\n', hq: 'hw.ramSize = 4096\n' });
  makeAvd('certo', { config: 'hw.ramSize=2048M\n', hq: 'hw.ramSize = 2048\n' });
  const c = only(await runDoctor(setup().ctx), 'avd-ram');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.equal(by.piso.level, 'warn');
  assert.match(by.piso.message, /2560 MB.*2048 MB/);
  assert.match(by.piso.message, /acima dos 2048 MB do config\.ini \(emulador elevou\)/);
  assert.doesNotMatch(by.piso.message, /piso aplicado/);
  assert.match(by.piso.fix, /^devslim android tune piso --lowram \(com o AVD desligado; o emulador ignora -memory abaixo do piso dele sem lowram; o lowram muda o comportamento dos apps: o guest se declara aparelho de pouca RAM\)$/);
  assert.equal(by.grande.level, 'warn');
  assert.match(by.grande.message, /3072/);
  assert.match(by.grande.fix, /^devslim android tune grande \(e suba com devslim android up, que passa -memory\)$/, 'sem elevacao: o fix de sempre');
  assert.equal(by.certo.level, 'ok');
});

test('avd-ram: compara com a RAM do ultimo up/bake (lastLaunch) quando ha; sem o campo, config.ini', async () => {
  const { env, ctx } = setup();
  const launched = (name: string, dir: string, ramMb: number) => {
    const profile = buildAndroidProfile({});
    recordAndroidTune(name, { avdDir: dir, originalConfigIni: 'x', originalConfigSha256: 'y', profile }, { env });
    const st = loadState<AndroidState>('android', name, { env })!;
    saveState('android', name, { ...st, lastLaunch: { ramMb, lowRam: false, at: '2026-11-17T09:00:00.000Z' } }, { env });
  };
  // up --ram 3072 sem tune: config.ini segue 2048, emulador usou 3072 = pedido valeu.
  launched('override', makeAvd('override', { config: 'hw.ramSize=2048\n', hq: 'hw.ramSize = 3072\n' }), 3072);
  // ultimo up pediu 2048 e o emulador elevou para 2560: continua warn.
  launched('elevado', makeAvd('elevado', { config: 'hw.ramSize=2048\n', hq: 'hw.ramSize = 2560\n' }), 2048);
  const c = only(await runDoctor(ctx), 'avd-ram');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.equal(by.override.level, 'ok');
  assert.equal(by.override.message, 'override: 3072 MB (pedido no ultimo up/bake 3072 MB)');
  assert.equal(by.elevado.level, 'warn');
  assert.match(by.elevado.message, /ultimo boot usou 2560 MB, acima dos 2048 MB pedidos no ultimo up\/bake \(emulador elevou\)/);
  assert.match(by.elevado.fix!, /--lowram/);
});

test('argent-gpu: argent no PATH sem a variavel = warn com export; host = ok; sem argent = ok', async () => {
  const exe = join(bin, 'argent');
  writeFileSync(exe, '#!/bin/sh\nexit 99\n');
  chmodSync(exe, 0o755);
  const w = only(await runDoctor(setup().ctx), 'argent-gpu')[0];
  assert.equal(w.level, 'warn');
  assert.equal(w.fix, 'export ARGENT_EMULATOR_GPU_MODE=host');
  assert.match(w.message, /-gpu auto/);
  assert.deepEqual(levels(await runDoctor(setup({ env: { ARGENT_EMULATOR_GPU_MODE: 'host' } }).ctx), 'argent-gpu'), ['ok']);
  rmSync(exe);
  assert.deepEqual(levels(await runDoctor(setup().ctx), 'argent-gpu'), ['ok']);
  writeFileSync(exe, '#!/bin/sh\nexit 99\n');
  chmodSync(exe, 0o755);
  const s = setup();
  await runDoctor(s.ctx);
  assert.ok(!s.exec.calls.some((c) => c.cmd.endsWith('argent')), 'argent nunca e executado');
});

test('default-boot-snapshot: ram.bin presente = warn com tamanho em MB; ausente = ok', async () => {
  makeAvd('cold', { defaultBootMb: 3 });
  makeAvd('clean');
  const c = only(await runDoctor(setup().ctx), 'default-boot-snapshot');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.match(c[0].message, /^cold: .*3 MB/);
  rmSync(join(avdHome, 'cold.avd', 'snapshots'), { recursive: true });
  assert.deepEqual(levels(await runDoctor(setup().ctx), 'default-boot-snapshot'), ['ok']);
});

test('orphan-images: imagem sem config.ini que a referencie = warn com tamanho; nunca apaga', async () => {
  const used = 'android-35/google_apis/arm64-v8a';
  const orphan = 'android-36.1/google_apis/arm64-v8a';
  makeAvd('a35');
  const { ctx } = setup({ sdk: { images: [used, orphan] } });
  const c = only(await runDoctor(ctx), 'orphan-images');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.match(c[0].message, /system-images\/android-36\.1\/google_apis\/arm64-v8a.*2 MB/);
  assert.ok(existsSync(join(sdk, 'system-images', orphan, 'system.img')), 'so relata');
  assert.ok(existsSync(join(sdk, 'system-images', used, 'system.img')));
  rmSync(join(sdk, 'system-images', orphan), { recursive: true });
  assert.deepEqual(levels(await runDoctor(ctx), 'orphan-images'), ['ok']);
});

test('swap: ate 80% ok, acima warn, acima de 95% fail e exit 1', async () => {
  const at = (used: number) => `total = 1000.00M  used = ${used}.00M  free = 0.00M  (encrypted)`;
  assert.deepEqual(levels(await runDoctor(setup({ swap: at(800) }).ctx), 'swap'), ['ok']);
  assert.deepEqual(levels(await runDoctor(setup({ swap: at(850) }).ctx), 'swap'), ['warn']);
  const high = await runDoctor(setup({ swap: at(961) }).ctx);
  const c = only(high, 'swap')[0];
  assert.equal(c.level, 'fail');
  assert.match(c.message, /nao boote device agora/);
  assert.equal(doctorExitCode(high), 1);
});

test('swap: sem arquivo de swap (total 0) = ok com 0 MB em uso, nao "nao lido"; lixo = warn nao lido', async () => {
  const zero = only(await runDoctor(setup({ swap: 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)' }).ctx), 'swap');
  assert.deepEqual(zero.map((c) => [c.level, c.message]), [['ok', 'swap com 0 MB em uso (sem arquivo de swap)']]);
  const junk = only(await runDoctor(setup({ swap: 'lixo' }).ctx), 'swap');
  assert.deepEqual(junk.map((c) => [c.level, c.message]), [['warn', 'sysctl vm.swapusage nao lido']]);
});

test('swap: doctor e up concordam nos limites (mesma constante de src/swap.ts) e na mensagem', async () => {
  assert.equal(DOCTOR_WARN, SWAP_WARN_PERCENT);
  assert.equal(DOCTOR_FAIL, SWAP_FAIL_PERCENT);
  // Usado em decimos de MB num total de 1000 MB: percent exato.
  const at = (pct: number) => `total = 1000.00M  used = ${(pct * 10).toFixed(2)}M  free = 0.00M  (encrypted)`;
  const cases: Array<[number, 'ok' | 'warn' | 'fail']> = [
    [SWAP_WARN_PERCENT, 'ok'],
    [SWAP_WARN_PERCENT + 0.1, 'warn'],
    [SWAP_FAIL_PERCENT, 'warn'],
    [SWAP_FAIL_PERCENT + 0.1, 'fail'],
  ];
  for (const [pct, expected] of cases) {
    const checks = await runDoctor(setup({ swap: at(pct) }).ctx);
    const doc = only(checks, 'swap')[0];
    assert.equal(doc.level, expected, `doctor em ${pct}%`);
    const gateExec = createFakeExec((c: FakeCall) => (c.cmd === 'sysctl' ? { stdout: `${at(pct)}\n` } : undefined));
    const err: string[] = [];
    let refused: string | null = null;
    try {
      await swapGate({ exec: gateExec, stderr: (t) => { err.push(t); }, force: false, action: 'up' });
    } catch (e) {
      refused = (e as Error).message;
    }
    assert.equal(refused !== null, expected === 'fail', `up recusa em ${pct}%`);
    assert.equal(err.length > 0, expected === 'warn', `up avisa em ${pct}%`);
    if (refused !== null) assert.ok(refused.includes(doc.message) && refused.includes(doc.fix!), 'mesma mensagem e fix do doctor');
    if (err.length > 0) assert.ok(err[0].includes(doc.message), 'mesmo texto do doctor no aviso');
  }
});

test('ios-always-enabled: store com ALWAYS_ENABLED desligado = warn com fix ios up; limpo = ok', async () => {
  const p = storePath(UDID, { base: storeBase });
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, serializeStorePlist(new Map([['com.apple.assistantd', true], ['com.apple.gamed', true], ['com.apple.sharingd', false]])));
  const sims = [{ udid: UDID, name: 'QA-iPhone17' }];
  const c = only(await runDoctor(setup({ sims }).ctx), 'ios-always-enabled')[0];
  assert.equal(c.level, 'warn');
  assert.match(c.message, /QA-iPhone17.*com\.apple\.assistantd, com\.apple\.gamed/);
  assert.doesNotMatch(c.message, /sharingd/);
  assert.equal(c.fix, 'devslim ios up QA-iPhone17');
  writeFileSync(p, serializeStorePlist(new Map([['com.apple.gamed', false]])));
  assert.deepEqual(levels(await runDoctor(setup({ sims }).ctx), 'ios-always-enabled'), ['ok']);
});

test('stale-session: entrada morta = warn com fix devslim down; sessao vazia ok', async () => {
  const { ctx, env } = setup();
  assert.deepEqual(levels(await runDoctor(ctx), 'stale-session'), ['ok']);
  recordSession({ platform: 'android', avd: 'morto', serial: 'emulator-5554', pid: 1, port: 5554, startedAt: 'x' }, env);
  const c = only(await runDoctor(ctx), 'stale-session')[0];
  assert.equal(c.level, 'warn');
  assert.match(c.message, /android morto emulator-5554/);
  assert.equal(c.fix, 'devslim down');
});

test('dirSize: soma recursiva; limite de profundidade e de arquivos marca truncated', () => {
  const d = join(root, 'tree');
  mkdirSync(join(d, 'a', 'b', 'c'), { recursive: true });
  writeFileSync(join(d, 'x'), Buffer.alloc(100));
  writeFileSync(join(d, 'a', 'y'), Buffer.alloc(200));
  writeFileSync(join(d, 'a', 'b', 'c', 'z'), Buffer.alloc(300));
  assert.deepEqual(dirSize(d), { bytes: 600, files: 3, truncated: false });
  assert.deepEqual(dirSize(d, { maxDepth: 1 }), { bytes: 300, files: 2, truncated: true });
  assert.equal(dirSize(d, { maxFiles: 1 }).truncated, true);
  assert.deepEqual(dirSize(join(root, 'nao-existe')), { bytes: 0, files: 0, truncated: false });
});

test('cli doctor: texto com nivel por linha, --json e exit code', async () => {
  makeAvd('lava', { hq: 'hw.gpu.mode = lavapipe\n' });
  const { ctx, exec } = setup({ swap: 'total = 1000.00M  used = 990.00M  free = 10.00M  (encrypted)' });
  const run = async (args: string[]) => {
    let stdout = '';
    const code = await main(args, {
      stdout: (t) => { stdout += t; },
      stderr: () => {},
      env: ctx.env!,
      cwd: root,
      runtime: { exec, storeBase },
    });
    return { code, stdout };
  };
  const t = await run(['doctor']);
  assert.equal(t.code, 1);
  assert.match(t.stdout, /^\[warn\] avd-gpu: lava: /m);
  assert.match(t.stdout, /^ {7}fix: devslim android tune lava$/m);
  assert.match(t.stdout, /^\[fail\] swap: /m);
  const j = await run(['doctor', '--json']);
  assert.equal(j.code, 1);
  const arr = JSON.parse(j.stdout);
  assert.ok(Array.isArray(arr));
  assert.ok(arr.some((c: Check) => c.id === 'swap' && c.level === 'fail'));
  noAdb(exec.calls);
});

// Linhas reais (2026-11-16): o argent lanca com -gpu auto e -netfast, sem -memory/-cores.
const QEMU = '/opt/homebrew/share/android-commandlinetools/emulator/qemu/darwin-aarch64/qemu-system-aarch64';
const argentLine = (avd: string) => `${QEMU} -avd ${avd} -no-snapshot-load -gpu auto -feature -Vulkan -noaudio -no-boot-anim -netfast -no-metrics -crash-report-mode never`;
const devslimLine = (avd: string) => `${QEMU} -avd ${avd} -gpu host -memory 2048 -cores 2 -port 5554 -no-window -no-audio -camera-back none -camera-front none -feature -Vulkan -no-boot-anim -no-metrics -no-snapshot`;
const studioLine = (avd: string) => `${QEMU} -netdelay none -netspeed full -avd ${avd} -qt-hide-window`;

function tuned(name: string, dir: string, env: Record<string, string>) {
  recordAndroidTune(name, { avdDir: dir, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
}

test('running-off-profile: nada rodando = um ok; nao chama ps nem adb', async () => {
  const { ctx, exec } = setup();
  const c = only(await runDoctor(ctx), 'running-off-profile');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', 'nenhum emulador rodando']]);
  assert.ok(!exec.calls.some((x) => x.cmd === 'ps'));
  noAdb(exec.calls);
});

test('running-off-profile: AVD tunado lancado pelo argent em lavapipe = warn com fatos e fix em duas linhas; avd-gpu continua (ultimo boot)', async () => {
  const dir = makeAvd('qa-tablet-api35', { hq: 'hw.ramSize = 4096\nhw.gpu.mode = lavapipe\n' });
  const { ctx, exec, env } = setup({ qemu: { 9421: argentLine('qa-tablet-api35') } });
  tuned('qa-tablet-api35', dir, env);
  const checks = await runDoctor(ctx);
  const c = only(checks, 'running-off-profile');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.equal(
    c[0].message,
    'qa-tablet-api35 (pid 9421) rodando agora: lancado por argent, gpu efetiva lavapipe (renderizacao por software), ram efetiva 4096 MB; perfil do tune: gpu host, 2048 MB',
  );
  assert.equal(c[0].fix, 'parar o emulador e subir com: devslim android up qa-tablet-api35\nou exportar ARGENT_EMULATOR_GPU_MODE=host no ambiente do argent');
  const gpu = only(checks, 'avd-gpu')[0];
  assert.equal(gpu.level, 'warn');
  assert.match(gpu.message, /ultimo boot/);
  noAdb(exec.calls);
});

test('running-off-profile: launcher alheio em AVD tunado com gpu host = warn; mesmo launcher em AVD sem state = ok', async () => {
  const dir = makeAvd('tunado', { hq: 'hw.ramSize = 2048\nhw.gpu.mode = host\n' });
  makeAvd('livre', { hq: 'hw.ramSize = 2048\nhw.gpu.mode = host\n' });
  const { ctx, env } = setup({ qemu: { 100: studioLine('tunado'), 200: argentLine('livre') } });
  tuned('tunado', dir, env);
  const c = only(await runDoctor(ctx), 'running-off-profile');
  assert.deepEqual(c.map((x) => [x.level, x.message.split(' ')[0]]), [['warn', 'tunado']]);
  assert.match(c[0].message, /^tunado \(pid 100\) rodando agora: lancado por fora do devslim, gpu efetiva host, ram efetiva 2048 MB; perfil do tune: gpu host, 2048 MB$/);
});

test('running-off-profile: GPU software sem state = warn; devslim com gpu host = ok', async () => {
  makeAvd('soft', { hq: 'hw.gpu.mode = swiftshader_indirect\n' });
  const { ctx } = setup({ qemu: { 300: studioLine('soft') } });
  const w = only(await runDoctor(ctx), 'running-off-profile');
  assert.deepEqual(w.map((x) => x.level), ['warn']);
  assert.match(w[0].message, /^soft \(pid 300\) rodando agora: lancado por fora do devslim, gpu efetiva swiftshader_indirect \(renderizacao por software\)$/);

  rmSync(join(avdHome, 'soft.avd'), { recursive: true });
  rmSync(join(avdHome, 'soft.ini'));
  const dir = makeAvd('bench-api35', { hq: 'hw.ramSize = 2560\nhw.gpu.mode = host\n' });
  const ok = setup({ qemu: { 73808: devslimLine('bench-api35') } });
  tuned('bench-api35', dir, ok.env);
  const c = only(await runDoctor(ok.ctx), 'running-off-profile');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '1 emulador(es) rodando no perfil']]);
});

test('cli doctor: fix de duas linhas sai indentado no texto', async () => {
  const dir = makeAvd('qa-tablet-api35', { hq: 'hw.gpu.mode = lavapipe\n' });
  const { ctx, exec, env } = setup({ qemu: { 9421: argentLine('qa-tablet-api35') } });
  tuned('qa-tablet-api35', dir, env);
  let stdout = '';
  await main(['doctor'], { stdout: (t) => { stdout += t; }, stderr: () => {}, env: ctx.env!, cwd: root, runtime: { exec, storeBase, pidAlive: ctx.pidAlive } });
  assert.match(stdout, /^\[warn\] running-off-profile: qa-tablet-api35 \(pid 9421\) rodando agora: /m);
  assert.match(stdout, /^ {7}fix: parar o emulador e subir com: devslim android up qa-tablet-api35\n {12}ou exportar ARGENT_EMULATOR_GPU_MODE=host no ambiente do argent$/m);
  noAdb(exec.calls);
});

// ---------------------------------------------------------------------------
// emulator-advertised: avd/running/pid_<pid>.ini (HOME=root no env do setup)

const RUNNING_FIXTURE = readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8');
const runningDirOf = () => join(root, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
function announce(text: string, pid = 73900): void {
  mkdirSync(runningDirOf(), { recursive: true });
  writeFileSync(join(runningDirOf(), `pid_${pid}.ini`), text);
}

test('emulator-advertised: nada rodando = ok; rodando sem entrada = warn com fix; nao chama adb', async () => {
  assert.deepEqual(only(await runDoctor(setup().ctx), 'emulator-advertised').map((c) => [c.level, c.message]), [['ok', 'nenhum emulador rodando']]);
  makeAvd('bench-api35', { hq: 'hw.gpu.mode = host\n' });
  const { ctx, exec } = setup({ qemu: { 73808: devslimLine('bench-api35') } });
  const c = only(await runDoctor(ctx), 'emulator-advertised');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.equal(
    c[0].message,
    `bench-api35 (pid 73808) rodando sem entrada em ${runningDirOf()}: ferramentas que dependem de gRPC (argent screenshot/tap) nao o enxergam; adb funciona normalmente`,
  );
  assert.equal(c[0].fix, 'devslim android down bench-api35 e devslim android up bench-api35 (lanca com -grpc <porta> -grpc-use-token)');
  noAdb(exec.calls);
});

test('emulator-advertised: entrada com grpc.port e token = ok; sem token = warn; token nunca aparece; running-off-profile nao muda', async () => {
  const dir = makeAvd('bench-api35', { hq: 'hw.ramSize = 2560\nhw.gpu.mode = host\n' });
  announce(RUNNING_FIXTURE);
  const { ctx, exec, env } = setup({ qemu: { 73808: devslimLine('bench-api35') } });
  tuned('bench-api35', dir, env);
  const checks = await runDoctor(ctx);
  assert.deepEqual(only(checks, 'emulator-advertised').map((c) => [c.level, c.message]), [['ok', `1 emulador(es) rodando, todos anunciados em ${runningDirOf()}`]]);
  assert.deepEqual(levels(checks, 'running-off-profile'), ['ok']);
  assert.ok(!JSON.stringify(checks).includes('abc123'));

  announce(RUNNING_FIXTURE.replace('grpc.token=abc123', ''));
  const w = only(await runDoctor(ctx), 'emulator-advertised');
  assert.deepEqual(w.map((c) => c.level), ['warn']);
  assert.match(w[0].message, /^bench-api35 \(pid 73808\) rodando com entrada em .* sem grpc\.token: /);
  assert.ok(!JSON.stringify(w).includes('abc123'));
  noAdb(exec.calls);
});

test('cli doctor --json e texto: emulator-advertised sem token no output', async () => {
  makeAvd('bench-api35', { hq: 'hw.gpu.mode = host\n' });
  announce(RUNNING_FIXTURE);
  const { ctx, exec } = setup({ qemu: { 73808: devslimLine('bench-api35'), 9421: argentLine('qa-tablet-api35') } });
  let stdout = '';
  await main(['doctor'], { stdout: (t) => { stdout += t; }, stderr: () => {}, env: ctx.env!, cwd: root, runtime: { exec, storeBase, pidAlive: ctx.pidAlive } });
  await main(['doctor', '--json'], { stdout: (t) => { stdout += t; }, stderr: () => {}, env: ctx.env!, cwd: root, runtime: { exec, storeBase, pidAlive: ctx.pidAlive } });
  assert.match(stdout, /^\[warn\] emulator-advertised: qa-tablet-api35 \(pid 9421\) rodando sem entrada em /m);
  assert.doesNotMatch(stdout, /emulator-advertised: bench-api35/);
  assert.ok(!stdout.includes('abc123'));
  noAdb(exec.calls);
});

test('emulator-advertised: entrada de pid morto nao conta; linha ok informa a contagem; nada apagado', async () => {
  makeAvd('bench-api35', { hq: 'hw.gpu.mode = host\n' });
  announce(RUNNING_FIXTURE, 73900); // boot anterior que caiu
  const { ctx, exec } = setup({ qemu: { 73808: devslimLine('bench-api35') }, alive: (pid) => pid !== 73900 });
  const c = only(await runDoctor(ctx), 'emulator-advertised');
  assert.deepEqual(c.map((x) => x.level), ['warn', 'ok']);
  assert.match(c[0].message, /^bench-api35 \(pid 73808\) rodando sem entrada em /);
  assert.equal(c[1].message, `1 entrada(s) de emulador morto em ${runningDirOf()} ignorada(s): pid_73900.ini (bench-api35); arquivos do emulador, nada apagado`);
  assert.ok(existsSync(join(runningDirOf(), 'pid_73900.ini')), 'stale fica no disco');
  assert.ok(!JSON.stringify(c).includes('abc123'));
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0, 'stale nao falha');

  // Viva + morta do mesmo AVD: a viva anuncia, a morta so aparece na contagem.
  announce(RUNNING_FIXTURE, 73808);
  const both = only(await runDoctor(ctx), 'emulator-advertised');
  assert.deepEqual(both.map((x) => [x.level, x.message.split(':')[0]]), [
    ['ok', `1 emulador(es) rodando, todos anunciados em ${runningDirOf()}`],
    ['ok', `1 entrada(s) de emulador morto em ${runningDirOf()} ignorada(s)`],
  ]);

  // Nada rodando: so a sobra.
  const idle = only(await runDoctor(setup({ alive: () => false }).ctx), 'emulator-advertised');
  assert.deepEqual(idle.map((x) => x.level), ['ok', 'ok']);
  assert.equal(idle[0].message, 'nenhum emulador rodando');
  assert.match(idle[1].message, /^2 entrada\(s\) de emulador morto em .*: pid_73808\.ini \(bench-api35\), pid_73900\.ini \(bench-api35\); /);
  noAdb(exec.calls);
});

// ---------------------------------------------------------------------------
// profile-drift: config.ini atual x o que o perfil salvo no state produziria

const PHONE_INI = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url), 'utf8');

// AVD tunado com o perfil: config.ini = saida do applyProfile sobre a fixture.
function tunedAvd(name: string, env: Record<string, string>, opts: AndroidProfileOptions = {}): { dir: string; config: string } {
  const profile = buildAndroidProfile(opts);
  const config = serializeIni(applyProfile(parseIni(PHONE_INI), profile).doc);
  const dir = makeAvd(name, { config });
  recordAndroidTune(name, { avdDir: dir, originalConfigIni: PHONE_INI, originalConfigSha256: 'y', profile }, { env });
  return { dir, config };
}

const editIni = (dir: string, edits: Record<string, string>) => {
  let doc = parseIni(readFileSync(join(dir, 'config.ini'), 'utf8'));
  for (const [k, v] of Object.entries(edits)) doc = setValue(doc, k, v);
  writeFileSync(join(dir, 'config.ini'), serializeIni(doc));
};

test('profile-drift: sem state = ok; config.ini no perfil salvo = ok; so leitura', async () => {
  assert.deepEqual(only(await runDoctor(setup().ctx), 'profile-drift').map((c) => [c.level, c.message]), [['ok', 'nenhum AVD com state do devslim']]);
  const { ctx, env } = setup();
  const { dir, config } = tunedAvd('bench-api35', env, { capabilities: ['camera'] });
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '1 AVD(s) com config.ini no perfil salvo']]);
  assert.equal(readFileSync(join(dir, 'config.ini'), 'utf8'), config, 'doctor nao escreve');
});

test('profile-drift: hw.gps=yes sem location no perfil = warn com --need somando as capacidades salvas', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('bench-api35', env, { capabilities: ['camera'] });
  editIni(dir, { 'hw.gps': 'yes' });
  const before = readFileSync(join(dir, 'config.ini'), 'utf8');
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.equal(c.length, 1);
  assert.equal(c[0].level, 'warn');
  assert.equal(c[0].message, 'bench-api35: config.ini difere do perfil salvo em 1 chave(s): hw.gps: atual=yes esperado=no');
  assert.equal(
    c[0].fix,
    'devslim android tune bench-api35 --need camera,location (o config.ini atual pede location)\nou devslim android tune bench-api35 para voltar ao perfil salvo',
  );
  assert.equal(readFileSync(join(dir, 'config.ini'), 'utf8'), before, 'so leitura');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0, 'drift e warn, nao fail');
});

test('profile-drift: drift generico lista cada chave (ausente incluida); fix e so o tune', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('bench-api35', env);
  editIni(dir, { 'hw.ramSize': '4096', 'hw.gpu.mode': 'auto' });
  writeFileSync(join(dir, 'config.ini'), readFileSync(join(dir, 'config.ini'), 'utf8').replace(/^showDeviceFrame=no\r?\n/m, ''));
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(c.map((x) => x.level), ['warn']);
  assert.equal(
    c[0].message,
    'bench-api35: config.ini difere do perfil salvo em 3 chave(s): hw.ramSize: atual=4096 esperado=2048; hw.gpu.mode: atual=auto esperado=host; showDeviceFrame: atual=(ausente) esperado=no',
  );
  assert.equal(c[0].fix, 'devslim android tune bench-api35');
});

test('profile-drift: AVD com state mas ausente, ou config.ini ilegivel, e pulado sem falhar', async () => {
  const { ctx, env } = setup();
  recordAndroidTune('sumiu-api35', { avdDir: join(avdHome, 'sumiu-api35.avd'), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  const only1 = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(only1.map((x) => [x.level, x.message]), [['ok', '0 AVD(s) com config.ini no perfil salvo; 1 pulado(s) (AVD ausente ou config.ini ilegivel)']]);

  const { dir } = tunedAvd('bench-api35', env, { capabilities: ['location'] });
  const broken = makeAvd('quebrado-api35');
  recordAndroidTune('quebrado-api35', { avdDir: broken, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  rmSync(join(broken, 'config.ini'));
  mkdirSync(join(broken, 'config.ini')); // diretorio no lugar do arquivo
  editIni(dir, { 'hw.gps': 'no' });
  const c = only(await runDoctor(ctx), 'profile-drift');
  assert.deepEqual(c.map((x) => x.level), ['warn']);
  assert.equal(c[0].message, 'bench-api35: config.ini difere do perfil salvo em 1 chave(s): hw.gps: atual=no esperado=yes');
  assert.equal(c[0].fix, 'devslim android tune bench-api35 --need none (o config.ini atual dispensa location)\nou devslim android tune bench-api35 para voltar ao perfil salvo');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0);
});

// ---------------------------------------------------------------------------
// avd-image: tag da system image x capacidades que exigem servicos Google

const ATD = (tag: string, api = 35) => ({ 'tag.id': tag, 'tag.ids': tag, 'image.sysdir.1': `system-images/android-${api}/${tag}/arm64-v8a/` });

test('avd-image: sem state = ok', async () => {
  assert.deepEqual(only(await runDoctor(setup().ctx), 'avd-image').map((c) => [c.level, c.message]), [['ok', 'nenhum AVD com state do devslim']]);
});

test('avd-image: google_apis sem push/weblogin/store = nota nao bloqueante sugerindo ATD com o numero medido', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('bench-api35', env, { capabilities: ['camera', 'keyboard'] });
  const before = readFileSync(join(dir, 'config.ini'), 'utf8');
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => x.level), ['ok']);
  assert.match(c[0].message, /^bench-api35: imagem google_apis \(servicos Google completos\) e o perfil nao pede push, weblogin nem store; /);
  assert.match(c[0].message, /3660 MB contra 4343 MB de phys_footprint no host, 2 min parado, uma medicao/);
  assert.equal(c[0].fix, 'devslim android create bench-api35-atd --image aosp_atd');
  assert.equal(readFileSync(join(dir, 'config.ini'), 'utf8'), before, 'so leitura');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0);
});

test('avd-image: playstore e API diferente de 35 = nota com --api', async () => {
  const { ctx, env } = setup();
  const { dir } = tunedAvd('loja-api34', env);
  editIni(dir, ATD('google_apis_playstore', 34));
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => x.level), ['ok']);
  assert.equal(c[0].fix, 'devslim android create loja-api34-atd --image aosp_atd --api 34');
});

test('avd-image: ATD ou default com push/weblogin/store = warn dizendo que nao funciona', async () => {
  const { ctx, env } = setup();
  const a = tunedAvd('atd-api35', env, { capabilities: ['push', 'weblogin'] });
  editIni(a.dir, ATD('aosp_atd'));
  const d = tunedAvd('def-api35', env, { capabilities: ['store'] });
  editIni(d.dir, ATD('default'));
  const g = tunedAvd('gatd-api35', env, { capabilities: ['push'] });
  editIni(g.dir, ATD('google_atd'));
  const c = only(await runDoctor(ctx), 'avd-image');
  const by = Object.fromEntries(c.map((x) => [x.message.split(':')[0], x]));
  assert.deepEqual(c.map((x) => x.level), ['warn', 'warn', 'warn']);
  assert.match(by['atd-api35'].message, /imagem aosp_atd \(sem servicos Google\) e o perfil pede push,weblogin: nao funciona nessa imagem/);
  assert.match(by['def-api35'].message, /imagem default \(sem servicos Google\) e o perfil pede store: nao funciona nessa imagem/);
  assert.match(by['gatd-api35'].message, /imagem google_atd \(servicos Google reduzidos\) e o perfil pede push: pode nao funcionar nessa imagem/);
  assert.equal(by['atd-api35'].fix, 'devslim android create atd-api35-gapis --image google_apis');
  assert.equal(doctorExitCode(await runDoctor(ctx)), 0, 'warn nao derruba o exit');
});

test('avd-image: google_apis com capacidade Google e ATD sem ela = ok; tag so pelo image.sysdir.1 tambem vale', async () => {
  const { ctx, env } = setup();
  tunedAvd('login-api35', env, { capabilities: ['weblogin'] });
  const a = tunedAvd('ui-api35', env, { capabilities: ['camera'] });
  editIni(a.dir, ATD('aosp_atd'));
  const b = tunedAvd('semtag-api35', env, { capabilities: ['push'] });
  let doc = parseIni(readFileSync(join(b.dir, 'config.ini'), 'utf8'));
  doc = setValue(doc, 'tag.id', '');
  doc = setValue(doc, 'image.sysdir.1', 'system-images/android-35/google_apis/arm64-v8a/');
  writeFileSync(join(b.dir, 'config.ini'), serializeIni(doc));
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '3 AVD(s) com imagem compativel com as capacidades do perfil']]);
});

test('avd-image: AVD ausente, config.ini ilegivel ou sem tag = pulado', async () => {
  const { ctx, env } = setup();
  recordAndroidTune('sumiu-api35', { avdDir: join(avdHome, 'sumiu-api35.avd'), originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  const broken = makeAvd('quebrado-api35');
  recordAndroidTune('quebrado-api35', { avdDir: broken, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  rmSync(join(broken, 'config.ini'));
  mkdirSync(join(broken, 'config.ini'));
  const notag = makeAvd('semtag-api35', { config: 'hw.ramSize=2048\n' });
  recordAndroidTune('semtag-api35', { avdDir: notag, originalConfigIni: 'x', originalConfigSha256: 'y', profile: buildAndroidProfile() }, { env });
  const c = only(await runDoctor(ctx), 'avd-image');
  assert.deepEqual(c.map((x) => [x.level, x.message]), [['ok', '0 AVD(s) com imagem compativel com as capacidades do perfil; 3 pulado(s) (AVD ausente, config.ini ilegivel ou sem tag da imagem)']]);
});
