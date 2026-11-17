import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLaunchArgs, grpcPortFor, GRPC_REFERENCE_PORT, SLIM_SNAPSHOT } from '../src/android/launchArgs.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';
import { DevslimError } from '../src/errors.ts';

const TAIL = ['-no-boot-anim', '-no-metrics', '-no-snapshot'];
const NO_IO = ['-no-window', '-no-audio', '-camera-back', 'none', '-camera-front', 'none'];
// gRPC always right after the port (or after -cores, without a port): console port + 3000.
const GRPC = (port = 5554) => ['-grpc', String(port + 3000), '-grpc-use-token'];

test('default profile', () => {
  assert.deepEqual(buildLaunchArgs('slim-api35', buildAndroidProfile()), [
    '-avd', 'slim-api35', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    ...GRPC(),
    ...NO_IO,
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('default profile with port', () => {
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

test('--aggressive with port', () => {
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

test('-lowram appears exactly when the profile has lowRam, regardless of RAM', () => {
  for (const ramMb of [1536, 2048, 3072]) {
    for (const lowRam of [false, true]) {
      for (const aggressive of [false, true]) {
        const p = buildAndroidProfile({ ramMb, lowRam, aggressive });
        const args = buildLaunchArgs('a', p);
        assert.equal(args.includes('-lowram'), lowRam, `ram ${ramMb} lowRam ${lowRam} aggressive ${aggressive}`);
        assert.equal(args[args.indexOf('-memory') + 1], String(ramMb), 'lowram does not change RAM');
      }
    }
  }
});

test('window capability drops -no-window', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ capabilities: ['window'] })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    ...GRPC(),
    '-no-audio', '-camera-back', 'none', '-camera-front', 'none',
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('audio capability drops -no-audio', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ capabilities: ['audio'] })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    ...GRPC(),
    '-no-window', '-camera-back', 'none', '-camera-front', 'none',
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('camera capability drops -camera-back/-camera-front none', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ capabilities: ['camera'], port: 5554 })), [
    '-avd', 'a', '-gpu', 'host', '-memory', '2048', '-cores', '2',
    '-port', '5554',
    ...GRPC(5554),
    '-no-window', '-no-audio',
    '-feature', '-Vulkan',
    ...TAIL,
  ]);
});

test('vulkan: no -feature -Vulkan', () => {
  assert.deepEqual(buildLaunchArgs('a', buildAndroidProfile({ vulkan: true, gpu: 'auto', ramMb: 4096 })), [
    '-avd', 'a', '-gpu', 'auto', '-memory', '4096', '-cores', '2',
    ...GRPC(),
    ...NO_IO,
    ...TAIL,
  ]);
});

test('named snapshot: -snapshot <name> -no-snapshot-save instead of -no-snapshot', () => {
  const args = buildLaunchArgs('a', buildAndroidProfile(), { snapshot: SLIM_SNAPSHOT });
  assert.deepEqual(args.slice(-5), ['-no-boot-anim', '-no-metrics', '-snapshot', 'slim_base', '-no-snapshot-save']);
  assert.ok(!args.includes('-no-snapshot'));
});

test('snapshot default_boot is an error', () => {
  assert.throws(() => buildLaunchArgs('a', buildAndroidProfile(), { snapshot: 'default_boot' }), DevslimError);
  assert.throws(() => buildLaunchArgs('a', buildAndroidProfile(), { snapshot: 'x y' }), DevslimError);
});

test('never contains -netfast, in any combination', () => {
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

test('invalid AVD name is an error', () => {
  assert.throws(() => buildLaunchArgs('a b', buildAndroidProfile()), DevslimError);
});

test('grpcPortFor: 8554 + (port - 5554); odd or out of range = error', () => {
  assert.equal(grpcPortFor(5554), 8554);
  assert.equal(grpcPortFor(5556), 8556);
  assert.equal(grpcPortFor(5682), 8682);
  for (const p of [5555, 5553, 5552, 5684, 0, 5554.5]) assert.throws(() => grpcPortFor(p), DevslimError, String(p));
  assert.equal(GRPC_REFERENCE_PORT, 5554);
});

test('gRPC: -grpc <port> -grpc-use-token by default, right after -port; 5554 and 5556', () => {
  const a = buildLaunchArgs('a', buildAndroidProfile({ port: 5554 }));
  assert.deepEqual(a.slice(a.indexOf('-port'), a.indexOf('-port') + 5), ['-port', '5554', '-grpc', '8554', '-grpc-use-token']);
  const b = buildLaunchArgs('a', buildAndroidProfile({ port: 5556 }));
  assert.deepEqual(b.slice(b.indexOf('-port'), b.indexOf('-port') + 5), ['-port', '5556', '-grpc', '8556', '-grpc-use-token']);
  assert.equal(a.filter((t) => t === '-grpc').length, 1);
});

test('gRPC without port (plan): reference 5554 -> 8554', () => {
  const a = buildLaunchArgs('a', buildAndroidProfile());
  assert.ok(!a.includes('-port'));
  assert.deepEqual(a.slice(a.indexOf('-grpc'), a.indexOf('-grpc') + 3), ['-grpc', '8554', '-grpc-use-token']);
});

test('grpc: false drops -grpc and -grpc-use-token; the rest stays the same', () => {
  for (const port of [undefined, 5554, 5556]) {
    const on = buildLaunchArgs('a', buildAndroidProfile({ port }));
    const off = buildLaunchArgs('a', buildAndroidProfile({ port, grpc: false }));
    assert.ok(!off.includes('-grpc') && !off.includes('-grpc-use-token'));
    assert.deepEqual(off, on.filter((t, i) => !['-grpc', '-grpc-use-token'].includes(t) && on[i - 1] !== '-grpc'));
  }
});

test('deterministic order: two identical calls give the same list', () => {
  const p = buildAndroidProfile({ port: 5558, capabilities: ['audio'] });
  assert.deepEqual(buildLaunchArgs('a', p, { snapshot: SLIM_SNAPSHOT }), buildLaunchArgs('a', p, { snapshot: SLIM_SNAPSHOT }));
});
