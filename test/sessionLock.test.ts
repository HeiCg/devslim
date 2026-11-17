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

// Advisory session.json lock: separate processes (up, down, watcher)
// read-modify-write it. No real processes: the "other process" is simulated
// by the lock file and the injected sleep.

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

// Fake clock that only advances on sleep; `onSleep` runs the "other process".
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
  writeFileSync(path, JSON.stringify({ pid, at: new Date(atMs).toISOString(), token: 'other-process' }) + '\n');
  return path;
}

test('lock: session.json.lock with pid and time during the critical section; gone afterwards, even on error', () => {
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
  assert.equal(existsSync(path), false, 'finally releases the lock');
  assert.deepEqual(c.sleeps, [], 'free lock: no wait');
});

test('lock: interleaved writes do not lose entries (A writes while B waits)', () => {
  // A already held the lock when B arrived. While B waits, A finishes its
  // critical section (releases the lock and writes through the same API).
  const lock = holdLock(4242, Date.parse('2026-11-17T10:00:00.000Z'));
  const { c, opts } = clock((n) => {
    if (n !== 2) return;
    unlinkSync(lock);
    recordSession(entry('a-api35', 5554), env);
  });
  recordSession(entry('b-api35', 5556), env, opts);
  assert.deepEqual(loadSession(env).map((e) => e.avd), ['a-api35', 'b-api35'], 'B read after the A write');
  assert.deepEqual(c.sleeps, [SESSION_LOCK_STEP_MS, SESSION_LOCK_STEP_MS]);
  assert.equal(existsSync(lock), false);

  // update and remove through the same path: nothing is lost with A in between.
  holdLock(4242, c.t);
  const second = clock((n) => {
    if (n !== 1) return;
    unlinkSync(lock);
    updateSession((e) => e.avd === 'a-api35', (e) => ({ ...e, pid: 1 }), env);
  });
  removeSession((e) => e.avd === 'b-api35', env, second.opts);
  assert.deepEqual(loadSession(env).map((e) => [e.avd, e.pid]), [['a-api35', 1]]);
});

test('lock: old (over 30 s) is treated as abandoned, removed and retaken', () => {
  const { c, opts } = clock();
  const lock = holdLock(4242, c.t - SESSION_LOCK_STALE_MS - 1000);
  recordSession(entry('a-api35', 5554), env, opts);
  assert.deepEqual(loadSession(env).map((e) => e.avd), ['a-api35']);
  assert.deepEqual(c.sleeps, [], 'without waiting for the timeout');
  assert.equal(existsSync(lock), false);
});

test('lock: dead owner pid = abandoned, even if recent', () => {
  const { c, opts } = clock();
  const lock = holdLock(4242, c.t);
  recordSession(entry('a-api35', 5554), env, { ...opts, pidAlive: (pid) => { c.alive.push(pid); return pid !== 4242; } });
  assert.ok(c.alive.includes(4242), 'checked the owner pid');
  assert.deepEqual(loadSession(env).map((e) => e.avd), ['a-api35']);
  assert.deepEqual(c.sleeps, []);
  assert.equal(existsSync(lock), false);
});

test('lock: empty file (owner has not written yet) is judged by file age', () => {
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

test('lock: 5 s timeout in 50 ms steps; the error names the file and owner pid; nothing written, foreign lock intact', () => {
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
    assert.equal(readFileSync(lock, 'utf8'), before, 'another process lock is never deleted on timeout');
    assert.equal(existsSync(sessionPath(env)), false, 'nothing written');
    rmSync(lock);
  }
});

test('lock: release only deletes our own lock (another process that took over stays)', () => {
  const { opts } = clock();
  const lock = sessionLockPath(env);
  withSessionLock(env, () => {
    // Simulates: someone judged our lock abandoned and put theirs in its place.
    writeFileSync(lock, JSON.stringify({ pid: 4242, at: new Date().toISOString(), token: 'other' }) + '\n');
  }, opts);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, 4242);
});
