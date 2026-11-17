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
  // -grpc <port> -grpc-use-token: the emulator writes the running ini argent reads.
  // Old state without the field = true.
  grpc: boolean;
}>;

export type AndroidProfileOptions = {
  ramMb?: number;
  aggressive?: boolean;
  // -lowram without touching RAM. Absent = whatever --aggressive says.
  lowRam?: boolean;
  gpu?: string;
  vulkan?: boolean;
  screen?: string;
  port?: number;
  capabilities?: readonly string[];
  grpc?: boolean;
};

// "keep" or "WxH@dpi", e.g. 720x1600@320.
export function parseScreen(text: string): Screen {
  if (text === 'keep') return 'keep';
  const m = /^(\d{3,4})x(\d{3,4})@(\d{2,3})$/.exec(text);
  if (!m) throw new DevslimError(`invalid screen: ${text} (use keep or WxH@dpi, e.g. 720x1600@320)`);
  const [width, height, density] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (width < 240 || height < 240 || width > 4096 || height > 4096) {
    throw new DevslimError(`invalid screen: ${text} (width and height between 240 and 4096)`);
  }
  if (density < 120 || density > 640) {
    throw new DevslimError(`invalid screen: ${text} (dpi between 120 and 640)`);
  }
  return Object.freeze({ width, height, density });
}

export function formatScreen(screen: Screen): string {
  return screen === 'keep' ? 'keep' : `${screen.width}x${screen.height}@${screen.density}`;
}

// Immutable profile. RAM is always a parameter: default 2048, --aggressive 1536 + lowRam.
// An explicit lowRam wins over --aggressive. Without lowRam the emulator raises any
// -memory below its floor (measured: 2560 MB on phone, 4096 MB on tablet).
export function buildAndroidProfile(opts: AndroidProfileOptions = {}): AndroidProfile {
  const aggressive = opts.aggressive === true;
  const ramMb = opts.ramMb ?? (aggressive ? AGGRESSIVE_RAM_MB : DEFAULT_RAM_MB);
  if (!Number.isInteger(ramMb) || ramMb < RAM_MIN_MB || ramMb > RAM_MAX_MB) {
    throw new DevslimError(`invalid RAM: ${ramMb} (integer in MB between ${RAM_MIN_MB} and ${RAM_MAX_MB})`);
  }

  const gpu = opts.gpu ?? 'host';
  if (!(GPU_MODES as readonly string[]).includes(gpu)) {
    throw new DevslimError(`invalid GPU mode: ${gpu} (valid: ${GPU_MODES.join(', ')})`);
  }

  let port: number | null = null;
  if (opts.port !== undefined) {
    const p = opts.port;
    if (!Number.isInteger(p) || p < PORT_MIN || p > PORT_MAX || p % 2 !== 0) {
      throw new DevslimError(`invalid port: ${p} (even number between ${PORT_MIN} and ${PORT_MAX})`);
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
