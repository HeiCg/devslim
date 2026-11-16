import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DevslimError } from './errors.ts';

// Capacidades religam o que o app precisa em cima do perfil mais economico.
export const CAPABILITIES = Object.freeze(['audio', 'camera', 'location', 'push', 'store', 'weblogin', 'window'] as const);
export type Capability = (typeof CAPABILITIES)[number];

// Dependencia exata -> capacidade. `store` e `window` nunca sao derivados:
// so entram via --need.
const DERIVED_BY_NAME: Readonly<Record<string, Capability>> = Object.freeze({
  'expo-audio': 'audio',
  'expo-av': 'audio',
  'expo-camera': 'camera',
  'react-native-vision-camera': 'camera',
  'expo-location': 'location',
  'react-native-geolocation-service': 'location',
  '@react-native-community/geolocation': 'location',
  '@rnmapbox/maps': 'location',
  'react-native-maps': 'location',
  'expo-notifications': 'push',
  '@react-native-google-signin/google-signin': 'weblogin',
  'expo-web-browser': 'weblogin',
  'expo-auth-session': 'weblogin',
});

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

// Deduplica e ordena na ordem canonica de CAPABILITIES.
export function sortCapabilities(list: Iterable<Capability>): Capability[] {
  const set = new Set(list);
  return CAPABILITIES.filter((c) => set.has(c));
}

// Aceita "a,b" ou ["a", "b,c"]. Capacidade desconhecida = erro com a lista valida.
export function parseCapabilities(input: string | readonly string[]): Capability[] {
  const parts = (typeof input === 'string' ? [input] : input)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const out: Capability[] = [];
  for (const p of parts) {
    if (!isCapability(p)) {
      throw new DevslimError(`capacidade desconhecida: ${p} (validas: ${CAPABILITIES.join(', ')})`);
    }
    out.push(p);
  }
  return sortCapabilities(out);
}

function depNames(section: unknown): string[] {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) return [];
  return Object.keys(section);
}

export function deriveCapabilities(packageJson: unknown): Capability[] {
  if (packageJson === null || typeof packageJson !== 'object') return [];
  const pkg = packageJson as { dependencies?: unknown; devDependencies?: unknown };
  const names = [...depNames(pkg.dependencies), ...depNames(pkg.devDependencies)];
  const found: Capability[] = [];
  for (const name of names) {
    const direct = DERIVED_BY_NAME[name];
    if (direct) found.push(direct);
    if (name.includes('document-scanner')) found.push('camera');
  }
  return sortCapabilities(found);
}

export function readPackageJson(dir: string): unknown {
  const path = join(dir, 'package.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new DevslimError(`package.json nao encontrado em ${dir}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DevslimError(`package.json invalido (JSON) em ${dir}`);
  }
}

// Une --need com o que o package.json de --for exige.
export function resolveCapabilities(opts: { need?: string | readonly string[]; forDir?: string } = {}): Capability[] {
  const explicit = opts.need === undefined ? [] : parseCapabilities(opts.need);
  const derived = opts.forDir === undefined ? [] : deriveCapabilities(readPackageJson(opts.forDir));
  return sortCapabilities([...explicit, ...derived]);
}
