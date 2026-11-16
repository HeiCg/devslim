import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createAdb } from '../src/android/adb.ts';
import { createFakeAndroid, type FakeAndroidOptions } from '../src/android/fakeAndroid.ts';
import { recordSession } from '../src/android/session.ts';
import {
  countPsProcesses,
  findQemuPid,
  measureAndroidGuest,
  measureAndroidHost,
  measureAvd,
  measureSim,
  parseDumpsysMeminfo,
  parseFootprintHeaderMb,
  parseFootprintMb,
  parsePhysFootprintMb,
  parseProcMeminfo,
  parseRssMb,
  parsePsTable,
  parseTopMem,
  processTree,
} from '../src/measure.ts';
import { createFakeIos } from '../src/ios/fakeIos.ts';

// Layout real do `footprint -p` no macOS 26.6 (capturado de um zsh), com numeros de qemu.
const FOOTPRINT_QEMU = `======================================================================
qemu-system-aarch64 [51234]: 64-bit    Footprint: 2690 MB (16384 bytes per page)
======================================================================

  Dirty      Clean  Reclaimable    Regions    Category
    ---        ---          ---        ---    ---
2048 MB        0 B          0 B          3    untagged (VM_ALLOCATE)
 412 MB        0 B          0 B        212    IOAccelerator
 118 MB        0 B          0 B         75    MALLOC_SMALL
    0 B      55 MB          0 B        410    __TEXT
    ---        ---          ---        ---    ---
2690 MB      55 MB          0 B       1234    TOTAL

Auxiliary data:
    phys_footprint: 2.6 GB
    phys_footprint_peak: 2.7 GB
`;

const FOOTPRINT_ZSH = `======================================================================
zsh [4964]: 64-bit    Footprint: 2272 KB (16384 bytes per page)
======================================================================

  Dirty      Clean  Reclaimable    Regions    Category
    ---        ---          ---        ---    ---
 976 KB        0 B          0 B          5    MALLOC_SMALL
    ---        ---          ---        ---    ---
2272 KB     560 KB          0 B        412    TOTAL

Auxiliary data:
    phys_footprint: 2288 KB
    phys_footprint_peak: 2400 KB
`;

const PROC_MEMINFO = `MemTotal:        2014388 kB
MemFree:          123456 kB
MemAvailable:    1061523 kB
Buffers:           12345 kB
Cached:           654321 kB
SwapCached:            0 kB
`;

const PS_A = `USER            PID   PPID     VSZ    RSS WCHAN            ADDR S NAME
root              1      0 10903164  9172 0                   0 S init
root              2      0       0      0 0                   0 S [kthreadd]
system          612      1 14423064 98232 0                   0 S system_server
u0_a123        1201    310 14012345 65432 0                   0 S com.example.app
`;

const DUMPSYS_TAIL = `Total PSS by category:
   612,345K: Dalvik
Total RAM: 2,014,388K (status normal)
 Free RAM: 1,061,523K (  290,295K cached pss +   691,804K cached kernel +    79,424K free)
DMA-BUF:    45,676K (    9,012K mapped +    36,664K unmapped)
      GPU:    12,345K (   12,345K dmabuf +         0K private)
 Used RAM:   871,869K (  645,481K used pss +   226,388K kernel)
 Lost RAM:    80,996K
     ZRAM:    12,345K physical used for    45,678K in swap (1,007,190K total swap)
   Tuning: 256 (large 512), oom   322,560K, restore limit   107,520K (high-end-gfx)
`;

test('parseFootprintMb: phys_footprint em GB, KB e MB; cai no cabecalho sem a linha', () => {
  assert.equal(parseFootprintMb(FOOTPRINT_QEMU), 2662.4);
  assert.equal(parseFootprintMb(FOOTPRINT_ZSH), 2.2);
  assert.equal(parseFootprintMb('    phys_footprint: 1234 MB\n    phys_footprint_peak: 1500 MB\n'), 1234);
  assert.equal(parseFootprintMb('x [1]: 64-bit    Footprint: 2690 MB (16384 bytes per page)\n'), 2690);
  assert.equal(parseFootprintMb('footprint: no process found'), null);
});

// Uso real (2026-11-16, bench-api35, pid 73808). Literais: a linha de cabecalho
// e a linha phys_footprint; a tabela do meio foi omitida (nao capturada).
const FOOTPRINT_REAL_73808 = `======================================================================
qemu-system-aarch64-headless [73808]: 64-bit    Footprint: 3000 MB (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 5582 MB
`;
const PS_RSS_REAL_73808 = '4137840\n'; // `ps -o rss= -p 73808`, em KB

test('fixture real: phys_footprint 5582, cabecalho 3000, RSS 4137840 KB = 4040.9 MB', async () => {
  assert.equal(parsePhysFootprintMb(FOOTPRINT_REAL_73808), 5582);
  assert.equal(parseFootprintHeaderMb(FOOTPRINT_REAL_73808), 3000);
  assert.equal(parseRssMb(PS_RSS_REAL_73808), 4040.9); // 4137840 / 1024 = 4040.86
  const fake = createFakeAndroid({ host: { footprint: FOOTPRINT_REAL_73808, rss: PS_RSS_REAL_73808 } });
  assert.deepEqual(await measureAndroidHost(73808, { exec: fake.exec }), { footprintMb: 5582, footprintHeaderMb: 3000, rssMb: 4040.9 });
});

test('footprint: KB/MB/GB nos dois campos; cada um null quando falta a sua linha', () => {
  assert.equal(parsePhysFootprintMb('    phys_footprint: 2.5 GB\n'), 2560);
  assert.equal(parsePhysFootprintMb('    phys_footprint: 2048 KB\n'), 2);
  assert.equal(parseFootprintHeaderMb('x [1]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)\n'), 1536);
  assert.equal(parseFootprintHeaderMb('zsh [4964]: 64-bit    Footprint: 2272 KB (16384 bytes per page)\n'), 2.2);
  assert.equal(parseFootprintHeaderMb(FOOTPRINT_QEMU), 2690);
  // So cabecalho: phys null (sem cair no cabecalho); so phys: cabecalho null.
  assert.equal(parsePhysFootprintMb('x [1]: 64-bit    Footprint: 2690 MB (16384 bytes per page)\n'), null);
  assert.equal(parseFootprintHeaderMb('    phys_footprint: 1234 MB\n    phys_footprint_peak: 1500 MB\n'), null);
  assert.equal(parseFootprintHeaderMb('footprint: no process found'), null);
});

test('measureAndroidHost: so cabecalho no footprint = footprintMb null, footprintHeaderMb preenchido', async () => {
  const fake = createFakeAndroid({ host: { footprint: 'x [1]: 64-bit    Footprint: 3000 MB (16384 bytes per page)\n', rss: null } });
  assert.deepEqual(await measureAndroidHost(1, { exec: fake.exec }), { footprintMb: null, footprintHeaderMb: 3000, rssMb: null });
});

test('parseRssMb: KB inteiro', () => {
  assert.equal(parseRssMb('  2754560\n'), 2690);
  assert.equal(parseRssMb(''), null);
});

test('parseProcMeminfo, countPsProcesses, parseDumpsysMeminfo', () => {
  assert.deepEqual(parseProcMeminfo(PROC_MEMINFO), { memTotalMb: 1967.2, memAvailableMb: 1036.6 });
  assert.deepEqual(parseProcMeminfo('lixo'), { memTotalMb: null, memAvailableMb: null });
  assert.equal(countPsProcesses(PS_A), 4);
  assert.equal(countPsProcesses(''), null);
  assert.equal(countPsProcesses('erro: sem permissao\n'), null);
  assert.deepEqual(parseDumpsysMeminfo(DUMPSYS_TAIL), { usedRamMb: 851.4, freeRamMb: 1036.6 });
  assert.deepEqual(parseDumpsysMeminfo('Applications Memory Usage (in Kilobytes):\n'), { usedRamMb: null, freeRamMb: null });
});

test('measureAndroidHost: footprint + ps; qualquer falha vira null', async () => {
  const ok = createFakeAndroid({ host: { footprint: FOOTPRINT_QEMU, rss: '2754560\n' } });
  assert.deepEqual(await measureAndroidHost(51234, { exec: ok.exec }), { footprintMb: 2662.4, footprintHeaderMb: 2690, rssMb: 2690 });
  assert.deepEqual(ok.exec.calls.map((c) => [c.cmd, ...c.args]), [['footprint', '-p', '51234'], ['ps', '-o', 'rss=', '-p', '51234']]);
  const bad = createFakeAndroid({});
  assert.deepEqual(await measureAndroidHost(1, { exec: bad.exec }), { footprintMb: null, footprintHeaderMb: null, rssMb: null });
  const throwing = async () => { throw new Error('footprint: comando nao encontrado'); };
  assert.deepEqual(await measureAndroidHost(1, { exec: throwing }), { footprintMb: null, footprintHeaderMb: null, rssMb: null });
});

test('measureAndroidGuest: meminfo, ps -A, dumpsys; falhas viram null', async () => {
  const fake = createFakeAndroid({ emulators: [{ avd: 'a', port: 5554 }], guest: { meminfo: PROC_MEMINFO, ps: PS_A, dumpsys: DUMPSYS_TAIL } });
  const adb = createAdb({ adbPath: fake.tools.adb, exec: fake.exec });
  assert.deepEqual(await measureAndroidGuest('emulator-5554', { adb }), {
    memTotalMb: 1967.2, memAvailableMb: 1036.6, processes: 4, usedRamMb: 851.4, freeRamMb: 1036.6,
  });
  assert.deepEqual(fake.deviceCommands(), ['shell cat /proc/meminfo', 'shell ps -A', 'shell dumpsys meminfo']);

  const partial = createFakeAndroid({ emulators: [{ avd: 'a', port: 5554 }], guest: { meminfo: PROC_MEMINFO } });
  const adb2 = createAdb({ adbPath: partial.tools.adb, exec: partial.exec });
  assert.deepEqual(await measureAndroidGuest('emulator-5554', { adb: adb2 }), {
    memTotalMb: 1967.2, memAvailableMb: 1036.6, processes: null, usedRamMb: null, freeRamMb: null,
  });
});

test('findQemuPid: pgrep -f com o nome do AVD; fallback para o pid da sessao', async () => {
  const hit = createFakeAndroid({ host: { pgrep: '51234\n' } });
  assert.equal(await findQemuPid('slim-api35', { exec: hit.exec, sessionPid: 9 }), 51234);
  assert.deepEqual(hit.exec.calls[0].args, ['-f', 'qemu-system.*-avd slim-api35( |$)']);
  const miss = createFakeAndroid({});
  assert.equal(await findQemuPid('slim-api35', { exec: miss.exec, sessionPid: 9 }), 9);
  assert.equal(await findQemuPid('slim-api35', { exec: miss.exec }), null);
});

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'devslim-measure-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctxFor(opts: FakeAndroidOptions) {
  const avdHome = join(root, 'avd');
  mkdirSync(join(avdHome, 'slim-api35.avd'), { recursive: true });
  writeFileSync(join(avdHome, 'slim-api35.avd', 'config.ini'), 'hw.ramSize=2048\n');
  const fake = createFakeAndroid(opts);
  const env = { ANDROID_HOME: fake.sdk, ANDROID_AVD_HOME: avdHome, DEVSLIM_HOME: join(root, 'home'), HOME: root };
  return { fake, env, ctx: { env, exec: fake.exec, fileExists: fake.fileExists, date: fake.date } };
}

test('measureAvd: objeto estavel; pid da sessao quando pgrep nao acha', async () => {
  const { ctx, env } = ctxFor({
    emulators: [{ avd: 'slim-api35', port: 5556 }],
    host: { footprint: FOOTPRINT_QEMU, rss: '2754560\n' },
    guest: { meminfo: PROC_MEMINFO, ps: PS_A, dumpsys: DUMPSYS_TAIL },
  });
  recordSession({ platform: 'android', avd: 'slim-api35', serial: 'emulator-5556', pid: 4242, port: 5556, startedAt: 'x' }, env);
  const m = await measureAvd('slim-api35', ctx);
  assert.deepEqual(m, {
    platform: 'android',
    avd: 'slim-api35',
    serial: 'emulator-5556',
    pid: 4242,
    host: { footprintMb: 2662.4, footprintHeaderMb: 2690, rssMb: 2690 },
    guest: { memTotalMb: 1967.2, memAvailableMb: 1036.6, processes: 4, usedRamMb: 851.4, freeRamMb: 1036.6 },
    at: '2026-11-16T12:00:00.000Z',
  });
});

test('measureAvd: sem pid conhecido, host vira null; AVD parado da erro', async () => {
  const { ctx } = ctxFor({ emulators: [{ avd: 'slim-api35', port: 5554 }] });
  const m = await measureAvd('slim-api35', ctx);
  assert.equal(m.pid, null);
  assert.deepEqual(m.host, { footprintMb: null, footprintHeaderMb: null, rssMb: null });
  assert.deepEqual(m.guest, { memTotalMb: null, memAvailableMb: null, processes: null, usedRamMb: null, freeRamMb: null });

  const off = ctxFor({});
  await assert.rejects(measureAvd('slim-api35', off.ctx), /nao esta rodando/);
});

// ---------------------------------------------------------------------------
// iOS

// Layout real do `top -l 1 -stats pid,mem` no macOS 26.6, com pids da arvore abaixo.
const TOP_IOS = `Processes: 512 total, 5 running, 507 sleeping, 3867 threads
2026/11/16 10:40:53
Load Avg: 4.71, 5.28, 5.52
PhysMem: 22G used (2803M wired, 7312M compressor), 1055M unused.

PID    MEM
700    2048K
701    198M+
702    1.5G-
703    15M
704    512B
705    10M
900    300M
`;

// 700 = launchd_sim do device; 701..703 filhos; 704 neto; 705 orfao (pai 1);
// 900 e outro processo do host. 702 tem espaco no caminho.
const PS_IOS = `  PID  PPID  %CPU COMM
    1     0   0.2 /sbin/launchd
  700     1   0.5 /Library/Developer/CoreSimulator/launchd_sim
  701   700   1.5 /Library/Developer/CoreSimulator/Volumes/iOS_23E244/RuntimeRoot/usr/libexec/backboardd
  702   700  10.0 /Library/Developer/CoreSimulator/Volumes/iOS 26.4/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard
  703   700   0,5 /usr/libexec/assetsd
  704   701   0.1 /usr/libexec/neto
  705     1   9.9 /usr/libexec/orfao
  900     1  50.0 /Applications/Outro.app/Contents/MacOS/Outro
`;

const SIM_UDID = 'DBF8B093-58A2-4B57-812A-60D6CF8594BD';

test('parseTopMem: sufixos B/K/M/G e +/- do top; cabecalho ignorado', () => {
  const m = parseTopMem(TOP_IOS);
  assert.equal(m.get(700), 2);
  assert.equal(m.get(701), 198);
  assert.equal(m.get(702), 1536);
  assert.equal(m.get(704), 512 / (1024 * 1024));
  assert.equal(m.size, 7);
  assert.equal(parseTopMem('PID    MEM\nlixo\n').size, 0);
});

test('parsePsTable + processTree: arvore a partir do launchd_sim, orfaos ignorados', () => {
  const t = parsePsTable(PS_IOS);
  assert.equal(t.get(702)!.comm, '/Library/Developer/CoreSimulator/Volumes/iOS 26.4/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard');
  assert.equal(t.get(703)!.cpu, 0.5, 'virgula decimal');
  assert.deepEqual(processTree(700, t), [700, 701, 702, 703, 704]);
  assert.deepEqual(processTree(12345, t), [12345], 'raiz sem filhos');
});

test('measureSim: soma footprint e cpu da arvore; objeto estavel', async () => {
  const fake = createFakeIos({
    storeBase: root,
    simulators: [{ udid: SIM_UDID, name: 'QA-iPhone17', state: 'Booted' }],
    measure: { pgrep: '700\n', ps: PS_IOS, top: TOP_IOS },
  });
  const m = await measureSim('QA-iPhone17', { exec: fake.exec, date: fake.date, env: {} });
  assert.deepEqual(m, {
    platform: 'ios',
    udid: SIM_UDID,
    name: 'QA-iPhone17',
    processes: 5,
    footprintMb: 1751,
    cpuPercent: 12.6,
    at: '2026-11-16T12:00:00.000Z',
  });
  assert.deepEqual(fake.calls.find((c) => c.cmd === 'pgrep')!.args, ['-f', `${SIM_UDID}/data/var/run/launchd_bootstrap`]);
  assert.deepEqual(fake.calls.find((c) => c.cmd === 'ps')!.args, ['-axo', 'pid,ppid,%cpu,comm']);
  assert.deepEqual(fake.calls.find((c) => c.cmd === 'top')!.args, ['-l', '1', '-stats', 'pid,mem']);
});

test('measureSim: device nao bootado ou sem launchd_sim = erro claro', async () => {
  const off = createFakeIos({ storeBase: root, simulators: [{ udid: SIM_UDID, name: 'QA-iPhone17' }] });
  await assert.rejects(measureSim(SIM_UDID, { exec: off.exec, env: {} }), /nao esta bootado \(estado Shutdown\)/);
  const nopid = createFakeIos({ storeBase: root, simulators: [{ udid: SIM_UDID, name: 'QA-iPhone17', state: 'Booted' }] });
  await assert.rejects(measureSim(SIM_UDID, { exec: nopid.exec, env: {} }), /launchd_sim de QA-iPhone17 .* nao encontrado/);
});
