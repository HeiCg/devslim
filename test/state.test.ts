import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { DevslimError } from '../src/errors.ts';
import { writeFileAtomic } from '../src/fsAtomic.ts';
import {
  clearState,
  devslimHome,
  loadState,
  recordAndroidTune,
  saveState,
  statePath,
  type AndroidState,
} from '../src/state.ts';

let home: string;
let env: Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'devslim-state-'));
  env = { DEVSLIM_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

test('DEVSLIM_HOME sets the root; default ~/.devslim', () => {
  assert.equal(devslimHome(env), home);
  assert.match(devslimHome({ HOME: '/x' }), /\.devslim$/);
  assert.equal(statePath('android', 'bench', { env }), join(home, 'state', 'android', 'bench.json'));
});

test('save/load/clear', () => {
  assert.equal(loadState('android', 'a', { env }), null);
  saveState('android', 'a', { x: 1 }, { env });
  assert.deepEqual(loadState('android', 'a', { env }), { x: 1 });
  assert.equal(clearState('android', 'a', { env }), true);
  assert.equal(clearState('android', 'a', { env }), false);
  assert.equal(loadState('android', 'a', { env }), null);
});

test('invalid id and platform are refused (no path traversal)', () => {
  for (const id of ['../x', 'a/b', '', '..', 'a b']) {
    assert.throws(() => statePath('android', id, { env }), DevslimError, id);
  }
  assert.throws(() => statePath('windows' as 'android', 'a', { env }), DevslimError);
});

test('corrupt state gives a clear error', () => {
  const path = statePath('android', 'a', { env });
  mkdirSync(join(home, 'state', 'android'), { recursive: true });
  writeFileSync(path, '{broken');
  assert.throws(() => loadState('android', 'a', { env }), /corrupt state/);
});

test('atomic write: replaces via rename (new inode) and leaves no tmp behind', () => {
  saveState('android', 'a', { v: 1 }, { env });
  const path = statePath('android', 'a', { env });
  const inodeBefore = statSync(path).ino;
  saveState('android', 'a', { v: 2 }, { env });
  assert.notEqual(statSync(path).ino, inodeBefore, 'new file via rename, not an in-place write');
  assert.deepEqual(loadState('android', 'a', { env }), { v: 2 });
  assert.deepEqual(readdirSync(join(home, 'state', 'android')), ['a.json']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('atomic write: a rename failure leaves the target intact and cleans up the tmp', () => {
  const dir = join(home, 'atomic');
  mkdirSync(join(dir, 'target'), { recursive: true }); // target is a directory: rename fails
  writeFileSync(join(dir, 'target', 'inside.txt'), 'original');
  assert.throws(() => writeFileAtomic(join(dir, 'target'), 'new'));
  assert.deepEqual(readdirSync(dir), ['target']);
  assert.equal(readFileSync(join(dir, 'target', 'inside.txt'), 'utf8'), 'original');
});

test('atomic write preserves the mode of the existing file', () => {
  const p = join(home, 'cfg.ini');
  writeFileSync(p, 'a=1\n', { mode: 0o640 });
  writeFileAtomic(p, 'a=2\n');
  assert.equal(readFileSync(p, 'utf8'), 'a=2\n');
  assert.equal(statSync(p).mode & 0o777, 0o640);
});

test('re-tune keeps the first config.ini backup', () => {
  const first = recordAndroidTune(
    'bench',
    {
      avdDir: '/avd/bench.avd',
      originalConfigIni: 'ORIGINAL\n',
      originalConfigSha256: 'h1',
      profile: buildAndroidProfile(),
      now: new Date('2026-11-16T10:00:00Z'),
    },
    { env },
  );
  assert.equal(first.preservedOriginal, false);

  const second = recordAndroidTune(
    'bench',
    {
      avdDir: '/avd/bench.avd',
      originalConfigIni: 'ALREADY TUNED\n',
      originalConfigSha256: 'h2',
      profile: buildAndroidProfile({ aggressive: true }),
      now: new Date('2026-11-16T11:00:00Z'),
    },
    { env },
  );
  assert.equal(second.preservedOriginal, true);

  const saved = loadState<AndroidState>('android', 'bench', { env });
  assert.ok(saved);
  assert.equal(saved.originalConfigIni, 'ORIGINAL\n');
  assert.equal(saved.originalConfigSha256, 'h1');
  assert.equal(saved.originalSavedAt, '2026-11-16T10:00:00.000Z');
  assert.equal(saved.updatedAt, '2026-11-16T11:00:00.000Z');
  assert.equal(saved.profile.ramMb, 1536, 'profile is the most recent one');
  assert.deepEqual(saved.disabledPackages, []);
});
