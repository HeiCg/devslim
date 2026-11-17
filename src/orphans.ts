import { existsSync } from 'node:fs';
import { DevslimError } from './errors.ts';
import { findAvd } from './android/avd.ts';
import { resolveRuntime } from './android/deps.ts';
import { loadSession, removeSession, type SessionEntry } from './android/session.ts';
import type { SimDevice } from './ios/simctl.ts';
import type { IosContext } from './ios/slim.ts';
import { listSimDevices } from './status.ts';
import { clearState, listStates, loadState, statePath, type IosState, type Platform } from './state.ts';

// State orfao: arquivo em $DEVSLIM_HOME/state/<plataforma>/ cujo device nao
// existe mais (AVD sem diretorio localizavel; UDID fora do `simctl list
// devices`). Deteccao so le. `forget` apaga o state (e a entrada da sessao)
// sem nunca mandar comando ao device; AVD ou simulador que ainda existe e
// recusado sem --force, porque ai o certo e `restore` / `ios off`.

type Env = Readonly<Record<string, string | undefined>>;

export type OrphanState = Readonly<{ platform: Platform; id: string; name: string; path: string; forget: string }>;

export function forgetCommand(platform: Platform, id: string): string {
  return `devslim ${platform} forget ${id}`;
}

// Diretorio do AVD, ou null se nao existe (mesma regra do `status`: findAvd).
function avdDirOf(name: string, env: Env): string | null {
  try {
    return findAvd(name, { env }).dir;
  } catch {
    return null;
  }
}

function iosNameOf(udid: string, env: Env): string | null {
  try {
    const name = loadState<IosState>('ios', udid, { env })?.name;
    return typeof name === 'string' && name !== '' ? name : null;
  } catch {
    return null; // state corrompido: so o UDID
  }
}

export function androidOrphans(env: Env): OrphanState[] {
  return listStates('android', { env })
    .filter((name) => avdDirOf(name, env) === null)
    .map((name) =>
      Object.freeze({ platform: 'android', id: name, name, path: statePath('android', name, { env }), forget: forgetCommand('android', name) }),
    );
}

// null = nao verificado (simctl falhou: nao da para afirmar que sumiu).
export function iosOrphans(env: Env, devices: readonly SimDevice[] | null): OrphanState[] | null {
  const ids = listStates('ios', { env });
  if (ids.length === 0) return [];
  if (devices === null) return null;
  return ids
    .filter((id) => !devices.some((d) => d.udid.toUpperCase() === id.toUpperCase()))
    .map((id) =>
      Object.freeze({ platform: 'ios', id, name: iosNameOf(id, env) ?? id, path: statePath('ios', id, { env }), forget: forgetCommand('ios', id) }),
    );
}

export type ForgetResult = Readonly<{
  platform: Platform;
  id: string; // nome do AVD ou UDID
  name: string;
  deviceExists: boolean | null; // null = nao deu para conferir (simctl falhou)
  forced: boolean;
  statePath: string;
  removedState: boolean;
  removedSession: readonly SessionEntry[];
}>;

// ---------------------------------------------------------------------------
// android forget

export function forgetAvd(name: string, ctx: { env?: Env; force?: boolean } = {}): ForgetResult {
  const env = ctx.env ?? process.env;
  const force = ctx.force === true;
  const path = statePath('android', name, { env }); // valida o nome
  const match = (e: SessionEntry) => e.platform === 'android' && e.avd === name;
  const hasState = existsSync(path);
  const inSession = loadSession(env).some(match);
  if (!hasState && !inSession) throw new DevslimError(`nada a esquecer: sem state nem entrada na sessao para o AVD ${name}`);
  const dir = avdDirOf(name, env);
  if (dir !== null && !force) {
    throw new DevslimError(
      `AVD ${name} ainda existe (${dir}); para desfazer o tune use devslim android restore ${name} ` +
        '(forget so limpa o registro de AVD apagado; --force remove o state mesmo assim)',
    );
  }
  const removedState = clearState('android', name, { env });
  const removedSession = inSession ? removeSession(match, env) : [];
  return Object.freeze({
    platform: 'android',
    id: name,
    name,
    deviceExists: dir !== null,
    forced: force,
    statePath: path,
    removedState,
    removedSession: Object.freeze(removedSession),
  });
}

// ---------------------------------------------------------------------------
// ios forget

const up = (s: string) => s.toUpperCase();

// Simulador existente com esse UDID ou nome exato; nome repetido = erro.
function existingSim(devices: readonly SimDevice[] | null, q: string): SimDevice | undefined {
  if (devices === null) return undefined;
  const byUdid = devices.find((d) => up(d.udid) === up(q));
  if (byUdid !== undefined) return byUdid;
  const byName = devices.filter((d) => d.name === q);
  if (byName.length > 1) throw new DevslimError(`nome "${q}" e ambiguo; use o UDID: ${byName.map((d) => d.udid).join(', ')}`);
  return byName[0];
}

// Simulador que sumiu: UDID ou nome salvo no state; senao a entrada da sessao.
function recordedSim(env: Env, q: string): { udid: string; name: string } | null {
  const hits = listStates('ios', { env }).filter((id) => up(id) === up(q) || iosNameOf(id, env) === q);
  if (hits.length > 1) throw new DevslimError(`nome "${q}" e ambiguo entre states; use o UDID: ${hits.join(', ')}`);
  if (hits.length === 1) return { udid: hits[0], name: iosNameOf(hits[0], env) ?? hits[0] };
  const entries = loadSession(env).filter((e) => e.platform === 'ios' && (up(e.serial) === up(q) || e.avd === q));
  if (entries.length > 1) throw new DevslimError(`nome "${q}" e ambiguo na sessao; use o UDID: ${entries.map((e) => e.serial).join(', ')}`);
  return entries.length === 1 ? { udid: entries[0].serial, name: entries[0].avd } : null;
}

export async function forgetSim(query: string, ctx: IosContext & { force?: boolean } = {}): Promise<ForgetResult> {
  const rt = resolveRuntime(ctx);
  const env = rt.env;
  const force = ctx.force === true;
  const q = query.trim();
  if (q === '') throw new DevslimError('falta o UDID ou nome do simulador');
  const devices = await listSimDevices(rt);
  const dev = existingSim(devices, q);
  const target = dev !== undefined ? { udid: dev.udid, name: dev.name } : recordedSim(env, q);
  if (target === null) throw new DevslimError(`nada a esquecer: sem state nem entrada na sessao para o simulador "${q}"`);
  const { udid, name } = target;

  // Arquivo do state com a grafia gravada (o UDID pode vir em minusculas).
  const stateId = listStates('ios', { env }).find((id) => up(id) === up(udid)) ?? udid;
  const path = statePath('ios', stateId, { env });
  const match = (e: SessionEntry) => e.platform === 'ios' && up(e.serial) === up(udid);
  const hasState = existsSync(path);
  const inSession = loadSession(env).some(match);
  if (!hasState && !inSession) throw new DevslimError(`nada a esquecer: sem state nem entrada na sessao para o simulador ${name} (${udid})`);

  const deviceExists = dev !== undefined ? true : devices === null ? null : false;
  if (deviceExists === true && !force) {
    throw new DevslimError(
      `simulador ${name} (${udid}) ainda existe; para desfazer o enxugamento use devslim ios off ${udid} ` +
        '(forget so limpa o registro de simulador apagado; --force remove o state mesmo assim)',
    );
  }
  if (deviceExists === null && !force) {
    throw new DevslimError(`nao deu para conferir se o simulador ${name} (${udid}) existe (xcrun simctl list devices falhou); --force remove o state mesmo assim`);
  }
  const removedState = clearState('ios', stateId, { env });
  const removedSession = inSession ? removeSession(match, env) : [];
  return Object.freeze({
    platform: 'ios',
    id: udid,
    name,
    deviceExists,
    forced: force,
    statePath: path,
    removedState,
    removedSession: Object.freeze(removedSession),
  });
}
