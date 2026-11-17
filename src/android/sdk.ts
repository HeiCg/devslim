import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DevslimError } from '../errors.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type SdkTool = 'emulator' | 'adb' | 'avdmanager';

const TOOL_PATH: Readonly<Record<SdkTool, readonly string[]>> = Object.freeze({
  emulator: Object.freeze(['emulator', 'emulator']),
  adb: Object.freeze(['platform-tools', 'adb']),
  avdmanager: Object.freeze(['cmdline-tools', 'latest', 'bin', 'avdmanager']),
});

export type SdkOptions = {
  env?: Env;
  fileExists?: (path: string) => boolean;
};

export function defaultFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function defaultDirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Raizes candidatas, nesta ordem: ANDROID_HOME, ANDROID_SDK_ROOT, ~/Library/Android/sdk.
export function sdkCandidates(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const v of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (v !== undefined && v !== '' && !out.includes(v)) out.push(v);
  }
  const fallback = join(env.HOME || homedir(), 'Library', 'Android', 'sdk');
  if (!out.includes(fallback)) out.push(fallback);
  return out;
}

// Caminho do binario dentro de uma raiz de SDK (exista ou nao).
export function sdkToolPath(root: string, tool: SdkTool): string {
  return join(root, ...TOOL_PATH[tool]);
}

// Raiz do SDK a partir do caminho de um binario achado por findSdkTool.
export function sdkRootOfTool(toolPath: string, tool: SdkTool): string {
  return join(toolPath, ...TOOL_PATH[tool].map(() => '..'));
}

// Primeira raiz candidata que existe como diretorio, ou null. So leitura.
export function findSdkRoot(env: Env = process.env): string | null {
  for (const root of sdkCandidates(env)) {
    try {
      if (statSync(root).isDirectory()) return root;
    } catch {
      // proximo candidato
    }
  }
  return null;
}

// Primeiro candidato em que o binario existe. Ausente = erro dizendo onde procurou.
export function findSdkTool(tool: SdkTool, opts: SdkOptions = {}): string {
  const exists = opts.fileExists ?? defaultFileExists;
  const tried = sdkCandidates(opts.env ?? process.env).map((root) => join(root, ...TOOL_PATH[tool]));
  const found = tried.find((p) => exists(p));
  if (found === undefined) {
    throw new DevslimError(`${tool} nao encontrado; procurado em: ${tried.join(', ')} (defina ANDROID_HOME)`);
  }
  return found;
}
