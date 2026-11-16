import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DevslimError } from '../src/errors.ts';
import { createFakeExec } from '../src/exec.ts';
import {
  createSimctl,
  parseDevicesJson,
  parsePrintDisabled,
  parseRuntimeId,
  parseRuntimesJson,
  resolveDevice,
  type SimDevice,
} from '../src/ios/simctl.ts';

// Saidas reais desta maquina (macOS 26.6, Xcode com runtime iOS 26.4), capturadas
// com `xcrun simctl list devices -j` e `xcrun simctl list runtimes -j`.
const DEVICES_JSON = readFileSync(new URL('./fixtures/ios/simctl-devices.json', import.meta.url), 'utf8');
const RUNTIMES_JSON = readFileSync(new URL('./fixtures/ios/simctl-runtimes.json', import.meta.url), 'utf8');
const QA = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';

test('parse de list devices -j real', () => {
  const devs = parseDevicesJson(DEVICES_JSON);
  assert.equal(devs.length, 5);
  const qa = devs.find((d) => d.name === 'QA-iPhone17')!;
  assert.deepEqual(qa, { udid: QA, name: 'QA-iPhone17', state: 'Shutdown', runtimeId: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', isAvailable: true });
  assert.ok(devs.every((d) => d.isAvailable && d.runtimeId.endsWith('iOS-26-4')));
  assert.throws(() => parseDevicesJson('nao json'), DevslimError);
});

test('parse de list runtimes -j real e do identificador', () => {
  const rts = parseRuntimesJson(RUNTIMES_JSON);
  assert.deepEqual(rts, [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', platform: 'iOS', version: '26.4', name: 'iOS 26.4', isAvailable: true }]);
  assert.deepEqual(parseRuntimeId('com.apple.CoreSimulator.SimRuntime.iOS-18-5'), { platform: 'iOS', version: '18.5' });
  assert.deepEqual(parseRuntimeId('com.apple.CoreSimulator.SimRuntime.xrOS-2-5'), { platform: 'xrOS', version: '2.5' });
  assert.equal(parseRuntimeId('lixo'), null);
});

test('resolveDevice: UDID exato (qualquer caixa), nome exato, ambiguo lista UDIDs, aliases recusados', () => {
  const devs = parseDevicesJson(DEVICES_JSON);
  assert.equal(resolveDevice(devs, QA).name, 'QA-iPhone17');
  assert.equal(resolveDevice(devs, QA.toLowerCase()).udid, QA);
  assert.equal(resolveDevice(devs, 'QA-iPhone17').udid, QA, 'nome exato; QA-iPhone17b nao casa');
  assert.throws(() => resolveDevice(devs, 'QA-iPhone'), /nenhum simulador com UDID ou nome "QA-iPhone"/);

  const dup: SimDevice[] = [...devs, { ...devs.find((d) => d.udid === QA)!, udid: '11111111-2222-3333-4444-555555555555', state: 'Booted' }];
  assert.throws(() => resolveDevice(dup, 'QA-iPhone17'), (e: unknown) => {
    assert.ok(e instanceof DevslimError);
    assert.match(e.message, /nome "QA-iPhone17" e ambiguo; use o UDID: /);
    assert.match(e.message, new RegExp(QA));
    assert.match(e.message, /11111111-2222-3333-4444-555555555555 \(iOS-26-4, Booted\)/);
    return true;
  });
  for (const alias of ['booted', 'all', 'BOOTED']) assert.throws(() => resolveDevice(devs, alias), /alias do simctl/);
});

test('parse de print-disabled nos dois formatos', () => {
  const novo = 'disabled services = {\n\t"com.apple.apsd" => disabled\n\t"com.apple.swcd" => enabled\n}\nlogin item associations = {\n}\n';
  assert.deepEqual([...parsePrintDisabled(novo)], [['com.apple.apsd', true], ['com.apple.swcd', false]]);
  const velho = 'disabled services = {\n\t"com.apple.apsd" => true\n\t"com.apple.swcd" => false\n}\n';
  assert.deepEqual([...parsePrintDisabled(velho)], [['com.apple.apsd', true], ['com.apple.swcd', false]]);
  assert.equal(parsePrintDisabled('lixo\n"x" => talvez\n').size, 0);
});

test('printDisabled: retry com backoff 1, 2, 4, 8 s no 124 / Domain is tearing down', async () => {
  const sleeps: number[] = [];
  let n = 0;
  const exec = createFakeExec(() => {
    n++;
    if (n === 1) return { code: 124, stderr: '' };
    if (n === 2) return { code: 1, stderr: 'Unable to lookup in current state: Domain is tearing down' };
    if (n === 3) return { code: 1, stderr: 'underlying error (domain=LaunchdSimError, code=124)' };
    return { stdout: '\t"com.apple.apsd" => disabled\n' };
  });
  const s = createSimctl({ exec, sleep: async (ms) => { sleeps.push(ms); } });
  const m = await s.printDisabled(QA);
  assert.deepEqual([...m], [['com.apple.apsd', true]]);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.deepEqual(exec.calls[0].args, ['simctl', 'spawn', QA, 'launchctl', 'print-disabled', 'system']);

  // esgota: 5 tentativas (1 + 4 retries) e erro
  const always = createFakeExec(() => ({ code: 124, stderr: 'Domain is tearing down' }));
  const sleeps2: number[] = [];
  await assert.rejects(createSimctl({ exec: always, sleep: async (ms) => { sleeps2.push(ms); } }).printDisabled(QA), /print-disabled system .* falhou/);
  assert.equal(always.calls.length, 5);
  assert.deepEqual(sleeps2, [1000, 2000, 4000, 8000]);

  // outro erro: falha na hora
  const other = createFakeExec(() => ({ code: 1, stderr: 'Invalid device' }));
  await assert.rejects(createSimctl({ exec: other, sleep: async () => {} }).printDisabled(QA), /Invalid device/);
  assert.equal(other.calls.length, 1);
});

test('boot/bootstatus/shutdown: argumentos, tolerancias, timeout padrao de 10 min', async () => {
  let state = 'Shutdown';
  const exec = createFakeExec(({ args }) => {
    const [, sub] = args;
    if (sub === 'boot') {
      if (state === 'Booted') return { code: 149, stderr: 'Unable to boot device in current state: Booted' };
      state = 'Booted';
      return {};
    }
    if (sub === 'bootstatus') return {};
    if (sub === 'shutdown') {
      if (state === 'Shutdown') return { code: 149, stderr: 'Unable to shutdown device in current state: Shutdown' };
      state = 'Shutdown';
      return {};
    }
    if (sub === 'list') return { stdout: JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [{ udid: QA, name: 'x', state, isAvailable: true }] } }) };
    return undefined;
  });
  const s = createSimctl({ exec, sleep: async () => {} });
  await s.boot(QA);
  await s.boot(QA); // ja bootado: ok
  await s.bootstatus(QA);
  await s.shutdown(QA);
  await s.shutdown(QA); // ja desligado: ok
  const bs = exec.calls.find((c) => c.args[1] === 'bootstatus')!;
  assert.deepEqual(bs.args, ['simctl', 'bootstatus', QA, '-b']);
  assert.equal(bs.opts.timeoutMs, 600_000);
  await assert.rejects(s.boot('booted'), /UDID invalido/);
  await assert.rejects(s.launchctlDisable(QA, 'com.apple.x; rm'), /label invalido/);
});

test('launchctl disable/enable: system/<label> via spawn', async () => {
  const exec = createFakeExec(({ args }) => (args.includes('enable') ? { code: 5, stderr: 'Input/output error' } : {}));
  const s = createSimctl({ exec });
  assert.deepEqual(await s.launchctlDisable(QA, 'com.apple.apsd'), { ok: true, detail: '' });
  const en = await s.launchctlEnable(QA, 'com.apple.apsd');
  assert.equal(en.ok, false);
  assert.match(en.detail, /exit 5: Input\/output error/);
  assert.deepEqual(exec.calls.map((c) => c.args.join(' ')), [
    `simctl spawn ${QA} launchctl disable system/com.apple.apsd`,
    `simctl spawn ${QA} launchctl enable system/com.apple.apsd`,
  ]);
});

test('list falha com dica de xcode-select quando nao ha simctl', async () => {
  const exec = createFakeExec(() => ({ code: 72, stderr: 'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH' }));
  await assert.rejects(createSimctl({ exec }).listDevices(), /xcode-select/);
});
