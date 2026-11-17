import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CAPABILITIES,
  deriveCapabilities,
  parseCapabilities,
  resolveCapabilities,
} from '../src/capabilities.ts';
import { DevslimError } from '../src/errors.ts';

const cases: Array<[string, string]> = [
  ['expo-audio', 'audio'],
  ['expo-av', 'audio'],
  ['expo-camera', 'camera'],
  ['react-native-vision-camera', 'camera'],
  ['react-native-document-scanner-plugin', 'camera'],
  ['@some/vision-document-scanner', 'camera'],
  ['expo-location', 'location'],
  ['react-native-geolocation-service', 'location'],
  ['@react-native-community/geolocation', 'location'],
  ['@rnmapbox/maps', 'location'],
  ['react-native-maps', 'location'],
  ['expo-notifications', 'push'],
  ['@react-native-google-signin/google-signin', 'weblogin'],
  ['expo-web-browser', 'weblogin'],
  ['expo-auth-session', 'weblogin'],
];

test('derivacao por dependencia, em dependencies e devDependencies', () => {
  for (const [dep, cap] of cases) {
    assert.deepEqual(deriveCapabilities({ dependencies: { [dep]: '1.0.0' } }), [cap], dep);
    assert.deepEqual(deriveCapabilities({ devDependencies: { [dep]: '1.0.0' } }), [cap], dep);
  }
});

test('derivacao une, deduplica e ordena', () => {
  const pkg = {
    dependencies: { 'expo-camera': '*', 'expo-av': '*', 'expo-notifications': '*', react: '*' },
    devDependencies: { 'expo-audio': '*', 'expo-web-browser': '*' },
  };
  assert.deepEqual(deriveCapabilities(pkg), ['audio', 'camera', 'push', 'weblogin']);
});

test('store, window e keyboard nunca sao derivados', () => {
  const pkg = {
    dependencies: {
      'react-native-keyboard-controller': '*',
      'react-native-keyboard-aware-scroll-view': '*',
      keyboard: '*',
      'react-native-purchases': '*',
      'react-native-iap': '*',
      'expo-store-review': '*',
      'expo-in-app-purchases': '*',
      store: '*',
      window: '*',
    },
  };
  assert.deepEqual(deriveCapabilities(pkg), []);
});

test('keyboard e capacidade valida (so por --need)', () => {
  assert.ok(CAPABILITIES.includes('keyboard'));
  assert.deepEqual(parseCapabilities('window,keyboard,audio'), ['audio', 'keyboard', 'window']);
});

test('package.json sem dependencias ou malformado nao quebra', () => {
  assert.deepEqual(deriveCapabilities({}), []);
  assert.deepEqual(deriveCapabilities(null), []);
  assert.deepEqual(deriveCapabilities({ dependencies: ['expo-av'] }), []);
});

test('parseCapabilities aceita lista com virgula e repetida', () => {
  assert.deepEqual(parseCapabilities('window, store'), ['store', 'window']);
  assert.deepEqual(parseCapabilities(['audio', 'camera,audio', '']), ['audio', 'camera']);
});

test('capacidade invalida da erro com a lista valida', () => {
  assert.throws(() => parseCapabilities('audio,bluetooth'), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.match(err.message, /bluetooth/);
    for (const c of CAPABILITIES) assert.match(err.message, new RegExp(c));
    assert.match(err.message, /validas: audio, camera, keyboard, location, push, store, weblogin, window\)/);
    return true;
  });
});

test('resolveCapabilities une --need com o package.json de --for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devslim-caps-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'expo-av': '*' } }));
    assert.deepEqual(resolveCapabilities({ need: 'store', forDir: dir }), ['audio', 'store']);
    assert.deepEqual(resolveCapabilities({ forDir: dir }), ['audio']);
    assert.deepEqual(resolveCapabilities({}), []);
    assert.throws(() => resolveCapabilities({ forDir: join(dir, 'nao-existe') }), DevslimError);
    writeFileSync(join(dir, 'package.json'), '{nao e json');
    assert.throws(() => resolveCapabilities({ forDir: dir }), /JSON/);
    assert.throws(() => resolveCapabilities({ need: 'nope' }), DevslimError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
