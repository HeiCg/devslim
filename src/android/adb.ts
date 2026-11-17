import { DevslimError } from '../errors.ts';
import type { Exec, ExecResult } from '../exec.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export type AdbDevice = Readonly<{ serial: string; state: string }>;
export type SettingsNamespace = 'global' | 'secure' | 'system';
export type PackageFailure = Readonly<{ pkg: string; error: string }>;
export type PackageBatch = Readonly<{ done: readonly string[]; failed: readonly PackageFailure[] }>;

export const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
export const DEFAULT_EXIT_TIMEOUT_MS = 60_000;
const DEFAULT_CMD_TIMEOUT_MS = 30_000;

const SERIAL_RE = /^[A-Za-z0-9._:-]+$/;
const PKG_RE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;
const KEY_RE = /^[A-Za-z0-9_.]+$/;
// `adb shell` joins the arguments into one shell line in the guest: we only accept
// values without spaces or metacharacters.
const VALUE_RE = /^[A-Za-z0-9_.,=:+-]+$/;
const SNAPSHOT_RE = /^[A-Za-z0-9._-]+$/;

// A value that can be written back with `settings put` via `adb shell`.
export function isSafeSettingValue(value: string): boolean {
  return VALUE_RE.test(value);
}

// `adb devices`: ignores the header and the "* daemon ..." lines.
export function parseAdbDevices(text: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('*') || line.startsWith('List of devices')) continue;
    const m = /^(\S+)\s+(\S+)/.exec(line);
    if (m) out.push(Object.freeze({ serial: m[1], state: m[2] }));
  }
  return out;
}

export function serialForPort(port: number): string {
  return `emulator-${port}`;
}

export function portForSerial(serial: string): number | null {
  const m = /^emulator-(\d+)$/.exec(serial);
  return m ? Number(m[1]) : null;
}

function tail(text: string): string {
  const t = text.trim().split(/\r?\n/).filter((l) => l.trim() !== '');
  return t.slice(-2).join(' | ') || '(no output)';
}

function describe(res: ExecResult): string {
  const why = res.code === null ? `signal ${res.signal ?? '?'} (timeout?)` : `exit ${res.code}`;
  return `${why}: ${tail(res.stderr + '\n' + res.stdout)}`;
}

// `pm` sometimes exits 0 and writes the exception to its output.
function pmFailed(res: ExecResult): boolean {
  return res.code !== 0 || /Exception|Error:|Failure/.test(res.stdout + res.stderr);
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new DevslimError(msg);
}

export type AdbOptions = {
  adbPath: string;
  exec: Exec;
  env?: Env;
  sleep?: Sleep;
  now?: () => number;
};

export type Adb = ReturnType<typeof createAdb>;

// Wrapper over exec. Every device command carries `-s <serial>`.
export function createAdb(opts: AdbOptions) {
  const { adbPath, exec, env } = opts;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;

  const run = (args: readonly string[], timeoutMs = DEFAULT_CMD_TIMEOUT_MS) => exec(adbPath, args, { env, timeoutMs });
  const onDevice = (serial: string, args: readonly string[], timeoutMs?: number) => {
    check(SERIAL_RE.test(serial), `invalid serial: ${serial}`);
    return run(['-s', serial, ...args], timeoutMs);
  };
  const shell = (serial: string, args: readonly string[], timeoutMs?: number) => onDevice(serial, ['shell', ...args], timeoutMs);

  async function listDevices(): Promise<AdbDevice[]> {
    const res = await run(['devices']);
    if (res.code !== 0) throw new DevslimError(`adb devices failed (${describe(res)})`);
    return parseAdbDevices(res.stdout);
  }

  // AVD name behind an emulator serial (`adb emu avd name`).
  async function avdName(serial: string): Promise<string | null> {
    const res = await onDevice(serial, ['emu', 'avd', 'name']);
    if (res.code !== 0) return null;
    const first = res.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '' && l !== 'OK');
    return first ?? null;
  }

  async function waitForBoot(serial: string, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<{ waitedMs: number }> {
    const timeoutMs = o.timeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
    const pollMs = o.pollMs ?? 2000;
    const start = now();
    let last = 'missing from adb devices';
    for (;;) {
      const dev = (await listDevices()).find((d) => d.serial === serial);
      if (dev === undefined) last = 'missing from adb devices';
      else if (dev.state !== 'device') last = `state ${dev.state}`;
      else {
        const res = await shell(serial, ['getprop', 'sys.boot_completed']);
        const val = res.stdout.trim();
        if (res.code === 0 && val === '1') return { waitedMs: now() - start };
        last = `sys.boot_completed=${val === '' ? '(empty)' : val}`;
      }
      if (now() - start >= timeoutMs) {
        throw new DevslimError(`${serial} did not finish booting within ${Math.round(timeoutMs / 1000)} s (last state: ${last})`);
      }
      await sleep(pollMs);
    }
  }

  // Waits for the serial to leave `adb devices` (emulator exited).
  async function waitForGone(serial: string, o: { timeoutMs?: number; pollMs?: number } = {}): Promise<{ waitedMs: number }> {
    const timeoutMs = o.timeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
    const pollMs = o.pollMs ?? 1000;
    const start = now();
    for (;;) {
      if (!(await listDevices()).some((d) => d.serial === serial)) return { waitedMs: now() - start };
      if (now() - start >= timeoutMs) {
        throw new DevslimError(`${serial} still in adb devices after ${Math.round(timeoutMs / 1000)} s`);
      }
      await sleep(pollMs);
    }
  }

  async function pmList(serial: string, extra: readonly string[]): Promise<string[]> {
    const res = await shell(serial, ['pm', 'list', 'packages', ...extra], 60_000);
    if (pmFailed(res)) throw new DevslimError(`${['pm list packages', ...extra].join(' ')} failed on ${serial} (${describe(res)})`);
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('package:'))
      .map((l) => l.slice('package:'.length));
  }

  async function pmOne(serial: string, pkg: string, args: readonly string[]): Promise<void> {
    check(PKG_RE.test(pkg), `invalid package name: ${pkg}`);
    const res = await shell(serial, ['pm', ...args, pkg]);
    if (pmFailed(res)) throw new DevslimError(`pm ${args.join(' ')} ${pkg} failed (${describe(res)})`);
  }

  async function batch(pkgs: readonly string[], one: (pkg: string) => Promise<void>): Promise<PackageBatch> {
    const done: string[] = [];
    const failed: PackageFailure[] = [];
    for (const pkg of pkgs) {
      try {
        await one(pkg);
        done.push(pkg);
      } catch (err) {
        failed.push(Object.freeze({ pkg, error: (err as Error).message }));
      }
    }
    return Object.freeze({ done: Object.freeze(done), failed: Object.freeze(failed) });
  }

  const disablePackage = (serial: string, pkg: string) => pmOne(serial, pkg, ['disable-user', '--user', '0']);
  const enablePackage = (serial: string, pkg: string) => pmOne(serial, pkg, ['enable']);

  function checkSetting(ns: SettingsNamespace, key: string): void {
    check(ns === 'global' || ns === 'secure' || ns === 'system', `invalid setting namespace: ${ns}`);
    check(KEY_RE.test(key), `invalid setting key: ${key}`);
  }

  // `null` = absent setting (`settings get` prints the string "null").
  async function getSetting(serial: string, ns: SettingsNamespace, key: string): Promise<string | null> {
    checkSetting(ns, key);
    const res = await shell(serial, ['settings', 'get', ns, key]);
    if (res.code !== 0) throw new DevslimError(`settings get ${ns} ${key} failed (${describe(res)})`);
    const val = res.stdout.replace(/\r?\n$/, '').trim();
    return val === 'null' ? null : val;
  }

  async function putSetting(serial: string, ns: SettingsNamespace, key: string, value: string): Promise<void> {
    checkSetting(ns, key);
    check(VALUE_RE.test(value), `invalid setting value for ${key}: ${JSON.stringify(value)}`);
    const res = await shell(serial, ['settings', 'put', ns, key, value]);
    if (res.code !== 0) throw new DevslimError(`settings put ${ns} ${key} failed (${describe(res)})`);
  }

  async function deleteSetting(serial: string, ns: SettingsNamespace, key: string): Promise<void> {
    checkSetting(ns, key);
    const res = await shell(serial, ['settings', 'delete', ns, key]);
    if (res.code !== 0) throw new DevslimError(`settings delete ${ns} ${key} failed (${describe(res)})`);
  }

  async function emuKill(serial: string): Promise<void> {
    const res = await onDevice(serial, ['emu', 'kill']);
    if (res.code !== 0 || /\bKO\b/.test(res.stdout)) throw new DevslimError(`adb emu kill on ${serial} failed (${describe(res)})`);
  }

  async function snapshotSave(serial: string, name: string): Promise<void> {
    check(SNAPSHOT_RE.test(name), `invalid snapshot name: ${name}`);
    const res = await onDevice(serial, ['emu', 'avd', 'snapshot', 'save', name], 300_000);
    if (res.code !== 0 || /\bKO\b/.test(res.stdout)) {
      throw new DevslimError(`snapshot save ${name} on ${serial} failed (${describe(res)})`);
    }
  }

  return Object.freeze({
    path: adbPath,
    run,
    shell,
    listDevices,
    avdName,
    waitForBoot,
    waitForGone,
    listPackages: (serial: string) => pmList(serial, []),
    listDisabledPackages: (serial: string) => pmList(serial, ['-d']),
    disablePackage,
    enablePackage,
    disablePackages: (serial: string, pkgs: readonly string[]) => batch(pkgs, (p) => disablePackage(serial, p)),
    enablePackages: (serial: string, pkgs: readonly string[]) => batch(pkgs, (p) => enablePackage(serial, p)),
    getSetting,
    putSetting,
    deleteSetting,
    emuKill,
    snapshotSave,
  });
}
