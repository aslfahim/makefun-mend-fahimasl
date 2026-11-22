// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of a hunk or chunk body: context (in both old and new), removed, added, or a `\` line. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'backslash';
  text: string;
}

/** One line of the replacement: a context line (the file's own line at its old index) or an added line. */
type NewLine = { kind: 'ctx'; oIdx: number } | { kind: 'add'; text: string };

/** A file as lines: its line break, its lines, whether it ends with one. */
interface FileLines {
  br: string;
  lines: string[];
  eol: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(br);
  const body = eol ? text.slice(0, -br.length) : text;
  return { br, lines: body.split(br), eol };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** 0-based positions where oldLines occur in lines at the given tier; occurrences may overlap. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0 || oldLines.length > lines.length) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineEq(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0 only when strict) at which oldLines occur, with its positions, or null. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const at = occurrences(lines, oldLines, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** The old lines and the replacement lines a body stands for. */
function deriveON(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ kind: 'ctx', oIdx: o.length - 1 });
    } else if (b.kind === 'del') o.push(b.text);
    else if (b.kind === 'add') n.push({ kind: 'add', text: b.text });
  }
  return { o, n };
}

/**
 * Replace lines [at, at + o.length) of file with n. Context lines are the file's own matched
 * lines; at tier 2 the added lines are re-indented from the old lines' indent to the file's.
 * eol null keeps the file's final break, otherwise it sets it.
 */
function applyLines(file: FileLines, o: string[], n: NewLine[], at: number, tier: number, eol: boolean | null): FileLines {
  const out: string[] = file.lines.slice(0, at);
  const f = file.lines[at] ?? '';
  const p = o.length > 0 ? o[0]! : '';
  for (const item of n) {
    if (item.kind === 'ctx') out.push(file.lines[at + item.oIdx]!);
    else {
      let text = item.text;
      const pLead = leadWs(p);
      if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(pLead)) {
        text = leadWs(f) + text.slice(pLead.length);
      }
      out.push(text);
    }
  }
  out.push(...file.lines.slice(at + o.length));
  return { br: file.br, lines: out, eol: eol === null ? file.eol : eol };
}


function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its old start line (1-based) and its body lines. */
interface UniHunk {
  a: number;
  body: BodyLine[];
}

/** One unified section: its paths (null is /dev/null), its mode flags and its hunks. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

/** A `--- `/`+++ ` path: the text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function uniPath(raw: string): string | null {
  const p = raw.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  const stripped = p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  return stripped === '/dev/null' ? null : stripped;
}

/** Whether a `\` line follows the body's last context or `+` line, and whether one follows its last `+` line. */
function noNlFlags(body: BodyLine[]): { afterCtxPlus: boolean; afterPlus: boolean } {
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'add') lastCtxPlus = i;
    if (b.kind === 'add') lastPlus = i;
  });
  const after = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]!.kind === 'backslash';
  return { afterCtxPlus: after(lastCtxPlus), afterPlus: after(lastPlus) };
}

/** Apply a section's hunks in order, each to the result of the ones before it. */
function applyHunks(file: FileLines, hunks: UniHunk[], path: string, strict: boolean): FileLines {
  let cur = file;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = deriveON(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, cur.lines.length);
      const ins = cur.lines.slice(0, at);
      for (const item of n) ins.push(item.kind === 'add' ? item.text : cur.lines[at + item.oIdx]!);
      ins.push(...cur.lines.slice(at));
      const atEnd = at === cur.lines.length;
      cur = { br: cur.br, lines: ins, eol: atEnd ? !noNlFlags(h.body).afterCtxPlus : cur.eol };
      d += n.length;
    } else {
      const found = findTier(cur.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      for (const p of found.at) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const runsToEnd = best + o.length === cur.lines.length;
      cur = applyLines(cur, o, n, best, found.tier, runsToEnd ? !noNlFlags(h.body).afterCtxPlus : null);
      d += n.length - o.length;
    }
  }
  return cur;
}

function unifiedSectionEdit(sec: UniSection, moves: Array<[string, string]>, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.isCreate || oldP === null;
    const isDelete = !isCreate && (sec.isDelete || newP === null);
    if (isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === 'add') lines.push(b.text);
        if (h.body.some((b) => b.kind === 'add')) noNl = noNlFlags(h.body).afterPlus;
      }
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      const oldText = tree.get(oldP!);
      if (oldText === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const out = applyHunks(splitFile(oldText), sec.hunks, oldP!, strict);
      tree.now.set(newP!, joinFile(out));
      tree.now.set(oldP!, null);
      moves.push([oldP!, newP!]);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(splitFile(before), sec.hunks, p, strict)));
  };
}

/** Parse a unified diff (SPEC.md section 6) into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  interface Draft {
    pairOld: string | null;
    pairNew: string | null;
    pairSet: boolean;
    renOld: string | null;
    renNew: string | null;
    diffOld: string | null;
    diffNew: string | null;
    isCreate: boolean;
    isDelete: boolean;
    hunks: UniHunk[];
  }
  const sections: Draft[] = [];
  let cur: Draft | null = null;
  let inHeader = false;
  const startSection = (d: Draft): void => {
    sections.push(d);
    cur = d;
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({ pairOld: null, pairNew: null, pairSet: false, renOld: null, renNew: null, diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [] });
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader && cur !== null) {
        cur.pairOld = uniPath(l);
        cur.pairNew = uniPath(lines[i + 1]!);
        cur.pairSet = true;
      } else {
        startSection({ pairOld: uniPath(l), pairNew: uniPath(lines[i + 1]!), pairSet: true, renOld: null, renNew: null, diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const lj = lines[j]!;
        if (lj.startsWith('diff --git ')) break;
        if (lj.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (lj === '') body.push({ kind: 'ctx', text: '' });
        else if (lj.startsWith(' ')) body.push({ kind: 'ctx', text: lj.slice(1) });
        else if (lj.startsWith('-')) body.push({ kind: 'del', text: lj.slice(1) });
        else if (lj.startsWith('+')) body.push({ kind: 'add', text: lj.slice(1) });
        else if (lj.startsWith('\\')) body.push({ kind: 'backslash', text: lj });
        else break;
        j++;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.renOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => {
    const sec: UniSection = {
      oldPath: s.pairSet ? s.pairOld : (s.renOld ?? s.diffOld),
      newPath: s.pairSet ? s.pairNew : (s.renNew ?? s.diffNew),
      isCreate: s.isCreate,
      isDelete: s.isDelete,
      hunks: s.hunks,
    };
    return unifiedSectionEdit(sec, moves, strict);
  });
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const file = splitFile(before);
    const found = findTier(file.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const n: NewLine[] = newLines.map((text) => ({ kind: 'add', text }) as NewLine);
    tree.now.set(path, joinFile(applyLines(file, oldLines, n, found.at[0]!, found.tier, null)));
  };
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), whether it is anchored to the end of the file, and its body. */
interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(file.lines.slice(cursor), [ch.anchor], strict);
        if (found === null) throw new Fail('no-match', path);
        cursor += found.at[0]! + 1;
      }
      const { o, n } = deriveON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? file.lines.length : cursor;
        const ins = file.lines.slice(0, at);
        for (const item of n) ins.push(item.kind === 'add' ? item.text : file.lines[at + item.oIdx]!);
        ins.push(...file.lines.slice(at));
        file = { br: file.br, lines: ins, eol: file.eol };
        cursor = at + n.length;
        continue;
      }
      const rest = file.lines.slice(cursor);
      const found = findTier(rest, o, strict);
      if (found === null) throw new Fail('no-match', path);
      let positions = found.at;
      if (ch.eof) positions = positions.filter((p) => cursor + p + o.length === file.lines.length);
      if (positions.length === 0) throw new Fail('no-match', path);
      const at = cursor + positions[0]!;
      file = applyLines(file, o, n, at, found.tier, null);
      cursor = at + n.length;
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, joinFile(file));
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, joinFile(file));
    }
  };
}

/** Parse a V4A patch (SPEC.md section 8) into one edit per section. */
function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      i++;
      const raw: Array<{ text: string; no: number }> = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let k = 0;
      while (k < raw.length && blank(raw[k]!.text)) k++;
      const fileLines: string[] = [];
      for (; k < raw.length; k++) {
        const b = raw[k]!;
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      i++;
      const raw: Array<{ text: string; no: number }> = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let k = 0;
      while (k < raw.length && blank(raw[k]!.text)) k++;
      if (k < raw.length) throw new Exit2(`error: parse ${raw[k]!.no}`);
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if ((m = /^\*\*\* Update File: (.*)$/.exec(line)) !== null) {
      const path = m[1]!.trim();
      const updateNo = i + 1;
      i++;
      while (i < last && blank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < last) {
        const mm = /^\*\*\* Move to: (.*)$/.exec(lines[i]!);
        if (mm !== null) {
          moveTo = mm[1]!.trim();
          i++;
          while (i < last && blank(lines[i]!)) i++;
        }
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '*** End of File') {
          if (cur !== null) cur.eof = true;
          cur = null;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          chunks.push(cur);
          i++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.body.push({ kind: 'del', text: l.slice(1) });
          else cur.body.push({ kind: 'add', text: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0) {
          const b = lastChunk.body[lastChunk.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') lastChunk.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  return { code: 0, out };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
