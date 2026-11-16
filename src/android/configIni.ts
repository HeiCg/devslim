import { hasCapability, type AndroidProfile } from './profile.ts';

// Documento ini que preserva cada byte: linhas nao tocadas sao reemitidas a
// partir de `raw` + `eol` originais. Chave alterada so reescreve o valor,
// mantendo o separador (`k=v` ou `k = v`) e o espaco final da linha.
export type IniEntry = Readonly<{
  kind: 'entry';
  raw: string;
  eol: string;
  key: string;
  value: string;
  prefix: string; // tudo antes do valor: espaco inicial, chave, separador
  suffix: string; // espaco depois do valor
}>;
export type IniOther = Readonly<{ kind: 'other'; raw: string; eol: string }>;
export type IniLine = IniEntry | IniOther;
export type IniDoc = Readonly<{ bom: string; lines: readonly IniLine[] }>;

export type IniChange = Readonly<{ key: string; from: string | null; to: string }>;

const ENTRY_RE = /^(\s*)([^\s=#;][^=]*?)(\s*=\s*)(.*?)(\s*)$/;
const EOL_RE = /\r\n|\n|\r/g;

function parseLine(raw: string, eol: string): IniLine {
  const m = ENTRY_RE.exec(raw);
  if (!m) return Object.freeze({ kind: 'other', raw, eol });
  return Object.freeze({
    kind: 'entry',
    raw,
    eol,
    key: m[2],
    value: m[4],
    prefix: m[1] + m[2] + m[3],
    suffix: m[5],
  });
}

export function parseIni(text: string): IniDoc {
  let bom = '';
  if (text.startsWith('﻿')) {
    bom = '﻿';
    text = text.slice(1);
  }
  const lines: IniLine[] = [];
  let start = 0;
  EOL_RE.lastIndex = 0;
  for (let m = EOL_RE.exec(text); m !== null; m = EOL_RE.exec(text)) {
    lines.push(parseLine(text.slice(start, m.index), m[0]));
    start = EOL_RE.lastIndex;
  }
  if (start < text.length) lines.push(parseLine(text.slice(start), ''));
  return Object.freeze({ bom, lines: Object.freeze(lines) });
}

export function serializeIni(doc: IniDoc): string {
  let out = doc.bom;
  for (const line of doc.lines) out += line.raw + line.eol;
  return out;
}

// Valor efetivo de uma chave (a ultima ocorrencia vence).
export function getValue(doc: IniDoc, key: string): string | undefined {
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    const l = doc.lines[i];
    if (l.kind === 'entry' && l.key === key) return l.value;
  }
  return undefined;
}

export function entryKeys(doc: IniDoc): string[] {
  const seen = new Set<string>();
  for (const l of doc.lines) if (l.kind === 'entry') seen.add(l.key);
  return [...seen];
}

function dominantEol(doc: IniDoc): string {
  for (const l of doc.lines) if (l.eol !== '') return l.eol;
  return '\n';
}

// Novo doc com `key=value`. Atualiza toda ocorrencia existente; se a chave nao
// existe, acrescenta no fim respeitando o estilo de fim de linha do arquivo.
export function setValue(doc: IniDoc, key: string, value: string): IniDoc {
  let found = false;
  let changed = false;
  const lines = doc.lines.map((l) => {
    if (l.kind !== 'entry' || l.key !== key) return l;
    found = true;
    if (l.value === value) return l;
    changed = true;
    return Object.freeze({ ...l, value, raw: l.prefix + value + l.suffix });
  });
  if (found) return changed ? Object.freeze({ bom: doc.bom, lines: Object.freeze(lines) }) : doc;

  const eol = dominantEol(doc);
  const last = lines[lines.length - 1];
  const raw = `${key}=${value}`;
  if (last === undefined) {
    lines.push(parseLine(raw, ''));
  } else if (last.eol === '') {
    // Arquivo sem newline final: a linha nova vira a ultima, tambem sem newline.
    lines[lines.length - 1] = Object.freeze({ ...last, eol });
    lines.push(parseLine(raw, ''));
  } else {
    lines.push(parseLine(raw, eol));
  }
  return Object.freeze({ bom: doc.bom, lines: Object.freeze(lines) });
}

// Valores canonicos das chaves geridas, na ordem em que sao aplicadas.
export function managedValues(doc: IniDoc, profile: AndroidProfile): Array<[string, string]> {
  const audio = hasCapability(profile, 'audio') ? 'yes' : 'no';
  const camera = hasCapability(profile, 'camera') ? 'emulated' : 'none';
  const gps = hasCapability(profile, 'location') ? 'yes' : 'no';
  const pairs: Array<[string, string]> = [
    ['hw.ramSize', String(profile.ramMb)],
    ['vm.heapSize', String(profile.heapMb)],
    ['hw.cpu.ncore', String(profile.cores)],
    ['hw.gpu.enabled', 'yes'],
    ['hw.gpu.mode', profile.gpu],
    ['hw.audioInput', audio],
    ['hw.audioOutput', audio],
    ['hw.camera.back', camera],
    ['hw.camera.front', camera],
    ['hw.gps', gps],
    ['showDeviceFrame', 'no'],
    ['fastboot.forceColdBoot', 'no'],
  ];
  if (profile.screen !== 'keep') {
    pairs.push(
      ['hw.lcd.width', String(profile.screen.width)],
      ['hw.lcd.height', String(profile.screen.height)],
      ['hw.lcd.density', String(profile.screen.density)],
    );
  }
  // Sensores: so os que ja existem no arquivo. orientation fica como esta
  // (hw.accelerometer nao e hw.sensors.*, entao tambem nao e tocado).
  for (const key of entryKeys(doc)) {
    if (key.startsWith('hw.sensors.') && key !== 'hw.sensors.orientation') pairs.push([key, 'no']);
  }
  return pairs;
}

export function applyProfile(doc: IniDoc, profile: AndroidProfile): { doc: IniDoc; changes: IniChange[] } {
  const changes: IniChange[] = [];
  let next = doc;
  for (const [key, to] of managedValues(doc, profile)) {
    const from = getValue(next, key);
    if (from === to) continue;
    next = setValue(next, key, to);
    changes.push(Object.freeze({ key, from: from ?? null, to }));
  }
  return { doc: next, changes };
}
