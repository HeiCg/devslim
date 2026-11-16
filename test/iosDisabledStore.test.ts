import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DevslimError } from '../src/errors.ts';
import { createFakeExec } from '../src/exec.ts';
import {
  mergeStore,
  parseStorePlist,
  readStore,
  serializeStorePlist,
  storePath,
} from '../src/ios/disabledStore.ts';

// Store real de um device iOS 26.4 desta maquina (copiado em modo leitura).
const RUNTIME_STORE = readFileSync(new URL('./fixtures/ios/disabled.runtime.plist', import.meta.url), 'utf8');
const UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'devslim-store-')); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

function put(text: string | Buffer): string {
  const p = storePath(UDID, { base });
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
}

test('caminho: <base>/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist; padrao /private/var/tmp', () => {
  assert.equal(storePath(UDID, { base }), join(base, `com.apple.CoreSimulator.SimDevice.${UDID}`, 'disabled.plist'));
  assert.equal(storePath(UDID), `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${UDID}/disabled.plist`);
});

test('UDID invalido recusa antes de montar caminho', async () => {
  for (const bad of ['booted', 'all', '../../etc', `${UDID}/..`, '']) {
    assert.throws(() => storePath(bad, { base }), (e: unknown) => e instanceof DevslimError && /UDID invalido/.test(e.message));
    await assert.rejects(mergeStore(bad, new Map([['com.apple.x', true]]), { base }), /UDID invalido/);
  }
  assert.deepEqual(readdirSync(base), []);
});

test('parse do store real do runtime: 17 entradas <false/>', () => {
  const m = parseStorePlist(RUNTIME_STORE);
  assert.equal(m.size, 17);
  assert.ok([...m.values()].every((v) => v === false));
  assert.equal(m.get('com.apple.eventkitsyncd'), false);
});

test('round-trip: serializa ordenado, reparse igual, reserializa identico; escapa &', () => {
  const m = new Map<string, boolean>([['com.apple.z', true], ['com.apple.a&b', false], ['com.apple.m', true]]);
  const text = serializeStorePlist(m);
  assert.match(text, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.ok(text.indexOf('com.apple.a&amp;b') < text.indexOf('com.apple.m'));
  const back = parseStorePlist(text);
  assert.deepEqual([...back].sort(), [...m].sort());
  assert.equal(serializeStorePlist(back), text);
  assert.deepEqual([...parseStorePlist(serializeStorePlist(new Map()))], []);
  assert.deepEqual([...parseStorePlist('<plist version="1.0"><dict/></plist>')], []);
});

test('arquivo ausente = mapa vazio', async () => {
  assert.equal((await readStore(UDID, { base })).size, 0);
});

test('merge preserva entradas alheias true e false, cria diretorio, modo 0644, devolve anteriores', async () => {
  const before = new Map(parseStorePlist(RUNTIME_STORE));
  before.set('com.apple.alheio.desligado', true);
  put(serializeStorePlist(before));
  const prev = await mergeStore(UDID, new Map([['com.apple.apsd', true], ['com.apple.eventkitsyncd', true]]), { base });
  assert.deepEqual([...prev], [['com.apple.apsd', undefined], ['com.apple.eventkitsyncd', false]]);
  const after = await readStore(UDID, { base });
  assert.equal(after.size, before.size + 1);
  assert.equal(after.get('com.apple.alheio.desligado'), true);
  assert.equal(after.get('com.apple.nanonewscd'), false);
  assert.equal(after.get('com.apple.apsd'), true);
  assert.equal(after.get('com.apple.eventkitsyncd'), true);
  assert.equal(statSync(storePath(UDID, { base })).mode & 0o777, 0o644);

  // diretorio ausente: criado
  const other = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  await mergeStore(other, new Map([['com.apple.x', true]]), { base });
  assert.ok(existsSync(storePath(other, { base })));
  assert.equal(statSync(storePath(other, { base })).mode & 0o777, 0o644);
});

test('merge sem diferenca nao reescreve o arquivo', async () => {
  const p = put('<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n  <key>com.apple.apsd</key>\n  <true/>\n</dict>\n</plist>\n');
  const raw = readFileSync(p, 'utf8');
  await mergeStore(UDID, new Map([['com.apple.apsd', true]]), { base });
  assert.equal(readFileSync(p, 'utf8'), raw);
});

test('bplist: converte via plutil -convert xml1 -o - <arquivo>', async () => {
  const p = put(Buffer.from('bplist00\x00\x01binario', 'latin1'));
  const exec = createFakeExec(({ cmd }) => (cmd === 'plutil' ? { stdout: serializeStorePlist(new Map([['com.apple.apsd', true]])) } : undefined));
  const m = await readStore(UDID, { base, exec });
  assert.deepEqual([...m], [['com.apple.apsd', true]]);
  assert.deepEqual(exec.calls.map((c) => [c.cmd, ...c.args]), [['plutil', '-convert', 'xml1', '-o', '-', p]]);

  // merge sobre bplist grava XML com as entradas anteriores
  await mergeStore(UDID, new Map([['com.apple.swcd', true]]), { base, exec });
  assert.deepEqual([...parseStorePlist(readFileSync(p, 'utf8'))].sort(), [['com.apple.apsd', true], ['com.apple.swcd', true]]);

  const failing = createFakeExec(() => ({ code: 1, stderr: 'invalid' }));
  put(Buffer.from('bplist00zz', 'latin1'));
  await assert.rejects(readStore(UDID, { base, exec: failing }), /plutil nao converteu/);
});

test('estrutura inesperada: recusa sem escrever', async () => {
  const bad = [
    '<plist version="1.0"><dict><key>com.apple.a</key><string>x</string></dict></plist>',
    '<plist version="1.0"><dict><key>com.apple.a</key><dict><key>b</key><true/></dict></dict></plist>',
    '<plist version="1.0"><array><true/></array></plist>',
    '<plist version="1.0"><dict><key>com.apple.a</key><true/><key>com.apple.a</key><false/></dict></plist>',
    '<plist version="1.0"><dict><true/></dict></plist>',
    'nao e plist',
    '',
  ];
  for (const text of bad) {
    const p = put(text);
    await assert.rejects(mergeStore(UDID, new Map([['com.apple.apsd', true]]), { base }), (e: unknown) => {
      assert.ok(e instanceof DevslimError, text);
      assert.match(e.message, /estrutura inesperada/);
      return true;
    });
    assert.equal(readFileSync(p, 'utf8'), text, 'arquivo intocado');
    assert.deepEqual(readdirSync(join(p, '..')), ['disabled.plist'], 'sem temporario sobrando');
  }
});
