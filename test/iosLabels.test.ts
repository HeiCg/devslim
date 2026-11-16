import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from '../src/capabilities.ts';
import { DevslimError } from '../src/errors.ts';
import {
  ALWAYS_ENABLED,
  CAPABILITY_KEEPS,
  CATEGORIES,
  CATEGORY_BREAKS,
  CATEGORY_IDS,
  FORBIDDEN,
  labelsToDisable,
  managedSet,
  repairSet,
  touchableSet,
} from '../src/ios/labels.ts';

const allEntries = () => CATEGORY_IDS.flatMap((id) => CATEGORIES[id]);

test('16 categorias, todas com texto do que quebra', () => {
  assert.deepEqual([...CATEGORY_IDS], [
    'widgets', 'siri', 'search', 'icloud', 'store', 'pim', 'web', 'family',
    'health', 'photos', 'apps', 'messaging', 'connectivity', 'telemetry', 'mdm', 'other',
  ]);
  for (const id of CATEGORY_IDS) {
    assert.ok(CATEGORIES[id].length > 0, id);
    assert.ok(CATEGORY_BREAKS[id].length > 10, id);
  }
});

test('invariante: nenhum FORBIDDEN e nenhum ALWAYS_ENABLED em categoria alguma', () => {
  const all = new Set(allEntries());
  for (const l of FORBIDDEN) assert.ok(!all.has(l), `proibido em categoria: ${l}`);
  for (const l of ALWAYS_ENABLED) assert.ok(!all.has(l), `always-enabled em categoria: ${l}`);
  const managed = managedSet();
  for (const l of [...FORBIDDEN, ...ALWAYS_ENABLED]) assert.ok(!managed.has(l), l);
  assert.equal(FORBIDDEN.length, 15);
  assert.deepEqual([...ALWAYS_ENABLED], ['com.apple.assistantd', 'com.apple.gamed', 'com.apple.sharingd']);
});

test('repairSet = ALWAYS_ENABLED, disjunto do managedSet; touchableSet = uniao; labelsToDisable nunca devolve um ALWAYS_ENABLED', () => {
  assert.deepEqual([...repairSet()].sort(), [...ALWAYS_ENABLED].sort());
  const managed = managedSet();
  for (const l of repairSet()) assert.ok(!managed.has(l), l);
  assert.deepEqual([...touchableSet()].sort(), [...new Set([...managed, ...ALWAYS_ENABLED])].sort());
  assert.equal(touchableSet().size, 176);
  const everyProfile = [
    labelsToDisable(),
    ...CAPABILITIES.map((c) => labelsToDisable({ capabilities: [c] })),
    ...CATEGORY_IDS.map((id) => labelsToDisable({ except: [id] })),
  ];
  for (const list of everyProfile) for (const l of ALWAYS_ENABLED) assert.ok(!list.includes(l), l);
  assert.throws(() => labelsToDisable({ keep: ['com.apple.gamed'] }), /fora da lista gerida/);
});

test('todo label comeca com com.apple. e nao repete dentro da categoria', () => {
  for (const id of CATEGORY_IDS) {
    assert.equal(new Set(CATEGORIES[id]).size, CATEGORIES[id].length, `repetido em ${id}`);
    for (const l of CATEGORIES[id]) assert.match(l, /^com\.apple\.[A-Za-z0-9._-]+$/, l);
  }
});

test('contagem: 179 entradas, 173 labels unicos geridos; repetidos so os 6 compartilhados de proposito', () => {
  const all = allEntries();
  assert.equal(all.length, 179);
  assert.equal(managedSet().size, 173);
  const counts = new Map<string, number>();
  for (const l of all) counts.set(l, (counts.get(l) ?? 0) + 1);
  const shared = [...counts].filter(([, n]) => n > 1).map(([l]) => l).sort();
  assert.deepEqual(shared, [
    'com.apple.amsaccountsd',
    'com.apple.amsengagementd',
    'com.apple.amsondevicestoraged',
    'com.apple.financed',
    'com.apple.navd',
    'com.apple.passd',
  ]);
  assert.ok([...counts.values()].every((n) => n <= 2));
});

test('perfil padrao desliga todo o managedSet, ordenado', () => {
  const all = labelsToDisable();
  assert.equal(all.length, 173);
  assert.deepEqual(all, [...managedSet()].sort());
  assert.ok(all.includes('com.apple.apsd'));
  assert.ok(all.includes('com.apple.swcd'));
});

test('cada capacidade religa o esperado', () => {
  const base = new Set(labelsToDisable());
  const religa = (cap: (typeof CAPABILITIES)[number]) => [...base].filter((l) => !labelsToDisable({ capabilities: [cap] }).includes(l)).sort();

  assert.deepEqual(religa('push'), ['com.apple.apsd']);
  assert.deepEqual(religa('weblogin'), [...CATEGORIES.web].sort());
  assert.ok(religa('weblogin').includes('com.apple.swcd'));
  assert.deepEqual(religa('camera'), [...CATEGORIES.photos].sort());
  assert.deepEqual(religa('audio'), []);
  assert.deepEqual(religa('window'), []);
  // location: locationd e geod nao sao geridos; so o XPC do MapKit publico volta.
  assert.deepEqual(religa('location'), ['com.apple.MapKit.SnapshotService']);
  for (const l of ['com.apple.locationd', 'com.apple.geod']) assert.ok(!managedSet().has(l), `${l} fora da lista gerida`);
  const store = religa('store');
  assert.deepEqual(store, [...new Set([...CATEGORIES.store, ...CATEGORIES.icloud])].sort());
  // StoreKit (features.go): passd e financed ficam ligados mesmo listados tambem em `other`.
  for (const l of ['com.apple.storekitd', 'com.apple.itunesstored', 'com.apple.appstored', 'com.apple.passd', 'com.apple.financed', 'com.apple.akd']) {
    assert.ok(store.includes(l), l);
  }
  assert.deepEqual(Object.keys(CAPABILITY_KEEPS).sort(), [...CAPABILITIES].sort());
});

test('except mantem a categoria inteira, inclusive labels compartilhados; keep mantem labels avulsos', () => {
  const r = labelsToDisable({ except: ['widgets'], keep: ['com.apple.triald', 'com.apple.triald'] });
  for (const l of CATEGORIES.widgets) assert.ok(!r.includes(l), l);
  assert.ok(!r.includes('com.apple.navd'), 'navd tambem esta em connectivity, mas widgets mantido o segura');
  assert.ok(!r.includes('com.apple.triald'));
  assert.equal(r.length, 173 - 4 - 1);
  assert.throws(() => labelsToDisable({ except: ['nada'] }), (e: unknown) => e instanceof DevslimError && /categoria desconhecida: nada/.test(e.message));
  assert.throws(() => labelsToDisable({ keep: ['com.apple.sleepd'] }), /label fora da lista gerida: com\.apple\.sleepd/);
});
