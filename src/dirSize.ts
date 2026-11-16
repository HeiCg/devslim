import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Tamanho de diretorio: recursivo em Node (sem processo), sem seguir symlink,
// com limite de profundidade e de arquivos. `truncated` = algum limite cortou.
// Usado pelo doctor (snapshot e imagens orfas) e pelo plan/tune (snapshots/).

export type DirSize = Readonly<{ bytes: number; files: number; truncated: boolean }>;

const round1 = (n: number) => Math.round(n * 10) / 10;
export const bytesToMb = (bytes: number) => round1(bytes / (1024 * 1024));

export function dirSize(path: string, opts: { maxDepth?: number; maxFiles?: number } = {}): DirSize {
  const maxDepth = opts.maxDepth ?? 12;
  const maxFiles = opts.maxFiles ?? 100_000;
  let bytes = 0;
  let files = 0;
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated && files >= maxFiles) return;
      let st;
      try {
        st = lstatSync(join(dir, name));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth + 1 > maxDepth) truncated = true;
        else walk(join(dir, name), depth + 1);
      } else if (st.isFile()) {
        if (files >= maxFiles) {
          truncated = true;
          return;
        }
        files++;
        bytes += st.size;
      }
    }
  };
  walk(path, 0);
  return Object.freeze({ bytes, files, truncated });
}

export const sizeText = (s: DirSize) => `${bytesToMb(s.bytes)} MB${s.truncated ? ' (ou mais; contagem cortada)' : ''}`;
