import { parseCapabilities, type Capability } from '../capabilities.ts';
import { DevslimError } from '../errors.ts';

export const RAM_MIN_MB = 1536;
export const RAM_MAX_MB = 8192;
export const DEFAULT_RAM_MB = 2048;
export const AGGRESSIVE_RAM_MB = 1536;
export const HEAP_MB = 256;
export const CORES = 2;
export const PORT_MIN = 5554;
export const PORT_MAX = 5682;
export const GPU_MODES = Object.freeze(['host', 'auto', 'swiftshader_indirect', 'angle_indirect', 'guest'] as const);

export type ScreenSpec = Readonly<{ width: number; height: number; density: number }>;
export type Screen = 'keep' | ScreenSpec;

export type AndroidProfile = Readonly<{
  ramMb: number;
  heapMb: number;
  cores: number;
  gpu: string;
  vulkan: boolean;
  lowRam: boolean;
  screen: Screen;
  port: number | null;
  capabilities: readonly Capability[];
  // -grpc <porta> -grpc-use-token: o emulador grava o running ini que o argent le.
  // State antigo sem o campo = true.
  grpc: boolean;
}>;

export type AndroidProfileOptions = {
  ramMb?: number;
  aggressive?: boolean;
  // -lowram sem mexer na RAM. Ausente = o que --aggressive diz.
  lowRam?: boolean;
  gpu?: string;
  vulkan?: boolean;
  screen?: string;
  port?: number;
  capabilities?: readonly string[];
  grpc?: boolean;
};

// "keep" ou "LxA@dpi", ex. 720x1600@320.
export function parseScreen(text: string): Screen {
  if (text === 'keep') return 'keep';
  const m = /^(\d{3,4})x(\d{3,4})@(\d{2,3})$/.exec(text);
  if (!m) throw new DevslimError(`tela invalida: ${text} (use keep ou LxA@dpi, ex. 720x1600@320)`);
  const [width, height, density] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (width < 240 || height < 240 || width > 4096 || height > 4096) {
    throw new DevslimError(`tela invalida: ${text} (largura e altura entre 240 e 4096)`);
  }
  if (density < 120 || density > 640) {
    throw new DevslimError(`tela invalida: ${text} (dpi entre 120 e 640)`);
  }
  return Object.freeze({ width, height, density });
}

export function formatScreen(screen: Screen): string {
  return screen === 'keep' ? 'keep' : `${screen.width}x${screen.height}@${screen.density}`;
}

// Perfil imutavel. RAM e sempre parametro: padrao 2048, --aggressive 1536 + lowRam.
// lowRam explicito vence o --aggressive. Sem lowRam o emulador eleva qualquer
// -memory abaixo do piso dele (medido: 2560 MB em phone, 4096 MB em tablet).
export function buildAndroidProfile(opts: AndroidProfileOptions = {}): AndroidProfile {
  const aggressive = opts.aggressive === true;
  const ramMb = opts.ramMb ?? (aggressive ? AGGRESSIVE_RAM_MB : DEFAULT_RAM_MB);
  if (!Number.isInteger(ramMb) || ramMb < RAM_MIN_MB || ramMb > RAM_MAX_MB) {
    throw new DevslimError(`RAM invalida: ${ramMb} (inteiro em MB entre ${RAM_MIN_MB} e ${RAM_MAX_MB})`);
  }

  const gpu = opts.gpu ?? 'host';
  if (!(GPU_MODES as readonly string[]).includes(gpu)) {
    throw new DevslimError(`modo de GPU invalido: ${gpu} (validos: ${GPU_MODES.join(', ')})`);
  }

  let port: number | null = null;
  if (opts.port !== undefined) {
    const p = opts.port;
    if (!Number.isInteger(p) || p < PORT_MIN || p > PORT_MAX || p % 2 !== 0) {
      throw new DevslimError(`porta invalida: ${p} (numero par entre ${PORT_MIN} e ${PORT_MAX})`);
    }
    port = p;
  }

  return Object.freeze({
    ramMb,
    heapMb: HEAP_MB,
    cores: CORES,
    gpu,
    vulkan: opts.vulkan === true,
    lowRam: opts.lowRam ?? aggressive,
    screen: parseScreen(opts.screen ?? 'keep'),
    port,
    capabilities: Object.freeze(parseCapabilities(opts.capabilities ?? [])),
    grpc: opts.grpc !== false,
  });
}

export function hasCapability(profile: AndroidProfile, cap: Capability): boolean {
  return profile.capabilities.includes(cap);
}
