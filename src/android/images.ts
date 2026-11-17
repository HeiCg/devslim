import { join } from 'node:path';
import { DevslimError } from '../errors.ts';

// System images do `create`. Atalho = tag; vira
// system-images;android-<api>;<tag>;<abi> com a ABI do host.
// Trade-off medido (2026-11-17, API 35, 2 min parado, uma medicao cada):
// aosp_atd 3660 MB de phys_footprint contra 4343 MB do google_apis. ATD tira os
// servicos Google (aosp_atd) ou os reduz (google_atd): no aosp_atd nao ha login
// Google, push FCM nem compra Play Billing.
export const IMAGE_SHORTCUTS = Object.freeze(['google_apis', 'google_atd', 'aosp_atd', 'default'] as const);
export type ImageShortcut = (typeof IMAGE_SHORTCUTS)[number];
export const DEFAULT_API = 35;
export const DEFAULT_SHORTCUT: ImageShortcut = 'google_apis';

const ID_PREFIX = 'system-images;';

// arm64 (Apple Silicon) = arm64-v8a; qualquer outro host = x86_64.
export function hostAbi(arch: string = process.arch): 'arm64-v8a' | 'x86_64' {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export function isShortcut(value: string): value is ImageShortcut {
  return (IMAGE_SHORTCUTS as readonly string[]).includes(value);
}

// Id completo passa como veio (e nao combina com api); atalho expande;
// ausente = google_apis.
export function resolveImage(image: string | undefined, o: { api?: number; arch?: string } = {}): string {
  const value = image ?? DEFAULT_SHORTCUT;
  if (value.startsWith(ID_PREFIX)) {
    if (o.api !== undefined) throw new DevslimError(`--api so vale com atalho de imagem (${IMAGE_SHORTCUTS.join(', ')}); o id completo ja traz a API: ${value}`);
    return value;
  }
  if (!isShortcut(value)) {
    throw new DevslimError(`imagem desconhecida: ${value} (atalhos: ${IMAGE_SHORTCUTS.join(', ')}; ou o id completo system-images;android-N;tag;abi)`);
  }
  const api = o.api ?? DEFAULT_API;
  if (!Number.isInteger(api) || api < 1) throw new DevslimError(`API invalida: ${api} (inteiro positivo, ex. 35)`);
  return `${ID_PREFIX}android-${api};${value};${hostAbi(o.arch)}`;
}

// Diretorio da imagem dentro do SDK: <sdk>/system-images/android-35/aosp_atd/arm64-v8a.
export function imageDir(sdkRoot: string, id: string): string {
  return join(sdkRoot, ...id.split(';'));
}

// Tag da imagem de um AVD: tag.id do config.ini; sem ele, o segmento depois de
// android-N no image.sysdir.1 (relativo ou absoluto). null = nao deu para saber.
export function imageTag(cfg: { tagId?: string; sysdir?: string }): string | null {
  const tag = cfg.tagId?.trim();
  if (tag) return tag;
  const parts = (cfg.sysdir ?? '').trim().replace(/\\/g, '/').split('/').filter((s) => s !== '');
  const i = parts.findIndex((s) => /^android-\w+$/.test(s));
  return i === -1 || i + 1 >= parts.length ? null : parts[i + 1];
}

// google_apis e variantes com Play Store: servicos Google completos.
export function isGoogleApisTag(tag: string): boolean {
  return tag === 'google_apis' || tag.startsWith('google_apis_') || tag.includes('playstore');
}

// Imagens enxutas: ATD (aosp_atd sem servicos Google, google_atd com servicos
// reduzidos) e default (AOSP puro).
export function isAtdTag(tag: string): boolean {
  return tag === 'aosp_atd' || tag === 'google_atd' || tag === 'default';
}
