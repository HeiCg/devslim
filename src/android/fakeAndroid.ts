import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeExec, type ExecResult, type FakeCall, type FakeSpawnCall, type SignalPid, type SpawnDetached } from '../exec.ts';

// Fake Android world for tests: a fictitious SDK, in-memory emulators,
// fake clock and sleep. No real process is created. Answers adb,
// emulator (via spawnDetached), avdmanager, xcrun, sysctl, footprint, ps and pgrep.

export type FakeEmulatorInit = {
  avd: string;
  port: number;
  state?: string; // default 'device'
  installed?: readonly string[];
  disabled?: readonly string[];
  settings?: Readonly<Record<string, string>>; // 'global/key' -> value
  bootSteps?: number; // how many getprop calls until sys.boot_completed=1 (default 1)
  neverBoots?: boolean;
  ignoresKill?: boolean;
  failPackages?: readonly string[]; // pm disable/enable fails for these
  failSettings?: readonly string[]; // 'ns/key' whose put/delete fails
  dexoptFails?: boolean;
  pid?: number;
  // `dumpsys activity activities` output (default: launcher in the foreground).
  activities?: string;
};

export const FAKE_LAUNCHER_ACTIVITIES =
  '  topResumedActivity=ActivityRecord{e8b3c4 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t5}\n';

export type FakeEmulator = {
  avd: string;
  port: number;
  serial: string;
  state: string;
  pid: number;
  installed: string[];
  disabled: Set<string>;
  settings: Map<string, string>;
  bootLeft: number;
  neverBoots: boolean;
  ignoresKill: boolean;
  failPackages: Set<string>;
  failSettings: Set<string>;
  dexoptFails: boolean;
  snapshots: string[];
  activities: string;
};

export type FakeAndroidOptions = {
  sdk?: string;
  avdHome?: string; // where the fake avdmanager creates the AVD
  emulators?: readonly FakeEmulatorInit[];
  simulators?: readonly { udid: string; name: string }[];
  xcrunFails?: boolean;
  swap?: string;
  // Defaults for the emulator that spawnDetached "starts".
  spawned?: Omit<FakeEmulatorInit, 'avd' | 'port'>;
  avdmanagerFails?: boolean;
  // System images "installed" in the fake SDK (full ids). Default: google_apis
  // API 35 on both ABIs. dirExists only answers for them.
  systemImages?: readonly string[];
  // process.arch of the fake host (default arm64).
  arch?: string;
  // AVD directory, so snapshot save creates snapshots/<name>.
  avdDir?: (avd: string) => string | null;
  // cmdline: answer to `ps -o command= -p <pid>` (qemu line).
  host?: { footprint?: string | null; rss?: string | null; pgrep?: string | null; cmdline?: string | null };
  guest?: { meminfo?: string | null; ps?: string | null; dumpsys?: string | null };
};

const DEFAULT_SDK = '/fake-sdk';

export function createFakeAndroid(opts: FakeAndroidOptions = {}) {
  const sdk = opts.sdk ?? DEFAULT_SDK;
  const tools = Object.freeze({
    adb: join(sdk, 'platform-tools', 'adb'),
    emulator: join(sdk, 'emulator', 'emulator'),
    avdmanager: join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
  });
  const clock = { t: 0 };
  const sleeps: number[] = [];
  const emulators = new Map<string, FakeEmulator>();
  // "Live" watchers (pid -> command line) and signals received.
  const watchers = new Map<number, string>();
  const signals: { pid: number; signal: string }[] = [];
  let nextPid = 50000;

  function addEmulator(init: FakeEmulatorInit): FakeEmulator {
    const serial = `emulator-${init.port}`;
    const emu: FakeEmulator = {
      avd: init.avd,
      port: init.port,
      serial,
      state: init.state ?? 'device',
      pid: init.pid ?? nextPid++,
      installed: [...(init.installed ?? [])],
      disabled: new Set(init.disabled ?? []),
      settings: new Map(Object.entries(init.settings ?? {})),
      bootLeft: init.bootSteps ?? 1,
      neverBoots: init.neverBoots === true,
      ignoresKill: init.ignoresKill === true,
      failPackages: new Set(init.failPackages ?? []),
      failSettings: new Set(init.failSettings ?? []),
      dexoptFails: init.dexoptFails === true,
      snapshots: [],
      activities: init.activities ?? FAKE_LAUNCHER_ACTIVITIES,
    };
    emulators.set(serial, emu);
    return emu;
  }
  for (const e of opts.emulators ?? []) addEmulator(e);

  const ok = (stdout = ''): Partial<ExecResult> => ({ code: 0, stdout });
  const fail = (stderr: string, code = 1): Partial<ExecResult> => ({ code, stderr });

  function shell(emu: FakeEmulator, args: string[]): Partial<ExecResult> {
    const [a0, a1, a2, a3, a4] = args;
    if (a0 === 'getprop' && a1 === 'sys.boot_completed') {
      if (emu.neverBoots) return ok('\n');
      if (emu.bootLeft > 1) {
        emu.bootLeft--;
        return ok('\n');
      }
      emu.bootLeft = 0;
      return ok('1\n');
    }
    if (a0 === 'settings') {
      const id = `${a2}/${a3}`;
      if (a1 === 'get') return ok(`${emu.settings.get(id) ?? 'null'}\n`);
      if (emu.failSettings.has(id)) return fail(`settings ${a1} failed for ${id}`, 255);
      if (a1 === 'put') {
        emu.settings.set(id, a4);
        return ok();
      }
      if (a1 === 'delete') {
        emu.settings.delete(id);
        return ok('Deleted 1 rows\n');
      }
    }
    if (a0 === 'pm' && a1 === 'list' && a2 === 'packages') {
      const list = a3 === '-d' ? emu.installed.filter((p) => emu.disabled.has(p)) : emu.installed;
      return ok(list.map((p) => `package:${p}\n`).join(''));
    }
    if (a0 === 'pm' && (a1 === 'disable-user' || a1 === 'enable')) {
      const pkg = args[args.length - 1];
      if (emu.failPackages.has(pkg) || !emu.installed.includes(pkg)) {
        return { code: 255, stdout: '', stderr: `Exception occurred while executing '${a1}':\njava.lang.IllegalArgumentException: Unknown package: ${pkg}\n` };
      }
      if (a1 === 'enable') emu.disabled.delete(pkg);
      else emu.disabled.add(pkg);
      return ok(`Package ${pkg} new state: ${a1 === 'enable' ? 'enabled' : 'disabled-user'}\n`);
    }
    if (a0 === 'cmd' && a1 === 'package' && a2 === 'bg-dexopt-job') {
      return emu.dexoptFails ? { code: 255, stdout: 'Failure: dexopt job cancelled\n' } : ok('Success\n');
    }
    if (a0 === 'am' && a1 === 'kill-all') return ok();
    if (a0 === 'cat' && a1 === '/proc/meminfo') return opts.guest?.meminfo == null ? fail('no meminfo') : ok(opts.guest.meminfo);
    if (a0 === 'ps' && a1 === '-A') return opts.guest?.ps == null ? fail('no ps') : ok(opts.guest.ps);
    if (a0 === 'dumpsys' && a1 === 'activity' && a2 === 'activities') return ok(emu.activities);
    if (a0 === 'dumpsys' && a1 === 'meminfo') return opts.guest?.dumpsys == null ? fail('no dumpsys') : ok(opts.guest.dumpsys);
    return fail(`/system/bin/sh: ${a0}: not in the fake`, 127);
  }

  function adb(args: string[]): Partial<ExecResult> | undefined {
    if (args[0] === 'devices') {
      const lines = [...emulators.values()].map((e) => `${e.serial}\t${e.state}`);
      return ok(`List of devices attached\n${lines.map((l) => l + '\n').join('')}\n`);
    }
    if (args[0] !== '-s') return undefined;
    const emu = emulators.get(args[1]);
    const rest = args.slice(2);
    if (emu === undefined) return fail(`adb: device '${args[1]}' not found`);
    if (rest[0] === 'emu') {
      const what = rest.slice(1).join(' ');
      if (what === 'avd name') return ok(`${emu.avd}\r\nOK\r\n`);
      if (what === 'kill') {
        if (!emu.ignoresKill) emulators.delete(emu.serial);
        return ok('OK: killing emulator, bye bye\r\n');
      }
      if (rest[1] === 'avd' && rest[2] === 'snapshot' && rest[3] === 'save') {
        emu.snapshots.push(rest[4]);
        const dir = opts.avdDir?.(emu.avd);
        if (dir) {
          mkdirSync(join(dir, 'snapshots', rest[4]), { recursive: true });
          writeFileSync(join(dir, 'snapshots', rest[4], 'ram.bin'), 'ram');
        }
        return ok('OK\r\n');
      }
      return undefined;
    }
    if (rest[0] === 'shell') {
      if (emu.state !== 'device') return fail(`adb: device ${emu.state}`);
      return shell(emu, rest.slice(1));
    }
    return undefined;
  }

  function avdmanager(call: FakeCall): Partial<ExecResult> | undefined {
    const a = call.args;
    if (a[0] !== 'create' || a[1] !== 'avd') return undefined;
    if (opts.avdmanagerFails) return fail('Error: Package path is not valid. Valid system image paths are:', 1);
    if (call.opts.input !== 'no\n') return fail('expected "no" on stdin', 3);
    const name = a[a.indexOf('-n') + 1];
    const [, api, tag, abi] = (a[a.indexOf('-k') + 1] ?? '').split(';');
    const home = opts.avdHome;
    if (home) {
      const dir = join(home, `${name}.avd`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(home, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${name}.avd\ntarget=android-35\n`);
      writeFileSync(
        join(dir, 'config.ini'),
        `AvdId=${name}\nabi.type=${abi ?? 'arm64-v8a'}\nhw.ramSize=2G\nhw.gpu.mode=auto\nhw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=420\n` +
          `image.sysdir.1=system-images/${api}/${tag}/${abi}/\ntag.id=${tag}\n`,
      );
    }
    return ok(`Do you wish to create a custom hardware profile? [no] `);
  }

  const exec = createFakeExec((call) => {
    const { cmd, args } = call;
    if (cmd === tools.adb) return adb(args);
    if (cmd === tools.avdmanager) return avdmanager(call);
    if (cmd === 'xcrun') {
      if (opts.xcrunFails) return fail('xcrun: error: unable to find utility "simctl"', 72);
      const devices = (opts.simulators ?? []).map((s) => ({ ...s, state: 'Booted', isAvailable: true }));
      return ok(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-4': devices } }));
    }
    if (cmd === 'sysctl') return ok(`${opts.swap ?? 'total = 2048.00M  used = 100.00M  free = 1948.00M  (encrypted)'}\n`);
    if (cmd === 'pgrep') return opts.host?.pgrep == null ? { code: 1 } : ok(opts.host.pgrep);
    if (cmd === 'footprint') return opts.host?.footprint == null ? fail('footprint: failed', 1) : ok(opts.host.footprint);
    if (cmd === 'ps' && args.includes('command=') && watchers.has(Number(args[args.length - 1]))) {
      return ok(`${watchers.get(Number(args[args.length - 1]))}\n`);
    }
    if (cmd === 'ps' && args.includes('command=')) return opts.host?.cmdline == null ? { code: 1 } : ok(`${opts.host.cmdline}\n`);
    if (cmd === 'ps') return opts.host?.rss == null ? { code: 1 } : ok(opts.host.rss);
    return undefined;
  });

  const images = opts.systemImages ?? [
    'system-images;android-35;google_apis;arm64-v8a',
    'system-images;android-35;google_apis;x86_64',
  ];
  const imageDirs = new Set(images.map((id) => join(sdk, ...id.split(';'))));

  const spawnCalls: FakeSpawnCall[] = [];
  const spawnDetached: SpawnDetached = async (cmd, args, o) => {
    spawnCalls.push({ cmd, args: [...args], opts: o });
    if (args.includes('_idle-watch')) {
      // Idle-down watcher: only gets a pid and a command line (for ps).
      const pid = nextPid++;
      watchers.set(pid, [cmd, ...args].join(' '));
      return { pid };
    }
    if (cmd !== tools.emulator) throw new Error(`fake spawnDetached: unexpected command ${cmd}`);
    const avd = args[args.indexOf('-avd') + 1];
    const portIdx = args.indexOf('-port');
    const port = portIdx === -1 ? 5554 : Number(args[portIdx + 1]);
    const emu = addEmulator({ ...opts.spawned, avd, port });
    return { pid: emu.pid };
  };

  // Device commands issued (without the adb path), in order.
  const deviceCommands = () =>
    exec.calls.filter((c) => c.cmd === tools.adb && c.args[0] === '-s').map((c) => c.args.slice(2).join(' '));

  return {
    sdk,
    tools,
    exec,
    spawnDetached,
    spawnCalls,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    sleeps,
    now: () => clock.t,
    date: () => new Date('2026-11-16T12:00:00.000Z'),
    fileExists: (p: string) => (Object.values(tools) as string[]).includes(p),
    dirExists: (p: string) => imageDirs.has(p),
    arch: opts.arch ?? 'arm64',
    emulators,
    addEmulator,
    deviceCommands,
    watchers,
    signals,
    signalPid: ((pid, signal) => {
      signals.push({ pid, signal });
      watchers.delete(pid);
    }) as SignalPid,
    pidAlive: (pid: number) => watchers.has(pid),
  };
}

export type FakeAndroid = ReturnType<typeof createFakeAndroid>;
