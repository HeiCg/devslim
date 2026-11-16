import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { loadSession } from '../src/android/session.ts';
import { DevslimError } from '../src/errors.ts';
import type { Exec } from '../src/exec.ts';
import { parseStorePlist, readStore, serializeStorePlist, storePath } from '../src/ios/disabledStore.ts';
import { createFakeIos, type FakeIosOptions } from '../src/ios/fakeIos.ts';
import { ALWAYS_ENABLED, CATEGORIES, CATEGORY_IDS, labelsToDisable, managedSet, touchableSet } from '../src/ios/labels.ts';
import { checkIosRuntime, downSim, offSim, planSim, upSim, type IosContext } from '../src/ios/slim.ts';
import { loadState, saveState, type IosState } from '../src/state.ts';

const UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';
const OTHER = '71DA7575-EE5E-4B6A-82B4-54084F780EA9';
const RUNTIME_STORE = readFileSync(new URL('./fixtures/ios/disabled.runtime.plist', import.meta.url), 'utf8');
const MANAGED = managedSet();
const TOUCHABLE = touchableSet();
const ALL = labelsToDisable();
const REPAIR = [...ALWAYS_ENABLED].sort();

let root: string;
let base: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devslim-ios-'));
  base = join(root, 'var-tmp');
  home = join(root, 'devslim-home');
  mkdirSync(base);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function world(o: Partial<FakeIosOptions> = {}, env: Record<string, string> = {}) {
  const fake = createFakeIos({
    storeBase: base,
    simulators: [{ udid: UDID, name: 'QA-iPhone17' }, { udid: OTHER, name: 'QA-iPhone17b' }],
    ...o,
  });
  const stderr: string[] = [];
  const ctx: IosContext = {
    env: { DEVSLIM_HOME: home, HOME: root, ...env },
    exec: fake.exec,
    sleep: fake.sleep,
    now: fake.now,
    date: fake.date,
    fileExists: fake.fileExists,
    stderr: (t) => { stderr.push(t); },
    storeBase: base,
  };
  return { fake, ctx, stderr };
}

function seedStore(udid: string, entries: Map<string, boolean>): void {
  const p = storePath(udid, { base });
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, serializeStorePlist(entries));
}

const fileStore = (udid = UDID) => parseStorePlist(readFileSync(storePath(udid, { base }), 'utf8'));
const fakeState = (w: { fake: { sims: Map<string, { state: string }> } }) => w.fake.sims.get(UDID)!.state;
const launchctlCalls = (calls: { cmd: string; args: string[] }[]) =>
  calls.filter((c) => c.cmd === 'xcrun' && c.args[3] === 'launchctl' && /^(disable|enable)$/.test(c.args[4]));

test('gate: so iOS >= 18.5; outra plataforma fora de escopo', async () => {
  assert.throws(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '18.4' }), /iOS 18\.4 nao suportado: exige iOS 18\.5/);
  assert.throws(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '17.5' }), DevslimError);
  assert.doesNotThrow(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '18.5' }));
  assert.doesNotThrow(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '26.4' }));
  assert.throws(() => checkIosRuntime({ identifier: 'x', platform: 'tvOS', version: '26.4' }), /fora de escopo/);

  const old = 'com.apple.CoreSimulator.SimRuntime.iOS-18-4';
  const { ctx, fake } = world({
    simulators: [{ udid: UDID, name: 'velho', runtimeId: old }],
    runtimes: [{ identifier: old, platform: 'iOS', version: '18.4' }],
  });
  await assert.rejects(upSim('velho', {}, ctx), /iOS 18\.4 nao suportado/);
  assert.ok(!fake.simctlCommands().some((c) => /^(boot|shutdown|spawn)/.test(c)), 'gate antes de qualquer efeito');
  assert.deepEqual(readdirSync(base), []);
});

test('plan: so leitura; conta labels e quantos ja estao no store', async () => {
  const { ctx, fake } = world();
  seedStore(UDID, new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.apsd', true], ['com.apple.triald', true]]));
  const before = readFileSync(storePath(UDID, { base }), 'utf8');
  const p = await planSim('QA-iPhone17', { capabilities: ['push'] }, ctx);
  assert.equal(p.udid, UDID);
  assert.deepEqual(p.runtime, { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', platform: 'iOS', version: '26.4' });
  assert.equal(p.labels.length, 172);
  assert.equal(p.managedTotal, 173);
  assert.equal(p.alreadyInStore, 1, 'apsd esta no store mas push o mantem; so triald conta');
  assert.equal(p.storeExists, true);
  assert.equal(p.hasState, false);
  assert.deepEqual(fake.simctlCommands(), ['list devices -j', 'list runtimes -j']);
  assert.equal(readFileSync(storePath(UDID, { base }), 'utf8'), before);
  assert.ok(!existsSync(home));
});

test('up de device desligado: store mesclado, backup no state, boot, conferencia, sessao', async () => {
  const { ctx, fake } = world();
  const alien = new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.alheio', true], ['com.apple.apsd', false]]);
  seedStore(UDID, alien);
  const r = await upSim(UDID, {}, ctx);
  assert.equal(r.alreadySlim, false);
  assert.equal(r.labels, 173);
  assert.equal(r.storeChanges, 173);
  assert.equal(r.fallback.used, false);
  assert.deepEqual(r.notApplied, []);
  assert.equal(r.backupAdded, 173);

  const store = fileStore();
  for (const l of ALL) assert.equal(store.get(l), true, l);
  for (const [l, v] of parseStorePlist(RUNTIME_STORE)) assert.equal(store.get(l), v, `entrada do runtime preservada: ${l}`);
  assert.equal(store.get('com.apple.alheio'), true);

  const st = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  assert.equal(st.backup['com.apple.apsd'], false);
  assert.equal(st.backup['com.apple.triald'], null);
  assert.equal(Object.keys(st.backup).length, 173);

  assert.deepEqual(fake.simctlCommands(), [
    'list devices -j',
    'list runtimes -j',
    'list devices booted -j',
    `boot ${UDID}`,
    `bootstatus ${UDID} -b`,
    `spawn ${UDID} launchctl print-disabled system`,
  ]);
  assert.deepEqual(loadSession(ctx.env).map((e) => [e.platform, e.serial, e.avd]), [['ios', UDID, 'QA-iPhone17']]);
  assert.equal(fake.sims.get(UDID)!.state, 'Booted');
});

test('bootado e ja cobrindo o perfil: alreadySlim, sem shutdown nem escrita', async () => {
  const live = Object.fromEntries(ALL.map((l) => [l, true]));
  const { ctx, fake } = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live }] });
  const r = await upSim('QA-iPhone17', {}, ctx);
  assert.equal(r.alreadySlim, true);
  assert.equal(r.statePath, null);
  assert.ok(!fake.simctlCommands().some((c) => /^(shutdown|boot )/.test(c)));
  assert.deepEqual(readdirSync(base), []);
  assert.deepEqual(loadSession(ctx.env), [], 'nao foi subido pelo devslim');
});

test('bootado e divergente: shutdown ANTES de escrever o store; alvo bootado nao conta na guarda', async () => {
  const { ctx, fake } = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live: { 'com.apple.apsd': true } }] });
  const p = storePath(UDID, { base });
  const seen: boolean[] = [];
  const exec: Exec = async (cmd, args, o) => {
    if (cmd === 'xcrun' && args[1] === 'shutdown') seen.push(existsSync(p));
    return fake.exec(cmd, args, o);
  };
  const r = await upSim(UDID, {}, { ...ctx, exec });
  assert.deepEqual(seen, [false], 'store ainda nao existia no shutdown');
  assert.equal(r.shutdownFirst, true);
  assert.equal(r.wasBooted, true);
  const cmds = fake.simctlCommands();
  assert.ok(cmds.indexOf(`shutdown ${UDID}`) < cmds.indexOf(`boot ${UDID}`));
  assert.equal(fake.sims.get(UDID)!.state, 'Booted');
  assert.deepEqual(r.notApplied, []);
});

test('guarda: outro simulador bootado ou emulador recusa; --force passa; aviso de swap', async () => {
  const a = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17' }, { udid: OTHER, name: 'QA-iPhone17b', state: 'Booted' }] });
  await assert.rejects(upSim(UDID, {}, a.ctx), /ios up recusado: ja ha device rodando: simulador QA-iPhone17b/);
  assert.deepEqual(readdirSync(base), []);

  const b = world({ emulators: ['emulator-5554'] }, { ANDROID_HOME: '/fake-sdk' });
  await assert.rejects(upSim(UDID, {}, b.ctx), /emulador emulator-5554/);

  const c = world({ emulators: ['emulator-5554'], swap: 'total = 18432.00M  used = 17704.94M  free = 727.06M  (encrypted)' }, { ANDROID_HOME: '/fake-sdk' });
  const r = await upSim(UDID, {}, { ...c.ctx, force: true });
  assert.equal(r.alreadySlim, false);
  assert.match(c.stderr.join(''), /aviso: swap em 96\.1% \(17704\.9 de 18432 MB\): nao boote device agora \(--force: bootando mesmo assim\)/);
});

const swapAt = (pct: number) => `total = 1000.00M  used = ${pct * 10}.00M  free = ${1000 - pct * 10}.00M  (encrypted)`;

test('swap no ios up: 96% recusa sem --force antes de qualquer efeito; 85% avisa e boota', async () => {
  const hi = world({ swap: swapAt(96) });
  await assert.rejects(upSim(UDID, {}, hi.ctx), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.equal(err.message, 'ios up recusado: swap em 96% (960 de 1000 MB): nao boote device agora; feche apps, sessoes e devices ociosos antes de subir device (--force para bootar mesmo assim)');
    return true;
  });
  assert.ok(!hi.fake.simctlCommands().some((c) => /^(boot|shutdown)/.test(c)), 'nada bootado');
  assert.deepEqual(readdirSync(base), [], 'store intocado');

  const mid = world({ swap: swapAt(85) });
  const r = await upSim(UDID, {}, mid.ctx);
  assert.equal(fakeState(mid), 'Booted');
  assert.equal(r.alreadySlim, false);
  assert.match(mid.stderr.join(''), /aviso: swap em 85% .*acima de 80%/);
});

test('swap no ios up: device ja bootado e enxuto a 96% nao e bloqueado; divergente (reboot) e', async () => {
  const live = Object.fromEntries(ALL.map((l) => [l, true]));
  const slim = world({ swap: swapAt(96), simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live }] });
  const r = await upSim('QA-iPhone17', {}, slim.ctx);
  assert.equal(r.alreadySlim, true);

  const div = world({ swap: swapAt(96), simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live: { 'com.apple.apsd': true } }] });
  await assert.rejects(upSim(UDID, {}, div.ctx), /ios up recusado: swap em 96%/);
  assert.ok(!div.fake.simctlCommands().some((c) => /^shutdown/.test(c)), 'nao desligou o device');
});

test('segundo up: primeiro backup vence; labels que saem do perfil voltam ao valor salvo', async () => {
  const { ctx, fake } = world();
  seedStore(UDID, new Map([['com.apple.apsd', false], ['com.apple.PosterBoard', true]]));
  await upSim(UDID, {}, ctx);
  const first = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  assert.equal(first.backup['com.apple.apsd'], false);
  assert.equal(first.backup['com.apple.PosterBoard'], true);
  assert.equal(first.backup['com.apple.chronod'], null);

  // segundo up com perfil diferente (device bootado e divergente): backup nao muda.
  const r = await upSim(UDID, { capabilities: ['push'], except: ['widgets'] }, ctx);
  const second = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  assert.deepEqual(second.backup, first.backup, 'primeiro backup preservado');
  assert.equal(second.backupSavedAt, first.backupSavedAt);
  assert.deepEqual(second.profile.except, ['widgets']);
  const store = fileStore();
  assert.equal(store.get('com.apple.apsd'), false, 'apsd volta ao <false/> salvo');
  assert.equal(store.get('com.apple.chronod'), false, 'ausente antes = false');
  assert.equal(store.get('com.apple.PosterBoard'), true, 'ja estava desligado antes de nos');
  assert.equal(store.get('com.apple.navd'), false, 'widgets mantido segura o navd compartilhado');
  assert.ok(r.restored.includes('com.apple.apsd'));
  assert.ok(r.restored.includes('com.apple.chronod'));
  assert.ok(!r.restored.includes('com.apple.PosterBoard'));
  assert.equal(fake.sims.get(UDID)!.live.get('com.apple.apsd'), false);
  assert.deepEqual([...r.notApplied, ...r.notRestored], []);
});

test('fallback: store ignorado -> launchctl em pool de no maximo 8, reboot, conferencia', async () => {
  const { ctx, fake } = world({ storeHonored: false });
  const r = await upSim(UDID, {}, ctx);
  assert.equal(r.fallback.used, true);
  assert.equal(r.fallback.passes, 1);
  assert.equal(r.fallback.rebooted, true);
  assert.deepEqual(r.notApplied, []);
  const calls = launchctlCalls(fake.calls);
  assert.equal(calls.length, 173);
  assert.equal(fake.concurrency.max, 8, 'pool cheio, nunca acima de 8');
  const cmds = fake.simctlCommands();
  const lastLaunchctl = cmds.map((c) => c.includes('launchctl disable')).lastIndexOf(true);
  assert.deepEqual(cmds.slice(lastLaunchctl + 1), [
    `shutdown ${UDID}`,
    'list devices -j',
    `boot ${UDID}`,
    `bootstatus ${UDID} -b`,
    `spawn ${UDID} launchctl print-disabled system`,
  ]);
});

test('fallback: no maximo 3 passadas; label que nao pega vai para notApplied', async () => {
  const { ctx, fake } = world({
    storeHonored: false,
    launchctlFailures: { 'com.apple.triald': 99, 'com.apple.cloudd': 1 },
    stubborn: ['com.apple.mobileassetd'],
  });
  const r = await upSim(UDID, {}, ctx);
  assert.equal(r.fallback.passes, 3);
  assert.deepEqual(r.fallback.failed, ['com.apple.triald']);
  assert.deepEqual(r.notApplied, ['com.apple.mobileassetd', 'com.apple.triald']);
  const calls = launchctlCalls(fake.calls);
  assert.equal(calls.filter((c) => c.args[5] === 'system/com.apple.triald').length, 3);
  assert.equal(calls.filter((c) => c.args[5] === 'system/com.apple.cloudd').length, 2);
  assert.ok(fake.concurrency.max <= 8);
  assert.deepEqual(fake.sleeps.filter((ms) => ms >= 1000), [1000, 2000], 'pausa entre passadas');
});

test('off: devolve valores salvos, grava false onde era ausente, limpa state; sem state = erro', async () => {
  const { ctx, fake } = world();
  await assert.rejects(offSim(UDID, ctx), /sem state para QA-iPhone17/);

  const seed = new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.apsd', false], ['com.apple.PosterBoard', true], ['com.apple.alheio', true]]);
  seedStore(UDID, seed);
  await upSim(UDID, {}, ctx);
  const r = await offSim(UDID, ctx);
  assert.equal(r.wasBooted, true);
  assert.equal(r.rebooted, true);
  assert.equal(r.restored, 173);
  assert.deepEqual(r.notRestored, []);
  const store = fileStore();
  assert.equal(store.get('com.apple.apsd'), false);
  assert.equal(store.get('com.apple.PosterBoard'), true);
  assert.equal(store.get('com.apple.triald'), false, 'ausente antes = false');
  assert.equal(store.get('com.apple.alheio'), true, 'alheio intocado');
  for (const [l, v] of parseStorePlist(RUNTIME_STORE)) assert.equal(store.get(l), v);
  assert.equal(loadState('ios', UDID, { env: ctx.env }), null);
  const cmds = fake.simctlCommands();
  const off = cmds.slice(cmds.lastIndexOf('list devices -j', cmds.indexOf(`shutdown ${UDID}`)));
  assert.equal(off[1], `shutdown ${UDID}`);
  assert.equal(fake.sims.get(UDID)!.state, 'Booted', 'estava bootado: reboota');

  // desligado: nao reboota
  await upSim(UDID, {}, ctx);
  fake.sims.get(UDID)!.state = 'Shutdown';
  const r2 = await offSim(UDID, ctx);
  assert.equal(r2.rebooted, false);
  assert.equal(fake.sims.get(UDID)!.state, 'Shutdown');
});

test('invariante: nada fora de managedSet() + ALWAYS_ENABLED e tocado; ALWAYS_ENABLED nunca recebe disable', async () => {
  const { ctx, fake } = world({ storeHonored: false, launchctlFailures: { 'com.apple.swcd': 1 } });
  const seed = new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.alheio', true], ['com.apple.sharingd', true]]);
  seedStore(UDID, seed);
  fake.sims.get(UDID)!.overrides.set('com.apple.gamed', true); // desligado por fora: fallback religa
  await upSim(UDID, { capabilities: ['store'] }, ctx);
  assert.equal((await readStore(UDID, { base })).get('com.apple.sharingd'), false, 'reparado no up');
  // state adulterado com label fora da lista: off ignora
  const st = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  saveState('ios', UDID, { ...st, backup: { ...st.backup, 'com.apple.sleepd': null, 'com.apple.alheio': false } }, { env: ctx.env });
  const off = await offSim(UDID, ctx);
  assert.deepEqual(off.ignored, ['com.apple.alheio', 'com.apple.sleepd']);

  const calls = launchctlCalls(fake.calls);
  assert.ok(calls.some((c) => c.args[4] === 'enable' && c.args[5] === 'system/com.apple.gamed'));
  for (const c of calls) {
    const label = c.args[5].replace(/^system\//, '');
    assert.ok(TOUCHABLE.has(label), `launchctl em label fora da lista: ${label}`);
    if (c.args[4] === 'disable') assert.ok(MANAGED.has(label), `disable em ALWAYS_ENABLED: ${label}`);
  }
  const store = await readStore(UDID, { base });
  for (const [l, v] of seed) {
    if (!TOUCHABLE.has(l)) assert.equal(store.get(l), v, `entrada nao gerida mudou: ${l}`);
  }
  assert.equal(store.get('com.apple.sharingd'), true, 'off devolve o valor salvo');
  assert.equal(store.has('com.apple.sleepd'), false);
  for (const l of store.keys()) assert.ok(TOUCHABLE.has(l) || seed.has(l), `chave nova fora da lista: ${l}`);
  assert.equal(store.has('com.apple.assistantd'), false, 'ALWAYS_ENABLED ausente nao ganha chave');
  // capacidade store: categorias store+icloud nunca recebem true
  for (const l of [...CATEGORIES.store, ...CATEGORIES.icloud]) assert.notEqual(store.get(l), true, l);
});

test('reparo: os 3 ALWAYS_ENABLED em true no store -> plan relata, up grava false com backup e confere, off devolve', async () => {
  const { ctx, fake } = world();
  const seed = new Map([...parseStorePlist(RUNTIME_STORE), ...REPAIR.map((l): [string, boolean] => [l, true])]);
  seedStore(UDID, seed);

  const p = await planSim('QA-iPhone17', {}, ctx);
  assert.deepEqual(p.repair, REPAIR);
  assert.equal(fileStore().get('com.apple.gamed'), true, 'plan nao escreve');

  const r = await upSim(UDID, {}, ctx);
  assert.deepEqual(r.repaired, REPAIR);
  assert.equal(r.storeChanges, 173 + 3);
  assert.equal(r.backupAdded, 173 + 3);
  assert.deepEqual([...r.notApplied, ...r.notRestored], []);
  assert.ok(!r.restored.some((l) => REPAIR.includes(l)), 'reparo nao entra em restored');
  const store = fileStore();
  for (const l of REPAIR) assert.equal(store.get(l), false, l);
  const st = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  for (const l of REPAIR) assert.equal(st.backup[l], true, `backup de ${l}`);
  for (const l of REPAIR) assert.equal(fake.sims.get(UDID)!.live.get(l), false, `ligado no launchd vivo: ${l}`);
  assert.ok(!launchctlCalls(fake.calls).length, 'store pegou; sem fallback');

  // plan depois do reparo: nada a reparar
  assert.deepEqual((await planSim(UDID, {}, ctx)).repair, []);

  // segundo up (outro perfil, device bootado): backup true NAO religa o desligamento
  await upSim(UDID, { capabilities: ['push'] }, ctx);
  for (const l of REPAIR) assert.equal(fileStore().get(l), false, `segundo up manteve ${l} ligado`);
  assert.equal(loadState<IosState>('ios', UDID, { env: ctx.env })!.backup['com.apple.gamed'], true, 'primeiro backup vence');

  const off = await offSim(UDID, ctx);
  assert.equal(off.restored, 176);
  assert.deepEqual(off.ignored, []);
  for (const l of REPAIR) assert.equal(fileStore().get(l), true, `off devolve ${l}`);
});

test('reparo: device bootado com ALWAYS_ENABLED desligado nao e alreadySlim', async () => {
  const live = { ...Object.fromEntries(ALL.map((l) => [l, true])), 'com.apple.assistantd': true };
  const { ctx } = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live }] });
  seedStore(UDID, new Map([...ALL.map((l): [string, boolean] => [l, true]), ['com.apple.assistantd', true]]));
  const r = await upSim(UDID, {}, ctx);
  assert.equal(r.alreadySlim, false);
  assert.equal(r.shutdownFirst, true);
  assert.deepEqual(r.repaired, ['com.apple.assistantd']);
  assert.equal(r.storeChanges, 1);
  assert.equal(fileStore().get('com.apple.assistantd'), false);
  assert.deepEqual(r.notRestored, []);
});

test('reparo: --keep/--except nao impedem; --keep de ALWAYS_ENABLED e recusado antes de escrever', async () => {
  const { ctx } = world();
  seedStore(UDID, new Map([['com.apple.gamed', true], ['com.apple.sharingd', true]]));
  const before = readFileSync(storePath(UDID, { base }), 'utf8');
  await assert.rejects(upSim(UDID, { keep: ['com.apple.gamed'] }, ctx), /label fora da lista gerida: com\.apple\.gamed/);
  assert.equal(readFileSync(storePath(UDID, { base }), 'utf8'), before);

  const r = await upSim(UDID, { except: [...CATEGORY_IDS], keep: [] }, ctx);
  assert.equal(r.labels, 0);
  assert.deepEqual(r.repaired, ['com.apple.gamed', 'com.apple.sharingd']);
  const store = fileStore();
  assert.equal(store.get('com.apple.gamed'), false);
  assert.equal(store.get('com.apple.sharingd'), false);
  assert.equal(store.has('com.apple.assistantd'), false, 'ausente continua ausente');
  for (const l of ALL) assert.notEqual(store.get(l), true, `except total nao desliga ${l}`);
});

test('reparo: launchd vivo ainda com ALWAYS_ENABLED desligado apos o boot -> fallback usa launchctl enable', async () => {
  const { ctx, fake } = world({ storeHonored: false });
  fake.sims.get(UDID)!.overrides.set('com.apple.sharingd', true);
  const r = await upSim(UDID, { except: [...CATEGORY_IDS] }, ctx);
  assert.equal(r.fallback.used, true);
  const calls = launchctlCalls(fake.calls).map((c) => `${c.args[4]} ${c.args[5]}`);
  assert.deepEqual(calls, ['enable system/com.apple.sharingd']);
  assert.deepEqual(r.notRestored, []);
  assert.equal(fake.sims.get(UDID)!.live.get('com.apple.sharingd'), false);
});

test('window abre o Simulator.app no fim; falha so avisa', async () => {
  const a = world();
  const r = await upSim(UDID, { capabilities: ['window'] }, a.ctx);
  assert.equal(r.windowOpened, true);
  assert.deepEqual(a.fake.calls.at(-1)!.args, ['-a', 'Simulator']);
  const b = world({ openFails: true });
  const r2 = await upSim(UDID, { capabilities: ['window'] }, b.ctx);
  assert.equal(r2.windowOpened, false);
  assert.match(b.stderr.join(''), /open -a Simulator falhou/);
});

test('down: so o que a sessao subiu; nome fora da sessao exige --force', async () => {
  const { ctx, fake } = world();
  assert.deepEqual(await downSim(undefined, ctx), []);
  await upSim(UDID, {}, ctx);
  fake.sims.get(OTHER)!.state = 'Booted';
  await assert.rejects(downSim('QA-iPhone17b', ctx), /nao foi subido pelo devslim/);
  const res = await downSim(undefined, ctx);
  assert.deepEqual(res.map((x) => [x.udid, x.result]), [[UDID, 'shutdown']]);
  assert.equal(fake.sims.get(UDID)!.state, 'Shutdown');
  assert.equal(fake.sims.get(OTHER)!.state, 'Booted');
  assert.deepEqual(loadSession(ctx.env), []);
  const forced = await downSim(undefined, { ...ctx, force: true });
  assert.deepEqual(forced.map((x) => [x.udid, x.registered, x.result]), [[OTHER, false, 'shutdown']]);
});
