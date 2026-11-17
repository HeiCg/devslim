import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  avdHome,
  existingRegenerated,
  findAvd,
  isAvdRunning,
  listAvds,
  runningLocks,
} from '../src/android/avd.ts';
import { DevslimError } from '../src/errors.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devslim-avd-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function makeAvd(home: string, name: string, opts: { ini?: string | null; dir?: string } = {}): string {
  const dir = opts.dir ?? join(home, `${name}.avd`);
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.ini'), 'hw.ramSize=2G\n');
  if (opts.ini !== null) {
    writeFileSync(join(home, `${name}.ini`), opts.ini ?? `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${name}.avd\ntarget=android-35\n`);
  }
  return dir;
}

test('avdHome: ANDROID_AVD_HOME > ANDROID_USER_HOME/avd > ~/.android/avd', () => {
  assert.equal(avdHome({ ANDROID_AVD_HOME: '/a', ANDROID_USER_HOME: '/u', HOME: '/h' }), '/a');
  assert.equal(avdHome({ ANDROID_USER_HOME: '/u', HOME: '/h' }), join('/u', 'avd'));
  assert.equal(avdHome({ HOME: '/h' }), join('/h', '.android', 'avd'));
});

test('findAvd uses path from <name>.ini', () => {
  const home = join(root, 'avd');
  const elsewhere = join(root, 'elsewhere', 'x.avd');
  makeAvd(home, 'x', { dir: elsewhere, ini: `path=${elsewhere}\n` });
  const info = findAvd('x', { env: { ANDROID_AVD_HOME: home } });
  assert.equal(info.dir, elsewhere);
  assert.equal(info.configPath, join(elsewhere, 'config.ini'));
});

test('findAvd falls back to path.rel and then to <home>/<name>.avd', () => {
  const home = join(root, 'avd');
  makeAvd(home, 'rel', { ini: 'path=/does/not/exist\npath.rel=avd/rel.avd\n' });
  assert.equal(findAvd('rel', { env: { ANDROID_AVD_HOME: home } }).dir, join(home, 'rel.avd'));
  makeAvd(home, 'noini', { ini: null });
  assert.equal(findAvd('noini', { env: { ANDROID_AVD_HOME: home } }).dir, join(home, 'noini.avd'));
});

test('findAvd: missing AVD lists the available ones; invalid name is refused', () => {
  const home = join(root, 'avd');
  makeAvd(home, 'bench');
  assert.throws(() => findAvd('nope', { env: { ANDROID_AVD_HOME: home } }), /available: bench/);
  assert.throws(() => findAvd('../bench', { env: { ANDROID_AVD_HOME: home } }), DevslimError);
  assert.deepEqual(listAvds({ ANDROID_AVD_HOME: home }), ['bench']);
});

test('lock: *.lock directory = running; multiinstance.lock alone (file) does not count', () => {
  const dir = makeAvd(join(root, 'avd'), 'r');
  writeFileSync(join(dir, 'multiinstance.lock'), '');
  assert.equal(isAvdRunning(dir), false);
  mkdirSync(join(dir, 'hardware-qemu.ini.lock'));
  assert.deepEqual(runningLocks(dir), ['hardware-qemu.ini.lock']);
  writeFileSync(join(dir, 'cache.img.lock'), '123');
  assert.deepEqual(runningLocks(dir), ['cache.img.lock', 'hardware-qemu.ini.lock']);
});

test('existingRegenerated lists hardware-qemu.ini and snapshots/ when present', () => {
  const dir = makeAvd(join(root, 'avd'), 'g');
  assert.deepEqual(existingRegenerated(dir), []);
  writeFileSync(join(dir, 'hardware-qemu.ini'), 'x');
  mkdirSync(join(dir, 'snapshots', 'default_boot'), { recursive: true });
  assert.deepEqual(existingRegenerated(dir), ['hardware-qemu.ini', 'snapshots']);
});
