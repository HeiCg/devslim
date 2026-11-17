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
  'com.google.android.inputmethod.latin',
  'com.android.inputmethod.latin',
  'com.android.shell',
];

test('NEVER_DISABLE contem o minimo exigido', () => {
  for (const p of REQUIRED_NEVER) assert.ok(NEVER_DISABLE.includes(p), p);
});

test('invariante: nenhum pacote de NEVER_DISABLE aparece em categoria alguma', () => {
  const never = new Set(NEVER_DISABLE);
  for (const cat of BLOAT_CATEGORIES) {
    for (const p of cat.packages) assert.ok(!never.has(p), `${p} em ${cat.id}`);
  }
});

test('categorias: ids unicos, nomes de pacote validos, sem duplicata entre categorias', () => {
  const ids = BLOAT_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const seen = new Set<string>();
  for (const cat of BLOAT_CATEGORIES) {
    assert.ok(cat.description.length > 0);
    for (const p of cat.packages) {
      assert.match(p, /^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/, p);
      assert.ok(!seen.has(p), `duplicado: ${p}`);
      seen.add(p);
    }
  }
});

test('Play Store so no nivel aggressive', () => {
  assert.ok(!managedPackages('standard').includes(PLAY_STORE));
  assert.ok(managedPackages('aggressive').includes(PLAY_STORE));
  const standard = new Set(managedPackages('standard'));
  for (const p of standard) assert.ok(managedPackages('aggressive').includes(p), 'aggressive contem standard');
});

test('planDisable ignora pacotes nao instalados e respeita a ordem da lista gerida', () => {
  const installed = ['com.google.android.youtube', 'com.example.app', 'com.android.printspooler', 'com.google.android.apps.photos'];
  assert.deepEqual(planDisable({ installed, level: 'standard' }), [
    'com.google.android.apps.photos',
    'com.google.android.youtube',
    'com.android.printspooler',
  ]);
});

test('planDisable nunca devolve NEVER_DISABLE, mesmo instalados', () => {
  const installed = [...NEVER_DISABLE, ...managedPackages('aggressive')];
  const plan = planDisable({ installed, level: 'aggressive' });
  for (const p of NEVER_DISABLE) assert.ok(!plan.includes(p), p);
});

test('capacidade store protege com.android.vending; standard nunca desliga', () => {
  const installed = [PLAY_STORE, 'com.google.android.setupwizard'];
  assert.deepEqual(planDisable({ installed, level: 'aggressive' }), [PLAY_STORE, 'com.google.android.setupwizard']);
  assert.deepEqual(planDisable({ installed, level: 'aggressive', capabilities: ['store'] }), ['com.google.android.setupwizard']);
  assert.deepEqual(planDisable({ installed, level: 'standard' }), []);
});

test('capacidade camera mantem com.android.camera2 e com.android.cameraextensions', () => {
  const installed = ['com.android.camera2', 'com.android.cameraextensions', 'com.android.gallery3d'];
  assert.deepEqual(planDisable({ installed, level: 'standard' }), [
    'com.android.gallery3d',
    'com.android.camera2',
    'com.android.cameraextensions',
  ]);
  assert.deepEqual(planDisable({ installed, level: 'standard', capabilities: ['camera'] }), ['com.android.gallery3d']);
});

const MAPS = 'com.google.android.apps.maps';

test('capacidade location mantem o Google Maps nas listas standard e aggressive', () => {
  assert.ok(managedPackages('standard').includes(MAPS), 'Maps segue na lista gerida');
  const installed = [MAPS, 'com.google.android.youtube', PLAY_STORE];
  for (const level of ['standard', 'aggressive'] as const) {
    const without = planDisable({ installed, level });
    assert.ok(without.includes(MAPS), `${level} sem location desliga o Maps`);
    const withLoc = planDisable({ installed, level, capabilities: ['location'] });
    assert.ok(!withLoc.includes(MAPS), `${level} com location mantem o Maps`);
    assert.deepEqual(withLoc, without.filter((p) => p !== MAPS), `${level}: location so tira o Maps`);
  }
  assert.deepEqual(planDisable({ installed, level: 'aggressive', capabilities: ['location', 'store'] }), ['com.google.android.youtube']);
});

test('planRestore com Maps desligado por bake anterior (sem location) ainda o religa', () => {
  assert.deepEqual(planRestore([MAPS]), [MAPS]);
});

test('planRestore ignora pacote fora da lista gerida e deduplica', () => {
  assert.deepEqual(
    planRestore(['com.google.android.youtube', 'com.example.app', 'com.android.chrome', 'com.google.android.youtube', PLAY_STORE]),
    ['com.google.android.youtube', PLAY_STORE],
  );
  assert.deepEqual(planRestore([]), []);
});

test('tamanho da lista gerida por nivel', () => {
  assert.equal(managedPackages('standard').length, 65);
  assert.equal(managedPackages('aggressive').length, 69);
});
