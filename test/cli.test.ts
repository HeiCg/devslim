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

// End to end: runs bin/devslim in a process, with a fake AVD in tmpdir.
const BIN = fileURLToPath(new URL('../bin/devslim', import.meta.url));
const PHONE = readFileSync(new URL('./fixtures/phone.config.ini', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

let root: string;
let avdHome: string;
let devslimHome: string;
let avdDir: string;
let configPath: string;

const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

// Map relative path -> sha256 (or "dir") of everything under `dir`.
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
  writeFileSync(join(avdDir, 'multiinstance.lock'), ''); // exists even with the emulator shut down
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test('--help and --version', () => {
  const h = run(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /devslim android plan <avd>/);
  for (const c of ['create <name>', 'up <avd>', 'bake <avd>', 'down \\[<avd>\\]', 'restore <avd> \\[--config-only\\]', 'measure <avd> \\[--json\\]']) {
    assert.match(h.stdout, new RegExp(`devslim android ${c}`), c);
  }
  const v = run(['--version']);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), pkg.version);
});

test('unknown command: error + help, exit 2', () => {
  const r = run(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^devslim: unknown command: frobnicate$/m);
  assert.match(r.stderr, /usage:/);
  assert.equal(run([]).code, 2);
  assert.equal(run(['android', 'explode', 'x']).code, 2);
  assert.equal(run(['android', 'plan']).code, 2);
  assert.equal(run(['android', 'plan', 'fake-api35', '--bogus']).code, 2);
});

test('plan writes nothing and shows changes + emulator line', () => {
  const before = tree(root);
  const r = run(['android', 'plan', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(tree(root), before, 'no file created, changed or removed');
  assert.ok(!existsSync(devslimHome));
  assert.match(r.stdout, /hw\.ramSize: 2G -> 2048/);
  assert.match(r.stdout, /hw\.gpu\.mode: auto -> host/);
  assert.match(
    r.stdout,
    /emulator -avd fake-api35 -gpu host -memory 2048 -cores 2 -grpc 8554 -grpc-use-token -no-window -no-audio -camera-back none -camera-front none -feature -Vulkan -no-boot-anim -no-metrics -no-snapshot \(gRPC 8554 for reference; port chosen at up\)$/m,
  );
  assert.match(r.stdout, /tune would delete: hardware-qemu\.ini, snapshots/);
  assert.doesNotMatch(r.stdout, /-netfast/);
});

test('plan --json with flags and --for', () => {
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
  // The fixture already has audio yes and camera.back emulated: with audio+camera only camera.front changes.
  const keys = out.changes.map((c: { key: string }) => c.key);
  assert.ok(!keys.includes('hw.audioOutput') && !keys.includes('hw.audioInput'));
  assert.ok(out.changes.some((c: { key: string; from: string; to: string }) => c.key === 'hw.camera.front' && c.from === 'none' && c.to === 'emulated'));
});

test('plan --no-grpc: no -grpc/-grpc-use-token, no suffix, profile grpc off; with --port the line has no suffix', () => {
  const r = run(['android', 'plan', 'fake-api35', '--no-grpc']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /-grpc/);
  assert.doesNotMatch(r.stdout, /for reference/);
  assert.match(r.stdout, /^profile: .*vulkan off, grpc off, /m);
  const j = JSON.parse(run(['android', 'plan', 'fake-api35', '--no-grpc', '--json']).stdout);
  assert.equal(j.profile.grpc, false);
  assert.ok(!j.emulatorArgs.includes('-grpc'));
  const withPort = run(['android', 'plan', 'fake-api35', '--port', '5556']);
  assert.match(withPort.stdout, /-port 5556 -grpc 8556 -grpc-use-token .*-no-snapshot$/m);
  assert.match(withPort.stdout, /^profile: .*grpc on, /m);
});

test('tune --no-grpc persists grpc: false in the state; the next plan inherits; old state without the field = grpc on', () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--no-grpc']).code, 0);
  const st = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.equal(st.profile.grpc, false);
  const inherited = run(['android', 'plan', 'fake-api35']);
  assert.match(inherited.stdout, /profile inherited from the previous tune/);
  assert.doesNotMatch(inherited.stdout, /-grpc/);
  // State written before the field existed.
  delete st.profile.grpc;
  writeFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), JSON.stringify(st));
  const old = run(['android', 'plan', 'fake-api35', '--json']);
  assert.equal(JSON.parse(old.stdout).profile.grpc, true);
  assert.ok(JSON.parse(old.stdout).emulatorArgs.includes('-grpc-use-token'));
});

test('--grpc re-enables over the saved grpc: false; without flag inherits false; tune --grpc persists true', () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--no-grpc']).code, 0);
  const statePath = join(devslimHome, 'state', 'android', 'fake-api35.json');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).profile.grpc, false);

  const kept = JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout);
  assert.equal(kept.profile.grpc, false, 'no flag: inherits the saved false');
  assert.ok(!kept.emulatorArgs.includes('-grpc'));

  const on = run(['android', 'plan', 'fake-api35', '--grpc']);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /profile inherited from the previous tune/);
  assert.match(on.stdout, /^profile: .*grpc on, /m);
  assert.match(on.stdout, /-grpc 8554 -grpc-use-token/);

  assert.equal(run(['android', 'tune', 'fake-api35', '--grpc']).code, 0);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).profile.grpc, true, 'tune --grpc writes true');
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).profile.grpc, true);
});

test('--grpc with --no-grpc = usage error in plan, tune, up and bake; nothing written', () => {
  const before = tree(avdDir);
  for (const sub of ['plan', 'tune', 'up', 'bake']) {
    const r = run(['android', sub, 'fake-api35', '--grpc', '--no-grpc']);
    assert.equal(r.code, 2, `${sub}: ${r.stderr}`);
    assert.equal(r.stderr.split('\n')[0], 'devslim: --grpc and --no-grpc conflict; use only one', sub);
  }
  assert.deepEqual(tree(avdDir), before);
  assert.ok(!existsSync(join(devslimHome, 'state')), 'refused tune writes no state');
});

test('cli up and bake accept --grpc: re-enables over the saved state with grpc false', async () => {
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
  assert.ok(!c.fake.spawnCalls[0].args.includes('-grpc'), 'no flag: inherits grpc false');
});

// ---------------------------------------------------------------------------
// --lowram / --no-lowram

const lowramState = () => JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8')).profile;

test('--lowram turns on -lowram without touching RAM; tune saves; plan inherits; --no-lowram overrides', () => {
  const p = run(['android', 'plan', 'fake-api35', '--lowram']);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^profile: ram 2048 MB \(lowram\), /m);
  assert.match(p.stdout, /emulator -avd fake-api35 -gpu host -memory 2048 .* -lowram -no-boot-anim/);
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--lowram', '--json']).stdout).profile.lowRam, true);

  assert.equal(run(['android', 'tune', 'fake-api35', '--lowram']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [2048, true]);
  assert.match(readFileSync(configPath, 'utf8'), /^hw\.ramSize=2048$/m);

  const inherited = run(['android', 'plan', 'fake-api35']);
  assert.match(inherited.stdout, /^profile inherited from the previous tune$/m);
  assert.match(inherited.stdout, / -lowram /, 'no flag inherits the saved lowram');
  const off = run(['android', 'plan', 'fake-api35', '--no-lowram']);
  assert.doesNotMatch(off.stdout, /^ {2}emulator .* -lowram /m);
  assert.match(off.stdout, /-memory 2048 /);

  // --ram after --lowram keeps the inherited lowram
  assert.equal(run(['android', 'tune', 'fake-api35', '--ram', '3072']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [3072, true]);
  assert.equal(run(['android', 'tune', 'fake-api35', '--no-lowram']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [3072, false]);
});

test('--aggressive stays 1536 + lowram; --no-lowram with it drops only the lowram', () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--aggressive']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [1536, true]);
  assert.equal(run(['android', 'tune', 'fake-api35', '--aggressive', '--no-lowram']).code, 0);
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [1536, false]);
  assert.equal(run(['android', 'tune', 'fake-api35', '--aggressive']).code, 0, '--aggressive turns lowram back on over the saved one');
  assert.deepEqual([lowramState().ramMb, lowramState().lowRam], [1536, true]);
});

test('--lowram with --no-lowram = usage error in plan, tune, up and bake; nothing written', () => {
  const before = tree(avdDir);
  for (const sub of ['plan', 'tune', 'up', 'bake']) {
    const r = run(['android', sub, 'fake-api35', '--lowram', '--no-lowram']);
    assert.equal(r.code, 2, `${sub}: ${r.stderr}`);
    assert.equal(r.stderr.split('\n')[0], 'devslim: --lowram and --no-lowram conflict; use only one', sub);
  }
  assert.deepEqual(tree(avdDir), before);
  assert.ok(!existsSync(join(devslimHome, 'state')));
});

test('cli up and bake accept --lowram/--no-lowram; bake --aggressive is still just the bloat list', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const a = inProcess();
  const up = await a.call(['android', 'up', 'fake-api35', '--lowram']);
  assert.equal(up.code, 0, up.stderr);
  assert.ok(a.fake.spawnCalls[0].args.includes('-lowram'));
  assert.equal(a.fake.spawnCalls[0].args[a.fake.spawnCalls[0].args.indexOf('-memory') + 1], '2048');

  const b = inProcess();
  const bake = await b.call(['android', 'bake', 'fake-api35', '--aggressive', '--lowram', '--force']);
  assert.equal(bake.code, 0, bake.stderr);
  assert.match(bake.stdout, /\(level aggressive\)/);
  assert.match(bake.stdout, /-memory 2048 .*-lowram/);

  assert.equal(run(['android', 'tune', 'fake-api35', '--lowram']).code, 0);
  const c = inProcess();
  const plain = await c.call(['android', 'bake', 'fake-api35', '--no-lowram', '--force']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(!c.fake.spawnCalls[0].args.includes('-lowram'), '--no-lowram overrides the saved one');
  const d = inProcess();
  await d.call(['android', 'bake', 'fake-api35', '--aggressive', '--force']);
  assert.ok(d.fake.spawnCalls[0].args.includes('-lowram'), 'no flag inherits the saved lowram');
});

// plan/tune note: RAM below 2560 without lowram will likely be raised by the emulator.
const NOTE_RE = /^note: /m;

test('plan/tune: floor note only below 2560 MB without lowram', () => {
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^note: the emulator will likely raise the requested RAM of 2048 MB \(observed floors: 2560 MB on phone, 4096 MB on a 2560x1600 tablet\); --lowram makes the request stick/m);
  assert.equal(p.stdout.match(/^note: .*$/gm)?.length, 1, 'a single line');
  assert.match(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).ramNote, /2048 MB/);
  assert.match(run(['android', 'plan', 'fake-api35', '--aggressive', '--no-lowram']).stdout, /^note: .*1536 MB/m);

  for (const flags of [['--lowram'], ['--aggressive'], ['--ram', '2560'], ['--ram', '4096']]) {
    const r = run(['android', 'plan', 'fake-api35', ...flags]);
    assert.doesNotMatch(r.stdout, NOTE_RE, flags.join(' '));
    assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', ...flags, '--json']).stdout).ramNote, null, flags.join(' '));
  }
  const t = run(['android', 'tune', 'fake-api35']);
  assert.match(t.stdout, NOTE_RE);
  assert.doesNotMatch(run(['android', 'tune', 'fake-api35', '--lowram']).stdout, NOTE_RE);
});

test('plan/tune: note uses the effective RAM from the last boot (hardware-qemu.ini) when present', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\nhw.gpu.mode = host\n');
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^note: on this AVD's last boot the emulator raised 2048 MB to 4096 MB; the 2048 MB request will likely be raised again; --lowram makes the request stick/m);
  assert.doesNotMatch(p.stdout, /observed floors/);
  const t = run(['android', 'tune', 'fake-api35', '--json']);
  assert.match(JSON.parse(t.stdout).ramNote, /raised 2048 MB to 4096 MB/);

  // last boot without a raise (effective = requested): falls back to the generic note
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 2048\n');
  assert.match(run(['android', 'plan', 'fake-api35']).stdout, /^note: .*observed floors/m);
});

test('plan: note compares the effective RAM with the last up -memory (lastLaunch), not with the profile', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0); // profile 2048
  const statePath = join(devslimHome, 'state', 'android', 'fake-api35.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  // up --ram 4096 without tune: effective 4096 is not a raise; the note goes back to the generic one.
  writeFileSync(statePath, JSON.stringify({ ...st, lastLaunch: { ramMb: 4096, lowRam: false, at: '2026-11-17T09:00:00.000Z' } }));
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 4096\n');
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^note: the emulator will likely raise the requested RAM of 2048 MB \(observed floors/m);
  assert.doesNotMatch(p.stdout, /on this AVD's last boot/);
  // last up requested 2048 and got 2560: the note cites the real raise.
  writeFileSync(statePath, JSON.stringify({ ...st, lastLaunch: { ramMb: 2048, lowRam: false, at: '2026-11-17T09:00:00.000Z' } }));
  writeFileSync(join(avdDir, 'hardware-qemu.ini'), 'hw.ramSize = 2560\n');
  assert.match(run(['android', 'plan', 'fake-api35']).stdout, /^note: on this AVD's last boot the emulator raised 2048 MB to 2560 MB/m);
});

test('help lists --lowram and --no-lowram', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /^ {2}--lowram {5,}/m);
  assert.match(h, /^ {2}--no-lowram {2,}/m);
  assert.match(h, /--aggressive +RAM 1536 \+ -lowram/);
});

test('help: --need lists keyboard; bake --aggressive mentions Gboard', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /--need a,b +capabilities: audio, camera, keyboard, location, push, store, weblogin, window;/);
  assert.match(h, /keyboard keeps Gboard in bake --aggressive/);
  assert.match(h, /--aggressive +bake: also disables the aggressive list \(Play Store, setup wizards, Gboard\)/);
});

test('cli bake --aggressive: Gboard disabled; --need keyboard keeps it', async () => {
  const GBOARD = 'com.google.android.inputmethod.latin';
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const a = inProcess({ spawned: { installed: [GBOARD, 'com.android.vending'] } });
  assert.equal((await a.call(['android', 'bake', 'fake-api35', '--aggressive'])).code, 0);
  const st = () => JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.deepEqual(st().disabledPackages, ['com.android.vending', GBOARD]);
  const b = inProcess({ spawned: { installed: [GBOARD, 'com.android.vending'] } });
  assert.equal((await b.call(['android', 'bake', 'fake-api35', '--aggressive', '--need', 'keyboard', '--force'])).code, 0);
  assert.deepEqual(st().disabledPackages, ['com.android.vending']);
  assert.deepEqual(st().profile.capabilities, [], 'bake does not write capabilities into the tune profile');
});

test('help lists --grpc', () => {
  const r = run(['--help']);
  assert.match(r.stdout, /^ {2}--grpc {7,}/m);
  assert.match(r.stdout, /\[--no-grpc\|--grpc\]|--grpc\]/);
});

test('user error: one line on stderr, no stack, exit != 0', () => {
  for (const args of [
    ['android', 'plan', 'fake-api35', '--ram', '1024'],
    ['android', 'plan', 'does-not-exist'],
    ['android', 'plan', 'fake-api35', '--need', 'bluetooth'],
    ['android', 'restore', 'fake-api35'],
  ]) {
    const r = run(args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.equal(r.stderr.trimEnd().split('\n').length, 1, `one line: ${r.stderr}`);
    assert.match(r.stderr, /^devslim: /);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test('tune changes config.ini, saves state and removes hardware-qemu.ini and snapshots/', () => {
  const r = run(['android', 'tune', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  const after = readFileSync(configPath, 'utf8');
  assert.match(after, /^hw\.ramSize=2048$/m);
  assert.match(after, /^hw\.gpu\.mode=host$/m);
  assert.match(after, /^custom\.vendor\.flag=abc=def$/m, 'unknown key intact');
  assert.ok(!existsSync(join(avdDir, 'hardware-qemu.ini')));
  assert.ok(!existsSync(join(avdDir, 'snapshots')));
  assert.ok(existsSync(join(avdDir, 'multiinstance.lock')), 'does not touch what is not its own');
  assert.match(r.stdout, /removed: hardware-qemu\.ini, snapshots/);

  const state = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.equal(state.originalConfigIni, PHONE.toString('utf8'));
  assert.equal(state.originalConfigSha256, sha(PHONE));
  assert.equal(state.profile.ramMb, 2048);
  assert.deepEqual(state.disabledPackages, []);
});

test('re-tune: same profile neither writes nor removes; a new profile keeps the first backup', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'), { recursive: true });
  const tuned = readFileSync(configPath);

  const same = run(['android', 'tune', 'fake-api35']);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /nothing written/);
  assert.ok(readFileSync(configPath).equals(tuned));
  assert.ok(existsSync(join(avdDir, 'snapshots', 'slim_base')), 'no change, snapshot stays');

  const agg = run(['android', 'tune', 'fake-api35', '--aggressive']);
  assert.equal(agg.code, 0, agg.stderr);
  assert.match(agg.stdout, /first tune backup kept/);
  assert.match(readFileSync(configPath, 'utf8'), /^hw\.ramSize=1536$/m);
  const state = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.equal(state.originalConfigSha256, sha(PHONE), 'original stays the one from before the first tune');
});

test('tune/plan inherit the saved profile: flags override, --need replaces, none clears, --reset goes back to defaults', () => {
  const statePath = join(devslimHome, 'state', 'android', 'fake-api35.json');
  const st = () => JSON.parse(readFileSync(statePath, 'utf8'));
  const cfg = () => readFileSync(configPath, 'utf8');
  assert.equal(run(['android', 'tune', 'fake-api35', '--need', 'location', '--ram', '3072']).code, 0);
  assert.match(cfg(), /^hw\.gps=yes$/m);

  // plan without state does not inherit; with state it shows the line and starts from the saved profile.
  const p = run(['android', 'plan', 'fake-api35', '--screen', '720x1600@320']);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^profile inherited from the previous tune$/m);
  assert.match(p.stdout, /emulator -avd fake-api35 -gpu host -memory 3072 /);
  const pj = JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout);
  assert.equal(pj.inheritedProfile, true);

  const t = run(['android', 'tune', 'fake-api35', '--screen', '720x1600@320', '--json']);
  assert.equal(t.code, 0, t.stderr);
  const tj = JSON.parse(t.stdout);
  assert.deepEqual(tj.changes.map((c: { key: string }) => c.key), ['hw.lcd.width', 'hw.lcd.height', 'hw.lcd.density'], 'changes only hw.lcd.*');
  assert.equal(tj.inheritedProfile, true);
  assert.match(cfg(), /^hw\.ramSize=3072$/m);
  assert.match(cfg(), /^hw\.gps=yes$/m);
  assert.equal(st().profile.ramMb, 3072);
  assert.deepEqual(st().profile.capabilities, ['location']);
  assert.deepEqual(st().profile.screen, { width: 720, height: 1600, density: 320 });

  // --need replaces (no merge)
  assert.equal(run(['android', 'tune', 'fake-api35', '--need', 'camera']).code, 0);
  assert.deepEqual(st().profile.capabilities, ['camera']);
  assert.match(cfg(), /^hw\.gps=no$/m);
  assert.match(cfg(), /^hw\.camera\.back=emulated$/m);
  assert.equal(st().profile.ramMb, 3072, 'RAM stays the inherited one');

  // --need none clears; combined with another capability it is a usage error
  assert.equal(run(['android', 'tune', 'fake-api35', '--need', 'none']).code, 0);
  assert.deepEqual(st().profile.capabilities, []);
  assert.match(cfg(), /^hw\.camera\.back=none$/m);
  const bad = run(['android', 'plan', 'fake-api35', '--need', 'none,camera']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^devslim: --need none cannot be combined with other capabilities$/m);

  // --reset: defaults, without the inheritance line
  const rp = run(['android', 'plan', 'fake-api35', '--reset']);
  assert.doesNotMatch(rp.stdout, /profile inherited/);
  assert.match(rp.stdout, /hw\.ramSize: 3072 -> 2048/);
  assert.equal(run(['android', 'tune', 'fake-api35', '--reset']).code, 0);
  assert.equal(st().profile.ramMb, 2048);
  assert.equal(st().profile.screen, 'keep');
  assert.deepEqual(st().profile.capabilities, []);

  // original backup stays the one from before the first tune
  assert.equal(st().originalConfigSha256, sha(PHONE));
  assert.equal(st().originalConfigIni, PHONE.toString('utf8'));
});

test('up and bake do not accept --reset; help documents inheritance, --need none and --reset', () => {
  assert.equal(run(['android', 'up', 'fake-api35', '--reset']).code, 2);
  const h = run(['--help']).stdout;
  assert.match(h, /--need a,b +capabilities: [^\n]*\n +replaces the tune ones; --need none clears them/);
  assert.match(h, /--reset +plan\/tune: ignores the saved profile and starts from the defaults/);
  assert.match(h, /plan\/tune\/up flags \(inherit the tune profile; flags override it\)/);
});

test('plan without state: no inheritance line', () => {
  const p = run(['android', 'plan', 'fake-api35']);
  assert.doesNotMatch(p.stdout, /profile inherited/);
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).inheritedProfile, false);
});

test('restore returns identical bytes (hash) and clears the state', () => {
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
  assert.match(again.stderr, /no tune state/);
});

test('restore keeps tablet without trailing newline byte for byte', () => {
  const tablet = readFileSync(new URL('./fixtures/tablet.config.ini', import.meta.url));
  writeFileSync(configPath, tablet);
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  assert.equal(run(['android', 'restore', 'fake-api35']).code, 0);
  assert.ok(readFileSync(configPath).equals(tablet));
});

test('tune refuses with a lock present and touches nothing', () => {
  mkdirSync(join(avdDir, 'hardware-qemu.ini.lock'));
  writeFileSync(join(avdDir, 'hardware-qemu.ini.lock', 'pid'), '4242');
  const before = tree(root);
  const r = run(['android', 'tune', 'fake-api35']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /seems to be running .*hardware-qemu\.ini\.lock/);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1);
  assert.deepEqual(tree(root), before);

  const plan = run(['android', 'plan', 'fake-api35']);
  assert.equal(plan.code, 0);
  assert.match(plan.stdout, /warning: AVD seems to be running/);
});

test('restore refuses with a lock present and keeps the state', () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  mkdirSync(join(avdDir, 'userdata-qemu.img.lock'));
  const r = run(['android', 'restore', 'fake-api35']);
  assert.equal(r.code, 1);
  assert.ok(existsSync(join(devslimHome, 'state', 'android', 'fake-api35.json')));
});

// ---------------------------------------------------------------------------
// Runtime end to end: main() in-process, with fake exec/spawn/sleep.

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

test('cli up: inherits the tune profile, starts, prints serial; --json; second up = already running', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35', '--ram', '3072']).code, 0);
  const { fake, call } = inProcess();
  const r = await call(['android', 'up', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AVD fake-api35 ready on emulator-5554 \(pid \d+, cold boot without snapshot/);
  assert.match(r.stdout, /emulator -avd fake-api35 -gpu host -memory 3072 -cores 2 -port 5554 .*-no-snapshot$/m);
  assert.match(r.stdout, /^tip: started without the slim_base snapshot; run devslim android bake fake-api35 once /m);
  assert.equal(r.stdout.trimEnd().split('\n').at(-1)!.startsWith('tip: '), true, 'tip is the last line');
  assert.equal(fake.spawnCalls.length, 1);

  const again = await call(['android', 'up', 'fake-api35', '--json']);
  assert.equal(again.code, 0, again.stderr);
  const j = JSON.parse(again.stdout);
  assert.equal(j.alreadyRunning, true);
  assert.equal(j.serial, 'emulator-5554');
  assert.ok(!('hint' in j), 'already running: no hint');
  assert.ok('ramEffectiveMb' in j);
  assert.equal(j.launcher, 'devslim', 'session records the AVD');
  assert.ok('gpuEffective' in j);
  assert.equal(again.stderr, '', 'ours and no software GPU: no warning');
  assert.equal(fake.spawnCalls.length, 1, 'does not start a second one');
});

test('cli up: emulator without advertisement = warning on stderr and exit 0; advertised = no warning and advertised in the JSON; --no-grpc does not warn', async () => {
  const runningDir = join(root, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running'); // HOME=root no env
  const quiet = inProcess();
  const r = await quiet.call(['android', 'up', 'fake-api35']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`^devslim: warning: emulator did not advertise itself in ${runningDir.replace(/[.]/g, '\\.')}: .*adb works normally$`, 'm'));

  const off = inProcess();
  const n = await off.call(['android', 'up', 'fake-api35', '--no-grpc', '--force']);
  assert.equal(n.code, 0, n.stderr);
  assert.doesNotMatch(n.stderr, /did not advertise itself/);
  assert.doesNotMatch(n.stdout, /-grpc/);

  mkdirSync(runningDir, { recursive: true });
  writeFileSync(join(runningDir, 'pid_61000.ini'), readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8').replace('avd.name=bench-api35', 'avd.name=fake-api35'));
  const loud = inProcess();
  const j = await loud.call(['android', 'up', 'fake-api35', '--json']);
  assert.equal(j.code, 0, j.stderr);
  assert.doesNotMatch(j.stderr, /did not advertise itself/);
  const out = JSON.parse(j.stdout);
  assert.deepEqual([out.advertised, out.grpcPort], [true, 8554]);
  assert.ok(!(j.stdout + j.stderr).includes('abc123'), 'token never leaks');
});

test('cli bake --no-grpc: line without -grpc; default bake carries -grpc 8554 -grpc-use-token', async () => {
  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const a = inProcess();
  const off = await a.call(['android', 'bake', 'fake-api35', '--no-grpc']);
  assert.equal(off.code, 0, off.stderr);
  assert.ok(!a.fake.spawnCalls[0].args.includes('-grpc'));
  const b = inProcess();
  const on = await b.call(['android', 'bake', 'fake-api35', '--force']);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /^command: emulator .*-port 5554 -grpc 8554 -grpc-use-token /m);
});

test('cli up: guard refuses in one line, exit 1; --force passes', async () => {
  const { call } = inProcess({ emulators: [{ avd: 'other', port: 5554 }] });
  const r = await call(['android', 'up', 'fake-api35']);
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trimEnd().split('\n').length, 1);
  assert.match(r.stderr, /^devslim: up refused: a device is already running: emulator emulator-5554/);
  const f = await call(['android', 'up', 'fake-api35', '--force', '--port', '5560']);
  assert.equal(f.code, 0, f.stderr);
  assert.match(f.stdout, /ready on emulator-5560/);
});

test('cli bake: without tune errors; with tune slims, saves slim_base and shuts down; the next up uses the snapshot', async () => {
  const { fake, call } = inProcess({ spawned: { installed: ['com.google.android.youtube', 'com.android.vending', 'com.android.chrome'] } });
  const noTune = await call(['android', 'bake', 'fake-api35']);
  assert.equal(noTune.code, 1);
  assert.match(noTune.stderr, /run first: devslim android tune fake-api35/);

  assert.equal(run(['android', 'tune', 'fake-api35']).code, 0);
  const r = await call(['android', 'bake', 'fake-api35', '--aggressive']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /bake of fake-api35 on emulator-5554 \(level aggressive\)/);
  assert.match(r.stdout, /-memory 2048 /, '--aggressive in bake does not touch the tune RAM');
  assert.match(r.stdout, /packages: 2 disabled now/);
  assert.match(r.stdout, /snapshot slim_base saved; emulator shut down/);
  assert.match(r.stdout, /timings: boot .* total /);
  assert.equal(fake.emulators.size, 0);
  const state = JSON.parse(readFileSync(join(devslimHome, 'state', 'android', 'fake-api35.json'), 'utf8'));
  assert.deepEqual(state.disabledPackages, ['com.google.android.youtube', 'com.android.vending']);
  assert.ok(existsSync(join(avdDir, 'snapshots', 'slim_base')));

  const up = await call(['android', 'up', 'fake-api35']);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /snapshot slim_base/);
  assert.match(up.stdout, /-snapshot slim_base -no-snapshot-save$/m);
  assert.doesNotMatch(up.stdout, /tip:|bake/, 'started from the snapshot: no tip');
});

test('cli up --json without slim_base carries hint and ramEffectiveMb', async () => {
  const { call } = inProcess();
  const r = await call(['android', 'up', 'fake-api35', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.fromSnapshot, false);
  assert.match(j.hint, /^tip: .*devslim android bake fake-api35/);
  assert.equal(j.ramEffectiveMb, null, 'fake writes neither hardware-qemu.ini nor log');
});

test('cli down: only the recorded one; --json', async () => {
  const { fake, call } = inProcess({ emulators: [{ avd: 'owners', port: 5556 }] });
  assert.equal((await call(['android', 'up', 'fake-api35', '--force'])).code, 0);
  assert.equal(fake.emulators.size, 2);
  const r = await call(['android', 'down', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((x: { avd: string; result: string }) => [x.avd, x.result]), [['fake-api35', 'killed']]);
  assert.deepEqual([...fake.emulators.values()].map((e) => e.avd), ['owners']);
  const empty = await call(['android', 'down']);
  assert.equal(empty.stdout, 'nothing to shut down (empty session)\n');
  const refused = await call(['android', 'down', 'owners']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--force/);
});

test('cli measure --json: stable object', async () => {
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
  assert.match(text.stdout, /host: phys_footprint 2662\.4 MB, footprint \(header\) n\/a, rss 2690 MB/);
});

test('cli measure text with the real footprint output: all three values', async () => {
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
  assert.match(text.stdout, /^host: phys_footprint 5582 MB, footprint \(header\) 3000 MB, rss 4040\.9 MB$/m);
});

test('cli restore: pending changes with AVD shut down = one error line; --config-only warns and keeps state', async () => {
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
  assert.match(c.stderr, /warning: --config-only/);
  assert.match(c.stdout, /state kept/);
  assert.ok(readFileSync(configPath).equals(PHONE));
  assert.ok(existsSync(statePath));
});

test('cli create: refuses an existing one; creates with a 720x1600@320 screen', async () => {
  const { fake, call } = inProcess();
  const dup = await call(['android', 'create', 'fake-api35']);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already exists/);
  const r = await call(['android', 'create', 'new-api35', '--device', 'pixel_6']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AVD new-api35 created \(system-images;android-35;google_apis;arm64-v8a, pixel_6\); not booted/);
  assert.match(readFileSync(join(avdHome, 'new-api35.avd', 'config.ini'), 'utf8'), /^hw\.lcd\.width=720$/m);
  assert.equal(fake.exec.calls[0].opts.input, 'no\n');
});

test('cli create --image shortcut and --api; missing image = sdkmanager in the message; --api with a full id = usage', async () => {
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
  assert.match(bad.stderr, /^devslim: --api only applies to an image shortcut/m);
  assert.equal((await call(['android', 'create', 'x', '--image', 'aosp_atd', '--api', 'abc'])).code, 2);
  const unknown = await call(['android', 'create', 'x', '--image', 'playstore']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown image: playstore/);
});

test('help: create lists --api, the image shortcuts and the ATD trade-off', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /devslim android create <name> \[--image I\] \[--api N\] \[--device D\]/);
  assert.match(h, /^ {2}--api N {6,}/m);
  assert.match(h, /google_apis, google_atd, aosp_atd, default/);
  assert.match(h, /aosp_atd: no Google sign-in, FCM push or Play Billing purchases/);
});

// ---------------------------------------------------------------------------
// iOS end to end: main() in-process with fake simulator and store (tmpdir).

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

test('cli ios: --help lists the subcommands; usage errors exit 2', async () => {
  const h = run(['--help']);
  for (const c of ['plan <udid\\|name>', 'up <udid\\|name>', 'off <udid\\|name>', 'down \\[<udid\\|name>\\]', 'measure <udid\\|name>', 'categories']) {
    assert.match(h.stdout, new RegExp(`devslim ios ${c}`), c);
  }
  assert.match(h.stdout, /breaks push, StoreKit, universal links and Apple ID sign-in/);
  const { call } = iosInProcess();
  assert.equal((await call(['ios'])).code, 2);
  assert.equal((await call(['ios', 'plan'])).code, 2);
  assert.equal((await call(['ios', 'up', 'x', '--bogus'])).code, 2);
  const alias = await call(['ios', 'plan', 'booted']);
  assert.equal(alias.code, 1);
  assert.match(alias.stderr, /^devslim: "booted" is a simctl alias/);
});

test('cli ios categories: text and --json', async () => {
  const { call, fake } = iosInProcess();
  const t = await call(['ios', 'categories']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^siri\s+28 labels  breaks: Siri/m);
  assert.match(t.stdout, /total managed: 173 unique labels/);
  const j = JSON.parse((await call(['ios', 'categories', '--json'])).stdout);
  assert.equal(j.managedTotal, 173);
  assert.equal(j.categories.length, 16);
  assert.deepEqual(j.capabilities.push, { categories: [], labels: ['com.apple.apsd'] });
  assert.equal(fake.calls.length, 0, 'categories calls nothing');
});

test('cli ios plan --json: read-only, object with labels and runtime', async () => {
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
  assert.match(up.stdout, /QA-iPhone17 \(DBF8B093-58A2-4B57-812A-60D6CF8594BD\) iOS 26\.4: 173 labels in the profile, 173 store entry\(ies\) changed/);
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
  assert.match(off.stdout, /173 label\(s\) returned to saved value; state removed/);
  assert.match(off.stdout, /simulator rebooted/);
  const offAgain = await call(['ios', 'off', 'QA-iPhone17']);
  assert.equal(offAgain.code, 1);
  assert.match(offAgain.stderr, /^devslim: no state for QA-iPhone17/);

  const down = await call(['ios', 'down']);
  assert.equal(down.code, 0, down.stderr);
  assert.match(down.stdout, /QA-iPhone17 DBF8B093-58A2-4B57-812A-60D6CF8594BD: shutdown/);
  assert.equal(fake.sims.get(SIM)!.state, 'Shutdown');
});

test('cli ios plan/up: repair of always-enabled labels shows in the text and in --json', async () => {
  const { call, storeBase } = iosInProcess();
  const p = join(storeBase, `com.apple.CoreSimulator.SimDevice.${SIM}`, 'disabled.plist');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>com.apple.assistantd</key>\n\t<true/>\n\t<key>com.apple.gamed</key>\n\t<true/>\n</dict>\n</plist>\n');
  const j = await call(['ios', 'plan', 'QA-iPhone17', '--json']);
  assert.equal(j.code, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout).repair, ['com.apple.assistantd', 'com.apple.gamed']);
  const t = await call(['ios', 'plan', 'QA-iPhone17']);
  assert.match(t.stdout, /^repair \(always-enabled labels the store has disabled\): com\.apple\.assistantd,com\.apple\.gamed$/m);
  const up = await call(['ios', 'up', 'QA-iPhone17']);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /^repaired \(always-enabled labels that were disabled in the store\): com\.apple\.assistantd, com\.apple\.gamed$/m);
});

test('--help lists the top-level commands', () => {
  const h = run(['--help']);
  for (const c of ['status \\[--json\\]', 'doctor \\[--json\\]', 'down \\[--force\\] \\[--json\\]', 'measure \\[--json\\]']) {
    assert.match(h.stdout, new RegExp(`devslim ${c}`), c);
  }
});

test('cli ios up: a label that does not stick = exit 3 with the list', async () => {
  const { call } = iosInProcess({ stubborn: ['com.apple.triald'] });
  const r = await call(['ios', 'up', SIM]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /NOT disabled \(1\): com\.apple\.triald/);
  assert.match(r.stdout, /launchctl in 1 pass\(es\) and reboot/);
});

test('plan and tune report the size of snapshots/ in the would-delete/removed line; JSON with snapshotsMb', () => {
  writeFileSync(join(avdDir, 'snapshots', 'default_boot', 'ram.bin'), Buffer.alloc(3 * 1024 * 1024 - 3));
  mkdirSync(join(avdDir, 'snapshots', 'slim_base'));
  writeFileSync(join(avdDir, 'snapshots', 'slim_base', 'ram.bin'), Buffer.alloc(3)); // exact total: 3 MiB
  const p = run(['android', 'plan', 'fake-api35']);
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^tune would delete: hardware-qemu\.ini, snapshots \(3 MB\)$/m);
  const j = JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout);
  assert.deepEqual(j.wouldRemove, ['hardware-qemu.ini', 'snapshots']);
  assert.equal(j.snapshotsMb, 3);

  const t = run(['android', 'tune', 'fake-api35']);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^removed: hardware-qemu\.ini, snapshots \(3 MB\)$/m);
  assert.ok(!existsSync(join(avdDir, 'snapshots')));
});

test('plan without snapshots/: would-delete line without size and snapshotsMb null', () => {
  rmSync(join(avdDir, 'snapshots'), { recursive: true });
  const p = run(['android', 'plan', 'fake-api35']);
  assert.match(p.stdout, /^tune would delete: hardware-qemu\.ini$/m);
  assert.equal(JSON.parse(run(['android', 'plan', 'fake-api35', '--json']).stdout).snapshotsMb, null);
});
