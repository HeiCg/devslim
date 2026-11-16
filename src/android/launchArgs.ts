import { DevslimError } from '../errors.ts';
import { hasCapability, PORT_MAX, PORT_MIN, type AndroidProfile } from './profile.ts';

// Nome do nosso snapshot. `default_boot` e do emulador/argent e e proibido.
export const SLIM_SNAPSHOT = 'slim_base';
export const FORBIDDEN_SNAPSHOT = 'default_boot';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Porta gRPC por instancia: 8554 para o console 5554, 8556 para 5556 etc.
// Sem -grpc explicito o emulador lancado com -port nao sobe o servidor gRPC nem
// grava avd/running/pid_<pid>.ini (medido; -grpc-use-token sozinho nao basta).
export const GRPC_BASE_PORT = 8554;
// Porta de console usada so para exibir a linha quando o perfil nao tem porta
// (plan); o up sempre resolve a porta antes de lancar.
export const GRPC_REFERENCE_PORT = PORT_MIN;

export function grpcPortFor(consolePort: number): number {
  if (!Number.isInteger(consolePort) || consolePort < PORT_MIN || consolePort > PORT_MAX || consolePort % 2 !== 0) {
    throw new DevslimError(`porta de console invalida para gRPC: ${consolePort} (numero par entre ${PORT_MIN} e ${PORT_MAX})`);
  }
  return GRPC_BASE_PORT + (consolePort - PORT_MIN);
}

// Argumentos para o binario `emulator`, em ordem deterministica.
// Nunca emite -netfast (no-op no emulador atual).
export function buildLaunchArgs(avdName: string, profile: AndroidProfile, opts: { snapshot?: string } = {}): string[] {
  if (!NAME_RE.test(avdName)) throw new DevslimError(`nome de AVD invalido: ${avdName}`);

  const args = [
    '-avd', avdName,
    '-gpu', profile.gpu,
    '-memory', String(profile.ramMb),
    '-cores', String(profile.cores),
  ];
  if (profile.port !== null) args.push('-port', String(profile.port));
  if (profile.grpc !== false) {
    args.push('-grpc', String(grpcPortFor(profile.port ?? GRPC_REFERENCE_PORT)), '-grpc-use-token');
  }
  if (!hasCapability(profile, 'window')) args.push('-no-window');
  if (!hasCapability(profile, 'audio')) args.push('-no-audio');
  if (!hasCapability(profile, 'camera')) args.push('-camera-back', 'none', '-camera-front', 'none');
  if (!profile.vulkan) args.push('-feature', '-Vulkan');
  if (profile.lowRam) args.push('-lowram');
  args.push('-no-boot-anim', '-no-metrics');

  if (opts.snapshot !== undefined) {
    const snap = opts.snapshot;
    if (snap === FORBIDDEN_SNAPSHOT) {
      throw new DevslimError(`snapshot ${FORBIDDEN_SNAPSHOT} e reservado ao emulador; use ${SLIM_SNAPSHOT}`);
    }
    if (!NAME_RE.test(snap)) throw new DevslimError(`nome de snapshot invalido: ${snap}`);
    args.push('-snapshot', snap, '-no-snapshot-save');
  } else {
    args.push('-no-snapshot');
  }
  return args;
}
