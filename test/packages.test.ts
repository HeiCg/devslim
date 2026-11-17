import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BLOAT_CATEGORIES,
  managedPackages,
  NEVER_DISABLE,
  planDisable,
  planRestore,
  PLAY_STORE,
} from '../src/android/packages.ts';

const REQUIRED_NEVER = [
  'com.google.android.bluetooth',
  'com.android.chrome',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.google.android.webview',
  'com.android.systemui',
  'com.android.settings',
  'com.android.providers.settings',
  'com.android.inputmethod.latin',
  'com.android.shell',
];

test('NEVER_DISABLE contains the required minimum', () => {
  for (const p of REQUIRED_NEVER) assert.ok(NEVER_DISABLE.includes(p), p);
});

test('invariant: no NEVER_DISABLE package appears in any category', () => {
  const never = new Set(NEVER_DISABLE);
  for (const cat of BLOAT_CATEGORIES) {
    for (const p of cat.packages) assert.ok(!never.has(p), `${p} in ${cat.id}`);
  }
});

test('categories: unique ids, valid package names, no duplicates across categories', () => {
  const ids = BLOAT_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const seen = new Set<string>();
  for (const cat of BLOAT_CATEGORIES) {
    assert.ok(cat.description.length > 0);
    for (const p of cat.packages) {
      assert.match(p, /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/, p);
      assert.ok(!seen.has(p), `duplicate: ${p}`);
      seen.add(p);
    }
  }
});

test('Play Store only at the aggressive level', () => {
  assert.ok(!managedPackages('standard').includes(PLAY_STORE));
  assert.ok(managedPackages('aggressive').includes(PLAY_STORE));
  const standard = new Set(managedPackages('standard'));
  for (const p of standard) assert.ok(managedPackages('aggressive').includes(p), 'aggressive contains standard');
});

test('planDisable ignores packages not installed and keeps the managed list order', () => {
  const installed = ['com.google.android.youtube', 'com.example.app', 'com.android.printspooler', 'com.google.android.apps.photos'];
  assert.deepEqual(planDisable({ installed, level: 'standard' }), [
    'com.google.android.apps.photos',
    'com.google.android.youtube',
    'com.android.printspooler',
  ]);
});

test('planDisable never returns NEVER_DISABLE, even when installed', () => {
  const installed = [...NEVER_DISABLE, ...managedPackages('aggressive')];
  const plan = planDisable({ installed, level: 'aggressive' });
  for (const p of NEVER_DISABLE) assert.ok(!plan.includes(p), p);
});

test('store capability protects com.android.vending; standard never disables it', () => {
  const installed = [PLAY_STORE, 'com.google.android.setupwizard'];
  assert.deepEqual(planDisable({ installed, level: 'aggressive' }), [PLAY_STORE, 'com.google.android.setupwizard']);
  assert.deepEqual(planDisable({ installed, level: 'aggressive', capabilities: ['store'] }), ['com.google.android.setupwizard']);
  assert.deepEqual(planDisable({ installed, level: 'standard' }), []);
});

test('camera capability keeps com.android.camera2 and com.android.cameraextensions', () => {
  const installed = ['com.android.camera2', 'com.android.cameraextensions', 'com.android.gallery3d'];
  assert.deepEqual(planDisable({ installed, level: 'standard' }), [
    'com.android.gallery3d',
    'com.android.camera2',
    'com.android.cameraextensions',
  ]);
  assert.deepEqual(planDisable({ installed, level: 'standard', capabilities: ['camera'] }), ['com.android.gallery3d']);
});

const MAPS = 'com.google.android.apps.maps';

test('location capability keeps Google Maps in the standard and aggressive lists', () => {
  assert.ok(managedPackages('standard').includes(MAPS), 'Maps stays in the managed list');
  const installed = [MAPS, 'com.google.android.youtube', PLAY_STORE];
  for (const level of ['standard', 'aggressive'] as const) {
    const without = planDisable({ installed, level });
    assert.ok(without.includes(MAPS), `${level} without location disables Maps`);
    const withLoc = planDisable({ installed, level, capabilities: ['location'] });
    assert.ok(!withLoc.includes(MAPS), `${level} with location keeps Maps`);
    assert.deepEqual(withLoc, without.filter((p) => p !== MAPS), `${level}: location only drops Maps`);
  }
  assert.deepEqual(planDisable({ installed, level: 'aggressive', capabilities: ['location', 'store'] }), ['com.google.android.youtube']);
});

test('planRestore with Maps disabled by an earlier bake (without location) still re-enables it', () => {
  assert.deepEqual(planRestore([MAPS]), [MAPS]);
});

test('planRestore ignores packages outside the managed list and deduplicates', () => {
  assert.deepEqual(
    planRestore(['com.google.android.youtube', 'com.example.app', 'com.android.chrome', 'com.google.android.youtube', PLAY_STORE]),
    ['com.google.android.youtube', PLAY_STORE],
  );
  assert.deepEqual(planRestore([]), []);
});

test('managed list size per level', () => {
  assert.equal(managedPackages('standard').length, 65);
  assert.equal(managedPackages('aggressive').length, 70);
});

const GBOARD = 'com.google.android.inputmethod.latin';

test('Gboard only in the aggressive list, never in standard; not in NEVER_DISABLE', () => {
  assert.ok(!managedPackages('standard').includes(GBOARD));
  assert.ok(managedPackages('aggressive').includes(GBOARD));
  assert.ok(!NEVER_DISABLE.includes(GBOARD));
  assert.ok(NEVER_DISABLE.includes('com.android.inputmethod.latin'), 'AOSP keyboard stays protected');
  const cat = BLOAT_CATEGORIES.find((c) => c.packages.includes(GBOARD));
  assert.equal(cat?.level, 'aggressive');
});

test('keyboard capability keeps Gboard; without it installed, nothing changes', () => {
  const installed = [GBOARD, PLAY_STORE];
  assert.deepEqual(planDisable({ installed, level: 'standard' }), []);
  assert.deepEqual(planDisable({ installed, level: 'aggressive' }), [PLAY_STORE, GBOARD]);
  assert.deepEqual(planDisable({ installed, level: 'aggressive', capabilities: ['keyboard'] }), [PLAY_STORE]);
  assert.deepEqual(planDisable({ installed: [PLAY_STORE], level: 'aggressive' }), [PLAY_STORE], 'image without Gboard: skipped');
});

test('planRestore re-enables Gboard disabled by an aggressive bake', () => {
  assert.deepEqual(planRestore([PLAY_STORE, GBOARD]), [PLAY_STORE, GBOARD]);
});
