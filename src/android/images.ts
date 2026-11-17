import { join } from 'node:path';
import { DevslimError } from '../errors.ts';

// System images for `create`. Shortcut = tag; becomes
// system-images;android-<api>;<tag>;<abi> with the host ABI.
// Measured trade-off (2026-11-17, API 35, 2 min idle, one measurement each):
// aosp_atd 3660 MB of phys_footprint vs 4343 MB for google_apis. ATD drops
// Google services (aosp_atd) or reduces them (google_atd): aosp_atd has no Google
// sign-in, FCM push or Play Billing purchases.
export const IMAGE_SHORTCUTS = Object.freeze(['google_apis', 'google_atd', 'aosp_atd', 'default'] as const);
export type ImageShortcut = (typeof IMAGE_SHORTCUTS)[number];
export const DEFAULT_API = 35;
export const DEFAULT_SHORTCUT: ImageShortcut = 'google_apis';

const ID_PREFIX = 'system-images;';

// arm64 (Apple Silicon) = arm64-v8a; any other host = x86_64.
export function hostAbi(arch: string = process.arch): 'arm64-v8a' | 'x86_64' {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export function isShortcut(value: string): value is ImageShortcut {
  return (IMAGE_SHORTCUTS as readonly string[]).includes(value);
}

// A full id passes through as given (and conflicts with api); a shortcut expands;
// absent = google_apis.
export function resolveImage(image: string | undefined, o: { api?: number; arch?: string } = {}): string {
  const value = image ?? DEFAULT_SHORTCUT;
  if (value.startsWith(ID_PREFIX)) {
    if (o.api !== undefined) throw new DevslimError(`--api only applies to an image shortcut (${IMAGE_SHORTCUTS.join(', ')}); the full id already includes the API: ${value}`);
    return value;
  }
  if (!isShortcut(value)) {
    throw new DevslimError(`unknown image: ${value} (shortcuts: ${IMAGE_SHORTCUTS.join(', ')}; or the full id system-images;android-N;tag;abi)`);
  }
  const api = o.api ?? DEFAULT_API;
  if (!Number.isInteger(api) || api < 1) throw new DevslimError(`invalid API: ${api} (positive integer, e.g. 35)`);
  return `${ID_PREFIX}android-${api};${value};${hostAbi(o.arch)}`;
}

// Image directory inside the SDK: <sdk>/system-images/android-35/aosp_atd/arm64-v8a.
export function imageDir(sdkRoot: string, id: string): string {
  return join(sdkRoot, ...id.split(';'));
}

// Image tag of an AVD: tag.id from config.ini; without it, the segment after
// android-N in image.sysdir.1 (relative or absolute). null = could not tell.
export function imageTag(cfg: { tagId?: string; sysdir?: string }): string | null {
  const tag = cfg.tagId?.trim();
  if (tag) return tag;
  const parts = (cfg.sysdir ?? '').trim().replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const i = parts.findIndex((s) => /^android-\w+$/.test(s));
  return i === -1 || i + 1 >= parts.length ? null : parts[i + 1];
}

// google_apis and Play Store variants: full Google services.
export function isGoogleApisTag(tag: string): boolean {
  return tag === 'google_apis' || tag.startsWith('google_apis_') || tag.includes('playstore');
}

// Lean images: ATD (aosp_atd without Google services, google_atd with reduced
// services) and default (plain AOSP).
export function isAtdTag(tag: string): boolean {
  return tag === 'aosp_atd' || tag === 'google_atd' || tag === 'default';
}
