import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { main } from '../src/cli.ts';
import { createFakeIos, type FakeIosOptions } from '../src/ios/fakeIos.ts';

// Ponta a ponta: roda bin/devslim num processo, com AVD fake em tmpdir.
const BIN = fileURLToPath(new URL('../bin/devslim', import.meta.url));
const PHONE = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

let root: string;
let avdHome: string;
let devslimHome: string;
let avdDir: string;
let configPath: string;

const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

// Mapa caminho relativo -> sha256 (ou "dir") de tudo sob `dir`.
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) {
        out[r] = 'dir';
        walk(abs, r);
      } else {
        out[r] = sha(readFileSync(abs));
      }
    }
  };
  walk(dir, '');
  return out;
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      ANDROID_AVD_HOME: avdHome,
      DEVSLIM_HOME: devslimHome,
      ...extraEnv,
    },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-cli-'));
  avdHome = join(root, 'avd');
  devslimHome = join(root, 'devslim-home');
  avdDir = join(avdHome, 'fake-api35.avd');
  configPath = join(avdDir, 'config.ini');
  mkdirSync(join(avdDir, 'snapshots', 'default_boot'), { recursive: true });
  writeFileSync(join(avdHome, 'fake-api35.ini'), `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/fake-api35.avd\ntarget=android-35\n`);
  writeFileSync(configPath, PHONE);
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.gpu.mode = auto\n');
  writeFileSync(join(avdDir, 'snapshots', 'default_boot', 'ram.bin'), 'ram');
  writeFileSync(join(avdDir, 'multiinstance.lock'), ''); // existe mesmo com o emulador desligado
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('--help e --version', () => {
  const h = run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /devslim android plan <avd>/);
  for (const c of ['create <nome>', 'up <avd>', 'bake <avd>', 'down \\[<avd>\\]', 'restore <avd> \\[--config-only\\]', 'measure <avd> \\[--json\\]']) {
    assert.match(h.stdout, new RegExp(`devslim android ${c}`), c);
  }
  const v = run(['--version']);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), pkg.version);
});

test('comando desconhecido: erro + help, exit 2', () => {
  const r = run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^devslim: comando desconhecido: frobnicate$/m);
  assert.match(r.stderr, /uso:/);
  assert.equal(run([]).code, 2);
  assert.equal(run(['android', 'explode', 'x']).code, 2);
  assert.equal(run(['android', 'plan']).code, 2);
  assert.equal(run(['android', 'plan', 'fake-api35', '--bogus']).code, 2);
});

test('plan nao escreve nada e mostra mudancas + linha do emulator', () => {
  const before = tree(root);
  const r = run(['android', 'plan', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(tree(root), before, 'nenhum arquivo criado, alterado ou removido');
  assert.ok(!existsSync(devslimHome));
  assert.match(r.stdout, /hw\.ramSize: 2G -> 2048/);
  assert.match(r.stdout, /hw\.gpu\.mode: auto -> host/);
  assert.match(
    r.stdout,
    /emulator -avd fake-api35 -gpu host -memory 2048 -cores 2 -grpc 8554 -grpc-use-token -no-window -no-audio -camera-back none -camera-front none -feature -Vulkan -no-boot-anim -no-metrics -no-snapshot \(gRPC 8554 de referencia; porta definida no up\)$/m,
  );
  assert.match(r.stdout, /tune apagaria: hardware-qemu\.ini, snapshots/);
  assert.doesNotMatch(r.stdout, /-netfast/);
});

test('plan --json com flags e --for', () => {
  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { 'expo-av': '*', 'expo-camera': '*' } }));
  const r = run(['android', 'plan', 'fake-api35', '--ram=3072', '--port', '5556', '--need', 'window', '--for', 'app', '--screen', '720x1600@320', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.avd, 'fake-api35');
  assert.deepEqual(out.profile.capabilities, ['audio', 'camera', 'window']);
  assert.equal(out.profile.ramMb, 3072);
  assert.deepEqual(out.emulatorArgs, [
    '-avd', 'fake-api35', '-gpu', 'host', '-memory', '3072', '-cores', '2', '-port', '5556',
    '-grpc', '8556', '-grpc-use-token',
    '-feature', '-Vulkan', '-no-boot-anim', '-no-metrics', '-no-snapshot',
  ]);
  assert.equal(out.profile.grpc, true);
  assert.ok(out.changes.some((c: { key: string; to: string }) => c.key === 'hw.lcd.width' && c.to === '720'));
  // A fixture ja tem audio yes e camera.back emulated: com audio+camera so camera.front muda.
  const keys = out.changes.map((c: { key: string }) => c.key);
  assert.ok(!keys.includes('hw.audioOutput') && !keys.includes('hw.audioInput'));
  assert.ok(out.changes.some((c: { key: string; from: string; to: string }) => c.key === 'hw.camera.front' && c.from === 'none' && c.to === 'emulated'));
});

test('plan --no-grpc: sem -grpc/-grpc-use-token, sem sufixo, perfil grpc off; com --port a linha nao leva sufixo', () => {
  const r = run(['android', 'plan', 'fake-api35', '--no-grpc']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /-grpc/);
  assert.doesNotMatch(r.stdout, /de referencia/);
  assert.match(r.stdout, /^perfil: .*vulkan off, grpc off, /m);
  const j = JSON.parse(run(['android', 'plan', 'fake-api35', '--no-grpc', '--json']).stdout);
  assert.equal(j.profile.grpc, false);
  assert.ok(!j.emulatorArgs.includes('-grpc'));
  const withPort = run(['android', 'plan', 'fake-api35', '--port', '5556']);
  assert.match(withPort.stdout, /-port 5556 -grpc 8556 -grpc-use-token .*-no-snapshot$/m);
  assert.match(withPort.stdout, /^perfil: .*grpc on, /m);
});

test('tune --no-grpc persiste grpc: false no state; plan seguinte herda; state antigo sem o campo = grpc on', () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--no-grpc']).code, 0);
  const st = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.equal(st.profile.grpc, false);
  const inherited = run(['android', 'plan', 'fake-api35']);
  assert.match(inherited.stdout, /perfil herdado do tune anterior/);
  assert.doesNotMatch(inherited.stdout, /-grpc/);
  // State gravado antes do campo existir.
  delete st.profile.grpc;
  writeFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), JSON.stringify(st));
  const old = run(['android', 'plan', 'fake-api35', '--json']);
  assert.equal(JSON.parse(old.stdout).profile.grpc, true);
  assert.ok(JSON.parse(old.stdout).emulatorArgs.includes('-grpc-use-token'));
});

test('--grpc religa sobre o grpc: false salvo; sem flag herda false; tune --grpc persiste true', () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--no-grpc']).code, 0);
  const statePath = join(devslimHome, 'state', 'android', 'fake-api35.json');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).profile.grpc, false);

  const kept = JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout);
  assert.equal(kept.profile.grpc, false, 'sem flag: herda o false salvo');
  assert.ok(!kept.emulatorArgs.includes('-grpc'));

  const on = run(['android', 'plan', 'fake-api35', '--grpc']);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /perfil herdado do tune anterior/);
  assert.match(on.stdout, /^perfil: .*grpc on, /m);
  assert.match(on.stdout, /-grpc 8554 -grpc-use-token/);

  assert.equal(run(['android', 'tune', 'fake-api35', '--grpc']).code, 0);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).profile.grpc, true, 'tune --grpc grava true');
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).profile.grpc, true);
});

test('--grpc com --no-grpc = erro de uso em plan, tune, up e bake; nada escrito', () => {
  const before = tree(avdDir);
  for (const sub of ['plan', 'tune', 'up', 'bake']) {
    const r = run(['android', sub, 'fake-api35', '--grpc', '--no-grpc']);
    assert.equal(r.code, 2, `${sub}: ${r.stderr}`);
    assert.equal(r.stderr.split('\n')[0], 'devslim: --grpc e --no-grpc nao combinam; use so um', sub);
  }
  assert.deepEqual(tree(avdDir), before);
  assert.ok(!existsSync(join(devslimHome, 'state')), 'tune recusado nao grava state');
});

test('cli up e bake aceitam --grpc: religa sobre o state salvo com grpc false', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--no-grpc']).code, 0);
  const a = inProcess();
  const up = await a.call(['android', 'up', 'fake-api35', '--grpc']);
  assert.equal(up.code, 0, up.stderr);
  assert.ok(a.fake.spawnCalls[0].args.includes('-grpc-use-token'));
  const b = inProcess();
  const bake = await b.call(['android', 'bake', 'fake-api35', '--grpc', '--force']);
  assert.equal(bake.code, 0, bake.stderr);
  assert.ok(b.fake.spawnCalls[0].args.includes('-grpc-use-token'));
  const c = inProcess();
  const plain = await c.call(['android', 'bake', 'fake-api35', '--force']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(!c.fake.spawnCalls[0].args.includes('-grpc'), 'sem flag: herda grpc false');
});

// ---------------------------------------------------------------------------
// --lowram / --no-lowram

const lowramState = () => JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8')).profile;

test('--lowram liga -lowram sem mexer na RAM; tune salva; plan herda; --no-lowram sobrepoe', () => {
  const p = run(['android', 'plan', 'fake-api35', '--lowram']);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^perfil: ram 2048 MB \(lowram\), /m);
  assert.match(p.stdout, /emulator -avd fake-api35 -gpu host -memory 2048 .* -lowram -no-boot-anim/);
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--lowram', '--json']).stdout).profile.lowRam, true);

  assert.equal(run(['android', 'tune', 'fake-api35', '--lowram']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [2048, true]);
  assert.match(readFileSync(configPath, 'utf8'), /^hw\.ramSize=2048$/m);

  const inherited = run(['android', 'plan', 'fake-api35']);
  assert.match(inherited.stdout, /^perfil herdado do tune anterior$/m);
  assert.match(inherited.stdout, / -lowram /, 'sem flag herda o lowram salvo');
  const off = run(['android', 'plan', 'fake-api35', '--no-lowram']);
  assert.doesNotMatch(off.stdout, /^ {2}emulator .* -lowram /m);
  assert.match(off.stdout, /-memory 2048 /);

  // --ram depois de --lowram mantem o lowram herdado
  assert.equal(run(['android', 'tune', 'fake-api35', '--ram', '3072']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [3072, true]);
  assert.equal(run(['android', 'tune', 'fake-api35', '--no-lowram']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [3072, false]);
});

test('--aggressive continua 1536 + lowram; --no-lowram junto tira so o lowram', () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--aggressive']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [1536, true]);
  assert.equal(run(['android', 'tune', 'fake-api35', '--aggressive', '--no-lowram']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [1536, false]);
  assert.equal(run(['android', 'tune', 'fake-api35', '--aggressive']).code, 0, '--aggressive religa o lowram sobre o salvo');
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [1536, true]);
});

test('--lowram com --no-lowram = erro de uso em plan, tune, up e bake; nada escrito', () => {
  const before = tree(avdDir);
  for (const sub of ['plan', 'tune', 'up', 'bake']) {
    const r = run(['android', sub, 'fake-api35', '--lowram', '--no-lowram']);
    assert.equal(r.code, 2, `${sub}: ${r.stderr}`);
    assert.equal(r.stderr.split('\n')[0], 'devslim: --lowram e --no-lowram nao combinam; use so um', sub);
  }
  assert.deepEqual(tree(avdDir), before);
  assert.ok(!existsSync(join(devslimHome, 'state')));
});

test('cli up e bake aceitam --lowram/--no-lowram; bake --aggressive segue sendo so a lista de bloat', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const a = inProcess();
  const up = await a.call(['android', 'up', 'fake-api35', '--lowram']);
  assert.equal(up.code, 0, up.stderr);
  assert.ok(a.fake.spawnCalls[0].args.includes('-lowram'));
  assert.equal(a.fake.spawnCalls[0].args[a.fake.spawnCalls[0].args.indexOf('-memory') + 1], '2048');

  const b = inProcess();
  const bake = await b.call(['android', 'bake', 'fake-api35', '--aggressive', '--lowram', '--force']);
  assert.equal(bake.code, 0, bake.stderr);
  assert.match(bake.stdout, /\(nivel aggressive\)/);
  assert.match(bake.stdout, /-memory 2048 .*-lowram/);

  assert.equal(run(['android', 'tune', 'fake-api35', '--lowram']).code, 0);
  const c = inProcess();
  const plain = await c.call(['android', 'bake', 'fake-api35', '--no-lowram', '--force']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(!c.fake.spawnCalls[0].args.includes('-lowram'), '--no-lowram sobrepoe o salvo');
  const d = inProcess();
  await d.call(['android', 'bake', 'fake-api35', '--aggressive', '--force']);
  assert.ok(d.fake.spawnCalls[0].args.includes('-lowram'), 'sem flag herda o lowram salvo');
});

// Nota do plan/tune: RAM abaixo de 2560 sem lowram deve ser elevada pelo emulador.
const NOTE_RE = /^nota: /m;

test('plan/tune: nota de piso so abaixo de 2560 MB sem lowram', () => {
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^nota: o emulador deve elevar a RAM pedida de 2048 MB \(pisos observados: 2560 MB em phone, 4096 MB em tablet 2560x1600\); --lowram faz o pedido valer/m);
  assert.equal(p.stdout.match(/^nota: .*$/gm)?.length, 1, 'uma linha so');
  assert.match(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).ramNote, /2048 MB/);
  assert.match(run(['android', 'plan', 'fake-api35', '--aggressive', '--no-lowram']).stdout, /^nota: .*1536 MB/m);

  for (const flags of [['--lowram'], ['--aggressive'], ['--ram', '2560'], ['--ram', '4096']]) {
    const r = run(['android', 'plan', 'fake-api35', ...flags]);
    assert.doesNotMatch(r.stdout, NOTE_RE, flags.join(' '));
    assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', ...flags, '--json']).stdout).ramNote, null, flags.join(' '));
  }
  const t = run(['android', 'tune', 'fake-api35']);
  assert.match(t.stdout, NOTE_RE);
  assert.doesNotMatch(run(['android', 'tune', 'fake-api35', '--lowram']).stdout, NOTE_RE);
});

test('plan/tune: nota usa a RAM efetiva do ultimo boot (hardware-qemu.ini) quando ha', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\nhw.gpu.mode = host\n');
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^nota: no ultimo boot deste AVD o emulador elevou 2048 MB para 4096 MB; o pedido de 2048 MB deve subir de novo; --lowram faz o pedido valer/m);
  assert.doesNotMatch(p.stdout, /pisos observados/);
  const t = run(['android', 'tune', 'fake-api35', '--json']);
  assert.match(JSON.parse(t.stdout).ramNote, /elevou 2048 MB para 4096 MB/);

  // ultimo boot sem elevacao (efetiva = pedida): cai na nota generica
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 2048\n');
  assert.match(run(['android', 'plan', 'fake-api35']).stdout, /^nota: .*pisos observados/m);
});

test('plan: nota compara a efetiva com o -memory do ultimo up (lastLaunch), nao com o perfil', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0); // perfil 2048
  const statePath = join(devslimHome, 'state', 'android', 'fake-api35.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  // up --ram 4096 sem tune: efetiva 4096 nao e elevacao; a nota volta a ser a generica.
  writeFileSync(statePath, JSON.stringify({ ...st, lastLaunch: { ramMb: 4096, lowRam: false, at: '2026-11-17T09:00:00.000Z' } }));
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\n');
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^nota: o emulador deve elevar a RAM pedida de 2048 MB \(pisos observados/m);
  assert.doesNotMatch(p.stdout, /no ultimo boot deste AVD/);
  // ultimo up pediu 2048 e virou 2560: nota cita a elevacao real.
  writeFileSync(statePath, JSON.stringify({ ...st, lastLaunch: { ramMb: 2048, lowRam: false, at: '2026-11-17T09:00:00.000Z' } }));
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 2560\n');
  assert.match(run(['android', 'plan', 'fake-api35']).stdout, /^nota: no ultimo boot deste AVD o emulador elevou 2048 MB para 2560 MB/m);
});

test('help lista --lowram e --no-lowram', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /^ {2}--lowram {5,}/m);
  assert.match(h, /^ {2}--no-lowram {2,}/m);
  assert.match(h, /--aggressive +RAM 1536 \+ -lowram/);
});

test('help: --need lista keyboard; bake --aggressive cita o Gboard', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /--need a,b +capacidades: audio, camera, keyboard, location, push, store, weblogin, window;/);
  assert.match(h, /keyboard mantem o Gboard no bake --aggressive/);
  assert.match(h, /--aggressive +bake: desliga tambem a lista aggressive \(Play Store, assistentes de setup, Gboard\)/);
});

test('cli bake --aggressive: Gboard desligado; --need keyboard mantem', async () => {
  const GBOARD = 'com.google.android.inputmethod.latin';
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const a = inProcess({ spawned: { installed: [GBOARD, 'com.android.vending'] } });
  assert.equal((await a.call(['android', 'bake', 'fake-api35', '--aggressive'])).code, 0);
  const st = () => JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.deepEqual(st().disabledPackages, ['com.android.vending', GBOARD]);
  const b = inProcess({ spawned: { installed: [GBOARD, 'com.android.vending'] } });
  assert.equal((await b.call(['android', 'bake', 'fake-api35', '--aggressive', '--need', 'keyboard', '--force'])).code, 0);
  assert.deepEqual(st().disabledPackages, ['com.android.vending']);
  assert.deepEqual(st().profile.capabilities, [], 'bake nao grava capacidades no perfil do tune');
});

test('help lista --grpc', () => {
  const r = run(['--help']);
  assert.match(r.stdout, /^ {2}--grpc {7,}/m);
  assert.match(r.stdout, /\[--no-grpc\|--grpc\]|--grpc\]/);
});

test('erro de usuario: uma linha em stderr, sem stack, exit != 0', () => {
  for (const args of [
    ['android', 'plan', 'fake-api35', '--ram', '1024'],
    ['android', 'plan', 'nao-existe'],
    ['android', 'plan', 'fake-api35', '--need', 'bluetooth'],
    ['android', 'restore', 'fake-api35'],
  ]) {
    const r = run(args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.equal(r.stderr.trimEnd().split('\n').length, 1, `uma linha: ${r.stderr}`);
    assert.match(r.stderr, /^devslim: /);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test('tune altera config.ini, salva state e remove hardware-qemu.ini e snapshots/', () => {
  const r = run(['android', 'tune', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  const after = readFileSync(configPath, 'utf8');
  assert.match(after, /^hw\.ramSize=2048$/m);
  assert.match(after, /^hw\.gpu\.mode=host$/m);
  assert.match(after, /^custom\.vendor\.flag=abc=def$/m, 'chave desconhecida intacta');
  assert.ok(!existsSync(join(avdDir, 'hardware-qemu.ini')));
  assert.ok(!existsSync(join(avdDir, 'snapshots')));
  assert.ok(existsSync(join(avdDir, 'multiinstance.lock')), 'nao mexe no que nao e dele');
  assert.match(r.stdout, /removido: hardware-qemu\.ini, snapshots/);

  const state = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.equal(state.originalConfigIni, PHONE.toString('utf8'));
  assert.equal(state.originalConfigSha256, sha(PHONE));
  assert.equal(state.profile.ramMb, 2048);
  assert.deepEqual(state.disabledPackages, []);
});

test('re-tune: mesmo perfil nao escreve nem remove; perfil novo mantem o primeiro backup', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  const tuned = readFileSync(configPath);

  const same = run(['android', 'tune', 'fake-api35']);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /nada escrito/);
  assert.ok(readFileSync(configPath).equals(tuned));
  assert.ok(existsSync(join(avdDir, 'snapshots', 'slim_base')), 'sem mudanca, snapshot fica');

  const agg = run(['android', 'tune', 'fake-api35', '--aggressive']);
  assert.equal(agg.code, 0, agg.stderr);
  assert.match(agg.stdout, /backup do primeiro tune mantido/);
  assert.match(readFileSync(configPath, 'utf8'), /^hw\.ramSize=1536$/m);
  const state = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.equal(state.originalConfigSha256, sha(PHONE), 'original continua o de antes do primeiro tune');
});

test('tune/plan herdam o perfil salvo: flags sobrepoem, --need substitui, none limpa, --reset volta ao padrao', () => {
  const statePath = join(devslimHome, 'state', 'android', 'fake-api35.json');
  const st = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const cfg = () => readFileSync(configPath, 'utf8');
  assert.equal(run(['android', 'tune', 'fake-api35', '--need', 'location', '--ram', '3072']).code, 0);
  assert.match(cfg(), /^hw\.gps=yes$/m);

  // plan sem state nao herda; com state mostra a linha e parte do perfil salvo.
  const p = run(['android', 'plan', 'fake-api35', '--screen', '720x1600@320']);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^perfil herdado do tune anterior$/m);
  assert.match(p.stdout, /emulator -avd fake-api35 -gpu host -memory 3072 /);
  const pj = JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout);
  assert.equal(pj.inheritedProfile, true);

  const t = run(['android', 'tune', 'fake-api35', '--screen', '720x1600@320', '--json']);
  assert.equal(t.code, 0, t.stderr);
  const tj = JSON.parse(t.stdout);
  assert.deepEqual(tj.changes.map((c: { key: string }) => c.key), ['hw.lcd.width', 'hw.lcd.height', 'hw.lcd.density'], 'muda so hw.lcd.*');
  assert.equal(tj.inheritedProfile, true);
  assert.match(cfg(), /^hw\.ramSize=3072$/m);
  assert.match(cfg(), /^hw\.gps=yes$/m);
  assert.equal(st().profile.ramMb, 3072);
  assert.deepEqual(st().profile.capabilities, ['location']);
  assert.deepEqual(st().profile.screen, { width: 720, height: 1600, density: 320 });

  // --need substitui (nao une)
  assert.equal(run(['android', 'tune', 'fake-api35', '--need', 'camera']).code, 0);
  assert.deepEqual(st().profile.capabilities, ['camera']);
  assert.match(cfg(), /^hw\.gps=no$/m);
  assert.match(cfg(), /^hw\.camera\.back=emulated$/m);
  assert.equal(st().profile.ramMb, 3072, 'RAM continua a herdada');

  // --need none limpa; combinado com outra capacidade e erro de uso
  assert.equal(run(['android', 'tune', 'fake-api35', '--need', 'none']).code, 0);
  assert.deepEqual(st().profile.capabilities, []);
  assert.match(cfg(), /^hw\.camera\.back=none$/m);
  const bad = run(['android', 'plan', 'fake-api35', '--need', 'none,camera']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^devslim: --need none nao combina com outras capacidades$/m);

  // --reset: padrao, sem a linha de heranca
  const rp = run(['android', 'plan', 'fake-api35', '--reset']);
  assert.doesNotMatch(rp.stdout, /perfil herdado/);
  assert.match(rp.stdout, /hw\.ramSize: 3072 -> 2048/);
  assert.equal(run(['android', 'tune', 'fake-api35', '--reset']).code, 0);
  assert.equal(st().profile.ramMb, 2048);
  assert.equal(st().profile.screen, 'keep');
  assert.deepEqual(st().profile.capabilities, []);

  // backup original continua o de antes do primeiro tune
  assert.equal(st().originalConfigSha256, sha(PHONE));
  assert.equal(st().originalConfigIni, PHONE.toString('utf8'));
});

test('up e bake nao aceitam --reset; help documenta heranca, --need none e --reset', () => {
  assert.equal(run(['android', 'up', 'fake-api35', '--reset']).code, 2);
  const h = run(['--help']).stdout;
  assert.match(h, /--need a,b +capacidades: [^\n]*\n +substitui as do tune; --need none limpa/);
  assert.match(h, /--reset +plan\/tune: ignora o perfil salvo e parte do padrao/);
  assert.match(h, /flags de plan\/tune\/up \(herdam o perfil do tune; flags sobrepoem\)/);
});

test('plan sem state: sem linha de heranca', () => {
  const p = run(['android', 'plan', 'fake-api35']);
  assert.doesNotMatch(p.stdout, /perfil herdado/);
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).inheritedProfile, false);
});

test('restore devolve bytes identicos (hash) e limpa o state', () => {
  const original = sha(readFileSync(configPath));
  assert.equal(run(['android', 'tune', 'fake-api35', '--screen', '720x1600@320']).code, 0);
  assert.equal(run(['android', 'tune', 'fake-api35', '--aggressive', '--need', 'audio']).code, 0);
  assert.notEqual(sha(readFileSync(configPath)), original);

  const r = run(['android', 'restore', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sha(readFileSync(configPath)), original);
  assert.ok(!existsSync(join(devslimHome, 'state', 'android', 'fake-api35.json')));

  const again = run(['android', 'restore', 'fake-api35']);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /sem state/);
});

test('restore preserva tablet sem newline final byte a byte', () => {
  const tablet = readFileSync(new URL('./fixtures/tablet.config.ini', import.meta.url));
  writeFileSync(configPath, tablet);
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  assert.equal(run(['android', 'restore', 'fake-api35']).code, 0);
  assert.ok(readFileSync(configPath).equals(tablet));
});

test('tune recusa com lock presente e nao toca em nada', () => {
  mkdirSync(join(avdDir, 'hardware-qemu.ini.lock'));
  writeFileSync(join(avdDir, 'hardware-qemu.ini.lock', 'pid'), '4242');
  const before = tree(root);
  const r = run(['android', 'tune', 'fake-api35']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /parece estar rodando .*hardware-qemu\.ini\.lock/);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1);
  assert.deepEqual(tree(root), before);

  const plan = run(['android', 'plan', 'fake-api35']);
  assert.equal(plan.code, 0);
  assert.match(plan.stdout, /aviso: AVD parece estar rodando/);
});

test('restore recusa com lock presente e mantem o state', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  mkdirSync(join(avdDir, 'userdata-qemu.img.lock'));
  const r = run(['android', 'restore', 'fake-api35']);
  assert.equal(r.code, 1);
  assert.ok(existsSync(join(devslimHome, 'state', 'android', 'fake-api35.json')));
});

// ---------------------------------------------------------------------------
// Runtime ponta a ponta: main() no processo, com exec/spawn/sleep falsos.

function inProcess(opts: FakeAndroidOptions = {}) {
  const fake = createFakeAndroid({ avdHome, avdDir: (name) => join(avdHome, `${name}.avd`), ...opts });
  const env = { PATH: process.env.PATH ?? '', HOME: root, ANDROID_HOME: fake.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: devslimHome };
  const call = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      env,
      cwd: root,
      runtime: {
        exec: fake.exec,
        spawnDetached: fake.spawnDetached,
        sleep: fake.sleep,
        now: fake.now,
        date: fake.date,
        fileExists: fake.fileExists,
        dirExists: fake.dirExists,
        arch: fake.arch,
        pidAlive: () => true,
      },
    });
    return { code, stdout, stderr };
  };
  return { fake, call };
}

const GUEST = {
  meminfo: 'MemTotal:        2014388 kB\nMemAvailable:    1061523 kB\n',
  ps: 'USER PID PPID VSZ RSS WCHAN ADDR S NAME\nroot 1 0 1 1 0 0 S init\n',
  dumpsys: ' Free RAM: 1,061,523K (x)\n Used RAM:   871,869K (y)\n',
};

test('cli up: herda o perfil do tune, sobe, imprime serial; --json; segundo up = ja rodando', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--ram', '3072']).code, 0);
  const { fake, call } = inProcess();
  const r = await call(['android', 'up', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AVD fake-api35 pronto em emulator-5554 \(pid \d+, cold boot sem snapshot/);
  assert.match(r.stdout, /emulator -avd fake-api35 -gpu host -memory 3072 -cores 2 -port 5554 .*-no-snapshot$/m);
  assert.match(r.stdout, /^dica: subiu sem snapshot slim_base; rode uma vez devslim android bake fake-api35 /m);
  assert.equal(r.stdout.trimEnd().split('\n').at(-1)!.startsWith('dica: '), true, 'dica e a ultima linha');
  assert.equal(fake.spawnCalls.length, 1);

  const again = await call(['android', 'up', 'fake-api35', '--json']);
  assert.equal(again.code, 0, again.stderr);
  const j = JSON.parse(again.stdout);
  assert.equal(j.alreadyRunning, true);
  assert.equal(j.serial, 'emulator-5554');
  assert.ok(!('hint' in j), 'ja rodando: sem hint');
  assert.ok('ramEffectiveMb' in j);
  assert.equal(j.launcher, 'devslim', 'sessao registra o AVD');
  assert.ok('gpuEffective' in j);
  assert.equal(again.stderr, '', 'nosso e sem GPU por software: sem aviso');
  assert.equal(fake.spawnCalls.length, 1, 'nao sobe segundo');
});

test('cli up: emulador sem anuncio = aviso em stderr e exit 0; anunciado = sem aviso e advertised no JSON; --no-grpc nao avisa', async () => {
  const runningDir = join(root, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running'); // HOME=root no env
  const quiet = inProcess();
  const r = await quiet.call(['android', 'up', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^devslim: aviso: emulador nao se anunciou em ${runningDir.replace(/[.]/g, '\\.')}: .*adb funciona normalmente$`, 'm'));

  const off = inProcess();
  const n = await off.call(['android', 'up', 'fake-api35', '--no-grpc', '--force']);
  assert.equal(n.code, 0, n.stderr);
  assert.doesNotMatch(n.stderr, /nao se anunciou/);
  assert.doesNotMatch(n.stdout, /-grpc/);

  mkdirSync(runningDir, { recursive: true });
  writeFileSync(join(runningDir, 'pid_61000.ini'), readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8').replace('avd.name=bench-api35', 'avd.name=fake-api35'));
  const loud = inProcess();
  const j = await loud.call(['android', 'up', 'fake-api35', '--json']);
  assert.equal(j.code, 0, j.stderr);
  assert.doesNotMatch(j.stderr, /nao se anunciou/);
  const out = JSON.parse(j.stdout);
  assert.deepEqual([out.advertised, out.grpcPort], [true, 8554]);
  assert.ok(!(j.stdout + j.stderr).includes('abc123'), 'token nunca sai');
});

test('cli bake --no-grpc: linha sem -grpc; bake padrao leva -grpc 8554 -grpc-use-token', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const a = inProcess();
  const off = await a.call(['android', 'bake', 'fake-api35', '--no-grpc']);
  assert.equal(off.code, 0, off.stderr);
  assert.ok(!a.fake.spawnCalls[0].args.includes('-grpc'));
  const b = inProcess();
  const on = await b.call(['android', 'bake', 'fake-api35', '--force']);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /^comando: emulator .*-port 5554 -grpc 8554 -grpc-use-token /m);
});

test('cli up: guarda recusa em uma linha, exit 1; --force passa', async () => {
  const { call } = inProcess({ emulators: [{ avd: 'outro', port: 5554 }] });
  const r = await call(['android', 'up', 'fake-api35']);
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1);
  assert.match(r.stderr, /^devslim: up recusado: ja ha device rodando: emulador emulator-5554/);
  const f = await call(['android', 'up', 'fake-api35', '--force', '--port', '5560']);
  assert.equal(f.code, 0, f.stderr);
  assert.match(f.stdout, /pronto em emulator-5560/);
});

test('cli bake: sem tune da erro; com tune enxuga, grava slim_base e desliga; up seguinte usa o snapshot', async () => {
  const { fake, call } = inProcess({ spawned: { installed: ['com.google.android.youtube', 'com.android.vending', 'com.android.chrome'] } });
  const noTune = await call(['android', 'bake', 'fake-api35']);
  assert.equal(noTune.code, 1);
  assert.match(noTune.stderr, /rode antes: devslim android tune fake-api35/);

  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const r = await call(['android', 'bake', 'fake-api35', '--aggressive']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /bake de fake-api35 em emulator-5554 \(nivel aggressive\)/);
  assert.match(r.stdout, /-memory 2048 /, '--aggressive no bake nao mexe na RAM do tune');
  assert.match(r.stdout, /pacotes: 2 desligado\(s\) agora/);
  assert.match(r.stdout, /snapshot slim_base gravado; emulador desligado/);
  assert.match(r.stdout, /tempos: boot .* total /);
  assert.equal(fake.emulators.size, 0);
  const state = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.deepEqual(state.disabledPackages, ['com.google.android.youtube', 'com.android.vending']);
  assert.ok(existsSync(join(avdDir, 'snapshots', 'slim_base')));

  const up = await call(['android', 'up', 'fake-api35']);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /snapshot slim_base/);
  assert.match(up.stdout, /-snapshot slim_base -no-snapshot-save$/m);
  assert.doesNotMatch(up.stdout, /dica:|bake/, 'partiu do snapshot: sem dica');
});

test('cli up --json sem slim_base traz hint e ramEffectiveMb', async () => {
  const { call } = inProcess();
  const r = await call(['android', 'up', 'fake-api35', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.fromSnapshot, false);
  assert.match(j.hint, /^dica: .*devslim android bake fake-api35/);
  assert.equal(j.ramEffectiveMb, null, 'fake nao escreve hardware-qemu.ini nem log');
});

test('cli down: so o registrado; --json', async () => {
  const { fake, call } = inProcess({ emulators: [{ avd: 'do-dono', port: 5556 }] });
  assert.equal((await call(['android', 'up', 'fake-api35', '--force'])).code, 0);
  assert.equal(fake.emulators.size, 2);
  const r = await call(['android', 'down', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((x: { avd: string; result: string }) => [x.avd, x.result]), [['fake-api35', 'killed']]);
  assert.deepEqual([...fake.emulators.values()].map((e) => e.avd), ['do-dono']);
  const empty = await call(['android', 'down']);
  assert.equal(empty.stdout, 'nada a desligar (sessao vazia)\n');
  const refused = await call(['android', 'down', 'do-dono']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--force/);
});

test('cli measure --json: objeto estavel', async () => {
  const { call } = inProcess({
    emulators: [{ avd: 'fake-api35', port: 5554 }],
    host: { pgrep: '51234\n', footprint: '    phys_footprint: 2.6 GB\n', rss: '2754560\n' },
    guest: GUEST,
  });
  const r = await call(['android', 'measure', 'fake-api35', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(m), ['platform', 'avd', 'serial', 'pid', 'host', 'guest', 'at']);
  assert.deepEqual(Object.keys(m.host), ['footprintMb', 'footprintHeaderMb', 'rssMb']);
  assert.deepEqual(Object.keys(m.guest), ['memTotalMb', 'memAvailableMb', 'processes', 'usedRamMb', 'freeRamMb']);
  assert.deepEqual(m, {
    platform: 'android',
    avd: 'fake-api35',
    serial: 'emulator-5554',
    pid: 51234,
    host: { footprintMb: 2662.4, footprintHeaderMb: null, rssMb: 2690 },
    guest: { memTotalMb: 1967.2, memAvailableMb: 1036.6, processes: 1, usedRamMb: 851.4, freeRamMb: 1036.6 },
    at: '2026-11-16T12:00:00.000Z',
  });
  const text = await call(['android', 'measure', 'fake-api35']);
  assert.match(text.stdout, /host: phys_footprint 2662\.4 MB, footprint \(cabecalho\) n\/d, rss 2690 MB/);
});

test('cli measure texto com a saida real do footprint: os tres valores', async () => {
  const { call } = inProcess({
    emulators: [{ avd: 'fake-api35', port: 5554 }],
    host: {
      pgrep: '73808\n',
      footprint: 'qemu-system-aarch64-headless [73808]: 64-bit    Footprint: 3000 MB (16384 bytes per page)\n\nAuxiliary data:\n    phys_footprint: 5582 MB\n',
      rss: '4137840\n',
    },
    guest: GUEST,
  });
  const text = await call(['android', 'measure', 'fake-api35']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^host: phys_footprint 5582 MB, footprint \(cabecalho\) 3000 MB, rss 4040\.9 MB$/m);
});

test('cli restore: pendencia com AVD desligado = uma linha de erro; --config-only avisa e mantem state', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const statePath = join(devslimHome, 'state', 'android', 'fake-api35.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.disabledPackages = ['com.google.android.youtube'];
  writeFileSync(statePath, JSON.stringify(state));
  const { call } = inProcess();
  const r = await call(['android', 'restore', 'fake-api35']);
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1);
  assert.match(r.stderr, /--config-only/);
  const c = await call(['android', 'restore', 'fake-api35', '--config-only']);
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stderr, /aviso: --config-only/);
  assert.match(c.stdout, /state mantido/);
  assert.ok(readFileSync(configPath).equals(PHONE));
  assert.ok(existsSync(statePath));
});

test('cli create: recusa existente; cria com tela 720x1600@320', async () => {
  const { fake, call } = inProcess();
  const dup = await call(['android', 'create', 'fake-api35']);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /ja existe/);
  const r = await call(['android', 'create', 'novo-api35', '--device', 'pixel_6']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AVD novo-api35 criado \(system-images;android-35;google_apis;arm64-v8a, pixel_6\); nao bootado/);
  assert.match(readFileSync(join(avdHome, 'novo-api35.avd', 'config.ini'), 'utf8'), /^hw\.lcd\.width=720$/m);
  assert.equal(fake.exec.calls[0].opts.input, 'no\n');
});

test('cli create --image atalho e --api; imagem ausente = sdkmanager na mensagem; --api com id completo = uso', async () => {
  const { call } = inProcess({ systemImages: ['system-images;android-34;aosp_atd;arm64-v8a'] });
  const r = await call(['android', 'create', 'atd-api34', '--image', 'aosp_atd', '--api', '34', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).image, 'system-images;android-34;aosp_atd;arm64-v8a');

  const miss = await call(['android', 'create', 'gatd', '--image', 'google_atd']);
  assert.equal(miss.code, 1);
  assert.equal(miss.stderr.trimEnd().split('\n').length, 1);
  assert.match(miss.stderr, /sdkmanager "system-images;android-35;google_atd;arm64-v8a"/);

  const bad = await call(['android', 'create', 'x', '--image', 'system-images;android-34;aosp_atd;arm64-v8a', '--api', '34']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^devslim: --api so vale com atalho de imagem/m);
  assert.equal((await call(['android', 'create', 'x', '--image', 'aosp_atd', '--api', 'abc'])).code, 2);
  const unknown = await call(['android', 'create', 'x', '--image', 'playstore']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /imagem desconhecida: playstore/);
});

test('help: create lista --api, os atalhos de imagem e o trade-off dos ATD', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /devslim android create <nome> \[--image I\] \[--api N\] \[--device D\]/);
  assert.match(h, /^ {2}--api N {6,}/m);
  assert.match(h, /google_apis, google_atd, aosp_atd, default/);
  assert.match(h, /aosp_atd: sem login Google, push FCM nem compra Play Billing/);
});

// ---------------------------------------------------------------------------
// iOS ponta a ponta: main() no processo com simulador e store falsos (tmpdir).

const SIM = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';

function iosInProcess(opts: Partial<FakeIosOptions> = {}) {
  const storeBase = join(root, 'var-tmp');
  mkdirSync(storeBase, { recursive: true });
  const fake = createFakeIos({ storeBase, simulators: [{ udid: SIM, name: 'QA-iPhone17' }], ...opts });
  const env = { PATH: process.env.PATH ?? '', HOME: root, DEVSLIM_HOME: devslimHome };
  const call = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await main(args, {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      env,
      cwd: root,
      runtime: { exec: fake.exec, sleep: fake.sleep, now: fake.now, date: fake.date, fileExists: fake.fileExists, storeBase },
    });
    return { code, stdout, stderr };
  };
  return { fake, call, storeBase };
}

test('cli ios: --help lista os subcomandos; erros de uso exit 2', async () => {
  const h = run(['--help']);
  for (const c of ['plan <udid\\|nome>', 'up <udid\\|nome>', 'off <udid\\|nome>', 'down \\[<udid\\|nome>\\]', 'measure <udid\\|nome>', 'categories']) {
    assert.match(h.stdout, new RegExp(`devslim ios ${c}`), c);
  }
  assert.match(h.stdout, /quebra push, StoreKit, universal links e login Apple ID/);
  const { call } = iosInProcess();
  assert.equal((await call(['ios'])).code, 2);
  assert.equal((await call(['ios', 'plan'])).code, 2);
  assert.equal((await call(['ios', 'up', 'x', '--bogus'])).code, 2);
  const alias = await call(['ios', 'plan', 'booted']);
  assert.equal(alias.code, 1);
  assert.match(alias.stderr, /^devslim: "booted" e alias do simctl/);
});

test('cli ios categories: texto e --json', async () => {
  const { call, fake } = iosInProcess();
  const t = await call(['ios', 'categories']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^siri\s+28 labels  quebra: Siri/m);
  assert.match(t.stdout, /total gerido: 173 labels unicos/);
  const j = JSON.parse((await call(['ios', 'categories', '--json'])).stdout);
  assert.equal(j.managedTotal, 173);
  assert.equal(j.categories.length, 16);
  assert.deepEqual(j.capabilities.push, { categories: [], labels: ['com.apple.apsd'] });
  assert.equal(fake.calls.length, 0, 'categories nao chama nada');
});

test('cli ios plan --json: so leitura, objeto com labels e runtime', async () => {
  const { call, fake, storeBase } = iosInProcess();
  const r = await call(['ios', 'plan', 'QA-iPhone17', '--need', 'push', '--except', 'widgets,siri', '--keep', 'com.apple.triald', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.udid, SIM);
  assert.equal(j.runtime.version, '26.4');
  assert.deepEqual(j.profile, { capabilities: ['push'], except: ['widgets', 'siri'], keep: ['com.apple.triald'], labels: 173 - 1 - 4 - 28 - 1 });
  assert.equal(j.labels.length, j.profile.labels);
  assert.equal(j.storeExists, false);
  assert.deepEqual(readdirSync(storeBase), []);
  assert.ok(!existsSync(devslimHome));
  assert.deepEqual(fake.simctlCommands(), ['list devices -j', 'list runtimes -j']);
});

test('cli ios up, measure --json, off, down', async () => {
  const { call, fake } = iosInProcess({
    measure: {
      pgrep: '700\n',
      ps: '  PID  PPID  %CPU COMM\n  700     1   1.0 launchd_sim\n  701   700   2.0 SpringBoard\n',
      top: 'PID    MEM\n700    10M\n701    90M+\n',
    },
  });
  const up = await call(['ios', 'up', 'QA-iPhone17']);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /QA-iPhone17 \(DBF8B093-58A2-4B57-812A-60D6CF8594BD\) iOS 26\.4: 173 labels no perfil, 173 entrada\(s\) do store mudaram/);
  assert.match(up.stdout, /^state: .*state\/ios\/DBF8B093-58A2-4B57-812A-60D6CF8594BD\.json$/m);

  const m = await call(['ios', 'measure', SIM, '--json']);
  assert.equal(m.code, 0, m.stderr);
  assert.deepEqual(JSON.parse(m.stdout), {
    platform: 'ios', udid: SIM, name: 'QA-iPhone17', processes: 2, footprintMb: 100, cpuPercent: 3, at: '2026-11-16T12:00:00.000Z',
  });

  const again = await call(['ios', 'up', 'QA-iPhone17', '--json']);
  assert.equal(JSON.parse(again.stdout).alreadySlim, true);

  const off = await call(['ios', 'off', 'QA-iPhone17']);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /173 label\(s\) devolvido\(s\) ao valor salvo; state removido/);
  assert.match(off.stdout, /simulador rebootado/);
  const offAgain = await call(['ios', 'off', 'QA-iPhone17']);
  assert.equal(offAgain.code, 1);
  assert.match(offAgain.stderr, /^devslim: sem state para QA-iPhone17/);

  const down = await call(['ios', 'down']);
  assert.equal(down.code, 0, down.stderr);
  assert.match(down.stdout, /QA-iPhone17 DBF8B093-58A2-4B57-812A-60D6CF8594BD: shutdown/);
  assert.equal(fake.sims.get(SIM)!.state, 'Shutdown');
});

test('cli ios plan/up: reparo dos sempre ligados aparece no texto e no --json', async () => {
  const { call, storeBase } = iosInProcess();
  const p = join(storeBase, `com.apple.CoreSimulator.SimDevice.${SIM}`, 'disabled.plist');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>com.apple.assistantd</key>\n\t<true/>\n\t<key>com.apple.gamed</key>\n\t<true/>\n</dict>\n</plist>\n');
  const j = await call(['ios', 'plan', 'QA-iPhone17', '--json']);
  assert.equal(j.code, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout).repair, ['com.apple.assistantd', 'com.apple.gamed']);
  const t = await call(['ios', 'plan', 'QA-iPhone17']);
  assert.match(t.stdout, /^reparo \(sempre ligados que o store traz desligados\): com\.apple\.assistantd,com\.apple\.gamed$/m);
  const up = await call(['ios', 'up', 'QA-iPhone17']);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /^reparados \(sempre ligados que estavam desligados no store\): com\.apple\.assistantd, com\.apple\.gamed$/m);
});

test('--help lista os comandos de topo', () => {
  const h = run(['--help']);
  for (const c of ['status \\[--json\\]', 'doctor \\[--json\\]', 'down \\[--force\\] \\[--json\\]', 'measure \\[--json\\]']) {
    assert.match(h.stdout, new RegExp(`devslim ${c}`), c);
  }
});

test('cli ios up: label que nao pega = exit 3 com a lista', async () => {
  const { call } = iosInProcess({ stubborn: ['com.apple.triald'] });
  const r = await call(['ios', 'up', SIM]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /NAO desligados \(1\): com\.apple\.triald/);
  assert.match(r.stdout, /launchctl em 1 passada\(s\) e reboot/);
});

test('plan e tune informam o tamanho de snapshots/ na linha apagaria/removido; JSON com snapshotsMb', () => {
  writeFileSync(join(avdDir, 'snapshots', 'default_boot', 'ram.bin'), Buffer.alloc(3 * 1024 * 1024 - 3));
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'));
  writeFileSync(join(avdDir, 'snapshots', 'slim_base', 'ram.bin'), Buffer.alloc(3)); // total exato: 3 MiB
  const p = run(['android', 'plan', 'fake-api35']);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^tune apagaria: hardware-qemu\.ini, snapshots \(3 MB\)$/m);
  const j = JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout);
  assert.deepEqual(j.wouldRemove, ['hardware-qemu.ini', 'snapshots']);
  assert.equal(j.snapshotsMb, 3);

  const t = run(['android', 'tune', 'fake-api35']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^removido: hardware-qemu\.ini, snapshots \(3 MB\)$/m);
  assert.ok(!existsSync(join(avdDir, 'snapshots')));
});

test('plan sem snapshots/: linha apagaria sem tamanho e snapshotsMb null', () => {
  rmSync(join(avdDir, 'snapshots'), { recursive: true });
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^tune apagaria: hardware-qemu\.ini$/m);
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).snapshotsMb, null);
});
