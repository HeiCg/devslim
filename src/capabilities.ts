import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DevslimError } from './errors.ts';

// Capabilities re-enable what the app needs on top of the leanest profile.
// keyboard: Android only (keeps Gboard in bake --aggressive); changes nothing on iOS.
export const CAPABILITIES = Object.freeze(['audio', 'camera', 'keyboard', 'location', 'push', 'store', 'weblogin', 'window'] as const);
export type Capability = (typeof CAPABILITIES)[number];

// Exact dependency -> capability. `store`, `window` and `keyboard` are never
// derived: they only come in via --need.
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

// Deduplicates and sorts in the canonical CAPABILITIES order.
export function sortCapabilities(list: Iterable<Capability>): Capability[] {
  const set = new Set(list);
  return CAPABILITIES.filter((c) => set.has(c));
}

// Accepts "a,b" or ["a", "b,c"]. Unknown capability = error listing the valid ones.
export function parseCapabilities(input: string | readonly string[]): Capability[] {
  const parts = (typeof input === 'string' ? [input] : input)
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const out: Capability[] = [];
  for (const p of parts) {
    if (!isCapability(p)) {
      throw new DevslimError(`unknown capability: ${p} (valid: ${CAPABILITIES.join(', ')})`);
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
    throw new DevslimError(`package.json not found in ${dir}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DevslimError(`invalid package.json (JSON) in ${dir}`);
  }
}

// Merges --need with what the --for package.json requires.
export function resolveCapabilities(opts: { need?: string | readonly string[]; forDir?: string } = {}): Capability[] {
  const explicit = opts.need === undefined ? [] : parseCapabilities(opts.need);
  const derived = opts.forDir === undefined ? [] : deriveCapabilities(readPackageJson(opts.forDir));
  return sortCapabilities([...explicit, ...derived]);
}
