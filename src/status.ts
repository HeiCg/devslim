import type { Exec } from './exec.ts';
import { findAvd, runningLocks } from './android/avd.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { readEffectiveHardware } from './android/hardwareQemu.ts';
import { launcherFor, launcherText, listQemuProcesses, type Launcher } from './android/launcher.ts';
import { hasSlimSnapshot } from './android/runtime.ts';
import { findRunningEntry, isAdvertised, readRunningEntries, type RunningEntry } from './android/runningIni.ts';
import { loadSession, type SessionEntry } from './android/session.ts';
import { readStore } from './ios/disabledStore.ts';
import { labelsToDisable } from './ios/labels.ts';
import { createSimctl, type SimDevice } from './ios/simctl.ts';
import type { IosContext } from './ios/slim.ts';
import { findQemuPid } from './measure.ts';
import { listStates, loadState, type AndroidState, type IosProfileRecord, type IosState } from './state.ts';
import type { Capability } from './capabilities.ts';
import { readSwap, type SwapStatus } from './swap.ts';

// `devslim status`: somente leitura. Nunca chama adb (subiria o daemon) nem
// escreve nada; emulador rodando = lock no .avd ou `pgrep` do qemu. Quem
// lancou cada emulador sai da linha de comando do qemu (pgrep -fl / ps).

// ---------------------------------------------------------------------------
// Liveness sem adb (usada tambem por doctor, down e measure de topo).

export type AvdLiveness = Readonly<{ dir: string | null; lock: boolean; pgrep: boolean; pid: number | null; running: boolean }>;

export async function avdLiveness(avd: string, opts: { exec: Exec; env: Runtime['env']; dir?: string | null }): Promise<AvdLiveness> {
  let dir = opts.dir ?? null;
  if (dir === null) {
    try {
      dir = findAvd(avd, { env: opts.env }).dir;
    } catch {
      dir = null; // AVD sumiu do disco: so o pgrep decide
    }
  }
  const lock = dir !== null && runningLocks(dir).length > 0;
  const pid = await findQemuPid(avd, { exec: opts.exec });
  return Object.freeze({ dir, lock, pgrep: pid !== null, pid, running: lock || pid !== null });
}

// `simctl list devices -j`; falha (sem Xcode) = null, nunca erro.
export async function listSimDevices(rt: Runtime): Promise<SimDevice[] | null> {
  try {
    return await createSimctl({ exec: rt.exec, sleep: rt.sleep, now: rt.now }).listDevices();
  } catch {
    return null;
  }
}

export type SessionStatus = Readonly<{
  platform: 'android' | 'ios';
  name: string;
  id: string; // serial (Android) ou UDID (iOS)
  pid: number;
  startedAt: string;
  alive: boolean;
  stale: boolean;
}>;

// Entrada morta: Android sem lock nem qemu; iOS com o device desligado ou
// inexistente. Sem lista do simctl (null) nao da para afirmar: conta como viva.
export async function sessionStatus(
  entries: readonly SessionEntry[],
  opts: { exec: Exec; env: Runtime['env']; devices: readonly SimDevice[] | null },
): Promise<SessionStatus[]> {
  const out: SessionStatus[] = [];
  for (const e of entries) {
    let alive: boolean;
    if (e.platform === 'android') {
      alive = (await avdLiveness(e.avd, { exec: opts.exec, env: opts.env })).running;
    } else if (opts.devices === null) {
      alive = true;
    } else {
      const dev = opts.devices.find((d) => d.udid.toUpperCase() === e.serial.toUpperCase());
      alive = dev !== undefined && dev.state !== 'Shutdown';
    }
    out.push(Object.freeze({ platform: e.platform, name: e.avd, id: e.serial, pid: e.pid, startedAt: e.startedAt, alive, stale: !alive }));
  }
  return out;
}

export { readSwap, type SwapStatus } from './swap.ts';

// ---------------------------------------------------------------------------
// status

export type IosStatus = Readonly<{
  udid: string;
  name: string;
  state: string; // do simctl; 'missing' (sumiu) ou 'unknown' (simctl falhou)
  booted: boolean;
  hasState: boolean;
  profile: IosProfileRecord | null;
  expected: number | null; // labels que o perfil salvo desliga
  disabledInStore: number | null; // desses, quantos estao desligados no store agora
  drift: boolean | null; // store perdeu entradas do perfil (ex. depois de erase)
}>;

export type AndroidStatus = Readonly<{
  avd: string;
  dir: string | null;
  exists: boolean;
  tuned: boolean;
  ramMb: number | null; // = ramRequestedMb (mantido por compatibilidade)
  gpu: string | null; // gpu pedida no tune
  ramRequestedMb: number | null; // RAM do perfil do tune (-memory)
  ramEffectiveMb: number | null; // hw.ramSize do hardware-qemu.ini do ultimo boot; null sem o arquivo
  ramFloored: boolean; // efetiva acima da pedida: o emulador elevou
  gpuEffective: string | null; // hw.gpu.mode do hardware-qemu.ini do ultimo boot
  baked: boolean; // snapshots/slim_base existe
  bakedAt: string | null;
  running: boolean;
  runningBy: Readonly<{ lock: boolean; pgrep: boolean }>;
  pid: number | null;
  // false = AVD rodando sem state do devslim (aparece so enquanto roda).
  hasState: boolean;
  // Quem lancou o emulador rodando (linha de comando do qemu); null parado ou ilegivel.
  launcher: Launcher | null;
  // Rodando: entrada em avd/running com grpc.port e grpc.token (o argent so
  // enxerga assim); null parado. grpcPort da entrada, se houver.
  advertised: boolean | null;
  grpcPort: number | null;
}>;

// Contrato estavel do `status --json`.
export type StatusReport = Readonly<{
  ios: readonly IosStatus[];
  android: readonly AndroidStatus[];
  session: readonly SessionStatus[];
  swap: SwapStatus;
  at: string;
}>;

async function iosStatus(rt: Runtime, ctx: IosContext, devices: readonly SimDevice[] | null): Promise<IosStatus[]> {
  const byUdid = new Map<string, IosStatus>();
  for (const d of devices ?? []) {
    if (d.state !== 'Booted') continue;
    byUdid.set(d.udid, Object.freeze({
      udid: d.udid, name: d.name, state: d.state, booted: true, hasState: false, profile: null, expected: null, disabledInStore: null, drift: null,
    }));
  }
  for (const udid of listStates('ios', { env: rt.env })) {
    let st: IosState | null;
    try {
      st = loadState<IosState>('ios', udid, { env: rt.env });
    } catch {
      st = null; // state corrompido: aparece sem perfil
    }
    const dev = devices?.find((d) => d.udid.toUpperCase() === udid.toUpperCase());
    const profile = st?.profile ?? null;
    let expectedLabels: string[] | null = null;
    if (profile !== null) {
      try {
        expectedLabels = labelsToDisable({ capabilities: profile.capabilities as Capability[], except: profile.except, keep: profile.keep });
      } catch {
        expectedLabels = null; // perfil salvo com id que nao existe mais
      }
    }
    let disabledInStore: number | null = null;
    if (expectedLabels !== null) {
      try {
        const store = await readStore(udid, { base: ctx.storeBase, exec: rt.exec });
        disabledInStore = expectedLabels.filter((l) => store.get(l) === true).length;
      } catch {
        disabledInStore = null; // store ilegivel
      }
    }
    const expected = expectedLabels?.length ?? profile?.labels ?? null;
    byUdid.set(dev?.udid ?? udid, Object.freeze({
      udid: dev?.udid ?? udid,
      name: dev?.name ?? st?.name ?? udid,
      state: dev?.state ?? (devices === null ? 'unknown' : 'missing'),
      booted: dev?.state === 'Booted',
      hasState: true,
      profile,
      expected,
      disabledInStore,
      drift: expected === null || disabledInStore === null ? null : disabledInStore < expected,
    }));
  }
  return [...byUdid.values()].sort((a, b) => a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
}

// AVDs com state, mais todo emulador rodando de AVD sem state (pgrep -fl).
async function androidStatus(rt: Runtime, session: readonly SessionEntry[]): Promise<AndroidStatus[]> {
  const processes = await listQemuProcesses(rt.exec);
  const announced: readonly RunningEntry[] = readRunningEntries(rt.runningDir);
  const stated = listStates('android', { env: rt.env });
  const unstated = [...new Set(processes.map((p) => p.avd))].filter((n) => !stated.includes(n));
  const out: AndroidStatus[] = [];
  for (const avd of [...stated, ...unstated]) {
    const hasState = stated.includes(avd);
    let st: AndroidState | null = null;
    if (hasState) {
      try {
        st = loadState<AndroidState>('android', avd, { env: rt.env });
      } catch {
        st = null;
      }
    }
    let info: ReturnType<typeof findAvd> | null;
    try {
      info = findAvd(avd, { env: rt.env });
    } catch {
      info = null;
    }
    const live = await avdLiveness(avd, { exec: rt.exec, env: rt.env, dir: info?.dir ?? null });
    const pid = live.pid ?? processes.find((p) => p.avd === avd)?.pid ?? null;
    const running = live.running || pid !== null;
    const inSession = session.some((e) => e.platform === 'android' && e.avd === avd);
    const launcher = running ? (await launcherFor(avd, { exec: rt.exec, pid, inSession, processes })).launcher : null;
    const hw = info === null ? null : readEffectiveHardware(info.dir);
    const entry = running ? findRunningEntry(announced, avd) : null;
    const requested = st?.profile?.ramMb ?? null;
    const effective = hw?.ramMb ?? null;
    out.push(Object.freeze({
      avd,
      dir: info?.dir ?? st?.avdDir ?? null,
      exists: info !== null,
      tuned: typeof st?.originalConfigIni === 'string',
      ramMb: requested,
      gpu: st?.profile?.gpu ?? null,
      ramRequestedMb: requested,
      ramEffectiveMb: effective,
      ramFloored: requested !== null && effective !== null && effective > requested,
      gpuEffective: hw?.gpu ?? null,
      baked: info !== null && hasSlimSnapshot(info),
      bakedAt: st?.bakedAt ?? null,
      running,
      runningBy: Object.freeze({ lock: live.lock, pgrep: pid !== null }),
      pid,
      hasState,
      launcher,
      advertised: running ? isAdvertised(entry) : null,
      grpcPort: entry?.grpcPort ?? null,
    }));
  }
  return out.sort((a, b) => a.avd.localeCompare(b.avd));
}

export async function collectStatus(ctx: IosContext = {}): Promise<StatusReport> {
  const rt = resolveRuntime(ctx);
  const devices = await listSimDevices(rt);
  const ios = await iosStatus(rt, ctx, devices);
  const entries = loadSession(rt.env);
  const android = await androidStatus(rt, entries);
  const session = await sessionStatus(entries, { exec: rt.exec, env: rt.env, devices });
  const swap = await readSwap(rt.exec);
  return Object.freeze({
    ios: Object.freeze(ios),
    android: Object.freeze(android),
    session: Object.freeze(session),
    swap,
    at: rt.date().toISOString(),
  });
}

// "ram pedida 2048 MB, efetiva 2560 MB (emulador elevou)"; sem hardware-qemu.ini, so a pedida.
function ramText(a: AndroidStatus): string {
  const asked = `ram pedida ${a.ramRequestedMb ?? '?'} MB`;
  if (a.ramEffectiveMb === null) return asked;
  return `${asked}, efetiva ${a.ramEffectiveMb} MB${a.ramFloored ? ' (emulador elevou)' : ''}`;
}

// AVD sem state: so o que o emulador de fato usou, se ha hardware-qemu.ini.
function effectiveText(a: AndroidStatus): string {
  const parts = [
    a.ramEffectiveMb === null ? null : `ram efetiva ${a.ramEffectiveMb} MB`,
    a.gpuEffective === null ? null : `gpu efetiva ${a.gpuEffective}`,
  ].filter((x) => x !== null);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

function gpuText(a: AndroidStatus): string {
  if (a.gpuEffective === null || a.gpuEffective === a.gpu) return `gpu ${a.gpu ?? '?'}`;
  return `gpu pedida ${a.gpu ?? '?'}, efetiva ${a.gpuEffective}`;
}

// Linhas de texto: uma por device/entrada, mais o swap.
export function statusText(s: StatusReport): string[] {
  const lines: string[] = [];
  for (const d of s.ios) {
    if (!d.hasState) {
      lines.push(`ios ${d.name} (${d.udid}) ${d.state}: sem state do devslim`);
      continue;
    }
    const p = d.profile;
    const caps = p !== null && p.capabilities.length > 0 ? ` (capacidades ${p.capabilities.join(',')})` : '';
    const store = d.disabledInStore === null ? 'store ilegivel ou ausente' : `store ${d.disabledInStore}/${d.expected} desligados`;
    lines.push(`ios ${d.name} (${d.udid}) ${d.state}: perfil ${d.expected ?? '?'} labels${caps}, ${store}${d.drift ? ', DRIFT (rode devslim ios up de novo)' : ''}`);
  }
  for (const a of s.android) {
    const parts: string[] = [];
    if (!a.hasState) {
      parts.push(`sem state do devslim${effectiveText(a)}`);
      parts.push(a.exists ? `baked ${a.baked ? 'sim' : 'nao'}` : 'AVD nao encontrado');
    } else {
      parts.push(
        a.exists ? (a.tuned ? `tunado (${ramText(a)}, ${gpuText(a)})` : 'nao tunado') : `AVD nao encontrado (${a.dir ?? '?'})`,
        `baked ${a.baked ? 'sim' : 'nao'}`,
      );
    }
    const by = [a.runningBy.lock ? 'lock' : null, a.runningBy.pgrep ? `pgrep pid ${a.pid}` : null].filter((x) => x !== null);
    // Sufixo so quando o emulador nao e nosso.
    const who = a.launcher === 'argent' || a.launcher === 'other' ? ` ${launcherText(a.launcher)}` : '';
    const ad = a.running && a.advertised === false ? ' sem anuncio gRPC' : '';
    parts.push(a.running ? `rodando (${by.join(', ')})${who}${ad}` : 'parado');
    lines.push(`android ${a.avd}: ${parts.join(', ')}`);
  }
  for (const e of s.session) {
    lines.push(`sessao ${e.platform} ${e.name} ${e.id}: ${e.stale ? 'STALE (devslim down limpa)' : 'viva'}`);
  }
  if (s.ios.length === 0) lines.push('ios: nada bootado e nenhum state');
  if (s.android.length === 0) lines.push('android: nenhum AVD com state nem emulador rodando');
  if (s.session.length === 0) lines.push('sessao: vazia');
  const w = s.swap;
  lines.push(w.percent === null ? 'swap: nao lido' : `swap: ${w.usedMb} de ${w.totalMb} MB (${w.percent}%)`);
  return lines;
}
