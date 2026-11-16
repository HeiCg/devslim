import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { findRunningEntry, isAdvertised, parseRunningIni, readRunningEntries, runningDir } from '../src/android/runningIni.ts';

// Formato real de avd/running/pid_<pid>.ini (chaves relevantes); token de mentira.
const FIXTURE = readFileSync(new URL('./fixtures/running-pid.ini', import.meta.url), 'utf8');
const RUNNING_INI = (o: { avd?: string; serial?: number; grpc?: number | null; token?: string | null } = {}) =>
  [
    `avd.name=${o.avd ?? 'bench-api35'}`,
    'avd.id=bench-api35',
    'avd.dir=/Users/x/.android/avd/bench-api35.avd',
    `port.serial=${o.serial ?? 5554}`,
    `port.adb=${(o.serial ?? 5554) + 1}`,
    o.grpc === null ? null : `grpc.port=${o.grpc ?? 8554}`,
    o.token === null ? null : `grpc.token=${o.token ?? 'abc123'}`,
    'cmdline="/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64" "-avd" "bench-api35" "-grpc" "8554" "-grpc-use-token"',
    '',
  ].filter((l) => l !== null).join('\n');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devslim-running-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('runningDir: macOS em ~/Library/Caches/TemporaryItems/avd/running; Linux em $XDG_RUNTIME_DIR; resto null', () => {
  assert.equal(runningDir({ env: { HOME: '/h' }, platform: 'darwin' }), '/h/Library/Caches/TemporaryItems/avd/running');
  assert.equal(runningDir({ env: { XDG_RUNTIME_DIR: '/run/user/501' }, platform: 'linux' }), '/run/user/501/avd/running');
  assert.equal(runningDir({ env: {}, platform: 'linux' }), null);
  assert.equal(runningDir({ env: { HOME: '/h' }, platform: 'win32' }), null);
});

test('parseRunningIni: fixture realista; token vira so booleano', () => {
  assert.deepEqual(parseRunningIni(FIXTURE, 73808), parseRunningIni(RUNNING_INI(), 73808));
  const e = parseRunningIni(RUNNING_INI(), 73808);
  assert.deepEqual(e, { pid: 73808, avdName: 'bench-api35', serialPort: 5554, adbPort: 5555, grpcPort: 8554, hasGrpcToken: true });
  assert.ok(!JSON.stringify(e).includes('abc123'));
  assert.equal(isAdvertised(e), true);
  const noToken = parseRunningIni(RUNNING_INI({ token: null }), 1)!;
  assert.equal(noToken.hasGrpcToken, false);
  assert.equal(isAdvertised(noToken), false);
  assert.equal(parseRunningIni(RUNNING_INI({ token: '' }), 1)!.hasGrpcToken, false);
  const noGrpc = parseRunningIni(RUNNING_INI({ grpc: null }), 1)!;
  assert.equal(noGrpc.grpcPort, null);
  assert.equal(isAdvertised(noGrpc), false);
  assert.equal(parseRunningIni('avd.name = x\r\nport.serial = 5556\r\n', 2)!.serialPort, 5556, 'espacos e CRLF');
});

test('parseRunningIni: malformado = null', () => {
  assert.equal(parseRunningIni('', 1), null);
  assert.equal(parseRunningIni('lixo binario \u0000\u0001', 1), null);
  assert.equal(parseRunningIni('port.serial=5554\n', 1), null, 'sem avd.name');
  assert.equal(parseRunningIni('avd.name=x\nport.serial=abc\n', 1), null, 'porta nao numerica');
  assert.equal(parseRunningIni('avd.name=x\nport.serial=99999\n', 1), null, 'porta fora de 1..65535');
});

test('readRunningEntries: le pid_*.ini, ignora malformado, ilegivel e outros nomes; ordena por pid', () => {
  writeFileSync(join(dir, 'pid_900.ini'), RUNNING_INI({ avd: 'b', serial: 5556, grpc: 8556 }));
  writeFileSync(join(dir, 'pid_100.ini'), RUNNING_INI());
  writeFileSync(join(dir, 'pid_200.ini'), 'nada aqui\n');
  writeFileSync(join(dir, 'pid_x.ini'), RUNNING_INI());
  writeFileSync(join(dir, 'outro.ini'), RUNNING_INI());
  mkdirSync(join(dir, 'pid_300.ini')); // diretorio com nome de arquivo: ilegivel
  writeFileSync(join(dir, 'pid_400.ini'), RUNNING_INI({ avd: 'c' }));
  chmodSync(join(dir, 'pid_400.ini'), 0o000);
  const list = readRunningEntries(dir);
  const readable = process.getuid?.() === 0 ? ['bench-api35', 'c', 'b'] : ['bench-api35', 'b'];
  assert.deepEqual(list.map((e) => e.avdName), readable);
  assert.deepEqual(list.map((e) => e.pid).filter((p) => p !== 400), [100, 900]);
  assert.ok(!JSON.stringify(list).includes('abc123'));
});

test('readRunningEntries: diretorio ausente ou null = lista vazia', () => {
  assert.deepEqual(readRunningEntries(join(dir, 'nao-existe')), []);
  assert.deepEqual(readRunningEntries(null), []);
});

test('findRunningEntry: por avd e porta do console; prefere a anunciada', () => {
  const entries = [
    parseRunningIni(RUNNING_INI({ avd: 'a', serial: 5554, grpc: null }), 1)!,
    parseRunningIni(RUNNING_INI({ avd: 'a', serial: 5554 }), 2)!,
    parseRunningIni(RUNNING_INI({ avd: 'b', serial: 5556, grpc: 8556 }), 3)!,
  ];
  assert.equal(findRunningEntry(entries, 'a')!.pid, 2);
  assert.equal(findRunningEntry(entries, 'a', 5554)!.pid, 2);
  assert.equal(findRunningEntry(entries, 'a', 5556), null);
  assert.equal(findRunningEntry(entries, 'b', null)!.grpcPort, 8556);
  assert.equal(findRunningEntry(entries, 'z'), null);
});
