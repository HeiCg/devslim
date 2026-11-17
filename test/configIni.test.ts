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

test('fixtures cover the required edge cases', () => {
  assert.ok(PHONE.endsWith('\n'), 'phone ends with a newline');
  assert.ok(!TABLET.endsWith('\n'), 'tablet without trailing newline');
  assert.match(PHONE, /^# /m);
  assert.match(PHONE, /^; /m);
  assert.match(TABLET, /^vendor\.unknown\.setting = 42$/m);
});

test('byte-for-byte round-trip of the phone and tablet fixtures', () => {
  for (const text of [PHONE, TABLET]) {
    assert.equal(serializeIni(parseIni(text)), text);
  }
});

test('round-trip preserves CRLF, CR, BOM, blank lines and missing trailing newline', () => {
  const cases = [
    '﻿a=1\r\nb = 2\r\n\r\n# c\r\n',
    'a=1\rb=2\r',
    'a=1\n\n\n  ; x\nno equals\n=no key\nk=',
    '',
    '\n',
    'k=v',
  ];
  for (const text of cases) assert.equal(serializeIni(parseIni(text)), text);
});

test('parse: value with "=" and key indented with spaces', () => {
  const doc = parseIni(PHONE);
  assert.equal(getValue(doc, 'custom.vendor.flag'), 'abc=def');
  assert.equal(getValue(doc, 'indented.key'), 'value with spaces');
});

test('setValue keeps the separator and trailing whitespace; a new key follows EOL and trailing newline', () => {
  const crlf = parseIni('a = 1  \r\nb=2');
  const changed = setValue(crlf, 'a', '9');
  assert.equal(serializeIni(changed), 'a = 9  \r\nb=2');
  assert.equal(serializeIni(setValue(crlf, 'c', '3')), 'a = 1  \r\nb=2\r\nc=3');
  assert.equal(serializeIni(setValue(parseIni('a=1\n'), 'c', '3')), 'a=1\nc=3\n');
  assert.equal(setValue(crlf, 'a', '1'), crlf, 'same value returns the same doc');
});

test('applyProfile on phone: expected changes and nothing outside the managed keys', () => {
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
  assert.equal(byKey['hw.camera.front'], undefined, 'already none: no change');
  assert.equal(getValue(out, 'hw.gps'), 'no');
  assert.equal(getValue(out, 'showDeviceFrame'), 'no');
  assert.equal(getValue(out, 'fastboot.forceColdBoot'), 'no');

  // Sensors: hw.sensors.* become no, except orientation; accelerometer intact.
  assert.equal(getValue(out, 'hw.sensors.light'), 'no');
  assert.equal(getValue(out, 'hw.sensors.proximity'), 'no');
  assert.equal(getValue(out, 'hw.sensors.orientation'), 'yes');
  assert.equal(getValue(out, 'hw.accelerometer'), 'yes');
  assert.equal(getValue(out, 'hw.gyroscope'), 'yes', 'hw.gyroscope is not hw.sensors.*');

  // No new sensor key is created.
  const sensorKeysBefore = doc.lines.filter((l) => l.kind === 'entry' && l.key.startsWith('hw.sensors.')).length;
  const sensorKeysAfter = out.lines.filter((l) => l.kind === 'entry' && l.key.startsWith('hw.sensors.')).length;
  assert.equal(sensorKeysAfter, sensorKeysBefore);
  assert.equal(out.lines.length, doc.lines.length, 'all managed keys already existed');
});

test('unknown keys, comments and order stay intact', () => {
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
    assert.equal(after.raw, before.raw, `line ${i + 1} intact`);
    assert.equal(after.eol, before.eol);
  }
  const text = serializeIni(out);
  assert.match(text, /^custom\.vendor\.flag=abc=def$/m);
  assert.match(text, /^ {2}indented\.key = value with spaces {2}$/m);
  assert.match(text, /^line without equals$/m);
  assert.ok(text.startsWith('# reference AVD'));
});

test('applyProfile is idempotent (second application = zero changes, same bytes)', () => {
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

test('tablet without trailing newline still has none after tune', () => {
  const { doc } = applyProfile(parseIni(TABLET), buildAndroidProfile());
  const text = serializeIni(doc);
  assert.ok(!text.endsWith('\n'));
  assert.ok(text.endsWith('vm.heapSize=256'));
});

test('screen=keep does not touch hw.lcd.*; explicit screen changes width/height/density', () => {
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
  assert.equal(getValue(custom.doc, 'hw.lcd.depth'), '32', 'other hw.lcd.* intact');
});

test('audio and camera capabilities flip the right keys', () => {
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

test('missing managed key is appended at the end; missing sensors are not created', () => {
  const { doc, changes } = applyProfile(parseIni('# minimal\nhw.ramSize=2G\n'), buildAndroidProfile());
  const text = serializeIni(doc);
  assert.ok(text.startsWith('# minimal\nhw.ramSize=2048\n'));
  assert.match(text, /^hw\.gpu\.mode=host$/m);
  assert.ok(text.endsWith('\n'));
  assert.ok(!/hw\.sensors\./.test(text));
  assert.ok(changes.some((c) => c.key === 'hw.gps' && c.from === null && c.to === 'no'));
});

test('location capability writes hw.gps=yes; without it, hw.gps=no', () => {
  const doc = parseIni(PHONE); // fixture comes with hw.gps=yes
  const base = applyProfile(doc, buildAndroidProfile());
  const loc = applyProfile(doc, buildAndroidProfile({ capabilities: ['location'] }));
  assert.equal(getValue(base.doc, 'hw.gps'), 'no');
  assert.ok(base.changes.some((c) => c.key === 'hw.gps' && c.from === 'yes' && c.to === 'no'));
  assert.equal(getValue(loc.doc, 'hw.gps'), 'yes');
  assert.ok(!loc.changes.some((c) => c.key === 'hw.gps'), 'already yes: no change');
  const tablet = applyProfile(parseIni(TABLET), buildAndroidProfile({ capabilities: ['location'] })); // hw.gps=no
  assert.ok(tablet.changes.some((c) => c.key === 'hw.gps' && c.from === 'no' && c.to === 'yes'));
  assert.equal(getValue(loc.doc, 'hw.audioOutput'), 'no', 'location does not touch other capabilities');
});
