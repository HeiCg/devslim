import { existsSync } from 'node:fs';
import { DevslimError } from './errors.ts';
import { findAvd } from './android/avd.ts';
import { resolveRuntime } from './android/deps.ts';
import { loadSession, removeSession, type SessionEntry } from './android/session.ts';
import type { SimDevice } from './ios/simctl.ts';
import type { IosContext } from './ios/slim.ts';
import { listSimDevices } from './status.ts';
import { clearState, listStates, loadState, statePath, type IosState, type Platform } from './state.ts';

// Orphan state: a file in $DEVSLIM_HOME/state/<platform>/ whose device no longer
// exists (AVD without a locatable directory; UDID missing from `simctl list
// devices`). Detection only reads. `forget` deletes the state (and the session entry)
// without ever sending a command to the device; an AVD or simulator that still exists is
// refused without --force, because then the right tool is `restore` / `ios off`.

type Env = Readonly<Record<string, string | undefined>>;

export type OrphanState = Readonly<{ platform: Platform; id: string; name: string; path: string; forget: string }>;

export function forgetCommand(platform: Platform, id: string): string {
  return `devslim ${platform} forget ${id}`;
}

// AVD directory, or null if it does not exist (same rule as `status`: findAvd).
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
    return null; // corrupt state: UDID only
  }
}

export function androidOrphans(env: Env): OrphanState[] {
  return listStates('android', { env })
    .filter((name) => avdDirOf(name, env) === null)
    .map((name) =>
      Object.freeze({ platform: 'android', id: name, name, path: statePath('android', name, { env }), forget: forgetCommand('android', name) }),
    );
}

// null = not checked (simctl failed: cannot tell that it is gone).
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
  id: string; // AVD name or UDID
  name: string;
  deviceExists: boolean | null; // null = could not check (simctl failed)
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
  const path = statePath('android', name, { env }); // validates the name
  const match = (e: SessionEntry) => e.platform === 'android' && e.avd === name;
  const hasState = existsSync(path);
  const inSession = loadSession(env).some(match);
  if (!hasState && !inSession) throw new DevslimError(`nothing to forget: no state and no session entry for AVD ${name}`);
  const dir = avdDirOf(name, env);
  if (dir !== null && !force) {
    throw new DevslimError(
      `AVD ${name} still exists (${dir}); to undo the tune use devslim android restore ${name} ` +
        '(forget only cleans the record of a deleted AVD; --force removes the state anyway)',
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

// Existing simulator with this UDID or exact name; duplicate name = error.
function existingSim(devices: readonly SimDevice[] | null, q: string): SimDevice | undefined {
  if (devices === null) return undefined;
  const byUdid = devices.find((d) => up(d.udid) === up(q));
  if (byUdid !== undefined) return byUdid;
  const byName = devices.filter((d) => d.name === q);
  if (byName.length > 1) throw new DevslimError(`name "${q}" is ambiguous; use the UDID: ${byName.map((d) => d.udid).join(', ')}`);
  return byName[0];
}

// Simulator that is gone: UDID or name saved in the state; else the session entry.
function recordedSim(env: Env, q: string): { udid: string; name: string } | null {
  const hits = listStates('ios', { env }).filter((id) => up(id) === up(q) || iosNameOf(id, env) === q);
  if (hits.length > 1) throw new DevslimError(`name "${q}" is ambiguous across states; use the UDID: ${hits.join(', ')}`);
  if (hits.length === 1) return { udid: hits[0], name: iosNameOf(hits[0], env) ?? hits[0] };
  const entries = loadSession(env).filter((e) => e.platform === 'ios' && (up(e.serial) === up(q) || e.avd === q));
  if (entries.length > 1) throw new DevslimError(`name "${q}" is ambiguous in the session; use the UDID: ${entries.map((e) => e.serial).join(', ')}`);
  return entries.length === 1 ? { udid: entries[0].serial, name: entries[0].avd } : null;
}

export async function forgetSim(query: string, ctx: IosContext & { force?: boolean } = {}): Promise<ForgetResult> {
  const rt = resolveRuntime(ctx);
  const env = rt.env;
  const force = ctx.force === true;
  const q = query.trim();
  if (q === '') throw new DevslimError('missing simulator UDID or name');
  const devices = await listSimDevices(rt);
  const dev = existingSim(devices, q);
  const target = dev !== undefined ? { udid: dev.udid, name: dev.name } : recordedSim(env, q);
  if (target === null) throw new DevslimError(`nothing to forget: no state and no session entry for simulator "${q}"`);
  const { udid, name } = target;

  // State file with the stored spelling (the UDID may come in lowercase).
  const stateId = listStates('ios', { env }).find((id) => up(id) === up(udid)) ?? udid;
  const path = statePath('ios', stateId, { env });
  const match = (e: SessionEntry) => e.platform === 'ios' && up(e.serial) === up(udid);
  const hasState = existsSync(path);
  const inSession = loadSession(env).some(match);
  if (!hasState && !inSession) throw new DevslimError(`nothing to forget: no state and no session entry for simulator ${name} (${udid})`);

  const deviceExists = dev !== undefined ? true : devices === null ? null : false;
  if (deviceExists === true && !force) {
    throw new DevslimError(
      `simulator ${name} (${udid}) still exists; to undo the slimming use devslim ios off ${udid} ` +
        '(forget only cleans the record of a deleted simulator; --force removes the state anyway)',
    );
  }
  if (deviceExists === null && !force) {
    throw new DevslimError(`could not check whether simulator ${name} (${udid}) exists (xcrun simctl list devices failed); --force removes the state anyway`);
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
