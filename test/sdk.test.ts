import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { findSdkTool, sdkCandidates } from '../src/android/sdk.ts';
import { DevslimError } from '../src/errors.ts';

test('candidates: ANDROID_HOME, ANDROID_SDK_ROOT, ~/Library/Android/sdk', () => {
  assert.deepEqual(sdkCandidates({ ANDROID_HOME: '/a', ANDROID_SDK_ROOT: '/b', HOME: '/h' }), ['/a', '/b', '/h/Library/Android/sdk']);
  assert.deepEqual(sdkCandidates({ ANDROID_HOME: '/a', ANDROID_SDK_ROOT: '/a', HOME: '/h' }), ['/a', '/h/Library/Android/sdk']);
  assert.deepEqual(sdkCandidates({ HOME: '/h' }), ['/h/Library/Android/sdk']);
});

test('paths of each binary and precedence', () => {
  const exists = (p: string) => ['/b/emulator/emulator', '/a/platform-tools/adb', '/b/platform-tools/adb', '/h/Library/Android/sdk/cmdline-tools/latest/bin/avdmanager'].includes(p);
  const env = { ANDROID_HOME: '/a', ANDROID_SDK_ROOT: '/b', HOME: '/h' };
  assert.equal(findSdkTool('adb', { env, fileExists: exists }), '/a/platform-tools/adb');
  assert.equal(findSdkTool('emulator', { env, fileExists: exists }), '/b/emulator/emulator');
  assert.equal(findSdkTool('avdmanager', { env, fileExists: exists }), join('/h/Library/Android/sdk', 'cmdline-tools', 'latest', 'bin', 'avdmanager'));
});

test('missing binary: DevslimError saying which and where it looked', () => {
  const env = { ANDROID_HOME: '/a', HOME: '/h' };
  assert.throws(
    () => findSdkTool('emulator', { env, fileExists: () => false }),
    (err: unknown) =>
      err instanceof DevslimError &&
      /^emulator not found/.test(err.message) &&
      err.message.includes('/a/emulator/emulator') &&
      err.message.includes('/h/Library/Android/sdk/emulator/emulator'),
  );
});
