import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAndroidProfile, formatScreen, parseScreen } from '../src/android/profile.ts';
import { DevslimError } from '../src/errors.ts';

test('padroes', () => {
  assert.deepEqual(buildAndroidProfile(), {
    ramMb: 2048,
    heapMb: 256,
    cores: 2,
    gpu: 'host',
    vulkan: false,
    lowRam: false,
    screen: 'keep',
    port: null,
    capabilities: [],
    grpc: true,
  });
});

test('grpc: ligado por padrao; grpc: false desliga', () => {
  assert.equal(buildAndroidProfile().grpc, true);
  assert.equal(buildAndroidProfile({ grpc: true }).grpc, true);
  assert.equal(buildAndroidProfile({ grpc: false }).grpc, false);
});

test('--aggressive = 1536 + lowRam; RAM explicita vence', () => {
  const a = buildAndroidProfile({ aggressive: true });
  assert.equal(a.ramMb, 1536);
  assert.equal(a.lowRam, true);
  const b = buildAndroidProfile({ aggressive: true, ramMb: 2048 });
  assert.equal(b.ramMb, 2048);
  assert.equal(b.lowRam, true);
});

test('lowRam proprio: liga -lowram sem mexer na RAM; lowRam explicito vence o --aggressive', () => {
  const l = buildAndroidProfile({ lowRam: true });
  assert.equal(l.ramMb, 2048);
  assert.equal(l.lowRam, true);
  const r = buildAndroidProfile({ lowRam: true, ramMb: 3072 });
  assert.deepEqual([r.ramMb, r.lowRam], [3072, true]);
  const a = buildAndroidProfile({ aggressive: true, lowRam: false });
  assert.deepEqual([a.ramMb, a.lowRam], [1536, false]);
  assert.equal(buildAndroidProfile({ lowRam: false }).lowRam, false);
});

test('RAM fora de 1536..8192 da erro claro', () => {
  for (const ramMb of [1024, 1535, 8193, 2048.5]) {
    assert.throws(() => buildAndroidProfile({ ramMb }), (e: unknown) => e instanceof DevslimError && /RAM invalida/.test(e.message));
  }
  assert.equal(buildAndroidProfile({ ramMb: 1536 }).ramMb, 1536);
  assert.equal(buildAndroidProfile({ ramMb: 8192 }).ramMb, 8192);
});

test('porta: par entre 5554 e 5682', () => {
  assert.equal(buildAndroidProfile({ port: 5554 }).port, 5554);
  assert.equal(buildAndroidProfile({ port: 5682 }).port, 5682);
  for (const port of [5553, 5555, 5684, 5000]) assert.throws(() => buildAndroidProfile({ port }), DevslimError);
});

test('screen: keep ou LxA@dpi', () => {
  assert.equal(parseScreen('keep'), 'keep');
  assert.deepEqual(parseScreen('720x1600@320'), { width: 720, height: 1600, density: 320 });
  assert.equal(formatScreen(parseScreen('720x1600@320')), '720x1600@320');
  for (const s of ['720x1600', '720*1600@320', 'x@1', '100x1600@320', '720x1600@1000']) {
    assert.throws(() => parseScreen(s), DevslimError, s);
  }
});

test('gpu invalida e capacidade invalida dao erro', () => {
  assert.throws(() => buildAndroidProfile({ gpu: 'magic' }), DevslimError);
  assert.throws(() => buildAndroidProfile({ capabilities: ['nope'] }), DevslimError);
});

test('perfil e imutavel', () => {
  const p = buildAndroidProfile({ screen: '720x1600@320', capabilities: ['audio'] });
  assert.ok(Object.isFrozen(p));
  assert.ok(Object.isFrozen(p.capabilities));
  assert.ok(Object.isFrozen(p.screen));
  assert.throws(() => { (p as { ramMb: number }).ramMb = 1; }, TypeError);
});
