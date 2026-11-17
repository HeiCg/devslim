import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fileSize,
  isSoftwareGpu,
  parseRamIncreaseLine,
  parseRamIncreaseMb,
  parseRamMb,
  ramIncreaseFromLog,
  ramIncreaseLineFromLog,
  readEffectiveHardware,
} from '../src/android/hardwareQemu.ts';
import { isSoftwareGpu as doctorIsSoftwareGpu, parseRamMb as doctorParseRamMb } from '../src/doctor.ts';

// Literal emulator log line from real use (bench-api35, -memory 2048).
const REAL_LINE = 'INFO         | Increasing RAM size to 2560MB';

test('parseRamIncreaseMb: real line, last occurrence wins, absence = null', () => {
  assert.equal(parseRamIncreaseMb(`INFO         | Android emulator version 36.1.9.0\n${REAL_LINE}\nINFO         | boot\n`), 2560);
  assert.equal(parseRamIncreaseMb(`${REAL_LINE.replace('2560', '4096')}\n${REAL_LINE}\n`), 2560);
  assert.equal(parseRamIncreaseMb('INFO         | Increasing RAM size to 3072 MB\r\n'), 3072);
  assert.equal(parseRamIncreaseMb('INFO         | boot completed\n'), null);
  assert.equal(parseRamIncreaseMb(''), null);
});

test('ramIncreaseFromLog: only the part after the offset; missing file = null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devslim-hwq-'));
  try {
    const log = join(dir, 'a.log');
    assert.equal(ramIncreaseFromLog(log), null);
    assert.equal(fileSize(log), 0);
    writeFileSync(log, `${REAL_LINE.replace('2560', '4096')}\n`);
    const offset = fileSize(log);
    assert.equal(ramIncreaseFromLog(log, offset), null, 'nothing new after the offset');
    appendFileSync(log, `${REAL_LINE}\n`);
    assert.equal(ramIncreaseFromLog(log, offset), 2560);
    assert.equal(ramIncreaseFromLog(log), 2560, 'no offset: last one in the file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEffectiveHardware: hardware-qemu.ini with " = "; absent = null; single parseRamMb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devslim-hwq-'));
  try {
    assert.equal(readEffectiveHardware(dir), null);
    writeFileSync(join(dir, 'hardware-qemu.ini'), 'hw.cpu.arch = arm64\nhw.ramSize = 2560\nhw.gpu.mode = host\nvm.heapSize = 576\n');
    assert.deepEqual(readEffectiveHardware(dir), { ramMb: 2560, gpu: 'host' });
    writeFileSync(join(dir, 'hardware-qemu.ini'), 'hw.ramSize = 2G\n');
    assert.deepEqual(readEffectiveHardware(dir), { ramMb: 2048, gpu: null });
    assert.equal(parseRamMb('2048MB'), 2048);
    assert.equal(doctorParseRamMb, parseRamMb, 'doctor re-exports the same function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseRamIncreaseLine/ramIncreaseLineFromLog: return MB and the line (whitespace collapsed) from this boot', () => {
  assert.deepEqual(parseRamIncreaseLine(`INFO | boot\n${REAL_LINE}\r\n`), { mb: 2560, line: 'INFO | Increasing RAM size to 2560MB' });
  assert.equal(parseRamIncreaseLine('INFO | boot\n'), null);
  const dir = mkdtempSync(join(tmpdir(), 'devslim-hwq-'));
  try {
    const log = join(dir, 'a.log');
    assert.equal(ramIncreaseLineFromLog(log), null);
    writeFileSync(log, `${REAL_LINE.replace('2560', '4096')}\n`);
    const offset = fileSize(log);
    appendFileSync(log, `${REAL_LINE}\n`);
    assert.deepEqual(ramIncreaseLineFromLog(log, offset), { mb: 2560, line: 'INFO | Increasing RAM size to 2560MB' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSoftwareGpu: lavapipe, swiftshader*, software, guest; host/auto not; doctor re-exports', () => {
  for (const m of ['lavapipe', 'swiftshader_indirect', 'swiftshader', 'software', 'guest', ' Lavapipe ']) assert.equal(isSoftwareGpu(m), true, m);
  for (const m of ['host', 'auto', 'angle_indirect']) assert.equal(isSoftwareGpu(m), false, m);
  assert.equal(doctorIsSoftwareGpu, isSoftwareGpu);
});
