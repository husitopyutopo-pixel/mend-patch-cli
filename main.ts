// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON edits) to a tree of
// text files, exactly as SPEC.md says: every file changed or none, with the
// exit code and stdout the specification fixes. Node 22, standard library
// only, run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are, and write the CLI in run() and the parsers below.

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

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
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

/** A file split into lines at its own line break, with its final-break flag. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}
function fileState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}
function serialize(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line as a matching tier reads it: tier 0 exact, tier 1 trailing ws off, tier 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = Math.max(0, from); i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; strict: 0 only) at which pat occurs at/after `from`. */
function findTier(lines: string[], pat: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, pat, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * One replacement: O is the old lines, N the new lines; an N line flagged ctx
 * is a context line and is written as the file's own matched line, never the
 * patch's. At tier 2 every other N line is re-indented from the patch's first
 * old line to the file's first matched line.
 */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}
function buildReplacement(fileLines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = leadingWs(fileLines[at]!);
  const p = leadingWs(o[0]!);
  return n.map((item) => {
    if (item.ctx) return fileLines[at + item.oIdx]!;
    let t = item.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

/** Replace the matched lines at `at` with the replacement lines, in place. */
function spliceReplacement(st: FileState, at: number, oLen: number, repl: string[]): void {
  st.lines.splice(at, oLen, ...repl);
}

/* ---------------- format detection (SPEC section 4) ---------------- */

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

/* ---------------- unified diffs (SPEC section 6) ---------------- */

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
  /** True when this line came from a raw empty patch line (a blank line). */
  rawEmpty: boolean;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed, a/ or b/ stripped. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const push = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const newSection = (): Section => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    create: false,
    del: false,
    hasPair: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          if (l === '') body.push({ kind: 'ctx', text: '', rawEmpty: true });
          else if (l[0] === ' ') body.push({ kind: 'ctx', text: l.slice(1), rawEmpty: false });
          else if (l[0] === '-') body.push({ kind: 'old', text: l.slice(1), rawEmpty: false });
          else if (l[0] === '+') body.push({ kind: 'new', text: l.slice(1), rawEmpty: false });
          else body.push({ kind: 'back', text: l.slice(1), rawEmpty: false });
          j += 1;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it: a trailing context
      // line with empty text (written bare or as a lone space) is dropped.
      // A trailing `\` line stops the strip: it belongs to the line before it.
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur.hasPair) {
          push();
          cur = newSection();
          cur.oldPath = headerPath(line);
          cur.newPath = headerPath(lines[i + 1]!);
          cur.hasPair = true;
          inHeader = true;
          i += 2;
          continue;
        }
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    if (cur !== null && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      push();
      cur = newSection();
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  push();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Split a hunk body into its old lines O and new lines N (with context flags). */
function hunkLines(body: BodyLine[]): { o: string[]; n: NewLine[]; noEol: boolean } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let noEol = false;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k]!;
    if (b.kind === 'back') continue;
    if (b.kind === 'ctx') {
      const oIdx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
    // A `\` line right after the hunk's last context or `+` line marks no final break.
    const isLastContent =
      b.kind === 'ctx' || b.kind === 'new'
        ? !body.slice(k + 1).some((x) => x.kind === 'ctx' || x.kind === 'new')
        : false;
    if (isLastContent && body[k + 1] !== undefined && body[k + 1]!.kind === 'back') noEol = true;
  }
  return { o, n, noEol };
}

function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const { o, n, noEol } = hunkLines(hunk.body);
    if (o.length === 0) {
      const at = Math.min(Math.max(0, hunk.a + d), st.lines.length);
      const atEnd = at === st.lines.length;
      const repl = n.map((x) => x.text);
      st.lines.splice(at, 0, ...repl);
      if (atEnd) st.finalBreak = !noEol;
      d += n.length;
      continue;
    }
    const found = findTier(st.lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + o.length === st.lines.length;
    const repl = buildReplacement(st.lines, best, o, n, found.tier);
    spliceReplacement(st, best, o.length, repl);
    if (atEnd) st.finalBreak = !noEol;
    d += n.length - o.length;
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP = s.oldPath ?? s.renameFrom ?? s.diffOld;
    let newP = s.newPath ?? s.renameTo ?? s.diffNew;
    if (oldP === null) oldP = newP;
    if (newP === null) newP = oldP;
    const oldPath = oldP ?? '';
    const newPath = newP ?? '';
    const oldNull = oldPath === '/dev/null';
    const newNull = newPath === '/dev/null';
    if (!oldNull && oldPath !== '' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!newNull && newPath !== '' && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (oldNull || s.create) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const made: string[] = [];
      for (const hunk of s.hunks) {
        for (const b of hunk.body) if (b.kind === 'new') made.push(b.text);
      }
      // A created file ends with a line break unless a `\` line follows its last `+` line.
      let noEol = false;
      for (let h = s.hunks.length - 1; h >= 0; h -= 1) {
        const body = s.hunks[h]!.body;
        const idx = body.map((b) => b.kind).lastIndexOf('new');
        if (idx >= 0) {
          noEol = body[idx + 1] !== undefined && body[idx + 1]!.kind === 'back';
          break;
        }
      }
      tree.now.set(newPath, made.length === 0 ? '' : made.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (newNull || s.del) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const st = fileState(before);
      applyHunks(st, s.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, serialize(st));
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const st = fileState(before);
    applyHunks(st, s.hunks, strict, oldPath);
    tree.now.set(oldPath, serialize(st));
  };
}

/* ---------------- SEARCH/REPLACE blocks (SPEC section 7) ---------------- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eqIdx = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eqIdx = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let k = searchIdx - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = repIdx + 1;
    i = repIdx + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (oldLines.length === 0) {
      if (cur !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    if (cur === null) throw new Fail('missing', path);
    const st = fileState(cur);
    const found = findTier(st.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const n: NewLine[] = newLines.map((text) => ({ text, ctx: false, oIdx: -1 }));
    const repl = buildReplacement(st.lines, found.positions[0]!, oldLines, n, found.tier);
    spliceReplacement(st, found.positions[0]!, oldLines.length, repl);
    tree.now.set(path, serialize(st));
  };
}

/* ---------------- V4A patches (SPEC section 8) ---------------- */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  headerLine: number;
}

function v4aChunkLines(chunk: V4aChunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of chunk.body) {
    if (b.kind === 'ctx') {
      const oIdx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oIdx });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = firstIdx + 1;
  const isHeader = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const headerPath = (l: string, prefixLen: number): string => l.slice(prefixLen).trim();
  while (i < lastIdx) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = isHeader(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    if (kind === 'add') {
      const path = headerPath(line, 14);
      const collected: Array<{ text: string; fromPlus: boolean }> = [];
      i += 1;
      while (i < lastIdx) {
        const l = lines[i]!;
        if (isHeader(l) !== null) break;
        if (l.startsWith('+')) {
          collected.push({ text: l.slice(1), fromPlus: true });
          i += 1;
        } else if (l === '') {
          collected.push({ text: '', fromPlus: false });
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (collected.length > 0 && !collected[collected.length - 1]!.fromPlus) collected.pop();
      sections.push({ kind, path, moveTo: null, addLines: collected.map((c) => c.text), chunks: [], headerLine });
      continue;
    }
    if (kind === 'delete') {
      const path = headerPath(line, 17);
      i += 1;
      while (i < lastIdx) {
        const l = lines[i]!;
        if (isHeader(l) !== null) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [], headerLine });
      continue;
    }
    // Update File section.
    const path = headerPath(line, 17);
    let moveTo: string | null = null;
    const chunks: V4aChunk[] = [];
    let curChunk: V4aChunk | null = null;
    let started = false;
    i += 1;
    while (i < lastIdx) {
      const l = lines[i]!;
      if (isHeader(l) !== null) break;
      if (l === '') {
        if (curChunk !== null) curChunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        i += 1;
        continue;
      }
      if (l.startsWith('*** Move to: ') && !started && curChunk === null && moveTo === null) {
        moveTo = l.slice(13).trim();
        started = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
        chunks.push(curChunk);
        started = true;
        i += 1;
        continue;
      }
      if (l === '*** End of File' || l.trimEnd() === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
        curChunk.eof = true;
        curChunk = null;
        i += 1;
        continue;
      }
      if (l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (curChunk === null) {
          if (started) throw new Exit2(`error: parse ${i + 1}`);
          curChunk = { anchor: null, eof: false, body: [] };
          chunks.push(curChunk);
          started = true;
        }
        if (l[0] === ' ') curChunk.body.push({ kind: 'ctx', text: l.slice(1), rawEmpty: false });
        else if (l[0] === '-') curChunk.body.push({ kind: 'old', text: l.slice(1), rawEmpty: false });
        else curChunk.body.push({ kind: 'new', text: l.slice(1), rawEmpty: false });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    // Blank lines at the end of a section are not part of it: drop trailing
    // context lines with empty text from the last chunk.
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk !== undefined) {
      while (lastChunk.body.length > 0) {
        const last = lastChunk.body[lastChunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') lastChunk.body.pop();
        else break;
      }
    }
    sections.push({ kind, path, moveTo, addLines: [], chunks, headerLine });
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const st = fileState(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(st.lines, [chunk.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found.positions[0]! + 1;
      }
      const { o, n } = v4aChunkLines(chunk);
      if (o.length === 0) {
        const at = chunk.eof ? st.lines.length : cursor;
        const repl = n.map((x) => x.text);
        st.lines.splice(at, 0, ...repl);
        cursor = at + repl.length;
        continue;
      }
      const found = findTier(st.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      let positions = found.positions;
      if (chunk.eof) positions = positions.filter((p) => p + o.length === st.lines.length);
      if (positions.length === 0) throw new Fail('no-match', s.path);
      const at = positions[0]!;
      const repl = buildReplacement(st.lines, at, o, n, found.tier);
      spliceReplacement(st, at, o.length, repl);
      cursor = at + repl.length;
    }
    const result = serialize(st);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, result);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, result);
    }
  };
}

/* ---------------- JSON edits (SPEC section 9) ---------------- */

/** One JSON edit object, or null when it is not one. */
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
      const st = fileState(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.now.set(p, serialize(st));
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

/* ---------------- output rows (SPEC section 2) ---------------- */

interface Row {
  key: string;
  text: string;
  writePath: string | null;
}

function buildRows(tree: Tree): Row[] {
  const changed = [...tree.now.keys()].filter((p) => tree.now.get(p) !== tree.original(p));
  // Compose chained moves (A -> B, B -> C becomes A -> C) where the middle
  // path neither existed before nor exists after the patch.
  let pairs: Array<[string, string]> = [...tree.moves];
  let merged = true;
  while (merged) {
    merged = false;
    for (let a = 0; a < pairs.length; a += 1) {
      for (let b = 0; b < pairs.length; b += 1) {
        if (a === b) continue;
        const mid = pairs[a]![1];
        if (mid === pairs[b]![0] && tree.original(mid) === null && tree.get(mid) === null) {
          pairs[a] = [pairs[a]![0], pairs[b]![1]];
          pairs.splice(b, 1);
          merged = true;
          break;
        }
      }
      if (merged) break;
    }
  }
  const claimed = new Set<string>();
  const rows: Row[] = [];
  for (const [oldP, newP] of pairs) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      claimed.add(oldP);
      claimed.add(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}`, writePath: newP });
    }
  }
  for (const p of changed) {
    if (claimed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    const text = was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}`;
    rows.push({ key: p, text, writePath: p });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return rows;
}

/* ---------------- the command line (SPEC sections 1, 2 and 10) ---------------- */

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = buildRows(tree);
  if (!check) {
    for (const row of rows) {
      const p = row.writePath!;
      const now = tree.now.get(p);
      if (now === null || now === undefined) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    // Deletions of moved-from paths whose row was an R line.
    for (const [oldP] of tree.moves) {
      if (tree.now.get(oldP) === null && tree.original(oldP) !== null) rmSync(oldP, { force: true });
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
