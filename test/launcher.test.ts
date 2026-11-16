import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeExec, type FakeCall } from '../src/exec.ts';
import { buildLaunchArgs } from '../src/android/launchArgs.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { classifyLauncher, launcherFor, listQemuProcesses, parseQemuProcesses, processCommandLine } from '../src/android/launcher.ts';

// Linhas reais (2026-11-16). Argent: lancado pelo tool-server do argent, sem
// -memory/-cores e com -netfast. devslim: buildLaunchArgs de um up.
const QEMU = '/opt/homebrew/share/android-commandlinetools/emulator/qemu/darwin-aarch64/qemu-system-aarch64';
const ARGENT = `${QEMU} -avd qa-tablet-api35 -no-snapshot-load -gpu auto -feature -Vulkan -noaudio -no-boot-anim -netfast -no-metrics -crash-report-mode never`;
const DEVSLIM = `${QEMU} -avd bench-api35 -gpu host -memory 2048 -cores 2 -port 5554 -grpc 8554 -grpc-use-token -no-window -no-audio -camera-back none -camera-front none -feature -Vulkan -no-boot-anim -no-metrics -no-snapshot`;
// Linha do devslim antes do gRPC (e com --no-grpc): continua devslim.
const DEVSLIM_NO_GRPC = `${QEMU} -avd bench-api35 -gpu host -memory 2048 -cores 2 -port 5554 -no-window -no-audio -camera-back none -camera-front none -feature -Vulkan -no-boot-anim -no-metrics -no-snapshot`;
const STUDIO = `${QEMU} -netdelay none -netspeed full -avd Pixel_9_API_35 -qt-hide-window -grpc-use-token`;

test('classifyLauncher: linha real do argent, do devslim e uma terceira', () => {
  assert.equal(classifyLauncher(ARGENT), 'argent');
  assert.equal(classifyLauncher(DEVSLIM), 'devslim');
  assert.equal(classifyLauncher(DEVSLIM_NO_GRPC), 'devslim');
  assert.equal(classifyLauncher(STUDIO), 'other');
});

test('classifyLauncher: linha gerada pelo buildLaunchArgs atual (com e sem gRPC) = devslim; argent continua argent', () => {
  for (const grpc of [true, false]) {
    for (const port of [5554, 5556]) {
      const line = `${QEMU} ${buildLaunchArgs('bench-api35', buildAndroidProfile({ port, grpc })).join(' ')}`;
      assert.equal(classifyLauncher(line), 'devslim', line);
      assert.equal(line.includes('-grpc-use-token'), grpc);
    }
  }
  assert.equal(classifyLauncher(ARGENT), 'argent');
  assert.equal(classifyLauncher(`${ARGENT} -grpc 8554 -grpc-use-token`), 'argent', 'gRPC nao muda a assinatura do argent');
});

test('classifyLauncher: sessao do devslim vence a assinatura; regras de borda', () => {
  assert.equal(classifyLauncher(STUDIO, true), 'devslim', 'sessao registra o AVD como vivo');
  assert.equal(classifyLauncher(ARGENT, true), 'devslim');
  assert.equal(classifyLauncher(`${DEVSLIM} -netfast`), 'other', '-netfast tira a assinatura do devslim; sem -crash-report-mode never nao e argent');
  assert.equal(classifyLauncher(`${QEMU} -avd x -memory 2048`), 'other', 'so -memory sem -cores');
  assert.equal(classifyLauncher(`${QEMU} -avd x -netfast -crash-report-mode always`), 'other');
  assert.equal(classifyLauncher(`${QEMU} -avd x -netfast -crash-report-mode\tnever`), 'argent', 'qualquer espaco entre tokens');
  assert.equal(classifyLauncher(''), 'other');
});

test('parseQemuProcesses: saida do pgrep -fl; ignora linha sem -avd ou que nao e qemu', () => {
  const out = `9421 ${ARGENT}\n73808 ${DEVSLIM}\n555 /usr/bin/vim notas-qemu-system.txt\n556 ${QEMU} -version\n51234\n\n`;
  assert.deepEqual(parseQemuProcesses(out), [
    { pid: 9421, avd: 'qa-tablet-api35', cmdline: ARGENT },
    { pid: 73808, avd: 'bench-api35', cmdline: DEVSLIM },
  ]);
  assert.deepEqual(parseQemuProcesses(''), []);
});

test('listQemuProcesses e processCommandLine: so pgrep/ps via exec; falha = vazio/null', async () => {
  const exec = createFakeExec((c: FakeCall) => {
    const line = `${c.cmd} ${c.args.join(' ')}`;
    if (line === 'pgrep -fl qemu-system') return { stdout: `9421 ${ARGENT}\n` };
    if (line === 'ps -o command= -p 9421') return { stdout: `${ARGENT}\n` };
    if (c.cmd === 'ps') return { code: 1 };
    return undefined;
  });
  assert.deepEqual((await listQemuProcesses(exec)).map((p) => [p.pid, p.avd]), [[9421, 'qa-tablet-api35']]);
  assert.equal(await processCommandLine(9421, exec), ARGENT);
  assert.equal(await processCommandLine(1, exec), null);

  const none = createFakeExec((c: FakeCall) => (c.cmd === 'pgrep' ? { code: 1 } : undefined));
  assert.deepEqual(await listQemuProcesses(none), []);
  const broken = createFakeExec(() => undefined); // fake lanca: vira vazio
  assert.deepEqual(await listQemuProcesses(broken), []);
  assert.equal(await processCommandLine(9421, broken), null);
  for (const c of [...exec.calls, ...none.calls]) assert.ok(c.cmd === 'pgrep' || c.cmd === 'ps', 'sem adb');
});

test('launcherFor: usa a lista do pgrep, cai no ps pelo pid; sem linha = devslim so se na sessao, senao null', async () => {
  const exec = createFakeExec((c: FakeCall) => (c.cmd === 'ps' && c.args.at(-1) === '73808' ? { stdout: `${DEVSLIM}\n` } : { code: 1 }));
  const list = parseQemuProcesses(`9421 ${ARGENT}\n`);
  assert.deepEqual(await launcherFor('qa-tablet-api35', { exec, pid: 9421, inSession: false, processes: list }), { launcher: 'argent', cmdline: ARGENT });
  assert.deepEqual(await launcherFor('bench-api35', { exec, pid: 73808, inSession: false }), { launcher: 'devslim', cmdline: DEVSLIM });
  assert.deepEqual(await launcherFor('x', { exec, pid: 1, inSession: false }), { launcher: null, cmdline: null });
  assert.deepEqual(await launcherFor('x', { exec, pid: null, inSession: true }), { launcher: 'devslim', cmdline: null });
});
