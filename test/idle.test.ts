import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../src/errors.ts';
import {
  androidForeground,
  formatDuration,
  IDLE_MIN_MS,
  IDLE_POLL_MS,
  idleLoop,
  iosForeground,
  isSystemPackage,
  parseIdleDuration,
  type IdleOwnership,
  type IdleProbe,
} from '../src/idle.ts';

// ---------------------------------------------------------------------------
// duracao

test('parseIdleDuration: 30m, 150s, 1h e numero puro (minutos)', () => {
  assert.equal(parseIdleDuration('30m'), 30 * 60_000);
  assert.equal(parseIdleDuration('150s'), 150_000);
  assert.equal(parseIdleDuration('1h'), 3_600_000);
  assert.equal(parseIdleDuration('45'), 45 * 60_000);
  assert.equal(parseIdleDuration('2m'), IDLE_MIN_MS);
  assert.equal(parseIdleDuration('120s'), IDLE_MIN_MS);
  assert.equal(parseIdleDuration('2'), IDLE_MIN_MS);
});

test('parseIdleDuration: abaixo de 2 minutos = erro de uso', () => {
  for (const v of ['90s', '1m', '1', '0', '119s', '0h']) {
    assert.throws(() => parseIdleDuration(v), (err: Error) => err instanceof UsageError && /minimo 2m/.test(err.message), v);
  }
});

test('parseIdleDuration: formato invalido = erro de uso', () => {
  for (const v of ['', 'm', '30x', '1.5h', '-5', '30 m', '1h30m', 'abc', '99999999999999999999']) {
    assert.throws(() => parseIdleDuration(v), (err: Error) => err instanceof UsageError && /--idle-down/.test(err.message), v);
  }
});

test('formatDuration: h, m e s juntos; zero = 0s', () => {
  assert.equal(formatDuration(30 * 60_000), '30m');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(5_400_000), '1h30m');
  assert.equal(formatDuration(150_000), '2m30s');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(1499), '1s');
});

// ---------------------------------------------------------------------------
// Android: dumpsys activity activities

const LAUNCHER = `ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)
Display #0 (activities from top to bottom):
  * Task{a1 #5 type=home A=10123:com.google.android.apps.nexuslauncher}
    mResumedActivity: ActivityRecord{e8b3c4 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t5}
  topResumedActivity=ActivityRecord{e8b3c4 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t5}
`;
const SETTINGS = '  topResumedActivity=ActivityRecord{77aa u0 com.android.settings/.Settings t9}\n';
const ANDROID_PKG = '  topResumedActivity=ActivityRecord{77aa u0 android/com.android.internal.app.ResolverActivity t9}\n';
const THIRD = `Display #0 (activities from top to bottom):
  topResumedActivity=ActivityRecord{1f2e u0 com.minhaempresa.app/.MainActivity t12}
`;
const OLD_SPELLING = '    ResumedActivity: ActivityRecord{1f2e u0 com.minhaempresa.app/com.minhaempresa.app.MainActivity t12}\n';
const OLD_LAUNCHER = '    mResumedActivity: ActivityRecord{9 u0 com.android.launcher3/.uioverrides.QuickstepLauncher t2}\n';

test('isSystemPackage: com.android., com.google.android. e android*', () => {
  for (const p of ['com.android.settings', 'com.google.android.apps.nexuslauncher', 'android', 'com.android.launcher3']) assert.equal(isSystemPackage(p), true, p);
  for (const p of ['com.minhaempresa.app', 'host.exp.exponent', 'com.google.maps']) assert.equal(isSystemPackage(p), false, p);
});

test('androidForeground: launcher e app de sistema = parado; app de terceiro = em uso', () => {
  assert.deepEqual(androidForeground(LAUNCHER), { active: false, packages: ['com.google.android.apps.nexuslauncher'] });
  assert.deepEqual(androidForeground(SETTINGS), { active: false, packages: ['com.android.settings'] });
  assert.deepEqual(androidForeground(ANDROID_PKG), { active: false, packages: ['android'] });
  assert.deepEqual(androidForeground(THIRD), { active: true, packages: ['com.minhaempresa.app'] });
});

test('androidForeground: as duas grafias (topResumedActivity= e ResumedActivity:)', () => {
  assert.deepEqual(androidForeground(OLD_SPELLING), { active: true, packages: ['com.minhaempresa.app'] });
  assert.deepEqual(androidForeground(OLD_LAUNCHER), { active: false, packages: ['com.android.launcher3'] });
  // Tela dividida: qualquer terceiro em primeiro plano conta como uso.
  assert.equal(androidForeground(LAUNCHER + THIRD).active, true);
});

test('androidForeground: vazio ou lixo = parado, sem pacote', () => {
  for (const t of ['', '\n', 'garbage {}}} topResumedActivity=null', 'Exception: dumpsys timed out', 'ResumedActivity: ActivityRecord{}']) {
    assert.deepEqual(androidForeground(t), { active: false, packages: [] }, JSON.stringify(t));
  }
});

// ---------------------------------------------------------------------------
// iOS: launchctl list

const APPLE_ONLY = `PID\tStatus\tLabel
512\t0\tcom.apple.SpringBoard
-\t0\tcom.apple.mobilegestalt.xpc
801\t0\tUIKitApplication:com.apple.mobilesafari[3f1a][rb-legacy]
802\t0\tUIKitApplication:com.apple.Preferences[77b2][rb-legacy]
`;
const WITH_THIRD = `${APPLE_ONLY}933\t0\tUIKitApplication:com.minhaempresa.app[a1b2][rb-legacy]\n`;

test('iosForeground: so apps da Apple = parado; app de terceiro = em uso; vazio = parado', () => {
  assert.deepEqual(iosForeground(APPLE_ONLY), { active: false, apps: [] });
  assert.deepEqual(iosForeground(WITH_THIRD), { active: true, apps: ['com.minhaempresa.app'] });
  assert.deepEqual(iosForeground(''), { active: false, apps: [] });
  assert.deepEqual(iosForeground('PID\tStatus\tLabel\n'), { active: false, apps: [] });
});

// ---------------------------------------------------------------------------
// laco

type Step = IdleProbe | Error;

// Relogio falso; probe responde da fila (ultima repete), owner idem.
function loopWorld(o: { probes: Step[]; owners?: IdleOwnership[]; idleMs?: number; shutdownFails?: boolean }) {
  const clock = { t: 0 };
  const sleeps: number[] = [];
  const logs: string[] = [];
  let shutdowns = 0;
  let pi = 0;
  let oi = 0;
  const owners = o.owners ?? ['owned'];
  const run = () =>
    idleLoop({
      idleMs: o.idleMs ?? 120_000,
      probe: async () => {
        const s = o.probes[Math.min(pi++, o.probes.length - 1)];
        if (s instanceof Error) throw s;
        return s;
      },
      owner: async () => owners[Math.min(oi++, owners.length - 1)],
      shutdown: async () => {
        shutdowns++;
        if (o.shutdownFails) throw new Error('emu kill falhou');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.t += ms;
      },
      now: () => clock.t,
      log: (m) => logs.push(m),
    });
  return { run, clock, sleeps, logs, shutdowns: () => shutdowns, probes: () => pi };
}

test('idleLoop: desliga depois do tempo todo parado; intervalo padrao 30 s', async () => {
  const w = loopWorld({ probes: ['idle'] });
  const r = await w.run();
  assert.deepEqual(r, { reason: 'shutdown', idleForMs: 120_000 });
  assert.equal(w.shutdowns(), 1);
  assert.deepEqual(w.sleeps, [IDLE_POLL_MS, IDLE_POLL_MS, IDLE_POLL_MS, IDLE_POLL_MS]);
  assert.equal(IDLE_POLL_MS, 30_000);
});

test('idleLoop: uso zera o relogio', async () => {
  // t=30 idle, 60 idle, 90 ativo (zera), 120..210 idle: desliga em 210 (120 s depois do ultimo uso).
  const w = loopWorld({ probes: ['idle', 'idle', 'active', 'idle'] });
  const r = await w.run();
  assert.equal(r.reason, 'shutdown');
  assert.equal(r.idleForMs, 120_000);
  assert.equal(w.clock.t, 210_000);
  assert.equal(w.shutdowns(), 1);
});

test('idleLoop: device parou = sai sem desligar', async () => {
  const w = loopWorld({ probes: ['idle', 'gone'] });
  assert.equal((await w.run()).reason, 'device-gone');
  assert.equal(w.shutdowns(), 0);
});

test('idleLoop: sessao mudou de dono, sumiu ou o registro do watcher saiu = sai sem desligar', async () => {
  for (const reason of ['session-changed', 'session-gone', 'watcher-removed'] as const) {
    const w = loopWorld({ probes: ['idle'], owners: ['owned', reason] });
    assert.equal((await w.run()).reason, reason);
    assert.equal(w.shutdowns(), 0, reason);
  }
});

test('idleLoop: dono confere de novo logo antes de desligar', async () => {
  // 4 iteracoes "owned", e a checagem antes do shutdown ja ve outro dono.
  const w = loopWorld({ probes: ['idle'], owners: ['owned', 'owned', 'owned', 'owned', 'session-changed'] });
  assert.equal((await w.run()).reason, 'session-changed');
  assert.equal(w.shutdowns(), 0);
});

test('idleLoop: 3 falhas seguidas do probe = sai sem desligar, com log', async () => {
  const boom = new Error('adb: device offline');
  const w = loopWorld({ probes: [boom] });
  assert.equal((await w.run()).reason, 'probe-failed');
  assert.equal(w.probes(), 3);
  assert.equal(w.shutdowns(), 0);
  assert.equal(w.logs.length, 3);
  assert.match(w.logs[2], /probe falhou \(3\/3\): adb: device offline/);
});

test('idleLoop: falha intercalada com sucesso zera a contagem; falha nao conta como uso nem como parado', async () => {
  const boom = new Error('x');
  const w = loopWorld({ probes: [boom, boom, 'idle', boom, boom, 'idle'], idleMs: 10 * 60_000 });
  const r = await w.run();
  assert.equal(r.reason, 'shutdown');
  assert.equal(w.shutdowns(), 1);
});

test('idleLoop: shutdown que falha = shutdown-failed com detalhe', async () => {
  const w = loopWorld({ probes: ['idle'], shutdownFails: true });
  const r = await w.run();
  assert.equal(r.reason, 'shutdown-failed');
  assert.equal(r.detail, 'emu kill falhou');
  assert.equal(w.shutdowns(), 1);
});
