import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { bakeAvd, createAvd, downAvd, pickFreePort, upAvd } from '../src/android/runtime.ts';
import { loadSession, recordSession } from '../src/android/session.ts';
import { tuneAvd } from '../src/android/tune.ts';
import { DevslimError } from '../src/errors.ts';
import { loadState, type AndroidState } from '../src/state.ts';

const PHONE = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url));
const AVD = 'slim-api35';

let root: string;
let avdHome: string;
let devslimHome: string;
let avdDir: string;
let stderr: string[];
let running: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-runtime-'));
  avdHome = join(root, 'avd');
  devslimHome = join(root, 'devslim-home');
  avdDir = join(avdHome, `${AVD}.avd`);
  mkdirSync(avdDir, { recursive: true });
  writeFileSync(join(avdHome, `${AVD}.ini`), `path=${avdDir}\n`);
  writeFileSync(join(avdDir, 'config.ini'), PHONE);
  stderr = [];
  running = join(root, 'avd-running'); // nao existe ate o teste criar
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function world(opts: FakeAndroidOptions = {}) {
  const fake = createFakeAndroid({ avdHome, avdDir: (name) => join(avdHome, `${name}.avd`), ...opts });
  const env = { ANDROID_HOME: fake.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: devslimHome, HOME: root };
  const ctx = {
    env,
    exec: fake.exec,
    spawnDetached: fake.spawnDetached,
    sleep: fake.sleep,
    now: fake.now,
    date: fake.date,
    fileExists: fake.fileExists,
    stderr: (t: string) => { stderr.push(t); },
    runningDir: running,
  };
  return { fake, env, ctx };
}

const BASE_ARGS = [
  '-avd', AVD, '-gpu', 'host', '-memory', '2048', '-cores', '2', '-port', '5554', '-grpc', '8554', '-grpc-use-token',
  '-no-window', '-no-audio', '-camera-back', 'none', '-camera-front', 'none', '-feature', '-Vulkan',
  '-no-boot-anim', '-no-metrics',
];

const INSTALLED = ['com.google.android.youtube', 'com.google.android.apps.photos', 'com.android.chrome', 'com.example.app'];

test('up sem slim_base: -no-snapshot, -port sempre, log em $DEVSLIM_HOME/logs, sessao registrada', async () => {
  const { fake, ctx, env } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(fake.spawnCalls.length, 1);
  const call = fake.spawnCalls[0];
  assert.equal(call.cmd, fake.tools.emulator);
  assert.deepEqual(call.args, [...BASE_ARGS, '-no-snapshot']);
  assert.equal(call.opts.logFile, join(devslimHome, 'logs', `${AVD}.log`));
  assert.ok(existsSync(join(devslimHome, 'logs')));
  assert.equal(r.serial, 'emulator-5554');
  assert.equal(r.port, 5554);
  assert.equal(r.fromSnapshot, false);
  assert.equal(r.alreadyRunning, false);
  assert.equal(r.pid, fake.emulators.get('emulator-5554')!.pid);
  assert.deepEqual(loadSession(env).map((e) => [e.platform, e.avd, e.serial, e.pid, e.port]), [['android', AVD, 'emulator-5554', r.pid, 5554]]);
  assert.ok(fake.exec.calls.some((c) => c.args.join(' ') === '-s emulator-5554 shell getprop sys.boot_completed'), 'esperou o boot');
  assert.ok(fake.exec.calls.some((c) => c.cmd === 'sysctl'), 'checou swap');
});

test('up com snapshots/slim_base: -snapshot slim_base -no-snapshot-save, -port presente', async () => {
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile({ port: 5558 }), ctx);
  const expected = [...BASE_ARGS, '-snapshot', 'slim_base', '-no-snapshot-save'];
  expected[expected.indexOf('-port') + 1] = '5558';
  expected[expected.indexOf('-grpc') + 1] = '8558';
  assert.deepEqual(fake.spawnCalls[0].args, expected);
  assert.equal(r.fromSnapshot, true);
  assert.equal(r.serial, 'emulator-5558');
});

test('pickFreePort: primeira par livre a partir de 5554', () => {
  assert.equal(pickFreePort([]), 5554);
  assert.equal(pickFreePort([{ serial: 'emulator-5554', state: 'device' }, { serial: 'emulator-5556', state: 'offline' }]), 5558);
  assert.equal(pickFreePort([{ serial: 'emulator-5556', state: 'device' }, { serial: 'R58M', state: 'device' }]), 5554);
  assert.equal(pickFreePort([{ serial: 'emulator-5555', state: 'device' }]), 5556, 'porta impar ocupa o par');
});

test('up com --force escolhe porta livre segundo adb devices', async () => {
  const { fake, ctx } = world({ emulators: [{ avd: 'outro', port: 5554 }, { avd: 'mais-um', port: 5556 }] });
  const r = await upAvd(AVD, buildAndroidProfile(), { ...ctx, force: true });
  assert.equal(r.port, 5558);
  const args = fake.spawnCalls[0].args;
  assert.equal(args[args.indexOf('-port') + 1], '5558');
});

test('up recusa com outro emulador rodando (guarda) e nao sobe nada', async () => {
  const { fake, ctx } = world({ emulators: [{ avd: 'outro', port: 5554 }] });
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), ctx), /up recusado: .*emulator-5554/);
  assert.equal(fake.spawnCalls.length, 0);
});

test('up com porta explicita ocupada da erro', async () => {
  const { ctx } = world({ emulators: [{ avd: 'outro', port: 5556 }] });
  await assert.rejects(upAvd(AVD, buildAndroidProfile({ port: 5556 }), { ...ctx, force: true }), /porta 5556 ja em uso/);
});

test('up com o AVD ja rodando: nao sobe outro, devolve o existente', async () => {
  const { fake, ctx, env } = world({ emulators: [{ avd: AVD, port: 5556, pid: 777 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5556', pid: 777, port: 5556, startedAt: 'x' }, env);
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(fake.spawnCalls.length, 0);
  assert.deepEqual(
    { serial: r.serial, pid: r.pid, port: r.port, alreadyRunning: r.alreadyRunning, fromSnapshot: r.fromSnapshot },
    { serial: 'emulator-5556', pid: 777, port: 5556, alreadyRunning: true, fromSnapshot: null },
  );
});

test('up: boot que nao termina vira erro com log e dica de down; sessao fica registrada', async () => {
  const { ctx, env } = world({ spawned: { neverBoots: true } });
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), { ...ctx, bootTimeoutMs: 6000, pollMs: 2000 }), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.match(err.message, /nao terminou o boot em 6 s/);
    assert.match(err.message, /logs\/slim-api35\.log/);
    assert.match(err.message, /devslim android down slim-api35/);
    return true;
  });
  assert.equal(loadSession(env).length, 1);
});

const swapAt = (pct: number) => `total = 1000.00M  used = ${pct * 10}.00M  free = ${1000 - pct * 10}.00M  (encrypted)`;

test('swap no up: 79% sem aviso; 85% avisa e boota', async () => {
  const low = world({ swap: swapAt(79) });
  await upAvd(AVD, buildAndroidProfile(), low.ctx);
  assert.equal(low.fake.spawnCalls.length, 1);
  assert.doesNotMatch(stderr.join(''), /swap/);

  const mid = world({ swap: swapAt(85) });
  await upAvd(AVD, buildAndroidProfile(), mid.ctx);
  assert.equal(mid.fake.spawnCalls.length, 1);
  assert.match(stderr.join(''), /^devslim: aviso: swap em 85% \(850 de 1000 MB\): acima de 80%$/m);
});

test('swap no up: 96% recusa sem --force (nada sobe, sessao vazia); com --force boota e avisa', async () => {
  const hi = world({ swap: swapAt(96) });
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), hi.ctx), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.equal(err.message, 'up recusado: swap em 96% (960 de 1000 MB): nao boote device agora; feche apps, sessoes e devices ociosos antes de subir device (--force para bootar mesmo assim)');
    return true;
  });
  assert.equal(hi.fake.spawnCalls.length, 0);
  assert.deepEqual(loadSession(hi.env), []);

  const forced = world({ swap: swapAt(96) });
  const r = await upAvd(AVD, buildAndroidProfile(), { ...forced.ctx, force: true });
  assert.equal(r.alreadyRunning, false);
  assert.equal(forced.fake.spawnCalls.length, 1);
  assert.match(stderr.join(''), /aviso: swap em 96% .*--force: bootando mesmo assim/);
});

test('swap no up: AVD ja rodando a 96% nao e bloqueado', async () => {
  const { fake, ctx } = world({ swap: swapAt(96), emulators: [{ avd: AVD, port: 5554 }] });
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.alreadyRunning, true);
  assert.equal(fake.spawnCalls.length, 0);
});

test('swap no bake: 96% recusa sem --force com a mesma mensagem', async () => {
  const { fake, ctx, env } = world({ swap: swapAt(96) });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), ctx), /^DevslimError: bake recusado: swap em 96% \(960 de 1000 MB\): nao boote device agora; .*--force para bootar mesmo assim/);
  assert.equal(fake.spawnCalls.length, 0);
});

test('bake sem state de tune da erro mandando rodar tune', async () => {
  const { fake, ctx } = world();
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), ctx), /ainda nao foi tunado; rode antes: devslim android tune slim-api35/);
  assert.equal(fake.spawnCalls.length, 0);
});

test('bake recusa AVD rodando', async () => {
  const { ctx, env } = world({ emulators: [{ avd: AVD, port: 5554 }] });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), ctx), /esta rodando \(emulator-5554\); desligue antes do bake/);
});

test('bake: sobe sem snapshot, enxuga, grava state, snapshot slim_base, emu kill, espera sair', async () => {
  const { fake, ctx, env } = world({
    spawned: { installed: INSTALLED, disabled: ['com.google.android.youtube'], bootSteps: 2, settings: { 'global/auto_sync': '1' } },
  });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true }); // snapshot antigo: bake ignora
  const r = await bakeAvd(AVD, buildAndroidProfile(), ctx);

  assert.deepEqual(fake.spawnCalls[0].args, [...BASE_ARGS, '-no-snapshot'], 'bake nunca carrega snapshot');
  const cmds = fake.deviceCommands();
  const idx = (s: string) => cmds.indexOf(s);
  assert.ok(idx('shell getprop sys.boot_completed') < idx('shell settings get global window_animation_scale'));
  assert.ok(idx('shell settings get global window_animation_scale') < idx('shell pm list packages'));
  assert.ok(idx('shell pm disable-user --user 0 com.google.android.apps.photos') < idx('shell cmd package bg-dexopt-job'));
  assert.ok(idx('shell am kill-all') < idx('emu avd snapshot save slim_base'));
  assert.equal(cmds.at(-1), 'emu kill');
  assert.equal(fake.emulators.size, 0, 'emulador desligado');

  const state = loadState<AndroidState>('android', AVD, { env })!;
  assert.deepEqual(state.disabledPackages, ['com.google.android.apps.photos'], 'youtube ja estava desligado: fora do state');
  assert.equal(state.settings!.find((s) => s.key === 'auto_sync')!.previous, '1');
  assert.equal(state.settings!.find((s) => s.key === 'window_animation_scale')!.previous, null);
  assert.equal(state.bakedAt, '2026-11-16T12:00:00.000Z');
  assert.equal(typeof state.originalConfigIni, 'string', 'backup do tune intacto');

  assert.deepEqual(loadSession(env), [], 'sessao do bake limpa');
  assert.ok(existsSync(join(avdDir, 'snapshots', 'slim_base', 'ram.bin')));
  assert.equal(r.snapshot, 'slim_base');
  assert.equal(r.level, 'standard');
  for (const k of ['bootMs', 'slimMs', 'snapshotMs', 'shutdownMs', 'totalMs'] as const) assert.equal(typeof r.timings[k], 'number', k);
  assert.ok(r.timings.bootMs >= 2000, 'boot com 2 polls de 2 s no relogio falso');
});

test('bake: falha no snapshot derruba o emulador e propaga o erro; state ja gravado', async () => {
  const { fake, ctx, env } = world({ spawned: { installed: INSTALLED } });
  tuneAvd(AVD, buildAndroidProfile(), { env });
  const original = fake.exec;
  const failing = Object.assign(
    async (cmd: string, args: readonly string[], o?: object) =>
      args.includes('snapshot') ? { code: 0, signal: null, stdout: 'KO: snapshot save failed\r\n', stderr: '' } : original(cmd, args, o),
    { calls: original.calls },
  );
  await assert.rejects(bakeAvd(AVD, buildAndroidProfile(), { ...ctx, exec: failing }), /snapshot save slim_base .*falhou/);
  assert.equal(fake.emulators.size, 0, 'emulador do bake nao fica vivo');
  assert.deepEqual(loadState<AndroidState>('android', AVD, { env })!.disabledPackages, [
    'com.google.android.apps.photos',
    'com.google.android.youtube',
  ]);
});

test('down sem argumento: so mata o registrado na sessao', async () => {
  const { fake, ctx, env } = world({ emulators: [{ avd: AVD, port: 5554 }, { avd: 'do-dono', port: 5556 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5554', pid: 1, port: 5554, startedAt: 'x' }, env);
  const r = await downAvd(undefined, ctx);
  assert.deepEqual(r.map((x) => [x.avd, x.result]), [[AVD, 'killed']]);
  assert.deepEqual([...fake.emulators.keys()], ['emulator-5556'], 'emulador do dono intocado');
  assert.ok(!fake.exec.calls.some((c) => c.args.join(' ') === '-s emulator-5556 emu kill'));
  assert.deepEqual(loadSession(env), []);
});

test('down <avd> nao registrado: recusa sem --force; com --force mata', async () => {
  const { fake, ctx } = world({ emulators: [{ avd: 'do-dono', port: 5556 }] });
  await assert.rejects(downAvd('do-dono', ctx), /nao foi subido pelo devslim .*--force/);
  assert.equal(fake.emulators.size, 1);
  const r = await downAvd('do-dono', { ...ctx, force: true });
  assert.deepEqual(r.map((x) => [x.avd, x.serial, x.registered, x.result]), [['do-dono', 'emulator-5556', false, 'killed']]);
  assert.equal(fake.emulators.size, 0);
});

test('down: entrada velha (serial sumiu) e serial reaproveitado por outro AVD nao matam nada', async () => {
  const { fake, ctx, env } = world({ emulators: [{ avd: 'do-dono', port: 5556 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5554', pid: 1, port: 5554, startedAt: 'x' }, env);
  recordSession({ platform: 'android', avd: 'velho', serial: 'emulator-5556', pid: 2, port: 5556, startedAt: 'x' }, env);
  const r = await downAvd(undefined, ctx);
  assert.deepEqual(r.map((x) => [x.avd, x.result]), [[AVD, 'stale'], ['velho', 'skipped']]);
  assert.equal(fake.emulators.size, 1, 'emulator-5556 roda do-dono: intocado');
  assert.deepEqual(loadSession(env), []);
});

test('down sem nada na sessao: lista vazia', async () => {
  const { ctx } = world();
  assert.deepEqual(await downAvd(undefined, ctx), []);
});

test('create recusa nome existente sem chamar avdmanager', async () => {
  const { fake, ctx } = world();
  await assert.rejects(createAvd(AVD, ctx), /AVD slim-api35 ja existe/);
  assert.equal(fake.exec.calls.length, 0);
});

test('create: avdmanager com args exatos e "no" no stdin; aplica tune com 720x1600@320; nao boota', async () => {
  const { fake, ctx, env } = world();
  const r = await createAvd('novo-api35', ctx);
  assert.deepEqual(fake.exec.calls.map((c) => [c.cmd, ...c.args]), [
    [fake.tools.avdmanager, 'create', 'avd', '-n', 'novo-api35', '-k', 'system-images;android-35;google_apis;arm64-v8a', '-d', 'pixel_7'],
  ]);
  assert.equal(fake.exec.calls[0].opts.input, 'no\n');
  assert.equal(fake.spawnCalls.length, 0, 'nao boota');
  const config = readFileSync(join(avdHome, 'novo-api35.avd', 'config.ini'), 'utf8');
  assert.match(config, /^hw\.lcd\.width=720$/m);
  assert.match(config, /^hw\.lcd\.height=1600$/m);
  assert.match(config, /^hw\.lcd\.density=320$/m);
  assert.match(config, /^hw\.ramSize=2048$/m);
  assert.equal(r.image, 'system-images;android-35;google_apis;arm64-v8a');
  const state = loadState<AndroidState>('android', 'novo-api35', { env })!;
  assert.match(state.originalConfigIni, /hw\.lcd\.width=1080/);
});

test('create com --image/--device e falha do avdmanager', async () => {
  const { fake, ctx } = world({ avdmanagerFails: true });
  await assert.rejects(createAvd('x-api34', { ...ctx, image: 'system-images;android-34;google_apis;arm64-v8a', device: 'pixel_6' }), /avdmanager create avd x-api34 falhou \(exit 1\)/);
  assert.deepEqual(fake.exec.calls[0].args.slice(-4), ['-k', 'system-images;android-34;google_apis;arm64-v8a', '-d', 'pixel_6']);
});

test('SDK ausente: erro dizendo qual binario e onde procurou', async () => {
  const { ctx } = world();
  await assert.rejects(upAvd(AVD, buildAndroidProfile(), { ...ctx, fileExists: () => false }), /adb nao encontrado; procurado em: .*platform-tools\/adb/);
});

// Emulador falso que, ao "subir", escreve o que o real escreve: hardware-qemu.ini e/ou log.
function emulatorWrites(ctx: ReturnType<typeof world>['ctx'], w: { hwIni?: string; log?: string }) {
  return {
    ...ctx,
    spawnDetached: async (cmd: string, args: readonly string[], o: { logFile: string; env?: Readonly<Record<string, string | undefined>> }) => {
      if (w.hwIni !== undefined) writeFileSync(join(avdDir, 'hardware-qemu.ini'), w.hwIni);
      if (w.log !== undefined) appendFileSync(o.logFile, w.log);
      return ctx.spawnDetached(cmd, args, o);
    },
  };
}

test('up: RAM efetiva do hardware-qemu.ini maior que a pedida avisa em stderr com os dois valores e a tentativa de tela', async () => {
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2560\nhw.gpu.mode = host\nvm.heapSize = 576\n' }));
  assert.equal(r.ramEffectiveMb, 2560);
  const err = stderr.join('');
  assert.match(err, /aviso: RAM pedida 2048 MB, efetiva 2560 MB \(emulador elevou; -memory 2048 nao vence\)\. /);
  assert.doesNotMatch(err, /piso do emulador|log: /, 'rotulo honesto; sem linha no log, nada citado');
  assert.match(err, /Tentativa, sem garantia de baixar a RAM efetiva: .*devslim android tune slim-api35 --screen 720x1600@320/);
});

test('up: aviso de RAM cita a linha do log deste boot quando ha', async () => {
  const { ctx } = world();
  const r = await upAvd(
    AVD,
    buildAndroidProfile(),
    emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2560\n', log: 'INFO         | Increasing RAM size to 2560MB\n' }),
  );
  assert.equal(r.ramEffectiveMb, 2560);
  assert.match(stderr.join(''), /\(emulador elevou; -memory 2048 nao vence\); log: "INFO \| Increasing RAM size to 2560MB"\. Tentativa/);
});

const ARGENT_LINE = '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd slim-api35 -no-snapshot-load -gpu auto -feature -Vulkan -noaudio -no-boot-anim -netfast -no-metrics -crash-report-mode never';

test('up com o AVD ja rodando fora do perfil (argent, lavapipe): avisa em stderr, nao mata, devolve launcher e gpuEffective', async () => {
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\nhw.gpu.mode = lavapipe\n');
  const { fake, ctx } = world({ emulators: [{ avd: AVD, port: 5554, pid: 9421 }], host: { pgrep: '9421\n', cmdline: ARGENT_LINE } });
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.alreadyRunning, true);
  assert.equal(r.launcher, 'argent');
  assert.equal(r.gpuEffective, 'lavapipe');
  assert.equal(r.ramEffectiveMb, 4096);
  assert.equal(fake.spawnCalls.length, 0);
  assert.equal(fake.emulators.size, 1, 'nunca mata sozinho');
  assert.ok(!fake.deviceCommands().includes('emu kill'));
  const err = stderr.join('');
  assert.match(err, /^devslim: aviso: AVD slim-api35 ja roda fora do perfil \(pid 9421, lancado por argent, gpu efetiva lavapipe \(software\), ram efetiva 4096 MB\); /m);
  assert.match(err, /nada subido, nada desligado\. Para subir no perfil: devslim android down slim-api35 --force e depois devslim android up slim-api35/);
  assert.ok(fake.exec.calls.some((c) => c.cmd === 'ps' && c.args.join(' ') === '-o command= -p 9421'), 'linha de comando via ps, sem adb');
});

test('up com o AVD ja rodando pelo devslim (sessao, gpu host): sem aviso, launcher devslim', async () => {
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 2048\nhw.gpu.mode = host\n');
  const { ctx, env } = world({ emulators: [{ avd: AVD, port: 5556, pid: 777 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5556', pid: 777, port: 5556, startedAt: 'x' }, env);
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.deepEqual([r.alreadyRunning, r.launcher, r.gpuEffective, r.pid], [true, 'devslim', 'host', 777]);
  assert.doesNotMatch(stderr.join(''), /fora do perfil/);
});

test('up sobe: launcher devslim e gpuEffective no retorno', async () => {
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2048\nhw.gpu.mode = host\n' }));
  assert.deepEqual([r.alreadyRunning, r.launcher, r.gpuEffective], [false, 'devslim', 'host']);
});

test('up: RAM efetiva igual a pedida nao avisa', async () => {
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { hwIni: 'hw.ramSize = 2048\n' }));
  assert.equal(r.ramEffectiveMb, 2048);
  assert.doesNotMatch(stderr.join(''), /elevou a RAM/);
});

test('up: sem hardware-qemu.ini, RAM efetiva vem da linha do log deste boot (ignora boots anteriores)', async () => {
  const { ctx } = world();
  mkdirSync(join(devslimHome, 'logs'), { recursive: true });
  writeFileSync(join(devslimHome, 'logs', `${AVD}.log`), 'INFO         | Increasing RAM size to 4096MB\n'); // boot antigo
  const r = await upAvd(AVD, buildAndroidProfile(), emulatorWrites(ctx, { log: 'INFO         | Android emulator version 36.1\nINFO         | Increasing RAM size to 2560MB\n' }));
  assert.equal(r.ramEffectiveMb, 2560);
  assert.match(stderr.join(''), /RAM pedida 2048 MB, efetiva 2560 MB .*; log: "INFO \| Increasing RAM size to 2560MB"/);
  assert.doesNotMatch(stderr.join(''), /4096/, 'linha de boot antigo nao e citada');

  stderr = [];
  const again = world();
  rmSync(join(devslimHome, 'logs'), { recursive: true, force: true });
  const none = await upAvd(AVD, buildAndroidProfile(), again.ctx);
  assert.equal(none.ramEffectiveMb, null, 'nem ini nem linha no log: desconhecida');
  assert.doesNotMatch(stderr.join(''), /elevou/);
});

test('up: dica de bake so quando subiu sem slim_base', async () => {
  const cold = world();
  const r = await upAvd(AVD, buildAndroidProfile(), cold.ctx);
  assert.equal(r.fromSnapshot, false);
  assert.equal(r.hint, 'dica: subiu sem snapshot slim_base; rode uma vez devslim android bake slim-api35 (com o AVD desligado) para os proximos up partirem de um guest ja enxuto');

  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  const warm = world();
  const w = await upAvd(AVD, buildAndroidProfile(), warm.ctx);
  assert.equal(w.fromSnapshot, true);
  assert.ok(!('hint' in w));

  const running = world({ emulators: [{ avd: AVD, port: 5556 }] });
  rmSync(join(avdDir, 'snapshots'), { recursive: true });
  const a = await upAvd(AVD, buildAndroidProfile(), running.ctx);
  assert.equal(a.alreadyRunning, true);
  assert.ok(!('hint' in a), 'ja rodando: sem dica');
});

// ---------------------------------------------------------------------------
// anuncio (avd/running/pid_<pid>.ini)

const RUNNING_FIXTURE = readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8');

function announce(o: { pid?: number; avd?: string; serial?: number; grpc?: number | null; token?: boolean } = {}): void {
  mkdirSync(running, { recursive: true });
  let text = RUNNING_FIXTURE.replace('avd.name=bench-api35', `avd.name=${o.avd ?? AVD}`)
    .replace('port.serial=5554', `port.serial=${o.serial ?? 5554}`)
    .replace('grpc.port=8554', o.grpc === null ? '' : `grpc.port=${o.grpc ?? 8554}`);
  if (o.token === false) text = text.replace('grpc.token=abc123', '');
  writeFileSync(join(running, `pid_${o.pid ?? 61000}.ini`), text);
}

const noLeak = (r: unknown) => {
  assert.ok(!JSON.stringify(r).includes('abc123'), 'token fora do retorno');
  assert.ok(!stderr.join('').includes('abc123'), 'token fora do stderr');
};

test('up anunciado: advertised true, grpcPort 8554, sem aviso, sem esperar', async () => {
  announce();
  const { fake, ctx } = world();
  const before = fake.sleeps.length;
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.advertised, true);
  assert.equal(r.grpcPort, 8554);
  assert.ok(!stderr.join('').includes('nao se anunciou'));
  assert.ok(fake.sleeps.slice(before).every((ms) => ms !== 500), 'nenhum poll de anuncio');
  noLeak(r);
});

test('up anunciado na porta da instancia: 5556 -> casa a entrada de port.serial 5556', async () => {
  announce({ serial: 5554, grpc: 8554, pid: 1 }); // outra instancia velha do mesmo AVD
  announce({ serial: 5556, grpc: 8556, pid: 2 });
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile({ port: 5556 }), ctx);
  const args = fake.spawnCalls[0].args;
  assert.deepEqual(args.slice(args.indexOf('-grpc'), args.indexOf('-grpc') + 3), ['-grpc', '8556', '-grpc-use-token']);
  assert.deepEqual([r.advertised, r.grpcPort], [true, 8556]);
});

test('up nao anunciado: espera ate 10 s, avisa em stderr com o diretorio, nao e erro', async () => {
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.equal(r.advertised, false);
  assert.equal(r.grpcPort, null);
  assert.equal(r.serial, 'emulator-5554', 'subiu normalmente');
  const polls = fake.sleeps.filter((ms) => ms === 500);
  assert.ok(polls.length >= 19 && polls.length <= 21, `poll de ~10 s (${polls.length} x 500 ms)`);
  const err = stderr.join('');
  assert.equal(
    err.split('\n').find((l) => l.includes('nao se anunciou')),
    `devslim: aviso: emulador nao se anunciou em ${running}: ferramentas que dependem de gRPC (argent screenshot/tap) nao vao enxerga-lo; adb funciona normalmente`,
  );
});

test('up com entrada sem token (ou sem grpc.port) conta como nao anunciado', async () => {
  announce({ token: false });
  const { ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.deepEqual([r.advertised, r.grpcPort], [false, 8554]);
  assert.match(stderr.join(''), /nao se anunciou/);
  noLeak(r);
});

test('up --no-grpc (perfil grpc false): sem -grpc na linha, sem espera, sem aviso', async () => {
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile({ grpc: false }), ctx);
  assert.ok(!fake.spawnCalls[0].args.includes('-grpc') && !fake.spawnCalls[0].args.includes('-grpc-use-token'));
  assert.equal(r.advertised, false);
  assert.ok(!stderr.join('').includes('nao se anunciou'));
  assert.equal(fake.sleeps.filter((ms) => ms === 500).length, 0);
});

test('up com runningDir null (plataforma sem diretorio conhecido): nao espera, avisa sem caminho', async () => {
  const { fake, ctx } = world();
  const r = await upAvd(AVD, buildAndroidProfile(), { ...ctx, runningDir: null });
  assert.equal(r.advertised, false);
  assert.equal(fake.sleeps.filter((ms) => ms === 500).length, 0);
  assert.match(stderr.join(''), /nao se anunciou em \(diretorio de anuncio desconhecido nesta plataforma\)/);
});

test('up com o AVD ja rodando: le o anuncio uma vez, sem aviso', async () => {
  announce({ serial: 5556, grpc: 8556 });
  const { ctx, env } = world({ emulators: [{ avd: AVD, port: 5556, pid: 777 }] });
  recordSession({ platform: 'android', avd: AVD, serial: 'emulator-5556', pid: 777, port: 5556, startedAt: 'x' }, env);
  const r = await upAvd(AVD, buildAndroidProfile(), ctx);
  assert.deepEqual([r.alreadyRunning, r.advertised, r.grpcPort], [true, true, 8556]);
  assert.equal(stderr.join(''), '');
  noLeak(r);
});
