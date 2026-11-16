import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyProfile,
  getValue,
  parseIni,
  serializeIni,
  setValue,
} from '../src/android/configIni.ts';
import { buildAndroidProfile } from '../src/android/profile.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PHONE = fixture('phone.config.ini');
const TABLET = fixture('tablet.config.ini');

test('fixtures cobrem os casos de borda pedidos', () => {
  assert.ok(PHONE.endsWith('\n'), 'phone termina com newline');
  assert.ok(!TABLET.endsWith('\n'), 'tablet sem newline final');
  assert.match(PHONE, /^# /m);
  assert.match(PHONE, /^; /m);
  assert.match(TABLET, /^vendor\.unknown\.setting = 42$/m);
});

test('round-trip byte a byte das fixtures phone e tablet', () => {
  for (const text of [PHONE, TABLET]) {
    assert.equal(serializeIni(parseIni(text)), text);
  }
});

test('round-trip preserva CRLF, CR, BOM, linhas em branco e ausencia de newline final', () => {
  const cases = [
    '﻿a=1\r\nb = 2\r\n\r\n# c\r\n',
    'a=1\rb=2\r',
    'a=1\n\n\n  ; x\nsem igual\n=sem chave\nk=',
    '',
    '\n',
    'k=v',
  ];
  for (const text of cases) assert.equal(serializeIni(parseIni(text)), text);
});

test('parse: valor com "=" e chave indentada com espacos', () => {
  const doc = parseIni(PHONE);
  assert.equal(getValue(doc, 'custom.vendor.flag'), 'abc=def');
  assert.equal(getValue(doc, 'indented.key'), 'valor com espacos');
});

test('setValue preserva separador e espaco final; chave nova respeita EOL e newline final', () => {
  const crlf = parseIni('a = 1  \r\nb=2');
  const changed = setValue(crlf, 'a', '9');
  assert.equal(serializeIni(changed), 'a = 9  \r\nb=2');
  assert.equal(serializeIni(setValue(crlf, 'c', '3')), 'a = 1  \r\nb=2\r\nc=3');
  assert.equal(serializeIni(setValue(parseIni('a=1\n'), 'c', '3')), 'a=1\nc=3\n');
  assert.equal(setValue(crlf, 'a', '1'), crlf, 'mesmo valor devolve o mesmo doc');
});

test('applyProfile no phone: mudancas esperadas e nada fora das chaves geridas', () => {
  const doc = parseIni(PHONE);
  const { doc: out, changes } = applyProfile(doc, buildAndroidProfile());
  const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));

  assert.deepEqual(byKey['hw.ramSize'], { key: 'hw.ramSize', from: '2G', to: '2048' });
  assert.deepEqual(byKey['vm.heapSize'], { key: 'vm.heapSize', from: '228M', to: '256' });
  assert.deepEqual(byKey['hw.cpu.ncore'], { key: 'hw.cpu.ncore', from: '4', to: '2' });
  assert.equal(getValue(out, 'hw.gpu.enabled'), 'yes');
  assert.equal(getValue(out, 'hw.gpu.mode'), 'host');
  assert.equal(getValue(out, 'hw.audioInput'), 'no');
  assert.equal(getValue(out, 'hw.audioOutput'), 'no');
  assert.equal(getValue(out, 'hw.camera.back'), 'none');
  assert.equal(getValue(out, 'hw.camera.front'), 'none');
  assert.equal(byKey['hw.camera.front'], undefined, 'ja era none: sem mudanca');
  assert.equal(getValue(out, 'hw.gps'), 'no');
  assert.equal(getValue(out, 'showDeviceFrame'), 'no');
  assert.equal(getValue(out, 'fastboot.forceColdBoot'), 'no');

  // Sensores: hw.sensors.* viram no, exceto orientation; accelerometer intacto.
  assert.equal(getValue(out, 'hw.sensors.light'), 'no');
  assert.equal(getValue(out, 'hw.sensors.proximity'), 'no');
  assert.equal(getValue(out, 'hw.sensors.orientation'), 'yes');
  assert.equal(getValue(out, 'hw.accelerometer'), 'yes');
  assert.equal(getValue(out, 'hw.gyroscope'), 'yes', 'hw.gyroscope nao e hw.sensors.*');

  // Nenhuma chave nova de sensor e criada.
  const sensorKeysBefore = doc.lines.filter((l) => l.kind === 'entry' && l.key.startsWith('hw.sensors.')).length;
  const sensorKeysAfter = out.lines.filter((l) => l.kind === 'entry' && l.key.startsWith('hw.sensors.')).length;
  assert.equal(sensorKeysAfter, sensorKeysBefore);
  assert.equal(out.lines.length, doc.lines.length, 'todas as chaves geridas ja existiam');
});

test('chaves desconhecidas, comentarios e ordem ficam intactos', () => {
  const doc = parseIni(PHONE);
  const { doc: out, changes } = applyProfile(doc, buildAndroidProfile());
  const changedKeys = new Set(changes.map((c) => c.key));
  assert.equal(out.lines.length, doc.lines.length);
  for (let i = 0; i < doc.lines.length; i++) {
    const before = doc.lines[i];
    const after = out.lines[i];
    if (before.kind === 'entry' && changedKeys.has(before.key)) {
      assert.equal(after.kind, 'entry');
      assert.equal((after as typeof before).key, before.key);
      continue;
    }
    assert.equal(after.raw, before.raw, `linha ${i + 1} intacta`);
    assert.equal(after.eol, before.eol);
  }
  const text = serializeIni(out);
  assert.match(text, /^custom\.vendor\.flag=abc=def$/m);
  assert.match(text, /^ {2}indented\.key = valor com espacos {2}$/m);
  assert.match(text, /^linha sem igual$/m);
  assert.ok(text.startsWith('# AVD de referencia'));
});

test('applyProfile e idempotente (segunda aplicacao = zero mudancas, mesmos bytes)', () => {
  const profiles = [
    buildAndroidProfile(),
    buildAndroidProfile({ aggressive: true, screen: '720x1600@320' }),
    buildAndroidProfile({ capabilities: ['audio', 'camera'], gpu: 'auto', ramMb: 3072 }),
  ];
  for (const text of [PHONE, TABLET]) {
    for (const profile of profiles) {
      const first = applyProfile(parseIni(text), profile);
      assert.ok(first.changes.length > 0);
      const second = applyProfile(first.doc, profile);
      assert.deepEqual(second.changes, []);
      assert.equal(serializeIni(second.doc), serializeIni(first.doc));
    }
  }
});

test('tablet sem newline final continua sem newline final depois do tune', () => {
  const { doc } = applyProfile(parseIni(TABLET), buildAndroidProfile());
  const text = serializeIni(doc);
  assert.ok(!text.endsWith('\n'));
  assert.ok(text.endsWith('vm.heapSize=256'));
});

test('screen=keep nao toca hw.lcd.*; screen explicito troca width/height/density', () => {
  const doc = parseIni(TABLET);
  const keep = applyProfile(doc, buildAndroidProfile());
  assert.ok(keep.changes.every((c) => !c.key.startsWith('hw.lcd.')));
  assert.equal(getValue(keep.doc, 'hw.lcd.width'), '2560');

  const custom = applyProfile(doc, buildAndroidProfile({ screen: '1080x1920@240' }));
  const lcd = custom.changes.filter((c) => c.key.startsWith('hw.lcd.')).map((c) => [c.key, c.from, c.to]);
  assert.deepEqual(lcd, [
    ['hw.lcd.width', '2560', '1080'],
    ['hw.lcd.height', '1600', '1920'],
    ['hw.lcd.density', '320', '240'],
  ]);
  assert.equal(getValue(custom.doc, 'hw.lcd.depth'), '32', 'outras hw.lcd.* intactas');
});

test('capacidades audio e camera invertem as chaves certas', () => {
  const doc = parseIni(PHONE);
  const base = applyProfile(doc, buildAndroidProfile()).doc;
  const audio = applyProfile(doc, buildAndroidProfile({ capabilities: ['audio'] })).doc;
  const camera = applyProfile(doc, buildAndroidProfile({ capabilities: ['camera'] })).doc;

  for (const k of ['hw.audioInput', 'hw.audioOutput']) {
    assert.equal(getValue(base, k), 'no');
    assert.equal(getValue(audio, k), 'yes');
    assert.equal(getValue(camera, k), 'no');
  }
  for (const k of ['hw.camera.back', 'hw.camera.front']) {
    assert.equal(getValue(base, k), 'none');
    assert.equal(getValue(camera, k), 'emulated');
    assert.equal(getValue(audio, k), 'none');
  }
});

test('chave gerida ausente e acrescentada no fim; sensores ausentes nao sao criados', () => {
  const { doc, changes } = applyProfile(parseIni('# minimo\nhw.ramSize=2G\n'), buildAndroidProfile());
  const text = serializeIni(doc);
  assert.ok(text.startsWith('# minimo\nhw.ramSize=2048\n'));
  assert.match(text, /^hw\.gpu\.mode=host$/m);
  assert.ok(text.endsWith('\n'));
  assert.ok(!/hw\.sensors\./.test(text));
  assert.ok(changes.some((c) => c.key === 'hw.gps' && c.from === null && c.to === 'no'));
});

test('capacidade location grava hw.gps=yes; sem ela, hw.gps=no', () => {
  const doc = parseIni(PHONE); // fixture vem com hw.gps=yes
  const base = applyProfile(doc, buildAndroidProfile());
  const loc = applyProfile(doc, buildAndroidProfile({ capabilities: ['location'] }));
  assert.equal(getValue(base.doc, 'hw.gps'), 'no');
  assert.ok(base.changes.some((c) => c.key === 'hw.gps' && c.from === 'yes' && c.to === 'no'));
  assert.equal(getValue(loc.doc, 'hw.gps'), 'yes');
  assert.ok(!loc.changes.some((c) => c.key === 'hw.gps'), 'ja estava yes: sem mudanca');
  const tablet = applyProfile(parseIni(TABLET), buildAndroidProfile({ capabilities: ['location'] })); // hw.gps=no
  assert.ok(tablet.changes.some((c) => c.key === 'hw.gps' && c.from === 'no' && c.to === 'yes'));
  assert.equal(getValue(loc.doc, 'hw.audioOutput'), 'no', 'location nao mexe em outras capacidades');
});
