import { DevslimError } from '../errors.ts';
import type { Exec, ExecResult } from '../exec.ts';
import { realSleep, type Sleep } from '../android/adb.ts';
import { UDID_RE } from './disabledStore.ts';

// Everything that talks to `xcrun simctl`. Exec and sleep are injectable.

export const DEFAULT_BOOTSTATUS_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 60_000;
export const LIST_TIMEOUT_MS = 60_000;
export const SPAWN_TIMEOUT_MS = 2 * 60_000;
// Pauses between attempts when launchd_sim answers 124 / "Domain is tearing down".
export const LAUNCHD_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000]);

export type SimDevice = Readonly<{
  udid: string;
  name: string;
  state: string; // Booted | Shutdown | Shutting Down | Creating ...
  runtimeId: string; // com.apple.CoreSimulator.SimRuntime.iOS-26-4
  isAvailable: boolean;
}>;

export type SimRuntime = Readonly<{
  identifier: string;
  platform: string; // iOS | tvOS | watchOS | xrOS ...
  version: string; // 26.4
  name: string;
  isAvailable: boolean;
}>;

const ALIASES = Object.freeze(['booted', 'all']);

function describe(res: ExecResult): string {
  const text = (res.stderr.trim() || res.stdout.trim()).split(/\r?\n/).slice(-3).join(' | ');
  return `exit ${res.code}${res.signal ? ` signal ${res.signal}` : ''}: ${text || '(no output)'}`;
}

function listError(what: string, res: ExecResult): DevslimError {
  const hint = /unable to find utility "simctl"/.test(res.stderr)
    ? ' (simctl ships with full Xcode; select it with sudo xcode-select -s /Applications/Xcode.app)'
    : '';
  return new DevslimError(`xcrun simctl list ${what} failed (${describe(res)})${hint}`);
}

export function parseDevicesJson(json: string): SimDevice[] {
  let data: { devices?: Record<string, unknown> };
  try {
    data = JSON.parse(json);
  } catch {
    throw new DevslimError('simctl list devices -j: invalid JSON');
  }
  const out: SimDevice[] = [];
  for (const [runtimeId, list] of Object.entries(data.devices ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const d of list as Record<string, unknown>[]) {
      if (typeof d?.udid !== 'string') continue;
      out.push(
        Object.freeze({
          udid: d.udid,
          name: typeof d.name === 'string' ? d.name : d.udid,
          state: typeof d.state === 'string' ? d.state : 'Unknown',
          runtimeId,
          isAvailable: d.isAvailable === true,
        }),
      );
    }
  }
  return out;
}

export function parseRuntimesJson(json: string): SimRuntime[] {
  let data: { runtimes?: unknown };
  try {
    data = JSON.parse(json);
  } catch {
    throw new DevslimError('simctl list runtimes -j: invalid JSON');
  }
  if (!Array.isArray(data.runtimes)) return [];
  return (data.runtimes as Record<string, unknown>[])
    .filter((r) => typeof r?.identifier === 'string')
    .map((r) => {
      const parsed = parseRuntimeId(r.identifier as string);
      return Object.freeze({
        identifier: r.identifier as string,
        platform: typeof r.platform === 'string' ? r.platform : (parsed?.platform ?? '?'),
        version: typeof r.version === 'string' ? r.version : (parsed?.version ?? '?'),
        name: typeof r.name === 'string' ? r.name : (r.identifier as string),
        isAvailable: r.isAvailable === true,
      });
    });
}

// `com.apple.CoreSimulator.SimRuntime.iOS-26-4` -> { platform: 'iOS', version: '26.4' }.
export function parseRuntimeId(id: string): { platform: string; version: string } | null {
  const m = /^com\.apple\.CoreSimulator\.SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(id);
  return m ? { platform: m[1], version: m[2].replace(/-/g, '.') } : null;
}

// Exact UDID (case-insensitive), else exact name. Ambiguous name = error
// listing the UDIDs. simctl aliases (`booted`, `all`) are refused.
export function resolveDevice(devices: readonly SimDevice[], query: string): SimDevice {
  const q = query.trim();
  if (q === '') throw new DevslimError('missing simulator UDID or name');
  if (ALIASES.includes(q.toLowerCase())) {
    throw new DevslimError(`"${q}" is a simctl alias and is not accepted; pass a UDID or an exact name`);
  }
  if (UDID_RE.test(q)) {
    const byUdid = devices.find((d) => d.udid.toUpperCase() === q.toUpperCase());
    if (byUdid !== undefined) return byUdid;
  }
  const byName = devices.filter((d) => d.name === q);
  if (byName.length === 0) throw new DevslimError(`no simulator with UDID or name "${q}" (xcrun simctl list devices)`);
  if (byName.length > 1) {
    throw new DevslimError(`name "${q}" is ambiguous; use the UDID: ${byName.map((d) => `${d.udid} (${d.runtimeId.split('.').pop()}, ${d.state})`).join(', ')}`);
  }
  return byName[0];
}

// `launchctl print-disabled system`: lines `"label" => disabled|enabled`
// (recent launchd) or `=> true|false` (older). true = disabled.
export function parsePrintDisabled(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"([^"]+)"\s*=>\s*(disabled|enabled|true|false)\b/.exec(line);
    if (m) out.set(m[1], m[2] === 'disabled' || m[2] === 'true');
  }
  return out;
}

export function isLaunchdSettling(res: ExecResult): boolean {
  if (res.code === 0) return false;
  if (res.code === 124) return true;
  const text = `${res.stdout}\n${res.stderr}`;
  return /\b124\b/.test(text) || text.includes('Domain is tearing down');
}

export type SimctlOptions = {
  exec: Exec;
  sleep?: Sleep;
  now?: () => number;
  bootstatusTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollMs?: number;
};

export function createSimctl(opts: SimctlOptions) {
  const { exec } = opts;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const xcrun = (args: readonly string[], timeoutMs: number) => exec('xcrun', ['simctl', ...args], { timeoutMs });

  async function listDevices(): Promise<SimDevice[]> {
    const res = await xcrun(['list', 'devices', '-j'], LIST_TIMEOUT_MS);
    if (res.code !== 0) throw listError('devices', res);
    return parseDevicesJson(res.stdout);
  }

  async function listRuntimes(): Promise<SimRuntime[]> {
    const res = await xcrun(['list', 'runtimes', '-j'], LIST_TIMEOUT_MS);
    if (res.code !== 0) throw listError('runtimes', res);
    return parseRuntimesJson(res.stdout);
  }

  async function findDevice(query: string): Promise<SimDevice> {
    const dev = resolveDevice(await listDevices(), query);
    if (!dev.isAvailable) throw new DevslimError(`simulator ${dev.name} (${dev.udid}) is unavailable (missing runtime?)`);
    return dev;
  }

  // Tolerates an already booted device.
  async function boot(udid: string): Promise<void> {
    assertUdidArg(udid);
    const res = await xcrun(['boot', udid], 5 * 60_000);
    if (res.code === 0) return;
    const text = `${res.stdout}\n${res.stderr}`;
    if (/already booted|current state: Booted/i.test(text)) return;
    throw new DevslimError(`xcrun simctl boot ${udid} failed (${describe(res)})`);
  }

  async function bootstatus(udid: string, timeoutMs = opts.bootstatusTimeoutMs ?? DEFAULT_BOOTSTATUS_TIMEOUT_MS): Promise<void> {
    assertUdidArg(udid);
    const res = await xcrun(['bootstatus', udid, '-b'], timeoutMs);
    if (res.code !== 0) throw new DevslimError(`xcrun simctl bootstatus ${udid} -b failed (${describe(res)})`);
  }

  // Tolerates an already shut down device; waits for the state to become Shutdown in the listing.
  async function shutdown(udid: string): Promise<void> {
    assertUdidArg(udid);
    const res = await xcrun(['shutdown', udid], 2 * 60_000);
    if (res.code !== 0 && !/current state: Shutdown/i.test(`${res.stdout}\n${res.stderr}`)) {
      throw new DevslimError(`xcrun simctl shutdown ${udid} failed (${describe(res)})`);
    }
    const timeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? 500;
    const start = now();
    for (;;) {
      const dev = (await listDevices()).find((d) => d.udid === udid);
      if (dev === undefined || dev.state === 'Shutdown') return;
      if (now() - start >= timeoutMs) {
        throw new DevslimError(`${udid} did not shut down within ${Math.round(timeoutMs / 1000)} s (state ${dev.state})`);
      }
      await sleep(pollMs);
    }
  }

  function spawnLaunchctl(udid: string, args: readonly string[]): Promise<ExecResult> {
    return xcrun(['spawn', udid, 'launchctl', ...args], SPAWN_TIMEOUT_MS);
  }

  // Labels -> disabled? in the system domain. Retries with backoff 1, 2, 4, 8 s
  // while launchd_sim answers 124 / "Domain is tearing down".
  async function printDisabled(udid: string): Promise<Map<string, boolean>> {
    assertUdidArg(udid);
    for (let attempt = 0; ; attempt++) {
      const res = await spawnLaunchctl(udid, ['print-disabled', 'system']);
      if (res.code === 0) return parsePrintDisabled(res.stdout);
      if (!isLaunchdSettling(res) || attempt >= LAUNCHD_RETRY_DELAYS_MS.length) {
        throw new DevslimError(`launchctl print-disabled system on ${udid} failed (${describe(res)})`);
      }
      await sleep(LAUNCHD_RETRY_DELAYS_MS[attempt]);
    }
  }

  async function launchctlSet(udid: string, verb: 'disable' | 'enable', label: string): Promise<{ ok: boolean; detail: string }> {
    assertUdidArg(udid);
    if (!/^com\.apple\.[A-Za-z0-9._-]+$/.test(label)) throw new DevslimError(`invalid label: ${label}`);
    const res = await spawnLaunchctl(udid, [verb, `system/${label}`]);
    return { ok: res.code === 0, detail: res.code === 0 ? '' : describe(res) };
  }

  return Object.freeze({
    listDevices,
    listRuntimes,
    findDevice,
    boot,
    bootstatus,
    shutdown,
    printDisabled,
    launchctlDisable: (udid: string, label: string) => launchctlSet(udid, 'disable', label),
    launchctlEnable: (udid: string, label: string) => launchctlSet(udid, 'enable', label),
  });
}

export type Simctl = ReturnType<typeof createSimctl>;

function assertUdidArg(udid: string): void {
  if (!UDID_RE.test(udid)) throw new DevslimError(`invalid UDID: ${udid}`);
}
