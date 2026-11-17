import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { avdHome, findAvd, listAvds, type AvdInfo } from './android/avd.ts';
import { applyProfile, getValue, parseIni, type IniDoc } from './android/configIni.ts';
import { CAPABILITIES, sortCapabilities, type Capability } from './capabilities.ts';
import type { AndroidProfile } from './android/profile.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { loadSession } from './android/session.ts';
import { findSdkRoot, sdkCandidates, sdkToolPath, type SdkTool } from './android/sdk.ts';
import { readStore, storePath } from './ios/disabledStore.ts';
import { ALWAYS_ENABLED } from './ios/labels.ts';
import { parseRuntimesJson } from './ios/simctl.ts';
import { compareVersion, MIN_IOS_VERSION, type IosContext } from './ios/slim.ts';
import { listSimDevices, sessionStatus } from './status.ts';
import { assessSwap, readSwap } from './swap.ts';
import { dirSize, sizeText } from './dirSize.ts';
import { isSoftwareGpu, parseRamMb, readEffectiveHardware } from './android/hardwareQemu.ts';
import { classifyLauncher, launcherText, listQemuProcesses } from './android/launcher.ts';
import { findRunningEntry, isAdvertised, scanRunning } from './android/runningIni.ts';
import { launchedRamMb, listStates, loadState, type AndroidState } from './state.ts';
import { DEFAULT_API, imageTag, isAtdTag, isGoogleApisTag } from './android/images.ts';
import { formatDuration } from './idle.ts';
import { androidOrphans, iosOrphans } from './orphans.ts';

// `devslim doctor`: so leitura. Nunca chama adb, nunca executa o argent,
// nunca apaga nada. Checagens por AVD/device: avd-gpu e avd-ram dao uma linha
// por AVD (ultimo boot); profile-drift, avd-image, running-off-profile, emulator-advertised,
// default-boot-snapshot, orphan-images, ios-always-enabled e orphan-state dao
// uma linha por ocorrencia (ou um unico ok).

export type CheckLevel = 'ok' | 'warn' | 'fail';
export type Check = Readonly<{ id: string; level: CheckLevel; message: string; fix?: string }>;

export type DoctorContext = IosContext & { nodeVersion?: string };

export const MIN_NODE_MAJOR = 25;
export const MIN_EMULATOR_REVISION = Object.freeze([37, 2, 13] as const);
// Fonte unica em hardwareQemu.ts (tambem usada por status e up).
export { SOFTWARE_GPU_MODES, isSoftwareGpu } from './android/hardwareQemu.ts';
export const RAM_WARN_MB = 3072;
// Limites de swap: fonte unica em swap.ts (os mesmos do up/bake/ios up).
export { SWAP_WARN_PERCENT, SWAP_FAIL_PERCENT } from './swap.ts';

const check = (id: string, level: CheckLevel, message: string, fix?: string): Check =>
  Object.freeze(fix === undefined ? { id, level, message } : { id, level, message, fix });


// Tamanho de diretorio: movido para dirSize.ts (tambem usado pelo plan/tune).
export { dirSize, type DirSize } from './dirSize.ts';

// ---------------------------------------------------------------------------
// helpers

function readIni(path: string): ReturnType<typeof parseIni> | null {
  try {
    return parseIni(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export { parseRamMb } from './android/hardwareQemu.ts';

function avds(env: Runtime['env']): AvdInfo[] {
  const out: AvdInfo[] = [];
  for (const name of listAvds(env)) {
    try {
      out.push(findAvd(name, { env }));
    } catch {
      // .ini sem diretorio: nao ha o que checar
    }
  }
  return out;
}

function onPath(cmd: string, env: Runtime['env']): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const p = join(dir, cmd);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // proximo
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// checagens

function checkNode(version: string): Check {
  const v = version.replace(/^v/, '');
  const major = Number(v.split('.')[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR
    ? check('node', 'ok', `node ${v}`)
    : check('node', 'fail', `node ${v}: devslim exige ${MIN_NODE_MAJOR} ou mais novo (type stripping nativo)`, `instale node ${MIN_NODE_MAJOR}+`);
}

async function checkXcode(rt: Runtime): Promise<Check> {
  let xcode: string;
  try {
    const res = await rt.exec('xcodebuild', ['-version'], { timeoutMs: 30_000 });
    if (res.code !== 0) throw new Error(res.stderr.trim());
    xcode = res.stdout.split(/\r?\n/)[0].trim() || 'Xcode';
  } catch {
    return check('xcode', 'warn', 'xcodebuild -version nao respondeu: sem Xcode, devslim ios fica indisponivel', 'instale o Xcode e rode sudo xcode-select -s /Applications/Xcode.app');
  }
  let runtimes;
  try {
    const res = await rt.exec('xcrun', ['simctl', 'list', 'runtimes', '-j'], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim());
    runtimes = parseRuntimesJson(res.stdout);
  } catch (err) {
    return check('xcode', 'fail', `${xcode}, mas xcrun simctl list runtimes -j falhou (${(err as Error).message || 'sem saida'})`, 'sudo xcode-select -s /Applications/Xcode.app');
  }
  const ios = runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable && /^\d+(\.\d+)*$/.test(r.version));
  const good = ios.filter((r) => compareVersion(r.version, MIN_IOS_VERSION) >= 0).map((r) => r.version);
  const min = MIN_IOS_VERSION.join('.');
  if (good.length > 0) return check('xcode', 'ok', `${xcode}; runtime iOS ${good.join(', ')}`);
  if (ios.length === 0) return check('xcode', 'warn', `${xcode}, sem runtime iOS instalado`, 'Xcode > Settings > Components: instale um runtime iOS');
  return check('xcode', 'warn', `${xcode}; so runtime iOS antigo (${ios.map((r) => r.version).join(', ')}); devslim ios exige ${min}+`, `instale um runtime iOS ${min} ou mais novo`);
}

const TOOLS: readonly SdkTool[] = Object.freeze(['emulator', 'adb', 'avdmanager']);

function checkAndroidSdk(env: Runtime['env'], root: string | null): Check {
  if (root === null) {
    return check('android-sdk', 'warn', `SDK Android nao encontrado (procurado em ${sdkCandidates(env).join(', ')}); devslim android fica indisponivel`, 'defina ANDROID_HOME');
  }
  const missing = TOOLS.filter((t) => !existsSync(sdkToolPath(root, t)));
  if (missing.length > 0) {
    const what = missing.map((t) => `${t} (${relative(root, sdkToolPath(root, t))})`).join(', ');
    return check('android-sdk', 'fail', `SDK em ${root} sem: ${what}`, 'sdkmanager "emulator" "platform-tools" "cmdline-tools;latest"');
  }
  return check('android-sdk', 'ok', `SDK em ${root} com emulator, adb e avdmanager`);
}

function checkEmulatorVersion(root: string | null): Check {
  if (root === null) return check('emulator-version', 'ok', 'sem SDK Android; nao se aplica');
  const path = join(root, 'emulator', 'source.properties');
  const props = readIni(path);
  const rev = props === null ? undefined : getValue(props, 'Pkg.Revision');
  if (rev === undefined || !/^\d+(\.\d+)*$/.test(rev.trim())) {
    return check('emulator-version', 'warn', `versao do emulator nao lida (${path})`);
  }
  const v = rev.trim();
  const min = MIN_EMULATOR_REVISION.join('.');
  if (compareVersion(v, MIN_EMULATOR_REVISION) < 0) {
    return check('emulator-version', 'warn', `emulator ${v} < ${min}: versao sem o fix de vazamento de memoria GLES do host`, `atualize o pacote emulator do SDK para ${min} ou mais novo (sdkmanager "emulator")`);
  }
  return check('emulator-version', 'ok', `emulator ${v}`);
}

function checkAvdGpu(list: readonly AvdInfo[], home: string): Check[] {
  if (list.length === 0) return [check('avd-gpu', 'ok', `nenhum AVD em ${home}`)];
  return list.map((a) => {
    const hq = readIni(join(a.dir, 'hardware-qemu.ini'));
    const mode = hq === null ? undefined : getValue(hq, 'hw.gpu.mode');
    if (mode === undefined) return check('avd-gpu', 'ok', `${a.name}: sem hardware-qemu.ini com hw.gpu.mode (nao bootou desde o ultimo tune)`);
    if (isSoftwareGpu(mode)) {
      return check('avd-gpu', 'warn', `${a.name}: ultimo boot com hw.gpu.mode ${mode.trim()} (renderizacao por software, CPU e RAM altas)`, `devslim android tune ${a.name}`);
    }
    return check('avd-gpu', 'ok', `${a.name}: hw.gpu.mode ${mode.trim()}`);
  });
}

// Pedido = -memory do ultimo up/bake (lastLaunch no state) quando ha; senao o
// hw.ramSize do config.ini (state antigo ou AVD sem state).
function checkAvdRam(list: readonly AvdInfo[], home: string, env: Runtime['env']): Check[] {
  if (list.length === 0) return [check('avd-ram', 'ok', `nenhum AVD em ${home}`)];
  return list.map((a) => {
    const hq = readIni(join(a.dir, 'hardware-qemu.ini'));
    const runtime = hq === null ? null : parseRamMb(getValue(hq, 'hw.ramSize'));
    let launched: number | null = null;
    try {
      launched = launchedRamMb(loadState<AndroidState>('android', a.name, { env }));
    } catch {
      launched = null; // state ilegivel: config.ini
    }
    let asked = launched;
    if (asked === null) {
      const cfg = readIni(a.configPath);
      asked = cfg === null ? null : parseRamMb(getValue(cfg, 'hw.ramSize'));
    }
    const askedText = launched !== null ? 'pedidos no ultimo up/bake' : 'do config.ini';
    if (runtime === null) return check('avd-ram', 'ok', `${a.name}: sem hw.ramSize no hardware-qemu.ini (nao bootou desde o ultimo tune)`);
    const why: string[] = [];
    const raised = asked !== null && runtime > asked;
    if (raised) why.push(`acima dos ${asked} MB ${askedText} (emulador elevou)`);
    if (runtime > RAM_WARN_MB) why.push(`acima de ${RAM_WARN_MB} MB`);
    if (why.length > 0) {
      // Elevou: o emulador ignora -memory abaixo do piso sem lowram; tela menor nao ajuda (medido).
      const fix = raised
        ? `devslim android tune ${a.name} --lowram (com o AVD desligado; o emulador ignora -memory abaixo do piso dele sem lowram; o lowram muda o comportamento dos apps: o guest se declara aparelho de pouca RAM)`
        : `devslim android tune ${a.name} (e suba com devslim android up, que passa -memory)`;
      return check('avd-ram', 'warn', `${a.name}: ultimo boot usou ${runtime} MB, ${why.join(' e ')}`, fix);
    }
    const askedNote = asked === null ? '' : launched !== null ? ` (pedido no ultimo up/bake ${asked} MB)` : ` (config.ini ${asked} MB)`;
    return check('avd-ram', 'ok', `${a.name}: ${runtime} MB${askedNote}`);
  });
}

// config.ini de cada AVD com state x o que o perfil salvo produziria (mesmo
// applyProfile do plan/tune: nada de mapeamento proprio aqui). A capacidade que
// explica o drift sai de ligar/desligar cada uma no perfil e ver quais chaves
// passam a bater. AVD ausente, config.ini ilegivel ou state sem perfil: pulado.
// So leitura.
function driftCapabilities(doc: IniDoc, profile: AndroidProfile, keys: ReadonlySet<string>): { caps: Capability[]; added: Capability[]; removed: Capability[] } {
  const added: Capability[] = [];
  const removed: Capability[] = [];
  for (const cap of CAPABILITIES) {
    const has = profile.capabilities.includes(cap);
    const caps = has ? profile.capabilities.filter((c) => c !== cap) : [...profile.capabilities, cap];
    const alt = applyProfile(doc, { ...profile, capabilities: sortCapabilities(caps) }).changes;
    // Explica se alguma chave em drift deixa de mudar com a capacidade trocada.
    const explains = [...keys].some((k) => !alt.some((c) => c.key === k)) && alt.every((c) => keys.has(c.key));
    if (explains) (has ? removed : added).push(cap);
  }
  const caps = sortCapabilities([...profile.capabilities.filter((c) => !removed.includes(c)), ...added]);
  return { caps, added, removed };
}

function checkProfileDrift(env: Runtime['env']): Check[] {
  const names = listStates('android', { env });
  if (names.length === 0) return [check('profile-drift', 'ok', 'nenhum AVD com state do devslim')];
  const out: Check[] = [];
  let clean = 0;
  let skipped = 0;
  for (const name of names) {
    let profile: AndroidProfile | undefined;
    let doc: IniDoc | null = null;
    let changes: ReturnType<typeof applyProfile>['changes'] = [];
    try {
      profile = loadState<AndroidState>('android', name, { env })?.profile;
      if (profile === undefined || !Array.isArray(profile.capabilities)) throw new Error('state sem perfil');
      doc = readIni(findAvd(name, { env }).configPath);
      if (doc === null) throw new Error('config.ini ilegivel');
      changes = applyProfile(doc, profile).changes;
    } catch {
      skipped++;
      continue;
    }
    if (changes.length === 0) {
      clean++;
      continue;
    }
    const list = changes.map((c) => `${c.key}: atual=${c.from ?? '(ausente)'} esperado=${c.to}`).join('; ');
    const hint = driftCapabilities(doc, profile, new Set(changes.map((c) => c.key)));
    let fix = `devslim android tune ${name}`;
    if (hint.added.length > 0 || hint.removed.length > 0) {
      const why = [
        ...(hint.added.length > 0 ? [`pede ${hint.added.join(',')}`] : []),
        ...(hint.removed.length > 0 ? [`dispensa ${hint.removed.join(',')}`] : []),
      ].join(' e ');
      const need = hint.caps.length > 0 ? hint.caps.join(',') : 'none';
      fix = `devslim android tune ${name} --need ${need} (o config.ini atual ${why})\nou devslim android tune ${name} para voltar ao perfil salvo`;
    }
    out.push(check('profile-drift', 'warn', `${name}: config.ini difere do perfil salvo em ${changes.length} chave(s): ${list}`, fix));
  }
  if (out.length > 0) return out;
  const skip = skipped > 0 ? `; ${skipped} pulado(s) (AVD ausente ou config.ini ilegivel)` : '';
  return [check('profile-drift', 'ok', `${clean} AVD(s) com config.ini no perfil salvo${skip}`)];
}

// Tag da system image de cada AVD com state x capacidades que dependem dos
// servicos Google. google_apis (ou playstore) sem nenhuma delas: nota ok
// sugerindo ATD, com o numero medido. ATD/default com alguma delas: warn. AVD
// ausente, config.ini ilegivel ou sem tag: pulado. So leitura.
export const GOOGLE_SERVICE_CAPABILITIES: readonly Capability[] = Object.freeze(['push', 'weblogin', 'store']);
// Medido 2026-11-17 (API 35, pixel_7, 2 min parado, uma medicao cada):
// phys_footprint do qemu com o perfil padrao do devslim em aosp_atd x google_apis.
export const ATD_FOOTPRINT_MB = 3660;
export const GOOGLE_APIS_FOOTPRINT_MB = 4343;

const TAG_TEXT: Readonly<Record<string, string>> = Object.freeze({
  aosp_atd: 'sem servicos Google',
  default: 'sem servicos Google',
  google_atd: 'servicos Google reduzidos',
});

function checkAvdImage(env: Runtime['env']): Check[] {
  const names = listStates('android', { env });
  if (names.length === 0) return [check('avd-image', 'ok', 'nenhum AVD com state do devslim')];
  const out: Check[] = [];
  let fine = 0;
  let skipped = 0;
  for (const name of names) {
    let caps: readonly string[];
    let cfg: IniDoc | null;
    try {
      const profile = loadState<AndroidState>('android', name, { env })?.profile;
      if (profile === undefined || !Array.isArray(profile.capabilities)) throw new Error('state sem perfil');
      caps = profile.capabilities;
      cfg = readIni(findAvd(name, { env }).configPath);
    } catch {
      skipped++;
      continue;
    }
    const sysdir = cfg === null ? undefined : getValue(cfg, 'image.sysdir.1');
    const tag = cfg === null ? null : imageTag({ tagId: getValue(cfg, 'tag.id'), sysdir });
    if (tag === null) {
      skipped++;
      continue;
    }
    const api = /(?:^|\/)android-(\d+)(?:\/|$)/.exec((sysdir ?? '').replace(/\\/g, '/'))?.[1];
    const apiFlag = api !== undefined && Number(api) !== DEFAULT_API ? ` --api ${api}` : '';
    const needs = GOOGLE_SERVICE_CAPABILITIES.filter((c) => caps.includes(c));
    if (isGoogleApisTag(tag) && needs.length === 0) {
      out.push(check(
        'avd-image',
        'ok',
        `${name}: imagem ${tag} (servicos Google completos) e o perfil nao pede push, weblogin nem store; ` +
          `uma imagem ATD pesa menos (medido com aosp_atd: ${ATD_FOOTPRINT_MB} MB contra ${GOOGLE_APIS_FOOTPRINT_MB} MB de phys_footprint no host, 2 min parado, uma medicao cada)`,
        `devslim android create ${name}-atd --image aosp_atd${apiFlag}`,
      ));
    } else if (isAtdTag(tag) && needs.length > 0) {
      const verdict = tag === 'google_atd' ? 'pode nao funcionar' : 'nao funciona';
      out.push(check(
        'avd-image',
        'warn',
        `${name}: imagem ${tag} (${TAG_TEXT[tag]}) e o perfil pede ${needs.join(',')}: ${verdict} nessa imagem`,
        `devslim android create ${name}-gapis --image google_apis${apiFlag}`,
      ));
    } else {
      fine++;
    }
  }
  if (out.length > 0) return out;
  const skip = skipped > 0 ? `; ${skipped} pulado(s) (AVD ausente, config.ini ilegivel ou sem tag da imagem)` : '';
  return [check('avd-image', 'ok', `${fine} AVD(s) com imagem compativel com as capacidades do perfil${skip}`)];
}

// Emulador rodando agora fora do perfil: GPU efetiva por software, ou AVD
// tunado lancado por outro (argent, Studio). Fatos da linha de comando do qemu
// (pgrep -fl) e do hardware-qemu.ini deste boot; nunca adb.
async function checkRunningOffProfile(rt: Runtime): Promise<Check[]> {
  const procs = await listQemuProcesses(rt.exec);
  if (procs.length === 0) return [check('running-off-profile', 'ok', 'nenhum emulador rodando')];
  let session: ReturnType<typeof loadSession> = [];
  try {
    session = loadSession(rt.env);
  } catch {
    session = []; // sessao corrompida: so a assinatura decide
  }
  const out: Check[] = [];
  for (const p of procs) {
    let st: AndroidState | null = null;
    try {
      st = loadState<AndroidState>('android', p.avd, { env: rt.env });
    } catch {
      st = null;
    }
    let dir: string | null = null;
    try {
      dir = findAvd(p.avd, { env: rt.env }).dir;
    } catch {
      dir = null;
    }
    const hw = dir === null ? null : readEffectiveHardware(dir);
    const launcher = classifyLauncher(p.cmdline, session.some((e) => e.platform === 'android' && e.avd === p.avd));
    const tuned = typeof st?.originalConfigIni === 'string';
    const soft = hw?.gpu != null && isSoftwareGpu(hw.gpu);
    if (!soft && !(tuned && launcher !== 'devslim')) continue;
    const facts = [launcherText(launcher)];
    if (hw?.gpu != null) facts.push(`gpu efetiva ${hw.gpu}${soft ? ' (renderizacao por software)' : ''}`);
    if (hw?.ramMb != null) facts.push(`ram efetiva ${hw.ramMb} MB`);
    const profile = tuned && st?.profile !== undefined ? `; perfil do tune: gpu ${st.profile.gpu}, ${st.profile.ramMb} MB` : '';
    out.push(check(
      'running-off-profile',
      'warn',
      `${p.avd} (pid ${p.pid}) rodando agora: ${facts.join(', ')}${profile}`,
      `parar o emulador e subir com: devslim android up ${p.avd}\nou exportar ARGENT_EMULATOR_GPU_MODE=host no ambiente do argent`,
    ));
  }
  return out.length > 0 ? out : [check('running-off-profile', 'ok', `${procs.length} emulador(es) rodando no perfil`)];
}

// Emulador rodando sem entrada com grpc.port + grpc.token em avd/running: o
// argent (simulator-server) nao o enxerga para screenshot/describe/tap. Le so
// o diretorio; o valor do token nunca sai do runningIni.ts. Entrada de pid
// morto nao conta como anuncio; quando ha, vira uma linha ok so informativa
// (o arquivo e do emulador/SDK, nada e apagado).
async function checkEmulatorAdvertised(rt: Runtime): Promise<Check[]> {
  const procs = await listQemuProcesses(rt.exec);
  const dir = rt.runningDir;
  const scan = scanRunning(dir, rt.pidAlive);
  const staleNote = scan.stale.length === 0 ? [] : [check(
    'emulator-advertised',
    'ok',
    `${scan.stale.length} entrada(s) de emulador morto em ${dir} ignorada(s): ${scan.stale.map((e) => `pid_${e.pid}.ini (${e.avdName})`).join(', ')}; arquivos do emulador, nada apagado`,
  )];
  if (procs.length === 0) return [check('emulator-advertised', 'ok', 'nenhum emulador rodando'), ...staleNote];
  if (dir === null) {
    return [check('emulator-advertised', 'warn', `${procs.length} emulador(es) rodando; anuncio nao verificado (diretorio avd/running desconhecido nesta plataforma)`)];
  }
  const out: Check[] = [];
  for (const p of procs) {
    const e = findRunningEntry(scan.live, p.avd);
    if (isAdvertised(e)) continue;
    const what = e === null ? `sem entrada em ${dir}` : `com entrada em ${dir} sem ${e.grpcPort === null ? 'grpc.port' : 'grpc.token'}`;
    out.push(check(
      'emulator-advertised',
      'warn',
      `${p.avd} (pid ${p.pid}) rodando ${what}: ferramentas que dependem de gRPC (argent screenshot/tap) nao o enxergam; adb funciona normalmente`,
      `devslim android down ${p.avd} e devslim android up ${p.avd} (lanca com -grpc <porta> -grpc-use-token)`,
    ));
  }
  return [...(out.length > 0 ? out : [check('emulator-advertised', 'ok', `${procs.length} emulador(es) rodando, todos anunciados em ${dir}`)]), ...staleNote];
}

function checkArgentGpu(env: Runtime['env']): Check {
  const path = onPath('argent', env);
  if (path === null) return check('argent-gpu', 'ok', 'argent nao esta no PATH; nao se aplica');
  const mode = env.ARGENT_EMULATOR_GPU_MODE;
  if (mode === 'host') return check('argent-gpu', 'ok', `argent em ${path} com ARGENT_EMULATOR_GPU_MODE=host`);
  return check(
    'argent-gpu',
    'warn',
    `argent em ${path} e ARGENT_EMULATOR_GPU_MODE=${mode ?? '(ausente)'}: quando o argent boota um AVD sozinho ele usa -gpu auto, que pode cair em renderizacao por software (lavapipe/swiftshader); defina a variavel no ambiente do tool-server do argent`,
    'export ARGENT_EMULATOR_GPU_MODE=host',
  );
}

function checkDefaultBootSnapshot(list: readonly AvdInfo[]): Check[] {
  const out: Check[] = [];
  for (const a of list) {
    const dir = join(a.dir, 'snapshots', 'default_boot');
    if (!existsSync(join(dir, 'ram.bin'))) continue;
    out.push(check(
      'default-boot-snapshot',
      'warn',
      `${a.name}: snapshots/default_boot com ${sizeText(dirSize(dir))} (ram.bin regravado a cada cold boot do argent; o devslim usa slim_base)`,
    ));
  }
  return out.length > 0 ? out : [check('default-boot-snapshot', 'ok', 'nenhum AVD com snapshots/default_boot/ram.bin')];
}

const normSysdir = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');

function checkOrphanImages(root: string | null, list: readonly AvdInfo[]): Check[] {
  if (root === null) return [check('orphan-images', 'ok', 'sem SDK Android; nao se aplica')];
  const base = join(root, 'system-images');
  const referenced = new Set<string>();
  for (const a of list) {
    const cfg = readIni(a.configPath);
    const v = cfg === null ? undefined : getValue(cfg, 'image.sysdir.1');
    if (v === undefined || v.trim() === '') continue;
    const p = normSysdir(v);
    referenced.add(isAbsolute(p) ? normSysdir(relative(root, p)) : p);
  }
  const dirs = (p: string) => {
    try {
      return readdirSync(p).filter((n) => {
        try {
          return statSync(join(p, n)).isDirectory();
        } catch {
          return false;
        }
      }).sort();
    } catch {
      return [];
    }
  };
  const out: Check[] = [];
  for (const api of dirs(base)) {
    for (const tag of dirs(join(base, api))) {
      for (const abi of dirs(join(base, api, tag))) {
        const rel = `system-images/${api}/${tag}/${abi}`;
        if (referenced.has(rel)) continue;
        out.push(check(
          'orphan-images',
          'warn',
          `${rel}: nenhum config.ini de AVD referencia esta imagem; ocupa ${sizeText(dirSize(join(base, api, tag, abi)))} (so relatado, nada apagado)`,
          `sdkmanager --uninstall "${['system-images', api, tag, abi].join(';')}" se nao for usar`,
        ));
      }
    }
  }
  return out.length > 0 ? out : [check('orphan-images', 'ok', 'toda system image instalada e usada por algum AVD')];
}

async function checkSwap(rt: Runtime): Promise<Check> {
  const a = assessSwap(await readSwap(rt.exec));
  return check('swap', a.level, a.message, a.fix);
}

async function checkIosAlwaysEnabled(rt: Runtime, ctx: IosContext): Promise<Check[]> {
  const devices = await listSimDevices(rt);
  if (devices === null) return [check('ios-always-enabled', 'warn', 'nao verificado: xcrun simctl list devices -j falhou')];
  const out: Check[] = [];
  for (const d of devices) {
    if (!existsSync(storePath(d.udid, { base: ctx.storeBase }))) continue;
    let store;
    try {
      store = await readStore(d.udid, { base: ctx.storeBase, exec: rt.exec });
    } catch (err) {
      out.push(check('ios-always-enabled', 'warn', `${d.name} (${d.udid}): store ilegivel (${(err as Error).message})`));
      continue;
    }
    const off = ALWAYS_ENABLED.filter((l) => store.get(l) === true);
    if (off.length === 0) continue;
    const ambiguous = devices.filter((x) => x.name === d.name).length > 1;
    out.push(check(
      'ios-always-enabled',
      'warn',
      `${d.name} (${d.udid}): store desliga ${off.join(', ')}, que devem ficar sempre ligados`,
      `devslim ios up ${ambiguous ? d.udid : d.name}`,
    ));
  }
  return out.length > 0 ? out : [check('ios-always-enabled', 'ok', 'nenhum store de simulador desliga assistantd, gamed ou sharingd')];
}

// Entradas mortas na sessao; e, para device vivo com auto-desligar registrado,
// watcher cujo pid morreu (o device nao vai mais desligar sozinho).
async function checkStaleSession(rt: Runtime): Promise<Check[]> {
  const entries = loadSession(rt.env);
  if (entries.length === 0) return [check('stale-session', 'ok', 'sessao vazia')];
  const devices = entries.some((e) => e.platform === 'ios') ? await listSimDevices(rt) : [];
  const st = await sessionStatus(entries, { exec: rt.exec, env: rt.env, devices, pidAlive: rt.pidAlive });
  const stale = st.filter((e) => e.stale);
  const out: Check[] = [
    stale.length === 0
      ? check('stale-session', 'ok', `${entries.length} entrada(s) na sessao, todas vivas`)
      : check(
          'stale-session',
          'warn',
          `${stale.length} entrada(s) mortas na sessao: ${stale.map((e) => `${e.platform} ${e.name} ${e.id}`).join(', ')}`,
          'devslim down',
        ),
  ];
  for (const e of st) {
    if (e.stale || e.idleDown === null || e.idleDown.watcherAlive) continue;
    const id = e.platform === 'android' ? e.name : e.id;
    out.push(check(
      'stale-session',
      'warn',
      `${e.platform} ${e.name} ${e.id}: watcher do auto-desligar (pid ${e.idleDown.watcherPid}) morreu com o device rodando; ele nao vai desligar sozinho (motivo no log idle-${id}.log)`,
      `devslim ${e.platform} up ${id} --idle-down ${formatDuration(e.idleDown.ms)}\nou devslim down`,
    ));
  }
  return out;
}

// State do devslim cujo AVD ou simulador nao existe mais. So le; o fix e o
// `forget`, que apaga o registro sem tocar em device. Sem simctl, os states iOS
// ficam como nao verificados.
async function checkOrphanState(rt: Runtime): Promise<Check[]> {
  const out: Check[] = androidOrphans(rt.env).map((o) =>
    check('orphan-state', 'warn', `${o.path}: AVD ${o.name} nao existe mais (state orfao)`, o.forget),
  );
  const iosIds = listStates('ios', { env: rt.env });
  if (iosIds.length > 0) {
    const ios = iosOrphans(rt.env, await listSimDevices(rt));
    if (ios === null) {
      out.push(check('orphan-state', 'warn', `${iosIds.length} state(s) iOS nao verificado(s): xcrun simctl list devices -j falhou`));
    } else {
      for (const o of ios) out.push(check('orphan-state', 'warn', `${o.path}: simulador ${o.name} (${o.id}) nao existe mais (state orfao)`, o.forget));
    }
  }
  return out.length > 0 ? out : [check('orphan-state', 'ok', 'nenhum state orfao (todo state aponta para AVD ou simulador existente)')];
}

export async function runDoctor(ctx: DoctorContext = {}): Promise<Check[]> {
  const rt = resolveRuntime(ctx);
  const root = findSdkRoot(rt.env);
  const list = avds(rt.env);
  const home = avdHome(rt.env);
  return [
    checkNode(ctx.nodeVersion ?? process.version),
    await checkXcode(rt),
    checkAndroidSdk(rt.env, root),
    checkEmulatorVersion(root),
    ...checkAvdGpu(list, home),
    ...checkAvdRam(list, home, rt.env),
    ...checkProfileDrift(rt.env),
    ...checkAvdImage(rt.env),
    ...(await checkRunningOffProfile(rt)),
    ...(await checkEmulatorAdvertised(rt)),
    checkArgentGpu(rt.env),
    ...checkDefaultBootSnapshot(list),
    ...checkOrphanImages(root, list),
    await checkSwap(rt),
    ...(await checkIosAlwaysEnabled(rt, ctx)),
    ...(await checkStaleSession(rt)),
    ...(await checkOrphanState(rt)),
  ];
}

export function doctorExitCode(checks: readonly Check[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

export function doctorText(checks: readonly Check[]): string[] {
  const lines: string[] = [];
  for (const c of checks) {
    const tag = `[${c.level}]`.padEnd(6);
    lines.push(`${tag} ${c.id}: ${c.message}`);
    // fix de varias linhas: continuacao alinhada depois de "fix: ".
    if (c.fix !== undefined) lines.push(`${' '.repeat(7)}fix: ${c.fix.split('\n').join(`\n${' '.repeat(12)}`)}`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(`${fails} fail, ${warns} warn`);
  return lines;
}
