import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { loadSession, recordSession } from '../src/android/session.ts';
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

test('gate: only iOS >= 18.5; other platforms out of scope', async () => {
  assert.throws(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '18.4' }), /iOS 18\.4 not supported: requires iOS 18\.5/);
  assert.throws(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '17.5' }), DevslimError);
  assert.doesNotThrow(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '18.5' }));
  assert.doesNotThrow(() => checkIosRuntime({ identifier: 'x', platform: 'iOS', version: '26.4' }));
  assert.throws(() => checkIosRuntime({ identifier: 'x', platform: 'tvOS', version: '26.4' }), /out of scope/);

  const old = 'com.apple.CoreSimulator.SimRuntime.iOS-18-4';
  const { ctx, fake } = world({
    simulators: [{ udid: UDID, name: 'old', runtimeId: old }],
    runtimes: [{ identifier: old, platform: 'iOS', version: '18.4' }],
  });
  await assert.rejects(upSim('old', {}, ctx), /iOS 18\.4 not supported/);
  assert.ok(!fake.simctlCommands().some((c) => /^(boot|shutdown|spawn)/.test(c)), 'gate before any side effect');
  assert.deepEqual(readdirSync(base), []);
});

test('plan: read-only; counts labels and how many are already in the store', async () => {
  const { ctx, fake } = world();
  seedStore(UDID, new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.apsd', true], ['com.apple.triald', true]]));
  const before = readFileSync(storePath(UDID, { base }), 'utf8');
  const p = await planSim('QA-iPhone17', { capabilities: ['push'] }, ctx);
  assert.equal(p.udid, UDID);
  assert.deepEqual(p.runtime, { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', platform: 'iOS', version: '26.4' });
  assert.equal(p.labels.length, 172);
  assert.equal(p.managedTotal, 173);
  assert.equal(p.alreadyInStore, 1, 'apsd is in the store but push keeps it; only triald counts');
  assert.equal(p.storeExists, true);
  assert.equal(p.hasState, false);
  assert.deepEqual(fake.simctlCommands(), ['list devices -j', 'list runtimes -j']);
  assert.equal(readFileSync(storePath(UDID, { base }), 'utf8'), before);
  assert.ok(!existsSync(home));
});

test('up of a shut down device: merged store, backup in state, boot, verification, session', async () => {
  const { ctx, fake } = world();
  const alien = new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.foreign', true], ['com.apple.apsd', false]]);
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
  for (const [l, v] of parseStorePlist(RUNTIME_STORE)) assert.equal(store.get(l), v, `runtime entry preserved: ${l}`);
  assert.equal(store.get('com.apple.foreign'), true);

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

test('booted and already matching the profile: alreadySlim, no shutdown or write', async () => {
  const live = Object.fromEntries(ALL.map((l) => [l, true]));
  const { ctx, fake } = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live }] });
  const r = await upSim('QA-iPhone17', {}, ctx);
  assert.equal(r.alreadySlim, true);
  assert.equal(r.statePath, null);
  assert.ok(!fake.simctlCommands().some((c) => /^(shutdown|boot )/.test(c)));
  assert.deepEqual(readdirSync(base), []);
  assert.deepEqual(loadSession(ctx.env), [], 'not started by devslim');
});

test('booted and diverging: shutdown BEFORE writing the store; the booted target does not count in the guard', async () => {
  const { ctx, fake } = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live: { 'com.apple.apsd': true } }] });
  const p = storePath(UDID, { base });
  const seen: boolean[] = [];
  const exec: Exec = async (cmd, args, o) => {
    if (cmd === 'xcrun' && args[1] === 'shutdown') seen.push(existsSync(p));
    return fake.exec(cmd, args, o);
  };
  const r = await upSim(UDID, {}, { ...ctx, exec });
  assert.deepEqual(seen, [false], 'store did not exist yet at shutdown');
  assert.equal(r.shutdownFirst, true);
  assert.equal(r.wasBooted, true);
  const cmds = fake.simctlCommands();
  assert.ok(cmds.indexOf(`shutdown ${UDID}`) < cmds.indexOf(`boot ${UDID}`));
  assert.equal(fake.sims.get(UDID)!.state, 'Booted');
  assert.deepEqual(r.notApplied, []);
});

test('booted and diverging: the reboot belongs to devslim, so it enters the session; ios down without --force shuts it down', async () => {
  const { ctx, fake } = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live: { 'com.apple.apsd': true } }] });
  const r = await upSim(UDID, {}, ctx);
  assert.equal(r.wasBooted, true);
  assert.equal(r.shutdownFirst, true);
  assert.deepEqual(loadSession(ctx.env).map((e) => [e.platform, e.serial, e.avd, e.startedAt]), [['ios', UDID, 'QA-iPhone17', '2026-11-16T12:00:00.000Z']]);
  const down = await downSim(undefined, ctx);
  assert.deepEqual(down.map((d) => [d.udid, d.result]), [[UDID, 'shutdown']]);
  assert.equal(fake.sims.get(UDID)!.state, 'Shutdown');
  assert.deepEqual(loadSession(ctx.env), []);
});

test('booted and diverging already in the session: reboot keeps the existing entry (and the watcher record)', async () => {
  const { ctx } = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live: { 'com.apple.apsd': true } }] });
  const idleDown = { ms: 120_000, watcherPid: 777, startedAt: 'w' };
  recordSession({ platform: 'ios', avd: 'QA-iPhone17', serial: UDID, pid: 0, port: 0, startedAt: 'before', idleDown }, ctx.env);
  const r = await upSim(UDID, {}, ctx);
  assert.equal(r.shutdownFirst, true);
  assert.deepEqual(loadSession(ctx.env), [{ platform: 'ios', avd: 'QA-iPhone17', serial: UDID, pid: 0, port: 0, startedAt: 'before', idleDown }]);
});

test('guard: another booted simulator or emulator refuses; --force passes; swap warning', async () => {
  const a = world({ simulators: [{ udid: UDID, name: 'QA-iPhone17' }, { udid: OTHER, name: 'QA-iPhone17b', state: 'Booted' }] });
  await assert.rejects(upSim(UDID, {}, a.ctx), /ios up refused: a device is already running: simulator QA-iPhone17b/);
  assert.deepEqual(readdirSync(base), []);

  const b = world({ emulators: ['emulator-5554'] }, { ANDROID_HOME: '/fake-sdk' });
  await assert.rejects(upSim(UDID, {}, b.ctx), /emulator emulator-5554/);

  const c = world({ emulators: ['emulator-5554'], swap: 'total = 18432.00M  used = 17704.94M  free = 727.06M  (encrypted)' }, { ANDROID_HOME: '/fake-sdk' });
  const r = await upSim(UDID, {}, { ...c.ctx, force: true });
  assert.equal(r.alreadySlim, false);
  assert.match(c.stderr.join(''), /warning: swap at 96\.1% \(17704\.9 of 18432 MB\): do not boot a device now \(--force: booting anyway\)/);
});

const swapAt = (pct: number) => `total = 1000.00M  used = ${pct * 10}.00M  free = ${1000 - pct * 10}.00M  (encrypted)`;

test('swap on ios up: 96% refuses without --force before any side effect; 85% warns and boots', async () => {
  const hi = world({ swap: swapAt(96) });
  await assert.rejects(upSim(UDID, {}, hi.ctx), (err: unknown) => {
    assert.ok(err instanceof DevslimError);
    assert.equal(err.message, 'ios up refused: swap at 96% (960 of 1000 MB): do not boot a device now; close idle apps, sessions and devices before starting a device (--force to boot anyway)');
    return true;
  });
  assert.ok(!hi.fake.simctlCommands().some((c) => /^(boot|shutdown)/.test(c)), 'nothing booted');
  assert.deepEqual(readdirSync(base), [], 'store untouched');

  const mid = world({ swap: swapAt(85) });
  const r = await upSim(UDID, {}, mid.ctx);
  assert.equal(fakeState(mid), 'Booted');
  assert.equal(r.alreadySlim, false);
  assert.match(mid.stderr.join(''), /warning: swap at 85% .*above 80%/);
});

test('swap on ios up: device already booted and slim at 96% is not blocked; diverging (reboot) is', async () => {
  const live = Object.fromEntries(ALL.map((l) => [l, true]));
  const slim = world({ swap: swapAt(96), simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live }] });
  const r = await upSim('QA-iPhone17', {}, slim.ctx);
  assert.equal(r.alreadySlim, true);

  const div = world({ swap: swapAt(96), simulators: [{ udid: UDID, name: 'QA-iPhone17', state: 'Booted', live: { 'com.apple.apsd': true } }] });
  await assert.rejects(upSim(UDID, {}, div.ctx), /ios up refused: swap at 96%/);
  assert.ok(!div.fake.simctlCommands().some((c) => /^shutdown/.test(c)), 'did not shut down the device');
});

test('second up: first backup wins; labels leaving the profile return to the saved value', async () => {
  const { ctx, fake } = world();
  seedStore(UDID, new Map([['com.apple.apsd', false], ['com.apple.PosterBoard', true]]));
  await upSim(UDID, {}, ctx);
  const first = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  assert.equal(first.backup['com.apple.apsd'], false);
  assert.equal(first.backup['com.apple.PosterBoard'], true);
  assert.equal(first.backup['com.apple.chronod'], null);

  // second up with a different profile (device booted and diverging): backup does not change.
  const r = await upSim(UDID, { capabilities: ['push'], except: ['widgets'] }, ctx);
  const second = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  assert.deepEqual(second.backup, first.backup, 'first backup preserved');
  assert.equal(second.backupSavedAt, first.backupSavedAt);
  assert.deepEqual(second.profile.except, ['widgets']);
  const store = fileStore();
  assert.equal(store.get('com.apple.apsd'), false, 'apsd returns to the saved <false/>');
  assert.equal(store.get('com.apple.chronod'), false, 'absent before = false');
  assert.equal(store.get('com.apple.PosterBoard'), true, 'was already disabled before us');
  assert.equal(store.get('com.apple.navd'), false, 'kept widgets holds the shared navd');
  assert.ok(r.restored.includes('com.apple.apsd'));
  assert.ok(r.restored.includes('com.apple.chronod'));
  assert.ok(!r.restored.includes('com.apple.PosterBoard'));
  assert.equal(fake.sims.get(UDID)!.live.get('com.apple.apsd'), false);
  assert.deepEqual([...r.notApplied, ...r.notRestored], []);
});

test('fallback: store ignored -> launchctl in a pool of at most 8, reboot, verification', async () => {
  const { ctx, fake } = world({ storeHonored: false });
  const r = await upSim(UDID, {}, ctx);
  assert.equal(r.fallback.used, true);
  assert.equal(r.fallback.passes, 1);
  assert.equal(r.fallback.rebooted, true);
  assert.deepEqual(r.notApplied, []);
  const calls = launchctlCalls(fake.calls);
  assert.equal(calls.length, 173);
  assert.equal(fake.concurrency.max, 8, 'full pool, never above 8');
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

test('fallback: at most 3 passes; a label that does not stick goes to notApplied', async () => {
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
  assert.deepEqual(fake.sleeps.filter((ms) => ms >= 1000), [1000, 2000], 'pause between passes');
});

test('off: restores saved values, writes false where absent, clears state; no state = error', async () => {
  const { ctx, fake } = world();
  await assert.rejects(offSim(UDID, ctx), /no state for QA-iPhone17/);

  const seed = new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.apsd', false], ['com.apple.PosterBoard', true], ['com.apple.foreign', true]]);
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
  assert.equal(store.get('com.apple.triald'), false, 'absent before = false');
  assert.equal(store.get('com.apple.foreign'), true, 'foreign untouched');
  for (const [l, v] of parseStorePlist(RUNTIME_STORE)) assert.equal(store.get(l), v);
  assert.equal(loadState('ios', UDID, { env: ctx.env }), null);
  const cmds = fake.simctlCommands();
  const off = cmds.slice(cmds.lastIndexOf('list devices -j', cmds.indexOf(`shutdown ${UDID}`)));
  assert.equal(off[1], `shutdown ${UDID}`);
  assert.equal(fake.sims.get(UDID)!.state, 'Booted', 'was booted: reboots');

  // shut down: does not reboot
  await upSim(UDID, {}, ctx);
  fake.sims.get(UDID)!.state = 'Shutdown';
  const r2 = await offSim(UDID, ctx);
  assert.equal(r2.rebooted, false);
  assert.equal(fake.sims.get(UDID)!.state, 'Shutdown');
});

test('invariant: nothing outside managedSet() + ALWAYS_ENABLED is touched; ALWAYS_ENABLED never gets disable', async () => {
  const { ctx, fake } = world({ storeHonored: false, launchctlFailures: { 'com.apple.swcd': 1 } });
  const seed = new Map([...parseStorePlist(RUNTIME_STORE), ['com.apple.foreign', true], ['com.apple.sharingd', true]]);
  seedStore(UDID, seed);
  fake.sims.get(UDID)!.overrides.set('com.apple.gamed', true); // disabled from outside: fallback re-enables
  await upSim(UDID, { capabilities: ['store'] }, ctx);
  assert.equal((await readStore(UDID, { base })).get('com.apple.sharingd'), false, 'repaired on up');
  // tampered state with a label outside the list: off ignores it
  const st = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  saveState('ios', UDID, { ...st, backup: { ...st.backup, 'com.apple.sleepd': null, 'com.apple.foreign': false } }, { env: ctx.env });
  const off = await offSim(UDID, ctx);
  assert.deepEqual(off.ignored, ['com.apple.foreign', 'com.apple.sleepd']);

  const calls = launchctlCalls(fake.calls);
  assert.ok(calls.some((c) => c.args[4] === 'enable' && c.args[5] === 'system/com.apple.gamed'));
  for (const c of calls) {
    const label = c.args[5].replace(/^system\//, '');
    assert.ok(TOUCHABLE.has(label), `launchctl on a label outside the list: ${label}`);
    if (c.args[4] === 'disable') assert.ok(MANAGED.has(label), `disable on ALWAYS_ENABLED: ${label}`);
  }
  const store = await readStore(UDID, { base });
  for (const [l, v] of seed) {
    if (!TOUCHABLE.has(l)) assert.equal(store.get(l), v, `unmanaged entry changed: ${l}`);
  }
  assert.equal(store.get('com.apple.sharingd'), true, 'off restores the saved value');
  assert.equal(store.has('com.apple.sleepd'), false);
  for (const l of store.keys()) assert.ok(TOUCHABLE.has(l) || seed.has(l), `new key outside the list: ${l}`);
  assert.equal(store.has('com.apple.assistantd'), false, 'absent ALWAYS_ENABLED does not gain a key');
  // store capability: store+icloud categories never get true
  for (const l of [...CATEGORIES.store, ...CATEGORIES.icloud]) assert.notEqual(store.get(l), true, l);
});

test('repair: the 3 ALWAYS_ENABLED at true in the store -> plan reports, up writes false with backup and verifies, off restores', async () => {
  const { ctx, fake } = world();
  const seed = new Map([...parseStorePlist(RUNTIME_STORE), ...REPAIR.map((l): [string, boolean] => [l, true])]);
  seedStore(UDID, seed);

  const p = await planSim('QA-iPhone17', {}, ctx);
  assert.deepEqual(p.repair, REPAIR);
  assert.equal(fileStore().get('com.apple.gamed'), true, 'plan does not write');

  const r = await upSim(UDID, {}, ctx);
  assert.deepEqual(r.repaired, REPAIR);
  assert.equal(r.storeChanges, 173 + 3);
  assert.equal(r.backupAdded, 173 + 3);
  assert.deepEqual([...r.notApplied, ...r.notRestored], []);
  assert.ok(!r.restored.some((l) => REPAIR.includes(l)), 'repair does not go into restored');
  const store = fileStore();
  for (const l of REPAIR) assert.equal(store.get(l), false, l);
  const st = loadState<IosState>('ios', UDID, { env: ctx.env })!;
  for (const l of REPAIR) assert.equal(st.backup[l], true, `backup of ${l}`);
  for (const l of REPAIR) assert.equal(fake.sims.get(UDID)!.live.get(l), false, `enabled in the live launchd: ${l}`);
  assert.ok(!launchctlCalls(fake.calls).length, 'store took; no fallback');

  // plan after the repair: nothing to repair
  assert.deepEqual((await planSim(UDID, {}, ctx)).repair, []);

  // second up (other profile, device booted): backup true does NOT re-apply the disable
  await upSim(UDID, { capabilities: ['push'] }, ctx);
  for (const l of REPAIR) assert.equal(fileStore().get(l), false, `second up kept ${l} enabled`);
  assert.equal(loadState<IosState>('ios', UDID, { env: ctx.env })!.backup['com.apple.gamed'], true, 'first backup wins');

  const off = await offSim(UDID, ctx);
  assert.equal(off.restored, 176);
  assert.deepEqual(off.ignored, []);
  for (const l of REPAIR) assert.equal(fileStore().get(l), true, `off restores ${l}`);
});

test('repair: booted device with ALWAYS_ENABLED disabled is not alreadySlim', async () => {
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

test('repair: --keep/--except do not prevent it; --keep of ALWAYS_ENABLED is refused before writing', async () => {
  const { ctx } = world();
  seedStore(UDID, new Map([['com.apple.gamed', true], ['com.apple.sharingd', true]]));
  const before = readFileSync(storePath(UDID, { base }), 'utf8');
  await assert.rejects(upSim(UDID, { keep: ['com.apple.gamed'] }, ctx), /label outside the managed list: com\.apple\.gamed/);
  assert.equal(readFileSync(storePath(UDID, { base }), 'utf8'), before);

  const r = await upSim(UDID, { except: [...CATEGORY_IDS], keep: [] }, ctx);
  assert.equal(r.labels, 0);
  assert.deepEqual(r.repaired, ['com.apple.gamed', 'com.apple.sharingd']);
  const store = fileStore();
  assert.equal(store.get('com.apple.gamed'), false);
  assert.equal(store.get('com.apple.sharingd'), false);
  assert.equal(store.has('com.apple.assistantd'), false, 'absent stays absent');
  for (const l of ALL) assert.notEqual(store.get(l), true, `full except does not disable ${l}`);
});

test('repair: live launchd still with ALWAYS_ENABLED disabled after boot -> fallback uses launchctl enable', async () => {
  const { ctx, fake } = world({ storeHonored: false });
  fake.sims.get(UDID)!.overrides.set('com.apple.sharingd', true);
  const r = await upSim(UDID, { except: [...CATEGORY_IDS] }, ctx);
  assert.equal(r.fallback.used, true);
  const calls = launchctlCalls(fake.calls).map((c) => `${c.args[4]} ${c.args[5]}`);
  assert.deepEqual(calls, ['enable system/com.apple.sharingd']);
  assert.deepEqual(r.notRestored, []);
  assert.equal(fake.sims.get(UDID)!.live.get('com.apple.sharingd'), false);
});

test('window opens Simulator.app at the end; failure only warns', async () => {
  const a = world();
  const r = await upSim(UDID, { capabilities: ['window'] }, a.ctx);
  assert.equal(r.windowOpened, true);
  assert.deepEqual(a.fake.calls.at(-1)!.args, ['-a', 'Simulator']);
  const b = world({ openFails: true });
  const r2 = await upSim(UDID, { capabilities: ['window'] }, b.ctx);
  assert.equal(r2.windowOpened, false);
  assert.match(b.stderr.join(''), /open -a Simulator failed/);
});

test('down: only what the session started; a name outside the session requires --force', async () => {
  const { ctx, fake } = world();
  assert.deepEqual(await downSim(undefined, ctx), []);
  await upSim(UDID, {}, ctx);
  fake.sims.get(OTHER)!.state = 'Booted';
  await assert.rejects(downSim('QA-iPhone17b', ctx), /was not started by devslim/);
  const res = await downSim(undefined, ctx);
  assert.deepEqual(res.map((x) => [x.udid, x.result]), [[UDID, 'shutdown']]);
  assert.equal(fake.sims.get(UDID)!.state, 'Shutdown');
  assert.equal(fake.sims.get(OTHER)!.state, 'Booted');
  assert.deepEqual(loadSession(ctx.env), []);
  const forced = await downSim(undefined, { ...ctx, force: true });
  assert.deepEqual(forced.map((x) => [x.udid, x.registered, x.result]), [[OTHER, false, 'shutdown']]);
});
