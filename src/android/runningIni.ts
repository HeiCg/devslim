import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Anuncio do emulador rodando: cada instancia com servidor gRPC grava
// `avd/running/pid_<pid>.ini` (avd.name, port.serial, port.adb, grpc.port,
// grpc.token, cmdline). O argent (simulator-server) descobre o emulador por esse
// arquivo e exige grpc.port + grpc.token. So leitura aqui. O valor de
// grpc.token nunca sai deste modulo: so o booleano `hasGrpcToken`.

type Env = Readonly<Record<string, string | undefined>>;

export type RunningEntry = Readonly<{
  pid: number; // do nome do arquivo
  avdName: string;
  serialPort: number;
  adbPort: number | null;
  grpcPort: number | null;
  hasGrpcToken: boolean;
}>;

// macOS: ~/Library/Caches/TemporaryItems/avd/running. Linux:
// $XDG_RUNTIME_DIR/avd/running (sem a variavel = null). Outra plataforma = null
// (nao da para conferir). HOME do env vence o homedir() (testes).
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

// null = malformado (sem avd.name ou sem port.serial numerico).
export function parseRunningIni(text: string, pid: number): RunningEntry | null {
  const kv = new Map<string, string>();
  let hasGrpcToken = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    // O token nao entra no mapa: so se existe e nao e vazio.
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

// Todos os pid_*.ini do diretorio, por pid. Diretorio ausente (ou null) = [];
// arquivo ilegivel ou malformado e ignorado.
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

// Anunciado de forma que o argent enxerga: grpc.port e grpc.token presentes.
export function isAdvertised(e: RunningEntry | null | undefined): boolean {
  return e != null && e.grpcPort !== null && e.hasGrpcToken;
}

// Entrada do AVD (e da porta do console, quando dada). Varias: prefere a anunciada.
export function findRunningEntry(entries: readonly RunningEntry[], avd: string, serialPort?: number | null): RunningEntry | null {
  const hits = entries.filter((e) => e.avdName === avd && (serialPort == null || e.serialPort === serialPort));
  return hits.find(isAdvertised) ?? hits[0] ?? null;
}
