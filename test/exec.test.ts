import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DevslimError } from '../src/errors.ts';
import { createFakeExec, createFakeSpawnDetached, nodeExec, nodeSpawnDetached } from '../src/exec.ts';

test('nodeSpawnDetached: returns pid, sends stdout and stderr to the log (append)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devslim-spawn-'));
  try {
    const log = join(dir, 'x.log');
    const script = 'process.stdout.write("out\\n"); process.stderr.write("err\\n")';
    const { pid } = await nodeSpawnDetached(process.execPath, ['-e', script], { logFile: log });
    assert.ok(Number.isInteger(pid) && pid > 0);
    // The child is detached: wait for it to write, without a fixed sleep.
    for (let i = 0; i < 200 && !/err/.test(readFileSync(log, 'utf8')); i++) await new Promise((r) => setTimeout(r, 10));
    const text = readFileSync(log, 'utf8');
    assert.match(text, /out/);
    assert.match(text, /err/);
    await assert.rejects(nodeSpawnDetached('devslim-binary-that-does-not-exist', [], { logFile: log }), DevslimError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createFakeSpawnDetached records calls and returns increasing pids', async () => {
  const spawn = createFakeSpawnDetached(100);
  assert.deepEqual(await spawn('/sdk/emulator/emulator', ['-avd', 'a'], { logFile: '/l' }), { pid: 100 });
  assert.deepEqual(await spawn('/sdk/emulator/emulator', ['-avd', 'b'], { logFile: '/l' }), { pid: 101 });
  assert.deepEqual(spawn.calls.map((c) => c.args), [['-avd', 'a'], ['-avd', 'b']]);
});

test('nodeExec captures stdout, stderr and exit code, without a shell', async () => {
  const res = await nodeExec(process.execPath, [
    '-e',
    'process.stdout.write("out $HOME"); process.stderr.write("err"); process.exit(3)',
  ]);
  assert.equal(res.code, 3);
  assert.equal(res.stdout, 'out $HOME', 'argument does not go through a shell');
  assert.equal(res.stderr, 'err');
});

test('nodeExec passes stdin through', async () => {
  const res = await nodeExec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'echo' });
  assert.equal(res.stdout, 'echo');
  assert.equal(res.code, 0);
});

test('nodeExec with a missing binary gives DevslimError', async () => {
  await assert.rejects(nodeExec('devslim-binary-that-does-not-exist', []), DevslimError);
});

test('createFakeExec records calls and fails loudly on an unexpected call', async () => {
  const exec = createFakeExec(({ cmd, args }) => (cmd === 'adb' && args[0] === 'devices' ? { stdout: 'List\n' } : undefined));
  const res = await exec('adb', ['devices']);
  assert.equal(res.stdout, 'List\n');
  assert.equal(res.code, 0);
  await assert.rejects(exec('emulator', ['-avd', 'x']), /unexpected call/);
  assert.deepEqual(exec.calls.map((c) => [c.cmd, ...c.args]), [['adb', 'devices'], ['emulator', '-avd', 'x']]);
});
