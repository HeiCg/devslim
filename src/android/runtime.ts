import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DevslimError } from '../errors.ts';
import { devslimHome, loadState, recordAndroidGuest, type AndroidState } from '../state.ts';
import { portForSerial, serialForPort, type Adb, type AdbDevice } from './adb.ts';
import { avdHome, findAvd, listAvds, runningLocks, type AvdInfo } from './avd.ts';
import { resolveRuntime, type Runtime, type RuntimeContext } from './deps.ts';
import { buildLaunchArgs, SLIM_SNAPSHOT } from './launchArgs.ts';
import { imageDir, resolveImage } from './images.ts';
import { sdkRootOfTool } from './sdk.ts';
import type { BloatLevel } from './packages.ts';
import { buildAndroidProfile, PORT_MAX, PORT_MIN, type AndroidProfile } from './profile.ts';
import {
  assertSingleDevice,
  findAvdSerial,
  loadSession,
  recordSession,
  removeSession,
  runningEmulators,
  waitForExit,
  type SessionEntry,
} from './session.ts';
import { slimRunningDevice, type SlimReport } from './slim.ts';
import { tuneAvd, type TuneResult } from './tune.ts';
import { swapGate } from '../swap.ts';
import { fileSize, isSoftwareGpu, ramIncreaseLineFromLog, readEffectiveHardware } from './hardwareQemu.ts';
import { launcherFor, launcherText, type Launcher } from './launcher.ts';
import { findQemuPid } from '../measure.ts';
import { findRunningEntry, isAdvertised, scanRunning } from './runningIni.ts';
import { stopIdleWatcher } from '../idle.ts';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function slimSnapshotDir(avd: AvdInfo): string {
  return join(avd.dir, 'snapshots', SLIM_SNAPSHOT);
}

export function hasSlimSnapshot(avd: AvdInfo): boolean {
  return isDir(slimSnapshotDir(avd));
}

// Primeira porta par livre a partir de 5554, segundo `adb devices`.
export function pickFreePort(devices: readonly AdbDevice[]): number {
  const used = new Set(devices.map((d) => portForSerial(d.serial)).filter((p): p is number => p !== null));
  for (let p = PORT_MIN; p <= PORT_MAX; p += 2) {
    if (!used.has(p) && !used.has(p + 1)) return p;
  }
  throw new DevslimError(`nenhuma porta livre entre ${PORT_MIN} e ${PORT_MAX}`);
}

export function logFileFor(avd: string, env: Runtime['env']): string {
  return join(devslimHome(env), 'logs', `${avd}.log`);
}

type Launched = Readonly<{
  avd: string;
  serial: string;
  pid: number;
  port: number;
  fromSnapshot: boolean;
  emulatorArgs: readonly string[];
  logFile: string;
  logOffset: number; // tamanho do log antes do spawn: o resto e deste boot
  bootMs: number;
}>;

// Guarda, swap (recusa acima do limite sem --force), porta, spawn destacado, sessao, waitForBoot.
async function launch(
  rt: Runtime,
  adb: Adb,
  avd: AvdInfo,
  profile: AndroidProfile,
  o: { useSnapshot: boolean; force: boolean; action: string },
): Promise<Launched> {
  const census = await assertSingleDevice({ adb, exec: rt.exec, force: o.force, action: o.action });
  // Device ja rodando nunca chega aqui (upAvd devolve antes; bake recusa antes).
  await swapGate({ exec: rt.exec, stderr: rt.stderr, force: o.force, action: o.action });

  let port: number;
  if (profile.port !== null) {
    port = profile.port;
    if (census.emulators.some((d) => d.serial === serialForPort(port))) {
      throw new DevslimError(`porta ${port} ja em uso (${serialForPort(port)} no adb devices)`);
    }
  } else {
    port = pickFreePort(await adb.listDevices());
  }

  const fromSnapshot = o.useSnapshot && hasSlimSnapshot(avd);
  const emulatorArgs = buildLaunchArgs(avd.name, { ...profile, port }, fromSnapshot ? { snapshot: SLIM_SNAPSHOT } : {});
  const emulator = rt.tool('emulator');
  const logFile = logFileFor(avd.name, rt.env);
  mkdirSync(join(devslimHome(rt.env), 'logs'), { recursive: true, mode: 0o700 });

  const logOffset = fileSize(logFile);
  const t0 = rt.now();
  const { pid } = await rt.spawnDetached(emulator, emulatorArgs, { logFile, env: rt.env });
  const serial = serialForPort(port);
  // Registra antes do boot: se o boot falhar, `down` ainda acha o processo.
  recordSession({ platform: 'android', avd: avd.name, serial, pid, port, startedAt: rt.date().toISOString() }, rt.env);
  try {
    await adb.waitForBoot(serial, { timeoutMs: rt.bootTimeoutMs, pollMs: rt.pollMs });
  } catch (err) {
    throw new DevslimError(`${(err as Error).message}; log em ${logFile}; para encerrar: devslim android down ${avd.name}`);
  }
  return Object.freeze({
    avd: avd.name,
    serial,
    pid,
    port,
    fromSnapshot,
    emulatorArgs: Object.freeze(emulatorArgs),
    logFile,
    logOffset,
    bootMs: rt.now() - t0,
  });
}

// ---------------------------------------------------------------------------
// up

export type UpOptions = RuntimeContext & { force?: boolean };

export type UpResult = Readonly<{
  avd: string;
  serial: string;
  pid: number | null;
  port: number | null;
  fromSnapshot: boolean | null; // null quando ja estava rodando
  alreadyRunning: boolean;
  emulatorArgs: readonly string[];
  logFile: string | null;
  bootMs: number | null;
  // RAM que o emulador usou (hardware-qemu.ini; senao a linha "Increasing RAM
  // size" do log deste boot). null = nao deu para saber.
  ramEffectiveMb: number | null;
  // Quem lancou o emulador (linha de comando do qemu; null = nao deu para ler)
  // e o hw.gpu.mode do hardware-qemu.ini deste boot.
  launcher: Launcher | null;
  gpuEffective: string | null;
  // Entrada do AVD em avd/running com grpc.port e grpc.token (o que o argent
  // exige para screenshot/tap). O token nunca e lido para fora do runningIni.ts.
  advertised: boolean;
  grpcPort: number | null;
  hint?: string; // so quando subiu sem slim_base: sugere o bake
}>;

// O emulador eleva sem erro qualquer -memory abaixo do piso dele, a menos que
// o -lowram esteja ligado (medido 2026-11-17: 2560 MB em phone, 4096 MB em
// tablet 2560x1600; tela menor nao baixa o piso). O lowram faz o pedido valer,
// mas o guest passa a se declarar aparelho de pouca RAM.
export function lowRamTuneHint(avd: string): string {
  return `Com o AVD desligado: devslim android tune ${avd} --lowram (o lowram muda o comportamento dos apps: o guest se declara aparelho de pouca RAM)`;
}

export function ramFloorWarning(avd: string, requestedMb: number, effectiveMb: number, logLine: string | null = null, lowRam = false): string {
  const head =
    `devslim: aviso: RAM pedida ${requestedMb} MB, efetiva ${effectiveMb} MB (emulador elevou${lowRam ? ' mesmo com lowram' : ''}; -memory ${requestedMb} nao vence)` +
    `${logLine === null ? '' : `; log: "${logLine}"`}.`;
  if (lowRam) return `${head}\n`;
  return `${head} O emulador ignora -memory abaixo do piso dele a menos que o lowram esteja ligado. ${lowRamTuneHint(avd)}\n`;
}

// AVD ja rodando lancado por outro (argent, Studio) ou com GPU por software.
export function offProfileWarning(
  avd: string,
  o: { pid: number | null; launcher: Launcher | null; gpuEffective: string | null; ramEffectiveMb: number | null },
): string {
  const facts = [`pid ${o.pid ?? '?'}`];
  if (o.launcher !== null) facts.push(launcherText(o.launcher));
  if (o.gpuEffective !== null) facts.push(`gpu efetiva ${o.gpuEffective}${isSoftwareGpu(o.gpuEffective) ? ' (software)' : ''}`);
  if (o.ramEffectiveMb !== null) facts.push(`ram efetiva ${o.ramEffectiveMb} MB`);
  return (
    `devslim: aviso: AVD ${avd} ja roda fora do perfil (${facts.join(', ')}); nada subido, nada desligado. ` +
    `Para subir no perfil: devslim android down ${avd} --force e depois devslim android up ${avd}\n`
  );
}

// Espera maxima pelo running ini depois do boot; o emulador grava logo que o
// servidor gRPC sobe, normalmente antes do sys.boot_completed.
export const ADVERTISE_TIMEOUT_MS = 10_000;
export const ADVERTISE_POLL_MS = 500;

export function notAdvertisedWarning(dir: string | null): string {
  return (
    `devslim: aviso: emulador nao se anunciou em ${dir ?? '(diretorio de anuncio desconhecido nesta plataforma)'}: ` +
    'ferramentas que dependem de gRPC (argent screenshot/tap) nao vao enxerga-lo; adb funciona normalmente\n'
  );
}

// Procura a entrada do AVD (nome + porta do console). `wait`: ate
// ADVERTISE_TIMEOUT_MS ate ela aparecer anunciada; senao uma leitura so.
async function findAdvertisement(
  rt: Runtime,
  avd: string,
  port: number | null,
  wait: boolean,
): Promise<{ advertised: boolean; grpcPort: number | null }> {
  const deadline = rt.now() + ADVERTISE_TIMEOUT_MS;
  for (;;) {
    const e = findRunningEntry(scanRunning(rt.runningDir, rt.pidAlive).live, avd, port);
    if (isAdvertised(e) || !wait || rt.runningDir === null || rt.now() >= deadline) {
      return { advertised: isAdvertised(e), grpcPort: e?.grpcPort ?? null };
    }
    await rt.sleep(ADVERTISE_POLL_MS);
  }
}

export function bakeHint(avd: string): string {
  return `dica: subiu sem snapshot slim_base; rode uma vez devslim android bake ${avd} (com o AVD desligado) para os proximos up partirem de um guest ja enxuto`;
}

export async function upAvd(avdName: string, profile: AndroidProfile, opts: UpOptions = {}): Promise<UpResult> {
  const rt = resolveRuntime(opts);
  const avd = findAvd(avdName, { env: rt.env });
  const adb = rt.adb();

  const existing = await findAvdSerial(adb, avd.name);
  if (existing !== null) {
    const entry = loadSession(rt.env).find((e) => e.platform === 'android' && e.serial === existing && e.avd === avd.name);
    // Linha de comando sem adb: pid do qemu (pgrep), senao o da sessao; depois ps.
    const qemuPid = await findQemuPid(avd.name, { exec: rt.exec, sessionPid: entry?.pid ?? null });
    const { launcher } = await launcherFor(avd.name, { exec: rt.exec, pid: qemuPid, inSession: entry !== undefined });
    const hw = readEffectiveHardware(avd.dir);
    const gpuEffective = hw?.gpu ?? null;
    const ramEffectiveMb = hw?.ramMb ?? null;
    const pid = entry?.pid ?? qemuPid;
    if ((launcher !== null && launcher !== 'devslim') || (gpuEffective !== null && isSoftwareGpu(gpuEffective))) {
      rt.stderr(offProfileWarning(avd.name, { pid, launcher, gpuEffective, ramEffectiveMb }));
    }
    // Ja rodando: so registra o que ha no running dir, sem esperar nem avisar.
    const ad = await findAdvertisement(rt, avd.name, portForSerial(existing), false);
    return Object.freeze({
      avd: avd.name,
      serial: existing,
      pid,
      port: portForSerial(existing),
      fromSnapshot: null,
      alreadyRunning: true,
      emulatorArgs: Object.freeze([]),
      logFile: null,
      bootMs: null,
      ramEffectiveMb,
      launcher,
      gpuEffective,
      advertised: ad.advertised,
      grpcPort: ad.grpcPort,
    });
  }
  const locks = runningLocks(avd.dir);
  if (locks.length > 0 && !opts.force) {
    throw new DevslimError(`AVD ${avd.name} tem locks (${locks.join(', ')}) mas nao aparece no adb; confira se ha emulador preso (--force para ignorar)`);
  }

  const l = await launch(rt, adb, avd, profile, { useSnapshot: true, force: opts.force === true, action: 'up' });
  const hw = readEffectiveHardware(avd.dir);
  const logHit = ramIncreaseLineFromLog(l.logFile, l.logOffset);
  const ramEffectiveMb = hw?.ramMb ?? logHit?.mb ?? null;
  if (ramEffectiveMb !== null && ramEffectiveMb > profile.ramMb) {
    rt.stderr(ramFloorWarning(avd.name, profile.ramMb, ramEffectiveMb, logHit?.line ?? null, profile.lowRam));
  }
  const grpc = profile.grpc !== false;
  const ad = await findAdvertisement(rt, avd.name, l.port, grpc);
  if (grpc && !ad.advertised) rt.stderr(notAdvertisedWarning(rt.runningDir));
  return Object.freeze({
    avd: l.avd,
    serial: l.serial,
    pid: l.pid,
    port: l.port,
    fromSnapshot: l.fromSnapshot,
    alreadyRunning: false,
    emulatorArgs: l.emulatorArgs,
    logFile: l.logFile,
    bootMs: l.bootMs,
    ramEffectiveMb,
    launcher: 'devslim',
    gpuEffective: hw?.gpu ?? null,
    advertised: ad.advertised,
    grpcPort: ad.grpcPort,
    ...(l.fromSnapshot ? {} : { hint: bakeHint(avd.name) }),
  });
}

// ---------------------------------------------------------------------------
// bake

export type BakeOptions = RuntimeContext & { force?: boolean; level?: BloatLevel };

export type BakeResult = Readonly<{
  avd: string;
  serial: string;
  pid: number;
  port: number;
  level: BloatLevel;
  emulatorArgs: readonly string[];
  logFile: string;
  snapshot: string;
  slim: SlimReport;
  statePath: string;
  lingeringLocks: readonly string[];
  timings: Readonly<{ bootMs: number; slimMs: number; snapshotMs: number; shutdownMs: number; totalMs: number }>;
}>;

export async function bakeAvd(avdName: string, profile: AndroidProfile, opts: BakeOptions = {}): Promise<BakeResult> {
  const rt = resolveRuntime(opts);
  const avd = findAvd(avdName, { env: rt.env });
  const state = loadState<AndroidState>('android', avd.name, { env: rt.env });
  if (state === null || typeof state.originalConfigIni !== 'string') {
    throw new DevslimError(`AVD ${avd.name} ainda nao foi tunado; rode antes: devslim android tune ${avd.name}`);
  }
  const adb = rt.adb();
  const running = await findAvdSerial(adb, avd.name);
  if (running !== null) {
    throw new DevslimError(`AVD ${avd.name} esta rodando (${running}); desligue antes do bake: devslim android down ${avd.name}`);
  }
  const locks = runningLocks(avd.dir);
  if (locks.length > 0) {
    throw new DevslimError(`AVD ${avd.name} parece estar rodando (${locks.join(', ')}); desligue antes do bake`);
  }
  const level = opts.level ?? 'standard';

  const tStart = rt.now();
  const l = await launch(rt, adb, avd, profile, { useSnapshot: false, force: opts.force === true, action: 'bake' });

  let slim: SlimReport;
  let statePath: string;
  let tSlim: number;
  let tSnap: number;
  try {
    const t1 = rt.now();
    slim = await slimRunningDevice(l.serial, {
      adb,
      level,
      capabilities: profile.capabilities,
      prior: { disabledPackages: state.disabledPackages ?? [], settings: state.settings ?? [] },
    });
    tSlim = rt.now() - t1;
    // State antes do snapshot: o que mudou no guest ja fica registrado.
    statePath = recordAndroidGuest(
      avd.name,
      { disabledPackages: slim.disabledPackages, settings: slim.savedSettings, bakedAt: rt.date(), now: rt.date() },
      { env: rt.env },
    ).path;
    const t2 = rt.now();
    await adb.snapshotSave(l.serial, SLIM_SNAPSHOT);
    tSnap = rt.now() - t2;
  } catch (err) {
    // Nao deixa o emulador do bake vivo comendo RAM.
    try {
      await adb.emuKill(l.serial);
      removeSession((e) => e.serial === l.serial, rt.env);
    } catch { /* sessao continua registrada para o down */ }
    throw err;
  }

  const t3 = rt.now();
  await adb.emuKill(l.serial);
  const exit = await waitForExit({
    adb,
    serial: l.serial,
    avdDir: avd.dir,
    sleep: rt.sleep,
    now: rt.now,
    timeoutMs: rt.exitTimeoutMs,
    pollMs: rt.pollMs,
  });
  removeSession((e) => e.serial === l.serial, rt.env);
  const tShutdown = rt.now() - t3;

  return Object.freeze({
    avd: avd.name,
    serial: l.serial,
    pid: l.pid,
    port: l.port,
    level,
    emulatorArgs: l.emulatorArgs,
    logFile: l.logFile,
    snapshot: SLIM_SNAPSHOT,
    slim,
    statePath,
    lingeringLocks: Object.freeze(exit.lingeringLocks),
    timings: Object.freeze({ bootMs: l.bootMs, slimMs: tSlim, snapshotMs: tSnap, shutdownMs: tShutdown, totalMs: rt.now() - tStart }),
  });
}

// ---------------------------------------------------------------------------
// down

export type DownOutcome = Readonly<{
  avd: string;
  serial: string;
  registered: boolean;
  result: 'killed' | 'stale' | 'skipped' | 'failed';
  detail?: string;
}>;

export async function downAvd(avdName: string | undefined, opts: RuntimeContext & { force?: boolean } = {}): Promise<DownOutcome[]> {
  const rt = resolveRuntime(opts);
  const force = opts.force === true;
  const adb = rt.adb();
  const session = loadSession(rt.env).filter((e) => e.platform === 'android');

  type Target = { avd: string; serial: string; registered: boolean; entry?: SessionEntry };
  const targets: Target[] = [];
  if (avdName !== undefined) {
    if (!NAME_RE.test(avdName)) throw new DevslimError(`nome de AVD invalido: ${avdName}`);
    const entry = session.find((e) => e.avd === avdName);
    if (entry !== undefined) targets.push({ avd: entry.avd, serial: entry.serial, registered: true, entry });
    else if (!force) {
      throw new DevslimError(`AVD ${avdName} nao foi subido pelo devslim (nada na sessao); --force para desligar mesmo assim`);
    } else {
      const serial = await findAvdSerial(adb, avdName);
      if (serial === null) throw new DevslimError(`AVD ${avdName} nao esta rodando`);
      targets.push({ avd: avdName, serial, registered: false });
    }
  } else {
    for (const e of session) targets.push({ avd: e.avd, serial: e.serial, registered: true, entry: e });
    if (force) {
      for (const dev of await runningEmulators(adb)) {
        if (targets.some((t) => t.serial === dev.serial)) continue;
        targets.push({ avd: (await adb.avdName(dev.serial)) ?? '?', serial: dev.serial, registered: false });
      }
    }
  }

  const out: DownOutcome[] = [];
  for (const { entry, ...t } of targets) {
    const drop = () => removeSession((e: SessionEntry) => e.platform === 'android' && e.serial === t.serial, rt.env);
    // Auto-desligar: o watcher sai antes do device (e o campo da sessao junto).
    if (entry !== undefined) await stopIdleWatcher(entry, rt);
    const present = (await adb.listDevices()).some((d) => d.serial === t.serial);
    if (!present) {
      drop();
      out.push(Object.freeze({ ...t, result: 'stale', detail: 'ja nao estava no adb devices' }));
      continue;
    }
    if (!force) {
      const name = await adb.avdName(t.serial);
      if (name !== t.avd) {
        drop(); // o serial agora e de outro emulador: nao e nosso
        out.push(Object.freeze({ ...t, result: 'skipped', detail: `${t.serial} agora roda ${name ?? '(desconhecido)'}; nao mexido` }));
        continue;
      }
    }
    try {
      await adb.emuKill(t.serial);
      await adb.waitForGone(t.serial, { timeoutMs: rt.exitTimeoutMs, pollMs: rt.pollMs });
      drop();
      out.push(Object.freeze({ ...t, result: 'killed' }));
    } catch (err) {
      out.push(Object.freeze({ ...t, result: 'failed', detail: (err as Error).message }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// create

// Id do atalho padrao (google_apis) num host arm64; fora dele a ABI e x86_64.
export const DEFAULT_IMAGE = 'system-images;android-35;google_apis;arm64-v8a';
export const DEFAULT_DEVICE = 'pixel_7';
export const CREATE_SCREEN = '720x1600@320';

export type CreateResult = Readonly<{ avd: string; image: string; device: string; tune: TuneResult }>;

// Cria o AVD (sem bootar) e aplica o tune padrao com tela 720x1600@320.
// `image`: id completo ou atalho (google_apis, google_atd, aosp_atd, default)
// expandido com `api` (padrao 35) e a ABI do host. A imagem tem que estar no
// SDK; ausente = erro com o comando sdkmanager, nunca baixa sozinho.
export async function createAvd(
  name: string,
  o: RuntimeContext & { image?: string; api?: number; device?: string } = {},
): Promise<CreateResult> {
  const rt = resolveRuntime(o);
  if (!NAME_RE.test(name)) throw new DevslimError(`nome de AVD invalido: ${name}`);
  const home = avdHome(rt.env);
  if (listAvds(rt.env).includes(name) || existsSync(join(home, `${name}.avd`))) {
    throw new DevslimError(`AVD ${name} ja existe em ${home}`);
  }
  const image = resolveImage(o.image, { api: o.api, arch: rt.arch });
  const device = o.device ?? DEFAULT_DEVICE;
  const avdmanager = rt.tool('avdmanager');
  const dir = imageDir(sdkRootOfTool(avdmanager, 'avdmanager'), image);
  if (!rt.dirExists(dir)) {
    throw new DevslimError(`imagem ${image} nao instalada (falta ${dir}); instale com: sdkmanager "${image}" e rode o create de novo`);
  }
  // Responde "no" ao "Do you wish to create a custom hardware profile?".
  const res = await rt.exec(avdmanager, ['create', 'avd', '-n', name, '-k', image, '-d', device], {
    input: 'no\n',
    env: rt.env,
    timeoutMs: 180_000,
  });
  if (res.code !== 0) {
    const why = (res.stderr + '\n' + res.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new DevslimError(`avdmanager create avd ${name} falhou (exit ${res.code}): ${why || '(sem saida)'}`);
  }
  const tune = tuneAvd(name, buildAndroidProfile({ screen: CREATE_SCREEN }), { env: rt.env, now: rt.date() });
  return Object.freeze({ avd: name, image, device, tune });
}
