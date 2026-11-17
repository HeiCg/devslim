import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_API,
  hostAbi,
  IMAGE_SHORTCUTS,
  imageDir,
  imageTag,
  isAtdTag,
  isGoogleApisTag,
  resolveImage,
} from '../src/android/images.ts';
import { DevslimError } from '../src/errors.ts';

test('hostAbi: arm64 = arm64-v8a; o resto = x86_64', () => {
  assert.equal(hostAbi('arm64'), 'arm64-v8a');
  assert.equal(hostAbi('x64'), 'x86_64');
  assert.equal(hostAbi('ia32'), 'x86_64');
});

test('atalhos expandem para system-images;android-<api>;<tag>;<abi>', () => {
  assert.deepEqual([...IMAGE_SHORTCUTS], ['google_apis', 'google_atd', 'aosp_atd', 'default']);
  assert.equal(DEFAULT_API, 35);
  for (const tag of IMAGE_SHORTCUTS) {
    assert.equal(resolveImage(tag, { arch: 'arm64' }), `system-images;android-35;${tag};arm64-v8a`, tag);
    assert.equal(resolveImage(tag, { arch: 'x64', api: 34 }), `system-images;android-34;${tag};x86_64`, tag);
  }
});

test('sem imagem = google_apis na API padrao e ABI do host', () => {
  assert.equal(resolveImage(undefined, { arch: 'arm64' }), 'system-images;android-35;google_apis;arm64-v8a');
  assert.equal(resolveImage(undefined, { arch: 'x64', api: 36 }), 'system-images;android-36;google_apis;x86_64');
});

test('id completo passa como veio; com --api e erro', () => {
  const id = 'system-images;android-34;google_apis_playstore;x86_64';
  assert.equal(resolveImage(id, { arch: 'arm64' }), id);
  assert.throws(() => resolveImage(id, { api: 34 }), (e: unknown) => e instanceof DevslimError && /--api so vale com atalho/.test(e.message));
});

test('imagem desconhecida ou API invalida = erro com a lista de atalhos', () => {
  assert.throws(
    () => resolveImage('playstore', {}),
    (e: unknown) => e instanceof DevslimError && /imagem desconhecida: playstore .*google_apis, google_atd, aosp_atd, default/.test(e.message),
  );
  for (const api of [0, 1.5, -3]) assert.throws(() => resolveImage('aosp_atd', { api }), DevslimError, String(api));
});

test('imageDir: caminho da imagem dentro do SDK', () => {
  assert.equal(imageDir('/sdk', 'system-images;android-35;aosp_atd;arm64-v8a'), join('/sdk', 'system-images', 'android-35', 'aosp_atd', 'arm64-v8a'));
});

test('imageTag le tag.id ou, sem ele, o image.sysdir.1; classificacao das tags', () => {
  assert.equal(imageTag({ tagId: 'google_apis', sysdir: 'system-images/android-35/aosp_atd/arm64-v8a/' }), 'google_apis');
  assert.equal(imageTag({ sysdir: 'system-images/android-35/google_atd/arm64-v8a/' }), 'google_atd');
  assert.equal(imageTag({ sysdir: '/abs/sdk/system-images/android-34/default/x86_64' }), 'default');
  assert.equal(imageTag({}), null);
  assert.equal(imageTag({ sysdir: 'lixo' }), null);
  for (const t of ['google_apis', 'google_apis_playstore', 'playstore']) assert.ok(isGoogleApisTag(t), t);
  for (const t of ['google_atd', 'aosp_atd', 'default']) assert.ok(!isGoogleApisTag(t), t);
  for (const t of ['google_atd', 'aosp_atd', 'default']) assert.ok(isAtdTag(t), t);
  for (const t of ['google_apis', 'google_apis_playstore']) assert.ok(!isAtdTag(t), t);
});
