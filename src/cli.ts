import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { resolveCapabilities } from './capabilities.ts';
import { bytesToMb, sizeText } from './dirSize.ts';
import { DevslimError, UsageError } from './errors.ts';
import type { RuntimeContext } from './android/deps.ts';
import { findAvd, type AvdInfo } from './android/avd.ts';
import { getValue, parseIni } from './android/configIni.ts';
import { lastBootRaise, parseRamMb, ramFloorNote } from './android/hardwareQemu.ts';
import { IMAGE_SHORTCUTS } from './android/images.ts';
import { buildAndroidProfile, formatScreen, type AndroidProfile, type AndroidProfileOptions } from './android/profile.ts';
import { grpcPortFor, GRPC_REFERENCE_PORT } from './android/launchArgs.ts';
import { bakeAvd, createAvd, downAvd, upAvd, type BakeResult } from './android/runtime.ts';
import { planTune, restoreAvd, tuneAvd, type TunePlan } from './android/tune.ts';
import { measureAvd, measureSim, type AndroidMeasurement, type IosMeasurement } from './measure.ts';
import { loadState, type AndroidState } from './state.ts';
import { ALWAYS_ENABLED, CAPABILITY_KEEPS, CATEGORIES, CATEGORY_BREAKS, CATEGORY_IDS, managedSet } from './ios/labels.ts';
import { downSim, offSim, planSim, upSim, type IosContext, type IosSlimOptions, type SimPlan, type UpSimResult } from './ios/slim.ts';
import { doctorExitCode, doctorText, runDoctor } from './doctor.ts';
import { collectStatus, statusText } from './status.ts';
import { downAll, measureAll } from './topLevel.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Env;
  cwd: string;
  // Injecao para testes (exec, spawnDetached, sleep, relogio, base do store iOS). Ausente = real.
  runtime?: Omit<IosContext, 'env' | 'stderr'>;
};

export const HELP = `devslim ${pkg.version}: emulador Android e simulador iOS economicos

uso:
  devslim status [--json]                o que esta bootado, perfil aplicado, drift, sessao e swap (so leitura, sem adb)
  devslim doctor [--json]                checagens de ambiente (Xcode, SDK, emulator, AVDs, argent, swap); exit 1 se houver fail
  devslim down [--force] [--json]        desliga tudo que a sessao subiu (Android e iOS); remove entradas mortas sem matar
  devslim measure [--json]               mede todo emulador e simulador rodando (array; vazio se nada roda)

  devslim android plan <avd> [flags]     mostra mudancas do config.ini e a linha do emulator (nao escreve)
  devslim android tune <avd> [flags]     salva state, reescreve config.ini, apaga hardware-qemu.ini e snapshots/
  devslim android create <nome> [--image I] [--api N] [--device D]
                                         cria AVD (avdmanager) e aplica tune com tela 720x1600@320; nao boota;
                                         a system image tem que estar instalada (senao mostra o sdkmanager)
  devslim android up <avd> [flags] [--force]
                                         boota do snapshot slim_base (se houver) com flags economicas; avisa se o
                                         emulador elevou a RAM pedida, se o AVD ja roda fora do perfil (argent,
                                         GPU por software) e sugere bake quando nao ha slim_base
  devslim android bake <avd> [--aggressive] [--need a,b] [--for <dir>] [--no-grpc|--grpc]
                         [--lowram|--no-lowram] [--force]
                                         boota sem snapshot, enxuga via adb, grava snapshot slim_base e desliga
  devslim android down [<avd>] [--force] desliga o que o devslim subiu (--force: qualquer emulador)
  devslim android restore <avd> [--config-only]
                                         desfaz pacotes/settings no guest (AVD rodando) e devolve config.ini
  devslim android measure <avd> [--json] phys_footprint, cabecalho do footprint e RSS do qemu no host; memoria e processos no guest

  devslim ios plan <udid|nome> [flags ios]
                                         labels que o up desligaria e quantos ja estao no store (nao escreve)
  devslim ios up <udid|nome> [flags ios] [--force]
                                         desliga labels launchd no disabled.plist do device e boota; exit 3 se algum nao pegou
  devslim ios off <udid|nome> [--json]   devolve cada label ao valor salvo e limpa o state (reboota se estava bootado)
  devslim ios down [<udid|nome>] [--force] [--json]
                                         shutdown do que o devslim subiu (--force: qualquer simulador bootado)
  devslim ios measure <udid|nome> [--json]
                                         processos, phys_footprint e %cpu da arvore do launchd_sim
  devslim ios categories [--json]        categorias de labels, quantos labels e o que quebra
  devslim --help | --version

flags de plan/tune/up (herdam o perfil do tune; flags sobrepoem):
  --ram N          RAM em MB (1536..8192, padrao 2048); abaixo do piso do emulador (visto: 2560 MB
                   em phone, 4096 MB em tablet) ele eleva o pedido sem erro, salvo com --lowram
  --aggressive     RAM 1536 + -lowram
  --lowram         passa -lowram sem mudar a RAM: o -memory pedido passa a valer, mas o guest se
                   declara aparelho de pouca RAM (muda o comportamento dos apps); tambem vale no bake
  --no-lowram      tira o lowram salvo pelo tune ou o do --aggressive; nao combina com --lowram
  --gpu M          modo de GPU (padrao host)
  --vulkan         religa Vulkan no guest (sem -feature -Vulkan)
  --screen S       keep (padrao) ou LxA@dpi, ex. 720x1600@320
  --port N         porta par entre 5554 e 5682 (serial emulator-N); gRPC em 8554 + (N - 5554)
  --no-grpc        lanca sem -grpc <porta> -grpc-use-token (o emulador nao grava o running ini
                   que o argent usa para screenshot/tap); tambem vale no bake
  --grpc           religa o gRPC quando o tune salvou --no-grpc (sobrepoe o perfil salvo);
                   tambem vale no bake; nao combina com --no-grpc
  --need a,b       capacidades: audio, camera, keyboard, location, push, store, weblogin, window;
                   substitui as do tune; --need none limpa; keyboard mantem o Gboard no bake --aggressive
                   (sem ele o texto chega por adb/argent input, mas nao da para testar layout que desvia
                   do teclado); keyboard, store e window nunca saem do --for
  --for <dir>      deriva capacidades do package.json do app (tambem substitui as do tune)
  --reset          plan/tune: ignora o perfil salvo e parte do padrao
  --json           saida em JSON

outras flags:
  --force          up/bake/ios up: ignora a guarda de um device por vez e a recusa por swap acima de 95%;
                   down: mata o que nao foi subido pelo devslim
  --aggressive     bake: desliga tambem a lista aggressive (Play Store, assistentes de setup, Gboard)
  --config-only    restore: so o config.ini; pacotes/settings do guest ficam pendentes no state
  --image I        create: atalho google_apis, google_atd, aosp_atd, default (vira
                   system-images;android-<api>;<tag>;<abi>, ABI do host) ou o id completo; padrao google_apis
                   ATD = sem servicos Google (aosp_atd) ou com servicos reduzidos (google_atd): mais leve;
                   aosp_atd: sem login Google, push FCM nem compra Play Billing. ATD para teste de UI e
                   logica; google_apis quando o teste precisa de login, push ou compra
  --api N          create: API do atalho de imagem (padrao 35); nao combina com id completo
  --device D       create: padrao pixel_7

flags ios (plan/up):
  --need a,b       capacidades (push, store, weblogin, camera, location religam labels; window abre o Simulator.app;
                   audio e keyboard nao mudam nada no iOS)
  --for <dir>      deriva capacidades do package.json do app
  --except c,c     mantem categorias inteiras ligadas (ver ios categories)
  --keep l,l       mantem labels avulsos ligados
  --json           saida em JSON
  perfil padrao quebra push, StoreKit, universal links e login Apple ID; so iOS 18.5+

ambiente: ANDROID_HOME/ANDROID_SDK_ROOT (SDK, padrao ~/Library/Android/sdk),
          ANDROID_AVD_HOME (AVDs), DEVSLIM_HOME (state e logs, padrao ~/.devslim)
`;

type FlagSpec = Readonly<Record<string, 'value' | 'multi' | 'bool'>>;
type Parsed = { positionals: string[]; values: Record<string, string>; multi: Record<string, string[]>; bools: Set<string> };

const PROFILE_FLAGS: FlagSpec = Object.freeze({
  ram: 'value',
  aggressive: 'bool',
  gpu: 'value',
  vulkan: 'bool',
  screen: 'value',
  port: 'value',
  need: 'multi',
  for: 'value',
  'no-grpc': 'bool',
  grpc: 'bool',
  lowram: 'bool',
  'no-lowram': 'bool',
  json: 'bool',
});
const TUNE_FLAGS: FlagSpec = Object.freeze({ ...PROFILE_FLAGS, reset: 'bool' });
const RESTORE_FLAGS: FlagSpec = Object.freeze({ json: 'bool', 'config-only': 'bool' });
const UP_FLAGS: FlagSpec = Object.freeze({ ...PROFILE_FLAGS, force: 'bool' });
const BAKE_FLAGS: FlagSpec = Object.freeze({
  aggressive: 'bool',
  need: 'multi',
  for: 'value',
  'no-grpc': 'bool',
  grpc: 'bool',
  lowram: 'bool',
  'no-lowram': 'bool',
  force: 'bool',
  json: 'bool',
});
const DOWN_FLAGS: FlagSpec = Object.freeze({ force: 'bool', json: 'bool' });
const MEASURE_FLAGS: FlagSpec = Object.freeze({ json: 'bool' });
const CREATE_FLAGS: FlagSpec = Object.freeze({ image: 'value', api: 'value', device: 'value', json: 'bool' });

function parseFlags(args: readonly string[], spec: FlagSpec): Parsed {
  const out: Parsed = { positionals: [], values: {}, multi: {}, bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      out.positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`flag desconhecida: --${name}`);
    if (kind === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} nao recebe valor`);
      out.bools.add(name);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else value = args[++i];
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      throw new UsageError(`--${name} exige um valor`);
    }
    if (kind === 'multi') (out.multi[name] ??= []).push(value);
    else if (name in out.values) throw new UsageError(`--${name} repetida`);
    else out.values[name] = value;
  }
  return out;
}

function intFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} exige inteiro, recebeu: ${value}`);
  return Number(value);
}

function oneAvd(p: Parsed, sub: string): string {
  if (p.positionals.length === 0) throw new UsageError(`android ${sub}: falta o nome do AVD`);
  if (p.positionals.length > 1) throw new UsageError(`android ${sub}: argumento extra: ${p.positionals[1]}`);
  return p.positionals[0];
}

// `--need none` = lista vazia (limpa o que o tune salvou); nao combina com outras.
function needFlag(p: Parsed): string[] | undefined {
  const need = p.multi.need;
  if (need === undefined) return undefined;
  const list = need.flatMap((v) => v.split(',')).map((s) => s.trim()).filter((s) => s !== '');
  if (!list.includes('none')) return need;
  if (list.length > 1) throw new UsageError('--need none nao combina com outras capacidades');
  return [];
}

type ResolvedProfile = { profile: AndroidProfile; inherited: boolean };

// Caminho unico do perfil de plan/tune/up/bake: o do tune (state) como base e
// as flags dadas sobrepoem; sem state (ou com --reset), parte do padrao.
// --need e --for SUBSTITUEM as capacidades salvas (nao unem). --grpc e
// --no-grpc sobrepoem o grpc salvo (o tune --no-grpc grava false). --lowram e
// --no-lowram sobrepoem o lowram salvo e vencem o lowram do --aggressive.
function resolveProfile(p: Parsed, io: CliIo, avd: string): ResolvedProfile {
  if (p.bools.has('grpc') && p.bools.has('no-grpc')) throw new UsageError('--grpc e --no-grpc nao combinam; use so um');
  if (p.bools.has('lowram') && p.bools.has('no-lowram')) throw new UsageError('--lowram e --no-lowram nao combinam; use so um');
  const state = p.bools.has('reset') ? null : loadState<AndroidState>('android', avd, { env: io.env });
  const base = state?.profile;
  const opts: AndroidProfileOptions =
    base === undefined
      ? {}
      : {
          ramMb: base.ramMb,
          lowRam: base.lowRam,
          gpu: base.gpu,
          vulkan: base.vulkan,
          screen: formatScreen(base.screen),
          port: base.port ?? undefined,
          capabilities: base.capabilities ?? [],
          grpc: base.grpc, // state antigo sem o campo = undefined = ligado
        };
  if (p.bools.has('aggressive')) {
    opts.aggressive = true;
    opts.ramMb = undefined; // --aggressive sem --ram = 1536
    opts.lowRam = undefined; // e lowram, salvo --no-lowram
  }
  if (p.bools.has('lowram')) opts.lowRam = true;
  if (p.bools.has('no-lowram')) opts.lowRam = false;
  if (p.values.ram !== undefined) opts.ramMb = intFlag('ram', p.values.ram);
  if (p.values.gpu !== undefined) opts.gpu = p.values.gpu;
  if (p.bools.has('vulkan')) opts.vulkan = true;
  if (p.values.screen !== undefined) opts.screen = p.values.screen;
  if (p.values.port !== undefined) opts.port = intFlag('port', p.values.port);
  if (p.bools.has('no-grpc')) opts.grpc = false;
  if (p.bools.has('grpc')) opts.grpc = true;
  const need = needFlag(p);
  if (need !== undefined || p.values.for !== undefined) {
    opts.capabilities = resolveCapabilities({
      need,
      forDir: p.values.for === undefined ? undefined : resolve(io.cwd, p.values.for),
    });
  }
  return { profile: buildAndroidProfile(opts), inherited: base !== undefined };
}

function describeProfile(pr: AndroidProfile): string {
  const caps = pr.capabilities.length > 0 ? pr.capabilities.join(',') : '(nenhuma)';
  const parts = [
    `ram ${pr.ramMb} MB${pr.lowRam ? ' (lowram)' : ''}`,
    `heap ${pr.heapMb} MB`,
    `cores ${pr.cores}`,
    `gpu ${pr.gpu}`,
    `vulkan ${pr.vulkan ? 'on' : 'off'}`,
    `grpc ${pr.grpc ? 'on' : 'off'}`,
    `screen ${formatScreen(pr.screen)}`,
  ];
  if (pr.port !== null) parts.push(`port ${pr.port}`);
  parts.push(`capacidades ${caps}`);
  return parts.join(', ');
}

function planText(plan: TunePlan, inherited = false): string[] {
  const lines = [`AVD ${plan.avd.name} (${plan.avd.dir})`, `perfil: ${describeProfile(plan.profile)}`];
  if (inherited) lines.push('perfil herdado do tune anterior');
  lines.push(`config.ini: ${plan.changes.length} mudanca(s)`);
  for (const c of plan.changes) lines.push(`  ${c.key}: ${c.from ?? '(ausente)'} -> ${c.to}`);
  // Sem porta no perfil o up escolhe a porta livre na hora; a do gRPC sai dela.
  const ref = plan.profile.grpc && plan.profile.port === null ? ` (gRPC ${grpcPortFor(GRPC_REFERENCE_PORT)} de referencia; porta definida no up)` : '';
  lines.push('comando:', `  emulator ${plan.emulatorArgs.join(' ')}${ref}`);
  return lines;
}

// Nota de piso de RAM do plan/tune. Pedido do ultimo boot como no status: o
// -memory do perfil salvo; sem state, o hw.ramSize do config.ini.
function ramNoteFor(avd: AvdInfo, profile: AndroidProfile, io: CliIo): string | null {
  let requested: number | null = null;
  try {
    requested = loadState<AndroidState>('android', avd.name, { env: io.env })?.profile?.ramMb ?? null;
  } catch {
    requested = null; // state ilegivel: resolveProfile ja teria reclamado se precisasse dele
  }
  if (requested === null) {
    try {
      requested = parseRamMb(getValue(parseIni(readFileSync(avd.configPath, 'utf8')), 'hw.ramSize'));
    } catch {
      requested = null;
    }
  }
  return ramFloorNote(profile, lastBootRaise(avd.dir, requested));
}

// "hardware-qemu.ini, snapshots (812.3 MB)": tamanho so de snapshots/.
function removeList(names: readonly string[], plan: TunePlan): string {
  return names.map((n) => (n === 'snapshots' && plan.snapshotsSize !== null ? `${n} (${sizeText(plan.snapshotsSize)})` : n)).join(', ');
}

function planJson(plan: TunePlan): Record<string, unknown> {
  return {
    avd: plan.avd.name,
    avdDir: plan.avd.dir,
    profile: plan.profile,
    changes: plan.changes,
    emulatorArgs: plan.emulatorArgs,
    wouldRemove: plan.wouldRemove,
    snapshotsMb: plan.snapshotsSize === null ? null : bytesToMb(plan.snapshotsSize.bytes),
    runningLocks: plan.runningLocks,
  };
}

async function runAndroid(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  const out = (lines: string[]) => io.stdout(lines.join('\n') + '\n');
  const json = (obj: unknown) => io.stdout(JSON.stringify(obj, null, 2) + '\n');

  if (sub === 'plan') {
    const p = parseFlags(rest, TUNE_FLAGS);
    const avd = oneAvd(p, sub);
    const { profile, inherited } = resolveProfile(p, io, avd);
    const plan = planTune(avd, profile, { env: io.env });
    const ramNote = ramNoteFor(plan.avd, profile, io);
    if (p.bools.has('json')) {
      json({ ...planJson(plan), inheritedProfile: inherited, ramNote });
      return 0;
    }
    const lines = planText(plan, inherited);
    if (ramNote !== null) lines.push(ramNote);
    if (plan.wouldRemove.length > 0) lines.push(`tune apagaria: ${removeList(plan.wouldRemove, plan)}`);
    if (plan.runningLocks.length > 0) lines.push(`aviso: AVD parece estar rodando (${plan.runningLocks.join(', ')}); tune recusaria`);
    out(lines);
    return 0;
  }

  if (sub === 'tune') {
    const p = parseFlags(rest, TUNE_FLAGS);
    const avd = oneAvd(p, sub);
    const { profile, inherited } = resolveProfile(p, io, avd);
    // Antes do tune: ele apaga o hardware-qemu.ini do ultimo boot.
    const ramNote = ramNoteFor(findAvd(avd, { env: io.env }), profile, io);
    const res = tuneAvd(avd, profile, { env: io.env });
    if (p.bools.has('json')) {
      json({
        ...planJson(res),
        inheritedProfile: inherited,
        ramNote,
        wroteConfig: res.wroteConfig,
        removed: res.removed,
        preservedOriginal: res.preservedOriginal,
        statePath: res.statePath,
      });
      return 0;
    }
    const lines = planText(res, inherited);
    if (ramNote !== null) lines.push(ramNote);
    lines.push(
      res.preservedOriginal
        ? `state: ${res.statePath} (backup do primeiro tune mantido)`
        : `state: ${res.statePath} (backup do config.ini original salvo)`,
    );
    lines.push(res.wroteConfig ? 'config.ini reescrito' : 'config.ini ja estava no perfil; nada escrito');
    lines.push(res.removed.length > 0 ? `removido: ${removeList(res.removed, res)}` : 'removido: nada');
    out(lines);
    return 0;
  }

  if (sub === 'restore') {
    const p = parseFlags(rest, RESTORE_FLAGS);
    const avd = oneAvd(p, sub);
    const res = await restoreAvd(avd, { ...rtx(io), configOnly: p.bools.has('config-only') });
    for (const w of res.warnings) io.stderr(`devslim: aviso: ${w}\n`);
    if (p.bools.has('json')) {
      json({
        avd: res.avd.name,
        configPath: res.avd.configPath,
        bytes: res.bytes,
        sha256: res.sha256,
        clearedState: res.clearedState ? res.statePath : null,
        removedSnapshot: res.removedSnapshot,
        enabledPackages: res.unslim?.enabled ?? [],
        restoredSettings: res.unslim?.restoredSettings ?? [],
        warnings: res.warnings,
      });
      return 0;
    }
    const lines: string[] = [];
    if (res.unslim !== null) {
      lines.push(`guest: ${res.unslim.enabled.length} pacote(s) reabilitado(s), ${res.unslim.restoredSettings.length} setting(s) devolvido(s); emulador desligado`);
    }
    lines.push(`config.ini de ${res.avd.name} restaurado (${res.bytes} bytes, sha256 ${res.sha256})`);
    if (res.removedSnapshot) lines.push('snapshot slim_base removido');
    lines.push(res.clearedState ? `state removido: ${res.statePath}` : `state mantido (pendencia no guest): ${res.statePath}`);
    out(lines);
    return 0;
  }

  if (sub === 'create') {
    const p = parseFlags(rest, CREATE_FLAGS);
    const name = oneAvd(p, sub);
    const api = intFlag('api', p.values.api);
    if (api !== undefined && p.values.image?.startsWith('system-images;')) {
      throw new UsageError(`--api so vale com atalho de imagem (${IMAGE_SHORTCUTS.join(', ')}); o id completo ja traz a API`);
    }
    const res = await createAvd(name, { ...rtx(io), image: p.values.image, api, device: p.values.device });
    if (p.bools.has('json')) {
      json({ avd: res.avd, image: res.image, device: res.device, ...planJson(res.tune), statePath: res.tune.statePath });
      return 0;
    }
    out([`AVD ${res.avd} criado (${res.image}, ${res.device}); nao bootado`, ...planText(res.tune), `state: ${res.tune.statePath}`]);
    return 0;
  }

  if (sub === 'up') {
    const p = parseFlags(rest, UP_FLAGS);
    const avd = oneAvd(p, sub);
    const res = await upAvd(avd, resolveProfile(p, io, avd).profile, { ...rtx(io), force: p.bools.has('force') });
    if (p.bools.has('json')) {
      json(res);
      return 0;
    }
    if (res.alreadyRunning) {
      out([`AVD ${res.avd} ja estava rodando em ${res.serial} (pid ${res.pid ?? '?'}); nada subido`]);
      return 0;
    }
    const lines = [
      `AVD ${res.avd} pronto em ${res.serial} (pid ${res.pid}, ${res.fromSnapshot ? 'snapshot slim_base' : 'cold boot sem snapshot'}, boot ${secs(res.bootMs ?? 0)})`,
      `comando: emulator ${res.emulatorArgs.join(' ')}`,
      `log: ${res.logFile}`,
    ];
    if (res.hint !== undefined) lines.push(res.hint);
    out(lines);
    return 0;
  }

  if (sub === 'bake') {
    const p = parseFlags(rest, BAKE_FLAGS);
    const avd = oneAvd(p, sub);
    // --aggressive no bake e o nivel da lista de bloat; RAM continua a do tune.
    const forProfile: Parsed = { ...p, bools: new Set([...p.bools].filter((b) => b !== 'aggressive')) };
    const res = await bakeAvd(avd, resolveProfile(forProfile, io, avd).profile, {
      ...rtx(io),
      force: p.bools.has('force'),
      level: p.bools.has('aggressive') ? 'aggressive' : 'standard',
    });
    if (p.bools.has('json')) {
      json(res);
      return 0;
    }
    out(bakeText(res));
    return 0;
  }

  if (sub === 'down') {
    const p = parseFlags(rest, DOWN_FLAGS);
    if (p.positionals.length > 1) throw new UsageError(`android down: argumento extra: ${p.positionals[1]}`);
    const res = await downAvd(p.positionals[0], { ...rtx(io), force: p.bools.has('force') });
    if (p.bools.has('json')) {
      json(res);
      return res.some((r) => r.result === 'failed') ? 1 : 0;
    }
    if (res.length === 0) out(['nada a desligar (sessao vazia)']);
    else out(res.map((r) => `${r.avd} ${r.serial}: ${r.result}${r.detail ? ` (${r.detail})` : ''}`));
    return res.some((r) => r.result === 'failed') ? 1 : 0;
  }

  if (sub === 'measure') {
    const p = parseFlags(rest, MEASURE_FLAGS);
    const avd = oneAvd(p, sub);
    const m = await measureAvd(avd, rtx(io));
    if (p.bools.has('json')) {
      json(m);
      return 0;
    }
    out(measureText(m));
    return 0;
  }

  throw new UsageError(sub === undefined ? 'android: falta o subcomando' : `android: subcomando desconhecido: ${sub}`);
}

// ---------------------------------------------------------------------------
// ios

const IOS_PROFILE_FLAGS: FlagSpec = Object.freeze({ need: 'multi', for: 'value', except: 'multi', keep: 'multi', json: 'bool' });
const IOS_UP_FLAGS: FlagSpec = Object.freeze({ ...IOS_PROFILE_FLAGS, force: 'bool' });
const JSON_ONLY: FlagSpec = Object.freeze({ json: 'bool' });

// Exit code do `ios up`/`ios off` quando algum label nao ficou no valor pedido.
export const EXIT_NOT_APPLIED = 3;

function oneSim(p: Parsed, sub: string): string {
  if (p.positionals.length === 0) throw new UsageError(`ios ${sub}: falta o UDID ou nome do simulador`);
  if (p.positionals.length > 1) throw new UsageError(`ios ${sub}: argumento extra: ${p.positionals[1]}`);
  return p.positionals[0];
}

const splitList = (values: readonly string[] | undefined) =>
  (values ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter((s) => s !== '');

function iosOptions(p: Parsed, io: CliIo): IosSlimOptions {
  return {
    capabilities: resolveCapabilities({
      need: p.multi.need,
      forDir: p.values.for === undefined ? undefined : resolve(io.cwd, p.values.for),
    }),
    except: splitList(p.multi.except),
    keep: splitList(p.multi.keep),
  };
}

function iosCtx(io: CliIo): IosContext {
  return { ...io.runtime, env: io.env, stderr: io.stderr };
}

const listOr = (list: readonly string[], none: string) => (list.length > 0 ? list.join(',') : none);

function simPlanText(plan: SimPlan): string[] {
  const pr = plan.profile;
  return [
    `simulador ${plan.name} (${plan.udid}), ${plan.runtime.platform} ${plan.runtime.version}, estado ${plan.state}`,
    `perfil: capacidades ${listOr(pr.capabilities, '(nenhuma)')}, except ${listOr(pr.except, '(nenhuma)')}, keep ${listOr(pr.keep, '(nenhum)')}`,
    `labels a desligar: ${plan.labels.length} de ${plan.managedTotal} geridos; ${plan.alreadyInStore} ja desligados no store`,
    `reparo (sempre ligados que o store traz desligados): ${listOr(plan.repair, '(nenhum)')}`,
    `store: ${plan.storePath} (${plan.storeExists ? 'existe' : 'ausente'})`,
    plan.hasState ? 'state: existe (backup do primeiro up sera mantido)' : 'state: nenhum',
  ];
}

function upSimText(r: UpSimResult): string[] {
  if (r.alreadySlim) {
    return [`${r.name} (${r.udid}) ja estava bootado e enxuto (${r.labels} labels); nada feito${r.windowOpened ? '; Simulator.app aberto' : ''}`];
  }
  const lines = [
    `${r.name} (${r.udid}) ${r.runtime.platform} ${r.runtime.version}: ${r.labels} labels no perfil, ${r.storeChanges} entrada(s) do store mudaram${r.shutdownFirst ? ' (desligado antes de escrever)' : ''}`,
    `boot ${secs(r.bootMs ?? 0)}`,
  ];
  if (r.restored.length > 0) lines.push(`religados ao valor salvo (${r.restored.length}): ${r.restored.join(', ')}`);
  if (r.repaired.length > 0) lines.push(`reparados (sempre ligados que estavam desligados no store): ${r.repaired.join(', ')}`);
  if (r.fallback.used) {
    lines.push(`store offline nao pegou tudo: launchctl em ${r.fallback.passes} passada(s) e reboot${r.fallback.failed.length > 0 ? `; launchctl falhou em: ${r.fallback.failed.join(', ')}` : ''}`);
  }
  if (r.notApplied.length > 0) lines.push(`NAO desligados (${r.notApplied.length}): ${r.notApplied.join(', ')}`);
  if (r.notRestored.length > 0) lines.push(`NAO religados (${r.notRestored.length}): ${r.notRestored.join(', ')}`);
  if (r.windowOpened) lines.push('Simulator.app aberto');
  lines.push(`state: ${r.statePath}`);
  return lines;
}

function measureSimText(m: IosMeasurement): string[] {
  return [`${m.name} (${m.udid}) em ${m.at}: ${m.processes} processos, footprint ${m.footprintMb} MB, cpu ${m.cpuPercent}%`];
}

function categoriesData() {
  return {
    managedTotal: managedSet().size,
    alwaysEnabled: [...ALWAYS_ENABLED],
    categories: CATEGORY_IDS.map((id) => ({ id, count: CATEGORIES[id].length, breaks: CATEGORY_BREAKS[id], labels: [...CATEGORIES[id]] })),
    capabilities: Object.fromEntries(Object.entries(CAPABILITY_KEEPS).map(([c, k]) => [c, { categories: [...k.categories], labels: [...k.labels] }])),
  };
}

async function runIos(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  const out = (lines: string[]) => io.stdout(lines.join('\n') + '\n');
  const json = (obj: unknown) => io.stdout(JSON.stringify(obj, null, 2) + '\n');

  if (sub === 'categories') {
    const p = parseFlags(rest, JSON_ONLY);
    if (p.positionals.length > 0) throw new UsageError(`ios categories: argumento extra: ${p.positionals[0]}`);
    const data = categoriesData();
    if (p.bools.has('json')) {
      json(data);
      return 0;
    }
    const w = Math.max(...CATEGORY_IDS.map((id) => id.length));
    const lines = data.categories.map((c) => `${c.id.padEnd(w)}  ${String(c.count).padStart(2)} labels  quebra: ${c.breaks}`);
    lines.push(`total gerido: ${data.managedTotal} labels unicos (categorias se sobrepoem); nunca desligados: ${data.alwaysEnabled.join(', ')}`);
    out(lines);
    return 0;
  }

  if (sub === 'plan') {
    const p = parseFlags(rest, IOS_PROFILE_FLAGS);
    const plan = await planSim(oneSim(p, sub), iosOptions(p, io), iosCtx(io));
    if (p.bools.has('json')) json(plan);
    else out(simPlanText(plan));
    return 0;
  }

  if (sub === 'up') {
    const p = parseFlags(rest, IOS_UP_FLAGS);
    const r = await upSim(oneSim(p, sub), iosOptions(p, io), { ...iosCtx(io), force: p.bools.has('force') });
    if (p.bools.has('json')) json(r);
    else out(upSimText(r));
    return r.notApplied.length > 0 || r.notRestored.length > 0 ? EXIT_NOT_APPLIED : 0;
  }

  if (sub === 'off') {
    const p = parseFlags(rest, JSON_ONLY);
    const r = await offSim(oneSim(p, sub), iosCtx(io));
    if (p.bools.has('json')) json(r);
    else {
      const lines = [`${r.name} (${r.udid}): ${r.restored} label(s) devolvido(s) ao valor salvo; state removido (${r.statePath})`];
      lines.push(r.rebooted ? 'simulador rebootado' : 'simulador estava desligado; nao bootado');
      if (r.ignored.length > 0) lines.push(`ignorados (fora da lista gerida): ${r.ignored.join(', ')}`);
      if (r.notRestored.length > 0) lines.push(`NAO voltaram ao valor salvo (${r.notRestored.length}): ${r.notRestored.join(', ')}`);
      out(lines);
    }
    return r.notRestored.length > 0 ? EXIT_NOT_APPLIED : 0;
  }

  if (sub === 'down') {
    const p = parseFlags(rest, Object.freeze({ force: 'bool', json: 'bool' }));
    if (p.positionals.length > 1) throw new UsageError(`ios down: argumento extra: ${p.positionals[1]}`);
    const res = await downSim(p.positionals[0], { ...iosCtx(io), force: p.bools.has('force') });
    if (p.bools.has('json')) json(res);
    else if (res.length === 0) out(['nada a desligar (sessao vazia)']);
    else out(res.map((r) => `${r.name} ${r.udid}: ${r.result}${r.detail ? ` (${r.detail})` : ''}`));
    return res.some((r) => r.result === 'failed') ? 1 : 0;
  }

  if (sub === 'measure') {
    const p = parseFlags(rest, JSON_ONLY);
    const m = await measureSim(oneSim(p, sub), iosCtx(io));
    if (p.bools.has('json')) json(m);
    else out(measureSimText(m));
    return 0;
  }

  throw new UsageError(sub === undefined ? 'ios: falta o subcomando' : `ios: subcomando desconhecido: ${sub}`);
}

// ---------------------------------------------------------------------------
// comandos de topo

const TOP_DOWN_FLAGS: FlagSpec = Object.freeze({ force: 'bool', json: 'bool' });

async function runTop(cmd: 'status' | 'doctor' | 'down' | 'measure', args: readonly string[], io: CliIo): Promise<number> {
  const out = (lines: string[]) => io.stdout(lines.join('\n') + '\n');
  const json = (obj: unknown) => io.stdout(JSON.stringify(obj, null, 2) + '\n');
  const p = parseFlags(args, cmd === 'down' ? TOP_DOWN_FLAGS : JSON_ONLY);
  if (p.positionals.length > 0) throw new UsageError(`${cmd}: argumento extra: ${p.positionals[0]}`);
  const asJson = p.bools.has('json');

  if (cmd === 'status') {
    const s = await collectStatus(iosCtx(io));
    if (asJson) json(s);
    else out(statusText(s));
    return 0;
  }
  if (cmd === 'doctor') {
    const checks = await runDoctor(iosCtx(io));
    if (asJson) json(checks);
    else out(doctorText(checks));
    return doctorExitCode(checks);
  }
  if (cmd === 'down') {
    const res = await downAll({ ...iosCtx(io), force: p.bools.has('force') });
    // Plataforma pulada ja saiu em stderr; no texto ficam so os devices.
    const done = res.filter((r) => r.result !== 'skipped');
    if (asJson) json(res);
    else if (res.length === 0) out(['nada a desligar (sessao vazia)']);
    else if (done.length === 0) out(['nada a desligar']);
    else out(done.map((r) => `${r.platform} ${r.name} ${r.id}: ${r.result}${r.detail ? ` (${r.detail})` : ''}`));
    return res.some((r) => r.result === 'failed') ? 1 : 0;
  }
  const res = await measureAll(iosCtx(io));
  if (asJson) json(res);
  else if (res.length === 0) out(['nada rodando']);
  else out(res.flatMap((m) => (m.platform === 'android' ? measureText(m) : measureSimText(m))));
  return 0;
}

function rtx(io: CliIo): RuntimeContext {
  return { ...io.runtime, env: io.env, stderr: io.stderr };
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function bakeText(r: BakeResult): string[] {
  const s = r.slim;
  const set = s.settings.filter((x) => x.status === 'set').length;
  const lines = [
    `bake de ${r.avd} em ${r.serial} (nivel ${r.level})`,
    `comando: emulator ${r.emulatorArgs.join(' ')}`,
    `settings: ${set} alterado(s)`,
  ];
  for (const x of s.settings.filter((y) => y.status !== 'set')) lines.push(`  ${x.ns}/${x.key}: ${x.status}${x.note ? ` (${x.note})` : ''}`);
  lines.push(`pacotes: ${s.newlyDisabled.length} desligado(s) agora, ${s.disabledPackages.length} nossos no state, ${s.alreadyDisabled.length} ja desligado(s) antes (fora do state)`);
  if (s.reenabled.length > 0) lines.push(`  religados (sairam do plano): ${s.reenabled.join(', ')}`);
  for (const f of s.failedPackages) lines.push(`  falhou: ${f.pkg} (${f.error})`);
  if (s.packagesError !== null) lines.push(`  pacotes nao processados: ${s.packagesError}`);
  lines.push(`dexopt: ${s.dexopt.ok ? 'ok' : `falhou (${s.dexopt.detail})`}`);
  lines.push(`am kill-all: ${s.killAll.ok ? 'ok' : `falhou (${s.killAll.detail})`}`);
  lines.push(`snapshot ${r.snapshot} gravado; emulador desligado`);
  if (r.lingeringLocks.length > 0) lines.push(`aviso: locks ainda presentes: ${r.lingeringLocks.join(', ')}`);
  const t = r.timings;
  lines.push(`tempos: boot ${secs(t.bootMs)}, slim ${secs(t.slimMs)}, snapshot ${secs(t.snapshotMs)}, desligar ${secs(t.shutdownMs)}, total ${secs(t.totalMs)}`);
  lines.push(`state: ${r.statePath}`, `log: ${r.logFile}`);
  return lines;
}

function measureText(m: AndroidMeasurement): string[] {
  const v = (n: number | null, unit = ' MB') => (n === null ? 'n/d' : `${n}${unit}`);
  return [
    `${m.avd} (${m.serial}, pid ${m.pid ?? 'n/d'}) em ${m.at}`,
    `host: phys_footprint ${v(m.host.footprintMb)}, footprint (cabecalho) ${v(m.host.footprintHeaderMb)}, rss ${v(m.host.rssMb)}`,
    `guest: MemTotal ${v(m.guest.memTotalMb)}, MemAvailable ${v(m.guest.memAvailableMb)}, processos ${v(m.guest.processes, '')}`,
    `guest dumpsys: Used RAM ${v(m.guest.usedRamMb)}, Free RAM ${v(m.guest.freeRamMb)}`,
  ];
}

function defaultIo(): CliIo {
  return {
    stdout: (t) => { process.stdout.write(t); },
    stderr: (t) => { process.stderr.write(t); },
    env: process.env,
    cwd: process.cwd(),
  };
}

// Retorna o exit code. Erro esperado = uma linha em stderr, sem stack.
export async function main(argv: readonly string[], io: CliIo = defaultIo()): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      io.stdout(HELP);
      return 0;
    }
    if (cmd === '--version' || cmd === '-v') {
      io.stdout(`${pkg.version}\n`);
      return 0;
    }
    if (cmd === 'status' || cmd === 'doctor' || cmd === 'down' || cmd === 'measure') return await runTop(cmd, rest, io);
    if (cmd === 'android') return await runAndroid(rest, io);
    if (cmd === 'ios') return await runIos(rest, io);
    throw new UsageError(cmd === undefined ? 'falta o comando' : `comando desconhecido: ${cmd}`);
  } catch (err) {
    if (err instanceof DevslimError) {
      io.stderr(`devslim: ${err.message}\n`);
      if (err instanceof UsageError) io.stderr('\n' + HELP);
      return err.exitCode;
    }
    const e = err as Error;
    io.stderr(`devslim: erro inesperado: ${e?.message ?? String(err)}\n`);
    if (io.env.DEVSLIM_DEBUG) io.stderr(`${e?.stack ?? ''}\n`);
    return 1;
  }
}
