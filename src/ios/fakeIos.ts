import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, ExecOptions, ExecResult, FakeCall, FakeSpawnCall, SignalPid, SpawnDetached } from '../exec.ts';
import { parseStorePlist } from './disabledStore.ts';

// Fake iOS world for tests: in-memory simulators, a launchd_sim that reads the
// disabled.plist (base directory in tmpdir) on boot, fake clock and sleep.
// No real process is created. Answers xcrun simctl (list, boot,
// bootstatus, shutdown, spawn launchctl), plutil, open, sysctl, adb devices,
// pgrep, ps and top.

export const FAKE_RUNTIME_ID = 'com.apple.CoreSimulator.SimRuntime.iOS-26-4';
export const FAKE_SDK = '/fake-sdk';

export type FakeSimInit = {
  udid: string;
  name: string;
  state?: 'Booted' | 'Shutdown' | 'Shutting Down';
  runtimeId?: string;
  isAvailable?: boolean;
  live?: Readonly<Record<string, boolean>>; // launchd table if already booted
  launchctlList?: string; // `launchctl list` output (default: Apple apps only)
};

export const FAKE_APPLE_LAUNCHCTL_LIST =
  'PID\tStatus\tLabel\n512\t0\tcom.apple.SpringBoard\n801\t0\tUIKitApplication:com.apple.Preferences[77b2][rb-legacy]\n';

export type FakeSim = {
  udid: string;
  name: string;
  state: string;
  runtimeId: string;
  isAvailable: boolean;
  live: Map<string, boolean>; // live launchd (applies when Booted)
  overrides: Map<string, boolean>; // written by launchctl disable/enable; survives reboot
  boots: number;
  launchctlList: string;
};

export type FakeIosOptions = {
  storeBase: string;
  simulators?: readonly FakeSimInit[];
  runtimes?: readonly { identifier: string; platform: string; version: string; name?: string }[];
  storeHonored?: boolean; // launchd_sim reads disabled.plist on boot (default true)
  stubborn?: readonly string[]; // never stay disabled (neither store nor launchctl)
  launchctlFailures?: Readonly<Record<string, number>>; // label -> how many times launchctl fails before it sticks
  printFormat?: 'disabled' | 'bool';
  printSettling?: number; // how many initial print-disabled calls fail with 124
  plutilXml?: string | null; // plutil output (null = failure)
  emulators?: readonly string[]; // serials in `adb devices`
  swap?: string;
  measure?: { pgrep?: string | null; ps?: string | null; top?: string | null };
  openFails?: boolean;
};

export function createFakeIos(opts: FakeIosOptions) {
  const runtimes = opts.runtimes ?? [{ identifier: FAKE_RUNTIME_ID, platform: 'iOS', version: '26.4', name: 'iOS 26.4' }];
  const stubborn = new Set(opts.stubborn ?? []);
  const failuresLeft = new Map(Object.entries(opts.launchctlFailures ?? {}));
  let settling = opts.printSettling ?? 0;
  const clock = { t: 0 };
  const sleeps: number[] = [];
  const sims = new Map<string, FakeSim>();
  for (const s of opts.simulators ?? []) {
    sims.set(s.udid, {
      udid: s.udid,
      name: s.name,
      state: s.state ?? 'Shutdown',
      runtimeId: s.runtimeId ?? FAKE_RUNTIME_ID,
      isAvailable: s.isAvailable ?? true,
      live: new Map(Object.entries(s.live ?? {})),
      overrides: new Map(),
      boots: 0,
      launchctlList: s.launchctlList ?? FAKE_APPLE_LAUNCHCTL_LIST,
    });
  }
  const concurrency = { now: 0, max: 0 };
  // "Live" idle-down watchers (pid -> command line) and signals received.
  const watchers = new Map<number, string>();
  const signals: { pid: number; signal: string }[] = [];
  const spawnCalls: FakeSpawnCall[] = [];
  let nextPid = 60000;
  const spawnDetached: SpawnDetached = async (cmd, args, o) => {
    spawnCalls.push({ cmd, args: [...args], opts: o });
    if (!args.includes('_idle-watch')) throw new Error(`fake ios spawnDetached: unexpected command ${cmd}`);
    const pid = nextPid++;
    watchers.set(pid, [cmd, ...args].join(' '));
    return { pid };
  };

  const ok = (stdout = ''): Partial<ExecResult> => ({ code: 0, stdout });
  const fail = (stderr: string, code = 1): Partial<ExecResult> => ({ code, stderr });

  function readFileStore(udid: string): Map<string, boolean> {
    try {
      return parseStorePlist(readFileSync(join(opts.storeBase, `com.apple.CoreSimulator.SimDevice.${udid}`, 'disabled.plist'), 'utf8'));
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return new Map();
      throw err;
    }
  }

  function bootSim(sim: FakeSim): void {
    const live = new Map<string, boolean>(opts.storeHonored === false ? [] : readFileStore(sim.udid));
    for (const [l, v] of sim.overrides) live.set(l, v);
    for (const l of stubborn) live.delete(l);
    sim.live = live;
    sim.state = 'Booted';
    sim.boots++;
  }

  function devicesJson(onlyBooted: boolean): string {
    const devices: Record<string, unknown[]> = {};
    for (const s of sims.values()) {
      if (onlyBooted && s.state !== 'Booted') continue;
      (devices[s.runtimeId] ??= []).push({ udid: s.udid, name: s.name, state: s.state, isAvailable: s.isAvailable });
    }
    return JSON.stringify({ devices });
  }

  function printDisabled(sim: FakeSim): string {
    const word = (v: boolean) => (opts.printFormat === 'bool' ? String(v) : v ? 'disabled' : 'enabled');
    const lines = [...sim.live].map(([l, v]) => `\t"${l}" => ${word(v)}`);
    return `disabled services = {\n${lines.join('\n')}\n}\nlogin item associations = {\n}\n`;
  }

  async function launchctlSet(sim: FakeSim, verb: string, target: string): Promise<Partial<ExecResult>> {
    concurrency.now++;
    concurrency.max = Math.max(concurrency.max, concurrency.now);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    concurrency.now--;
    const label = target.replace(/^system\//, '');
    const left = failuresLeft.get(label) ?? 0;
    if (left > 0) {
      failuresLeft.set(label, left - 1);
      return fail(`Could not ${verb} service: 5: Input/output error`, 5);
    }
    const value = verb === 'disable';
    if (value && stubborn.has(label)) return ok(); // exit 0 but does not stick
    sim.overrides.set(label, value);
    sim.live.set(label, value);
    return ok();
  }

  async function simctl(args: string[]): Promise<Partial<ExecResult> | undefined> {
    const [sub, ...rest] = args;
    if (sub === 'list') {
      if (rest[0] === 'devices' && rest[1] === '-j') return ok(devicesJson(false));
      if (rest[0] === 'devices' && rest[1] === 'booted' && rest[2] === '-j') return ok(devicesJson(true));
      if (rest[0] === 'runtimes' && rest[1] === '-j') {
        return ok(JSON.stringify({ runtimes: runtimes.map((r) => ({ ...r, name: r.name ?? `${r.platform} ${r.version}`, isAvailable: true })) }));
      }
      return undefined;
    }
    const sim = sims.get(rest[0]);
    if (sim === undefined) return fail(`Invalid device: ${rest[0]}`, 164);
    if (sub === 'boot') {
      if (sim.state === 'Booted') return fail('Unable to boot device in current state: Booted', 149);
      bootSim(sim);
      return ok();
    }
    if (sub === 'bootstatus') return sim.state === 'Booted' ? ok('Device already booted, nothing to do.\n') : fail('device not booted', 1);
    if (sub === 'shutdown') {
      if (sim.state === 'Shutdown') return fail('Unable to shutdown device in current state: Shutdown', 149);
      sim.state = 'Shutdown';
      sim.live = new Map();
      return ok();
    }
    if (sub === 'spawn' && rest[1] === 'launchctl') {
      if (sim.state !== 'Booted') return fail('Unable to lookup in current state: Shutdown', 149);
      const [verb, a1] = rest.slice(2);
      if (verb === 'print-disabled' && a1 === 'system') {
        if (settling > 0) {
          settling--;
          return { code: 1, stdout: '', stderr: 'An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\nUnable to lookup in current state: Domain is tearing down\nunderlying error (domain=LaunchdSimError, code=124)\n' };
        }
        return ok(printDisabled(sim));
      }
      if ((verb === 'disable' || verb === 'enable') && a1?.startsWith('system/')) return launchctlSet(sim, verb, a1);
      if (verb === 'list' && a1 === undefined) return ok(sim.launchctlList);
    }
    return undefined;
  }

  const calls: FakeCall[] = [];
  const exec = (async (cmd: string, args: readonly string[], o: ExecOptions = {}) => {
    const call = { cmd, args: [...args], opts: o };
    calls.push(call);
    let res: Partial<ExecResult> | undefined;
    if (cmd === 'xcrun' && args[0] === 'simctl') res = await simctl(args.slice(1));
    else if (cmd === 'plutil') res = opts.plutilXml == null ? fail('plutil: invalid file', 1) : ok(opts.plutilXml);
    else if (cmd === 'open' && args.join(' ') === '-a Simulator') res = opts.openFails ? fail('Unable to find application named Simulator') : ok();
    else if (cmd === 'sysctl') res = ok(`${opts.swap ?? 'total = 2048.00M  used = 100.00M  free = 1948.00M  (encrypted)'}\n`);
    else if (cmd === join(FAKE_SDK, 'platform-tools', 'adb') && args[0] === 'devices') {
      res = ok(`List of devices attached\n${(opts.emulators ?? []).map((s) => `${s}\tdevice\n`).join('')}\n`);
    } else if (cmd === 'ps' && args.includes('command=') && watchers.has(Number(args[args.length - 1]))) {
      res = ok(`${watchers.get(Number(args[args.length - 1]))}\n`);
    } else if (cmd === 'pgrep') res = opts.measure?.pgrep == null ? { code: 1 } : ok(opts.measure.pgrep);
    else if (cmd === 'ps') res = opts.measure?.ps == null ? { code: 1 } : ok(opts.measure.ps);
    else if (cmd === 'top') res = opts.measure?.top == null ? { code: 1 } : ok(opts.measure.top);
    if (res === undefined) throw new Error(`fake ios: unexpected call: ${cmd} ${args.join(' ')}`);
    return Object.freeze({ code: 0, signal: null, stdout: '', stderr: '', ...res });
  }) as Exec & { calls: FakeCall[] };
  exec.calls = calls;

  // simctl commands issued (without "xcrun simctl"), in order.
  const simctlCommands = () => calls.filter((c) => c.cmd === 'xcrun').map((c) => c.args.slice(1).join(' '));

  return {
    exec,
    calls,
    sims,
    concurrency,
    simctlCommands,
    spawnDetached,
    spawnCalls,
    watchers,
    signals,
    signalPid: ((pid, signal) => {
      signals.push({ pid, signal });
      watchers.delete(pid);
    }) as SignalPid,
    pidAlive: (pid: number) => watchers.has(pid),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    sleeps,
    now: () => clock.t,
    date: () => new Date('2026-11-16T12:00:00.000Z'),
    // adb "installed" in /fake-sdk only when the test passes ANDROID_HOME=/fake-sdk.
    fileExists: (p: string) => p === join(FAKE_SDK, 'platform-tools', 'adb'),
  };
}

export type FakeIos = ReturnType<typeof createFakeIos>;
