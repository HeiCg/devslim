import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Running emulator advertisement: each instance with a gRPC server writes
// `avd/running/pid_<pid>.ini` (avd.name, port.serial, port.adb, grpc.port,
// grpc.token, cmdline). argent (simulator-server) discovers the emulator through this
// file and requires grpc.port + grpc.token. Read-only here. The grpc.token value
// never leaves this module: only the `hasGrpcToken` boolean.

type Env = Readonly<Record<string, string | undefined>>;

export type RunningEntry = Readonly<{
  pid: number; // from the file name
  avdName: string;
  serialPort: number;
  adbPort: number | null;
  grpcPort: number | null;
  hasGrpcToken: boolean;
}>;

// macOS: ~/Library/Caches/TemporaryItems/avd/running. Linux:
// $XDG_RUNTIME_DIR/avd/running (no variable = null). Other platform = null
// (cannot check). HOME from env wins over homedir() (tests).
export function runningDir(o: { env?: Env; platform?: string } = {}): string | null {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  if (platform === 'darwin') {
    const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
    return join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
  }
  if (platform === 'linux') {
    const xdg = env.XDG_RUNTIME_DIR;
    return xdg !== undefined && xdg !== '' ? join(xdg, 'avd', 'running') : null;
  }
  return null;
}

const FILE_RE = /^pid_(\d+)\.ini$/;
const LINE_RE = /^\s*([^\s=#;][^=]*?)\s*=\s*(.*?)\s*$/;

function portOf(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : null;
}

// null = malformed (no avd.name or no numeric port.serial).
export function parseRunningIni(text: string, pid: number): RunningEntry | null {
  const kv = new Map<string, string>();
  let hasGrpcToken = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    // The token does not go into the map: only whether it exists and is non-empty.
    if (m[1] === 'grpc.token') hasGrpcToken = m[2] !== '';
    else if (m[1] === 'avd.name' || m[1] === 'port.serial' || m[1] === 'port.adb' || m[1] === 'grpc.port') kv.set(m[1], m[2]);
  }
  const avdName = kv.get('avd.name');
  const serialPort = portOf(kv.get('port.serial'));
  if (avdName === undefined || avdName === '' || serialPort === null) return null;
  return Object.freeze({
    pid,
    avdName,
    serialPort,
    adbPort: portOf(kv.get('port.adb')),
    grpcPort: portOf(kv.get('grpc.port')),
    hasGrpcToken,
  });
}

// All pid_*.ini files in the directory, by pid. Missing directory (or null) = [];
// unreadable or malformed files are ignored.
export function readRunningEntries(dir: string | null): RunningEntry[] {
  if (dir === null) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RunningEntry[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const e = parseRunningIni(text, Number(m[1]));
    if (e !== null) out.push(e);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// Does the pid from the file name still exist? A pid_<pid>.ini left over from a
// dead emulator (crash, kill -9) does not count as an advertisement. Default:
// process.kill(pid, 0); EPERM = exists (another user's process).
export type PidAlive = (pid: number) => boolean;

export const nodePidAlive: PidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false; // 0 and negatives would signal a group
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM';
  }
};

export type RunningScan = Readonly<{
  live: readonly RunningEntry[]; // live pid: only these count as advertisement
  stale: readonly RunningEntry[]; // dead pid: ignored (the file is not deleted)
}>;

// readRunningEntries split by live/dead pid. Read-only: the files
// belong to the emulator/SDK and are never deleted here.
export function scanRunning(dir: string | null, alive: PidAlive = nodePidAlive): RunningScan {
  const live: RunningEntry[] = [];
  const stale: RunningEntry[] = [];
  for (const e of readRunningEntries(dir)) (alive(e.pid) ? live : stale).push(e);
  return Object.freeze({ live: Object.freeze(live), stale: Object.freeze(stale) });
}

// Advertised in a way argent can see: grpc.port and grpc.token present.
export function isAdvertised(e: RunningEntry | null | undefined): boolean {
  return e != null && e.grpcPort !== null && e.hasGrpcToken;
}

// AVD entry (and console port, when given). Several: prefers the advertised one.
// Takes the live entries (scanRunning(...).live) so it never matches a dead pid.
export function findRunningEntry(entries: readonly RunningEntry[], avd: string, serialPort?: number | null): RunningEntry | null {
  const hits = entries.filter((e) => e.avdName === avd && (serialPort == null || e.serialPort === serialPort));
  return hits.find(isAdvertised) ?? hits[0] ?? null;
}
