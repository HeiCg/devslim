import type { Exec } from '../exec.ts';

// Quem lancou o emulador que esta rodando, pela linha de comando do qemu (sem
// adb). O devslim nao marca o guest; reconhece por assinatura:
// - devslim: sessao do devslim registra o AVD como vivo, ou a linha tem
//   -memory e -cores e nao tem -netfast (buildLaunchArgs nunca emite -netfast);
// - argent: -netfast e -crash-report-mode never (medido no tool-server dele);
// - other: o resto (Android Studio, emulator na mao).

export type Launcher = 'devslim' | 'argent' | 'other';

const tokens = (cmdline: string) => cmdline.split(/\s+/).filter((t) => t !== '');

// Funcao pura. `inSession`: a sessao do devslim registra este AVD como vivo.
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

// `pgrep -fl qemu-system`: "<pid> <linha de comando>". So linhas cujo binario e
// qemu-system-* e que tem `-avd <nome>`.
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

// Todo qemu de emulador rodando. Falha (ou nada rodando) = lista vazia.
export async function listQemuProcesses(exec: Exec): Promise<QemuProcess[]> {
  const out = await stdoutOf(exec, 'pgrep', ['-fl', 'qemu-system']);
  return out === null ? [] : parseQemuProcesses(out);
}

// `ps -o command= -p <pid>`; null se o processo sumiu ou o ps falhou.
export async function processCommandLine(pid: number, exec: Exec): Promise<string | null> {
  const out = await stdoutOf(exec, 'ps', ['-o', 'command=', '-p', String(pid)]);
  const line = out?.trim();
  return line === undefined || line === '' ? null : line;
}

// Launcher de um AVD rodando. Linha de comando: da lista do pgrep (por pid ou
// nome), senao `ps` pelo pid. Sem linha: 'devslim' se a sessao o registra,
// senao null (nao deu para saber).
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
  return l === 'argent' ? 'lancado por argent' : l === 'other' ? 'lancado por fora do devslim' : 'lancado pelo devslim';
}
