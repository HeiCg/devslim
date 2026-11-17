import { DevslimError } from '../errors.ts';
import { hasCapability, PORT_MAX, PORT_MIN, type AndroidProfile } from './profile.ts';

// Name of our snapshot. `default_boot` belongs to the emulator/argent and is forbidden.
export const SLIM_SNAPSHOT = 'slim_base';
export const FORBIDDEN_SNAPSHOT = 'default_boot';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Per-instance gRPC port: 8554 for console 5554, 8556 for 5556 etc.
// Without an explicit -grpc the emulator launched with -port neither starts the gRPC server nor
// writes avd/running/pid_<pid>.ini (measured; -grpc-use-token alone is not enough).
export const GRPC_BASE_PORT = 8554;
// Console port used only to display the command line when the profile has no port
// (plan); up always resolves the port before launching.
export const GRPC_REFERENCE_PORT = PORT_MIN;

export function grpcPortFor(consolePort: number): number {
  if (!Number.isInteger(consolePort) || consolePort < PORT_MIN || consolePort > PORT_MAX || consolePort % 2 !== 0) {
    throw new DevslimError(`invalid console port for gRPC: ${consolePort} (even number between ${PORT_MIN} and ${PORT_MAX})`);
  }
  return GRPC_BASE_PORT + (consolePort - PORT_MIN);
}

// Arguments for the `emulator` binary, in deterministic order.
// Never emits -netfast (a no-op in the current emulator).
export function buildLaunchArgs(avdName: string, profile: AndroidProfile, opts: { snapshot?: string } = {}): string[] {
  if (!NAME_RE.test(avdName)) throw new DevslimError(`invalid AVD name: ${avdName}`);

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
      throw new DevslimError(`snapshot ${FORBIDDEN_SNAPSHOT} is reserved for the emulator; use ${SLIM_SNAPSHOT}`);
    }
    if (!NAME_RE.test(snap)) throw new DevslimError(`invalid snapshot name: ${snap}`);
    args.push('-snapshot', snap, '-no-snapshot-save');
  } else {
    args.push('-no-snapshot');
  }
  return args;
}
