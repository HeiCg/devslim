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

// Writes to a temporary file in the same directory and renames it over the
// target. A reader of the target sees either the whole old or the whole new content,
// never a half-written file. Preserves the mode of the existing file.
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
    fchmodSync(fd, mode); // open() applies umask; the final mode must be the requested one
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}
