import type { Exec } from '../exec.ts';

// Who launched the running emulator, from the qemu command line (no
// adb). devslim does not mark the guest; it recognizes a signature:
// - devslim: the devslim session records the AVD as alive, or the line has
//   -memory and -cores and no -netfast (buildLaunchArgs never emits -netfast);
// - argent: -netfast and -crash-report-mode never (measured on its tool-server);
// - other: everything else (Android Studio, emulator by hand).

export type Launcher = 'devslim' | 'argent' | 'other';

const tokens = (cmdline: string) => cmdline.split(/\s+/).filter((t) => t !== '');

// Pure function. `inSession`: the devslim session records this AVD as alive.
export function classifyLauncher(cmdline: string, inSession = false): Launcher {
  if (inSession) return 'devslim';
  const t = tokens(cmdline);
  const netfast = t.includes('-netfast');
  if (t.includes('-memory') && t.includes('-cores') && !netfast) return 'devslim';
  const crash = t.indexOf('-crash-report-mode');
  if (netfast && crash !== -1 && t[crash + 1] === 'never') return 'argent';
  return 'other';
}

export type QemuProcess = Readonly<{ pid: number; avd: string; cmdline: string }>;

// `pgrep -fl qemu-system`: "<pid> <command line>". Only lines whose binary is
// qemu-system-* and that have `-avd <name>`.
export function parseQemuProcesses(text: string): QemuProcess[] {
  const out: QemuProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    const cmdline = m[2];
    const t = tokens(cmdline);
    if (!/(^|\/)qemu-system[^/]*$/.test(t[0])) continue;
    const i = t.indexOf('-avd');
    if (i === -1 || t[i + 1] === undefined) continue;
    out.push(Object.freeze({ pid: Number(m[1]), avd: t[i + 1], cmdline }));
  }
  return out;
}

async function stdoutOf(exec: Exec, cmd: string, args: string[]): Promise<string | null> {
  try {
    const res = await exec(cmd, args, { timeoutMs: 10_000 });
    return res.code === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

// Every running emulator qemu. Failure (or nothing running) = empty list.
export async function listQemuProcesses(exec: Exec): Promise<QemuProcess[]> {
  const out = await stdoutOf(exec, 'pgrep', ['-fl', 'qemu-system']);
  return out === null ? [] : parseQemuProcesses(out);
}

// `ps -o command= -p <pid>`; null if the process is gone or ps failed.
export async function processCommandLine(pid: number, exec: Exec): Promise<string | null> {
  const out = await stdoutOf(exec, 'ps', ['-o', 'command=', '-p', String(pid)]);
  const line = out?.trim();
  return line === undefined || line === '' ? null : line;
}

// Launcher of a running AVD. Command line: from the pgrep list (by pid or
// name), else `ps` by pid. No line: 'devslim' if the session records it,
// else null (could not tell).
export async function launcherFor(
  avd: string,
  o: { exec: Exec; pid: number | null; inSession: boolean; processes?: readonly QemuProcess[] },
): Promise<{ launcher: Launcher | null; cmdline: string | null }> {
  const hit = o.processes?.find((p) => p.pid === o.pid) ?? o.processes?.find((p) => p.avd === avd);
  const cmdline = hit?.cmdline ?? (o.pid === null ? null : await processCommandLine(o.pid, o.exec));
  if (cmdline === null) return { launcher: o.inSession ? 'devslim' : null, cmdline: null };
  return { launcher: classifyLauncher(cmdline, o.inSession), cmdline };
}

export function launcherText(l: Launcher): string {
  return l === 'argent' ? 'launched by argent' : l === 'other' ? 'launched outside devslim' : 'launched by devslim';
}
