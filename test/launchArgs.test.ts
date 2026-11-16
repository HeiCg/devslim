import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLaunchArgs, grpcPortFor, GRPC_REFERENCE_PORT, SLIM_SNAPSHOT } from '../src/android/launchArgs.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { DevslimError } from '../src/errors.ts';

const TAIL = ['-no-boot-anim', '-no-metrics', '-no-snapshot'];
const NO_IO = ['-no-window', '-no-audio', '-camera-back', 'none', '-camera-front', 'none'];
// gRPC sempre logo depois da porta (ou de -cores, sem porta): porta do console + 3000.
const GRPC = (port = 5554) => ['-grpc', String(port + 3000), '-grpc-use-token'];

test('perfil padrao', () => {
  assert.deepEqual(buildLaunchArgs('slim-api35', buildAndroidProfile()), [
    '-avd', 'slim-api35', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    ...GRPC(),
    ...NO_IO,
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('perfil padrao com port', () => {
  assert.deepEqual(buildLaunchArgs('slim-api35', buildAndroidProfile({ port: 5556 })), [
    '-avd', 'slim-api35', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    '-port', '5556',
    ...GRPC(5556),
    ...NO_IO,
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('--aggressive: 1536 MB e -lowram', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ aggressive: true })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '1536', '-cores', '2',
    ...GRPC(),
    ...NO_IO,
    '-feature', '-Vulkan',
    '-lowram',
    ...TAIL,
  ]);
});

test('--aggressive com port', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ aggressive: true, port: 5682 })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '1536', '-cores', '2',
    '-port', '5682',
    ...GRPC(5682),
    ...NO_IO,
    '-feature', '-Vulkan',
    '-lowram',
    ...TAIL,
  ]);
});

test('capacidade window tira -no-window', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ capabilities: ['window'] })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    ...GRPC(),
    '-no-audio', '-camera-back', 'none', '-camera-front', 'none',
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('capacidade audio tira -no-audio', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ capabilities: ['audio'] })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    ...GRPC(),
    '-no-window', '-camera-back', 'none', '-camera-front', 'none',
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('capacidade camera tira -camera-back/-camera-front none', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ capabilities: ['camera'], port: 5554 })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    '-port', '5554',
    ...GRPC(5554),
    '-no-window', '-no-audio',
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('vulkan: sem -feature -Vulkan', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ vulkan: true, gpu: 'auto', ramMb: 4096 })), [
    '-avd', 'a', '-gpu', 'auto', '-memory', '4096', '-cores', '2',
    ...GRPC(),
    ...NO_IO,
    ...TAIL,
  ]);
});

test('snapshot nomeado: -snapshot <nome> -no-snapshot-save no lugar de -no-snapshot', () => {
  const args = buildLaunchArgs('a', buildAndroidProfile(), { snapshot: SLIM_SNAPSHOT });
  assert.deepEqual(args.slice(-5), ['-no-boot-anim', '-no-metrics', '-snapshot', 'slim_base', '-no-snapshot-save']);
  assert.ok(!args.includes('-no-snapshot'));
});

test('snapshot default_boot e erro', () => {
  assert.throws(() => buildLaunchArgs('a', buildAndroidProfile(), { snapshot: 'default_boot' }), DevslimError);
  assert.throws(() => buildLaunchArgs('a', buildAndroidProfile(), { snapshot: 'x y' }), DevslimError);
});

test('nunca contem -netfast, em nenhuma combinacao', () => {
  const caps = [[], ['audio'], ['camera'], ['window'], ['audio', 'camera', 'push', 'store', 'weblogin', 'window']];
  for (const capabilities of caps) {
    for (const aggressive of [false, true]) {
      for (const vulkan of [false, true]) {
        for (const snapshot of [undefined, SLIM_SNAPSHOT]) {
          const p = buildAndroidProfile({ capabilities, aggressive, vulkan, port: 5558 });
          assert.ok(!buildLaunchArgs('a', p, { snapshot }).includes('-netfast'));
        }
      }
    }
  }
});

test('nome de AVD invalido e erro', () => {
  assert.throws(() => buildLaunchArgs('a b', buildAndroidProfile()), DevslimError);
});

test('grpcPortFor: 8554 + (porta - 5554); impar ou fora da faixa = erro', () => {
  assert.equal(grpcPortFor(5554), 8554);
  assert.equal(grpcPortFor(5556), 8556);
  assert.equal(grpcPortFor(5682), 8682);
  for (const p of [5555, 5553, 5552, 5684, 0, 5554.5]) assert.throws(() => grpcPortFor(p), DevslimError, String(p));
  assert.equal(GRPC_REFERENCE_PORT, 5554);
});

test('gRPC: -grpc <porta> -grpc-use-token por padrao, logo depois do -port; 5554 e 5556', () => {
  const a = buildLaunchArgs('a', buildAndroidProfile({ port: 5554 }));
  assert.deepEqual(a.slice(a.indexOf('-port'), a.indexOf('-port') + 5), ['-port', '5554', '-grpc', '8554', '-grpc-use-token']);
  const b = buildLaunchArgs('a', buildAndroidProfile({ port: 5556 }));
  assert.deepEqual(b.slice(b.indexOf('-port'), b.indexOf('-port') + 5), ['-port', '5556', '-grpc', '8556', '-grpc-use-token']);
  assert.equal(a.filter((t) => t === '-grpc').length, 1);
});

test('gRPC sem porta (plan): referencia 5554 -> 8554', () => {
  const a = buildLaunchArgs('a', buildAndroidProfile());
  assert.ok(!a.includes('-port'));
  assert.deepEqual(a.slice(a.indexOf('-grpc'), a.indexOf('-grpc') + 3), ['-grpc', '8554', '-grpc-use-token']);
});

test('grpc: false tira -grpc e -grpc-use-token; o resto fica igual', () => {
  for (const port of [undefined, 5554, 5556]) {
    const on = buildLaunchArgs('a', buildAndroidProfile({ port }));
    const off = buildLaunchArgs('a', buildAndroidProfile({ port, grpc: false }));
    assert.ok(!off.includes('-grpc') && !off.includes('-grpc-use-token'));
    assert.deepEqual(off, on.filter((t, i) => !['-grpc', '-grpc-use-token'].includes(t) && on[i - 1] !== '-grpc'));
  }
});

test('ordem deterministica: duas chamadas iguais dao a mesma lista', () => {
  const p = buildAndroidProfile({ port: 5558, capabilities: ['audio'] });
  assert.deepEqual(buildLaunchArgs('a', p, { snapshot: SLIM_SNAPSHOT }), buildLaunchArgs('a', p, { snapshot: SLIM_SNAPSHOT }));
});
