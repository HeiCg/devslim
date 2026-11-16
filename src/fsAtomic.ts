import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Escreve num arquivo temporario no mesmo diretorio e faz rename por cima do
// destino. Quem le o destino ve o conteudo antigo inteiro ou o novo inteiro,
// nunca um arquivo pela metade. Preserva o modo do arquivo existente.
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let mode = opts.mode;
  if (mode === undefined) {
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      mode = 0o644;
    }
  }
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', mode);
    fchmodSync(fd, mode); // open() aplica umask; o modo final tem que ser o pedido
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ja fechado */ }
    }
    try { unlinkSync(tmp); } catch { /* tmp pode nao existir */ }
    throw err;
  }
}
