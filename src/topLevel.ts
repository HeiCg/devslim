import { DevslimError } from './errors.ts';
import { resolveRuntime, type Runtime } from './android/deps.ts';
import { downAvd, type DownOutcome } from './android/runtime.ts';
import { loadSession, removeSession } from './android/session.ts';
import { downSim, type DownSimOutcome, type IosContext } from './ios/slim.ts';
import { measureAvd, measureSim, type AndroidMeasurement, type IosMeasurement } from './measure.ts';
import { listStates } from './state.ts';
import { avdLiveness, listSimDevices, sessionStatus, type SessionStatus } from './status.ts';

// Comandos de topo: `devslim down` e `devslim measure` cobrem Android e iOS.

// result 'skipped': com --force e nada vivo na sessao daquela plataforma, a
// ferramenta dela faltou (sem SDK Android, sem Xcode); name e id vazios, o
// motivo vai em detail e num aviso em stderr. Nao conta como falha.
export type TopDownOutcome = Readonly<{
  platform: 'android' | 'ios';
  name: string;
  id: string; // serial ou UDID
  registered: boolean;
  result: DownOutcome['result'] | DownSimOutcome['result'] | 'skipped';
  detail?: string;
}>;

const fromAndroid = (r: DownOutcome): TopDownOutcome =>
  Object.freeze({ platform: 'android', name: r.avd, id: r.serial, registered: r.registered, result: r.result, ...(r.detail ? { detail: r.detail } : {}) });

const fromIos = (r: DownSimOutcome): TopDownOutcome =>
  Object.freeze({ platform: 'ios', name: r.name, id: r.udid, registered: r.registered, result: r.result, ...(r.detail ? { detail: r.detail } : {}) });

const failedFor = (s: SessionStatus, err: unknown): TopDownOutcome =>
  Object.freeze({ platform: s.platform, name: s.name, id: s.id, registered: true, result: 'failed', detail: (err as Error).message });

const skippedFor = (platform: 'android' | 'ios', err: unknown): TopDownOutcome =>
  Object.freeze({ platform, name: '', id: '', registered: false, result: 'skipped', detail: (err as Error).message });

function skipped(rt: Runtime, platform: 'android' | 'ios', err: unknown): TopDownOutcome {
  const o = skippedFor(platform, err);
  rt.stderr(`devslim: aviso: down --force pulou ${platform}: ${o.detail}\n`);
  return o;
}

// Desliga tudo que a sessao registrou. Entradas mortas (status `stale`, sem adb)
// saem da sessao sem nenhum comando no device; o resto vai para downAvd/downSim.
// `force` repassa para os dois (desliga tambem o que o devslim nao subiu).
export async function downAll(ctx: IosContext & { force?: boolean } = {}): Promise<TopDownOutcome[]> {
  const rt = resolveRuntime(ctx);
  const force = ctx.force === true;
  const entries = loadSession(rt.env);
  if (entries.length === 0 && !force) return [];
  const devices = entries.some((e) => e.platform === 'ios') ? await listSimDevices(rt) : [];
  const st = await sessionStatus(entries, { exec: rt.exec, env: rt.env, devices });

  const out: TopDownOutcome[] = [];
  for (const s of st.filter((x) => x.stale)) {
    removeSession((e) => e.platform === s.platform && e.serial === s.id, rt.env);
    out.push(Object.freeze({
      platform: s.platform,
      name: s.name,
      id: s.id,
      registered: true,
      result: 'stale',
      detail: s.platform === 'android' ? 'sem lock nem qemu rodando' : 'simulador desligado ou inexistente',
    }));
  }

  const live = st.filter((x) => !x.stale);
  const liveAndroid = live.filter((x) => x.platform === 'android');
  const liveIos = live.filter((x) => x.platform === 'ios');
  if (liveAndroid.length > 0 || force) {
    try {
      out.push(...(await downAvd(undefined, { ...ctx, force })).map(fromAndroid));
    } catch (err) {
      if (!(err instanceof DevslimError)) throw err;
      // Entrada viva que nao deu para desligar = failed. So --force e nada
      // nosso no Android (ex.: sem SDK) = plataforma pulada, avisada.
      if (liveAndroid.length > 0) out.push(...liveAndroid.map((s) => failedFor(s, err)));
      else out.push(skipped(rt, 'android', err));
    }
  }
  if (liveIos.length > 0 || force) {
    try {
      out.push(...(await downSim(undefined, { ...ctx, force })).map(fromIos));
    } catch (err) {
      if (!(err instanceof DevslimError)) throw err;
      if (liveIos.length > 0) out.push(...liveIos.map((s) => failedFor(s, err)));
      else out.push(skipped(rt, 'ios', err));
    }
  }
  return out;
}

export type AnyMeasurement = AndroidMeasurement | IosMeasurement;

// Mede tudo que esta rodando: AVDs com state ou na sessao (rodando por lock ou
// pgrep, sem adb) e simuladores bootados. Falha de um device vira aviso.
export async function measureAll(ctx: IosContext = {}): Promise<AnyMeasurement[]> {
  const rt = resolveRuntime(ctx);
  const out: AnyMeasurement[] = [];
  const names = new Set<string>(listStates('android', { env: rt.env }));
  for (const e of loadSession(rt.env)) if (e.platform === 'android') names.add(e.avd);
  for (const avd of [...names].sort()) {
    if (!(await avdLiveness(avd, { exec: rt.exec, env: rt.env })).running) continue;
    try {
      out.push(await measureAvd(avd, ctx));
    } catch (err) {
      rt.stderr(`devslim: aviso: measure de ${avd} falhou: ${(err as Error).message}\n`);
    }
  }
  for (const d of (await listSimDevices(rt)) ?? []) {
    if (d.state !== 'Booted') continue;
    try {
      out.push(await measureSim(d.udid, ctx));
    } catch (err) {
      rt.stderr(`devslim: aviso: measure de ${d.name} (${d.udid}) falhou: ${(err as Error).message}\n`);
    }
  }
  return out;
}
