import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  loadSession,
  recordSession,
  removeSession,
  SESSION_LOCK_STALE_MS,
  SESSION_LOCK_STEP_MS,
  SESSION_LOCK_TIMEOUT_MS,
  sessionLockPath,
  sessionPath,
  updateSession,
  withSessionLock,
  type SessionEntry,
  type SessionLockOptions,
} from '../src/android/session.ts';
import { DevslimError } from '../src/errors.ts';

// Lock consultivo de session.json: processos separados (up, down, watcher)
// fazem read-modify-write. Sem processos reais: o "outro processo" e simulado
// pelo arquivo de lock e pelo sleep injetado.

let home: string;
let env: Record<string, string>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'devslim-lock-'));
  env = { DEVSLIM_HOME: home };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const entry = (avd: string, port: number): SessionEntry => ({
  platform: 'android',
  avd,
  serial: `emulator-${port}`,
  pid: port,
  port,
  startedAt: '2026-11-17T10:00:00.000Z',
});

// Relogio falso que so anda no sleep; `onSleep` roda o "outro processo".
function clock(onSleep?: (n: number) => void) {
  const c = { t: Date.parse('2026-11-17T10:00:00.000Z'), sleeps: [] as number[], alive: [] as number[] };
  const opts: SessionLockOptions = {
    now: () => c.t,
    sleep: (ms) => {
      c.sleeps.push(ms);
      c.t += ms;
      onSleep?.(c.sleeps.length);
    },
    pidAlive: (pid) => {
      c.alive.push(pid);
      return true;
    },
  };
  return { c, opts };
}

function holdLock(pid: number, atMs: number): string {
  const path = sessionLockPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, at: new Date(atMs).toISOString(), token: 'outro-processo' }) + '\n');
  return path;
}

test('lock: session.json.lock com pid e hora durante a secao critica; some depois, inclusive com erro', () => {
  const { c, opts } = clock();
  const path = sessionLockPath(env);
  assert.equal(path, `${sessionPath(env)}.lock`);
  withSessionLock(env, () => {
    const held = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.equal(held.at, new Date(c.t).toISOString());
  }, opts);
  assert.equal(existsSync(path), false);
  assert.throws(() => withSessionLock(env, () => { throw new Error('boom'); }, opts), /boom/);
  assert.equal(existsSync(path), false, 'finally solta o lock');
  assert.deepEqual(c.sleeps, [], 'lock livre: nenhuma espera');
});

test('lock: escritas intercaladas nao perdem entrada (A grava enquanto B espera)', () => {
  // A ja segurava o lock quando B chegou. Durante a espera de B, A termina a
  // secao critica dele (solta o lock e grava pela mesma API).
  const lock = holdLock(4242, Date.parse('2026-11-17T10:00:00.000Z'));
  const { c, opts } = clock((n) => {
    if (n !== 2) return;
    unlinkSync(lock);
    recordSession(entry('a-api35', 5554), env);
  });
  recordSession(entry('b-api35', 5556), env, opts);
  assert.deepEqual(loadSession(env).map((e) => e.avd), ['a-api35', 'b-api35'], 'B leu depois da escrita de A');
  assert.deepEqual(c.sleeps, [SESSION_LOCK_STEP_MS, SESSION_LOCK_STEP_MS]);
  assert.equal(existsSync(lock), false);

  // update e remove pelo mesmo caminho: nada se perde com A no meio.
  holdLock(4242, c.t);
  const second = clock((n) => {
    if (n !== 1) return;
    unlinkSync(lock);
    updateSession((e) => e.avd === 'a-api35', (e) => ({ ...e, pid: 1 }), env);
  });
  removeSession((e) => e.avd === 'b-api35', env, second.opts);
  assert.deepEqual(loadSession(env).map((e) => [e.avd, e.pid]), [['a-api35', 1]]);
});

test('lock: velho (mais de 30 s) e tratado como abandonado, removido e retomado', () => {
  const { c, opts } = clock();
  const lock = holdLock(4242, c.t - SESSION_LOCK_STALE_MS - 1000);
  recordSession(entry('a-api35', 5554), env, opts);
  assert.deepEqual(loadSession(env).map((e) => e.avd), ['a-api35']);
  assert.deepEqual(c.sleeps, [], 'sem esperar o timeout');
  assert.equal(existsSync(lock), false);
});

test('lock: pid dono morto = abandonado, mesmo recente', () => {
  const { c, opts } = clock();
  const lock = holdLock(4242, c.t);
  recordSession(entry('a-api35', 5554), env, { ...opts, pidAlive: (pid) => { c.alive.push(pid); return pid !== 4242; } });
  assert.ok(c.alive.includes(4242), 'consultou o pid do dono');
  assert.deepEqual(loadSession(env).map((e) => e.avd), ['a-api35']);
  assert.deepEqual(c.sleeps, []);
  assert.equal(existsSync(lock), false);
});

test('lock: arquivo vazio (dono ainda nao escreveu) vale pela idade do arquivo', () => {
  const { c, opts } = clock();
  const lock = sessionLockPath(env);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, '');
  const old = (c.t - SESSION_LOCK_STALE_MS - 5000) / 1000;
  utimesSync(lock, old, old);
  recordSession(entry('a-api35', 5554), env, opts);
  assert.deepEqual(loadSession(env).map((e) => e.avd), ['a-api35']);
  assert.equal(existsSync(lock), false);
});

test('lock: timeout de 5 s em passos de 50 ms; erro cita o arquivo e o pid dono; nada escrito, lock alheio intacto', () => {
  for (const write of [
    (o: SessionLockOptions) => recordSession(entry('a-api35', 5554), env, o),
    (o: SessionLockOptions) => updateSession(() => true, (e) => e, env, o),
    (o: SessionLockOptions) => removeSession(() => true, env, o),
  ]) {
    const { c, opts } = clock();
    const lock = holdLock(4242, c.t);
    const before = readFileSync(lock, 'utf8');
    assert.throws(() => write(opts), (err: unknown) => {
      assert.ok(err instanceof DevslimError);
      assert.ok(err.message.includes(lock), err.message);
      assert.match(err.message, /pid 4242/);
      assert.match(err.message, /5 s/);
      return true;
    });
    assert.ok(c.sleeps.every((ms) => ms === SESSION_LOCK_STEP_MS));
    assert.equal(c.sleeps.length, SESSION_LOCK_TIMEOUT_MS / SESSION_LOCK_STEP_MS);
    assert.equal(readFileSync(lock, 'utf8'), before, 'lock de outro processo nunca e apagado por timeout');
    assert.equal(existsSync(sessionPath(env)), false, 'nada gravado');
    rmSync(lock);
  }
});

test('lock: soltar so apaga o proprio lock (outro processo que tomou o lugar fica)', () => {
  const { opts } = clock();
  const lock = sessionLockPath(env);
  withSessionLock(env, () => {
    // Simula: alguem julgou o nosso lock abandonado e pos o dele no lugar.
    writeFileSync(lock, JSON.stringify({ pid: 4242, at: new Date().toISOString(), token: 'outro' }) + '\n');
  }, opts);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, 4242);
});
