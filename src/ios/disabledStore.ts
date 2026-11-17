import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DevslimError } from '../errors.ts';
import { nodeExec, type Exec } from '../exec.ts';
import { writeFileAtomic } from '../fsAtomic.ts';

// Per-device launchd_sim override store:
//   <base>/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist
// launchd_sim reads the file on startup and rewrites it on every `launchctl
// disable/enable`. It is a flat dict label -> <true/> (disabled) | <false/>
// (explicitly enabled, the runtime writes a few). CoreSimulator internal
// detail: always verify after boot.

export const DEFAULT_STORE_BASE = '/private/var/tmp';
export const UDID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export type StoreOptions = {
  base?: string; // default /private/var/tmp; tests use tmpdir
  exec?: Exec; // only for `plutil` when the file is binary
};

export function assertUdid(udid: string): string {
  if (typeof udid !== 'string' || !UDID_RE.test(udid)) throw new DevslimError(`invalid UDID: ${udid}`);
  return udid;
}

export function storeDir(udid: string, opts: StoreOptions = {}): string {
  return join(opts.base ?? DEFAULT_STORE_BASE, `com.apple.CoreSimulator.SimDevice.${assertUdid(udid)}`);
}

export function storePath(udid: string, opts: StoreOptions = {}): string {
  return join(storeDir(udid, opts), 'disabled.plist');
}

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

function unescapeXml(text: string, where: string): string {
  return text.replace(/&([a-z]+|#\d+|#x[0-9a-fA-F]+);/g, (m, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    const v = ENTITIES[name];
    if (v === undefined) throw new DevslimError(`${where}: unknown XML entity ${m}`);
    return v;
  });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Strict parser for the flat dict. Any other structure (non-boolean value,
// nested dict, array, repeated key, stray text) = DevslimError.
export function parseStorePlist(text: string, where = 'disabled.plist'): Map<string, boolean> {
  const bad = (why: string) => new DevslimError(`${where}: unexpected structure (${why}); nothing was written`);
  let s = text.replace(/^﻿/, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/^\s*<\?xml[^?]*\?>/, '');
  s = s.replace(/^\s*<!DOCTYPE[^>]*>/, '');
  s = s.trim();
  const plist = /^<plist(?:\s+version="[^"]*")?\s*>([\s\S]*)<\/plist>$/.exec(s);
  if (!plist) throw bad('root is not <plist>');
  const body = plist[1].trim();
  const out = new Map<string, boolean>();
  if (body === '<dict/>') return out;
  const dict = /^<dict>([\s\S]*)<\/dict>$/.exec(body);
  if (!dict) throw bad('plist root is not a <dict>');
  const inner = dict[1];
  const entry = /\s*<key>([^<]*)<\/key>\s*<(true|false)\s*\/>/y;
  let pos = 0;
  while (pos < inner.length) {
    entry.lastIndex = pos;
    const m = entry.exec(inner);
    if (!m) {
      if (inner.slice(pos).trim() === '') break;
      const near = inner.slice(pos).trim().slice(0, 60).replace(/\s+/g, ' ');
      throw bad(`expected <key> followed by <true/> or <false/>, found: ${near}`);
    }
    const label = unescapeXml(m[1], where);
    if (label === '') throw bad('empty key');
    if (out.has(label)) throw bad(`repeated key ${label}`);
    out.set(label, m[2] === 'true');
    pos = entry.lastIndex;
  }
  return out;
}

// Same format launchd_sim writes, sorted keys: rewriting without
// changes produces identical bytes.
export function serializeStorePlist(entries: ReadonlyMap<string, boolean>): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
  ];
  for (const label of [...entries.keys()].sort()) {
    lines.push(`\t<key>${escapeXml(label)}</key>`, `\t<${entries.get(label) ? 'true' : 'false'}/>`);
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

// Store contents; missing file = empty map. Binary (`bplist`) is
// converted with `plutil -convert xml1 -o - <file>` (read-only).
export async function readStore(udid: string, opts: StoreOptions = {}): Promise<Map<string, boolean>> {
  const path = storePath(udid, opts);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return new Map();
    throw err;
  }
  if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
    const exec = opts.exec ?? nodeExec;
    const res = await exec('plutil', ['-convert', 'xml1', '-o', '-', path], { timeoutMs: 30_000 });
    if (res.code !== 0) {
      throw new DevslimError(`plutil could not convert ${path} (exit ${res.code}): ${(res.stderr || res.stdout).trim() || '(no output)'}`);
    }
    return parseStorePlist(res.stdout, path);
  }
  return parseStorePlist(buf.toString('utf8'), path);
}

// Merges `changes` into the store, preserving ALL other entries (including
// runtime <false/> ones). Creates the directory if missing; atomic write, mode 0644.
// Returns the previous value of each key in `changes` (absent = undefined).
// Unreadable store = error before any write. No difference = no write.
export async function mergeStore(
  udid: string,
  changes: ReadonlyMap<string, boolean>,
  opts: StoreOptions = {},
): Promise<Map<string, boolean | undefined>> {
  const path = storePath(udid, opts);
  const current = await readStore(udid, opts);
  const previous = new Map<string, boolean | undefined>();
  let dirty = false;
  for (const [label, value] of changes) {
    if (typeof value !== 'boolean') throw new DevslimError(`non-boolean value for ${label}`);
    if (label === '' || /[\u0000-\u001f]/.test(label)) throw new DevslimError(`invalid label: ${JSON.stringify(label)}`);
    const before = current.get(label);
    previous.set(label, before);
    if (before !== value) {
      current.set(label, value);
      dirty = true;
    }
  }
  if (dirty) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, serializeStorePlist(current), { mode: 0o644 });
  }
  return previous;
}
