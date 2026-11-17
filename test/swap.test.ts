import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeExec, type FakeCall } from '../src/exec.ts';
import { statusText, type StatusReport } from '../src/status.ts';
import { assessSwap, readSwap, swapGate } from '../src/swap.ts';

// `sysctl -n vm.swapusage` with no swap file (macOS reports total 0), a normal
// reading and garbage: only a command failure or unparsable output becomes "not read".

const NO_SWAP_FILE = 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)';
const NORMAL = 'total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)';

const sysctl = (stdout: string, code = 0) =>
  createFakeExec((c: FakeCall) => (c.cmd === 'sysctl' && c.args.join(' ') === '-n vm.swapusage' ? { code, stdout: `${stdout}\n` } : undefined));

const report = (swap: StatusReport['swap']): StatusReport => ({ ios: [], android: [], session: [], swap, at: '2026-11-17T00:00:00.000Z' });
const swapLine = (swap: StatusReport['swap']) => statusText(report(swap)).find((l) => l.startsWith('swap:'));

test('swap with no swap file (total 0): valid reading, 0%, its own text; doctor ok; gate silent', async () => {
  const s = await readSwap(sysctl(NO_SWAP_FILE));
  assert.deepEqual(s, { usedMb: 0, totalMb: 0, percent: 0 });
  assert.equal(swapLine(s), 'swap: 0 MB in use (no swap file)');
  const a = assessSwap(s);
  assert.equal(a.level, 'ok');
  assert.match(a.message, /0 MB in use \(no swap file\)/);
  const err: string[] = [];
  assert.deepEqual(await swapGate({ exec: sysctl(NO_SWAP_FILE), stderr: (t) => { err.push(t); }, force: false, action: 'up' }), s);
  assert.deepEqual(err, []);
});

test('normal swap: percent and the usual text', async () => {
  const s = await readSwap(sysctl(NORMAL));
  assert.deepEqual(s, { usedMb: 1024, totalMb: 2048, percent: 50 });
  assert.equal(swapLine(s), 'swap: 1024 of 2048 MB (50%)');
  assert.equal(assessSwap(s).level, 'ok');
});

test('swap: garbage or failing command = not read (warn in doctor)', async () => {
  for (const exec of [sysctl('garbage'), sysctl(NORMAL, 1), sysctl('total = 0.00M')]) {
    const s = await readSwap(exec);
    assert.deepEqual(s, { usedMb: null, totalMb: null, percent: null });
    assert.equal(swapLine(s), 'swap: not read');
    assert.equal(assessSwap(s).level, 'warn');
  }
  const throwing = createFakeExec(() => { throw new Error('no sysctl'); });
  assert.equal(swapLine(await readSwap(throwing)), 'swap: not read');
});
