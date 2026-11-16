import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DevslimError } from '../src/errors.ts';
import { createFakeExec, createFakeSpawnDetached, nodeExec, nodeSpawnDetached } from '../src/exec.ts';

test('nodeSpawnDetached: devolve pid, manda stdout e stderr para o log (append)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devslim-spawn-'));
  try {
    const log = join(dir, 'x.log');
    const script = 'process.stdout.write("saida\\n"); process.stderr.write("erro\\n")';
    const { pid } = await nodeSpawnDetached(process.execPath, ['-e', script], { logFile: log });
    assert.ok(Number.isInteger(pid) && pid > 0);
    // O filho e destacado: espera ele escrever, sem dormir fixo.
    for (let i = 0; i < 200 && !/erro/.test(readFileSync(log, 'utf8')); i++) await new Promise((r) => setTimeout(r, 10));
    const text = readFileSync(log, 'utf8');
    assert.match(text, /saida/);
    assert.match(text, /erro/);
    await assert.rejects(nodeSpawnDetached('devslim-binario-que-nao-existe', [], { logFile: log }), DevslimError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createFakeSpawnDetached grava chamadas e devolve pids crescentes', async () => {
  const spawn = createFakeSpawnDetached(100);
  assert.deepEqual(await spawn('/sdk/emulator/emulator', ['-avd', 'a'], { logFile: '/l' }), { pid: 100 });
  assert.deepEqual(await spawn('/sdk/emulator/emulator', ['-avd', 'b'], { logFile: '/l' }), { pid: 101 });
  assert.deepEqual(spawn.calls.map((c) => c.args), [['-avd', 'a'], ['-avd', 'b']]);
});

test('nodeExec captura stdout, stderr e exit code, sem shell', async () => {
  const res = await nodeExec(process.execPath, [
    '-e',
    'process.stdout.write("out $HOME"); process.stderr.write("err"); process.exit(3)',
  ]);
  assert.equal(res.code, 3);
  assert.equal(res.stdout, 'out $HOME', 'argumento nao passa por shell');
  assert.equal(res.stderr, 'err');
});

test('nodeExec repassa stdin', async () => {
  const res = await nodeExec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'eco' });
  assert.equal(res.stdout, 'eco');
  assert.equal(res.code, 0);
});

test('nodeExec com binario inexistente da DevslimError', async () => {
  await assert.rejects(nodeExec('devslim-binario-que-nao-existe', []), DevslimError);
});

test('createFakeExec grava chamadas e falha alto em chamada inesperada', async () => {
  const exec = createFakeExec(({ cmd, args }) => (cmd === 'adb' && args[0] === 'devices' ? { stdout: 'List\n' } : undefined));
  const res = await exec('adb', ['devices']);
  assert.equal(res.stdout, 'List\n');
  assert.equal(res.code, 0);
  await assert.rejects(exec('emulator', ['-avd', 'x']), /chamada inesperada/);
  assert.deepEqual(exec.calls.map((c) => [c.cmd, ...c.args]), [['adb', 'devices'], ['emulator', '-avd', 'x']]);
});
