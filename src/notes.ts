// Local notes: comments kept on this machine, for a coding agent, instead of on GitHub. One file
// per review in the cache, keyed like the review's branch (untangle/pr-168), so they outlive
// pushes. Each note moves with its lines when the review moves to newer commits. An agent reads
// them with `untangle watch`, answers in their threads with `untangle reply`, and may resolve
// them; what each agent has read is kept with the notes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot } from './cache.js';
import { gitMaybe } from './exec.js';
import { writeAtomic } from './server.js';

export type Side = 'LEFT' | 'RIGHT';
/** Which notes a copy takes: the open ones, the open ones not copied yet, or all of them. */
export type Scope = 'open' | 'new' | 'all';
/** Who wrote a comment or resolved a note: null for you, else the agent's name. */
export type By = string | null;

export interface NoteComment {
  id: string;
  by: By;
  body: string;
  at: string;
  edited: string | null;
  /** When it reached the agents (the notes' sequence then); null while held. */
  sent: number | null;
}

export interface Note {
  n: number;
  path: string;
  /** On the whole file, not on lines. */
  file: boolean;
  side: Side;
  line: number | null;
  startSide: Side | null;
  startLine: number | null;
  /** The lines' text, on the review's commits. */
  code: string[];
  /** Where it was written: the commit, the lines and their text then. */
  wrote: { head: string; path: string; line: number | null; startLine: number | null; code: string[] };
  /** Commits since it was written changed its lines (it sits on the lines that replaced them), or removed them. */
  changed: boolean;
  gone: boolean;
  resolved: { by: By; at: string } | null;
  /** In a copy for the agent already. */
  copied: boolean;
  /** The GitHub thread it answers, quoted. */
  quote: { thread: string; author: string; body: string; url: string } | null;
  comments: NoteComment[];
}

/** What changed besides new comments, for the agents: by the notes' sequence. */
interface NoteEvent { seq: number; type: 'edit' | 'resolve' | 'reopen' | 'delete' | 'post'; n: number; by: By; id?: string; sent?: number | null }

interface Stored {
  version: 1;
  /** Where new comments go, once chosen. */
  mode: 'local' | 'github' | null;
  /** Live review: notes and replies reach agents as they're written; else when they're sent. */
  live: boolean;
  /** The line a copy for the agent opens with. */
  opening: string;
  scope: Scope;
  /** The commits the notes' lines are on. */
  base: string | null;
  head: string | null;
  next: number;
  seq: number;
  notes: Note[];
  events: NoteEvent[];
  agents: Record<string, { seen: number; first: string; told: boolean }>;
}

/** The review the notes are on, as they need it. */
export interface NotesContext {
  repo: string;
  base: string;
  head: string;
  /** owner/repo#168, or the repository's name. */
  name: string;
  branch: string | null;
  /** The change a line is in: its chain's name and the commit that started it. */
  change(path: string, side: Side, line: number): { name: string; sha: string | null } | null;
  /** Posts into the pending review on GitHub: a thread on lines or a file, or a reply. Null without GitHub. */
  post: ((p: Post) => Promise<unknown>) | null;
}
export type Post = { thread: string; body: string } | { path: string; body: string; line?: number; side?: Side; startLine?: number; startSide?: Side };

export type NoteAction =
  | { action: 'add'; path: string; body: string; file?: boolean; side?: Side; line?: number; startSide?: Side; startLine?: number; quote?: { thread: string; author: string; body: string; url: string } }
  | { action: 'reply'; n: number; body: string }
  | { action: 'edit'; n: number; id: string; body: string }
  | { action: 'delete'; n: number; id?: string }
  | { action: 'resolve'; n: number; resolved: boolean }
  | { action: 'settings'; mode?: 'local' | 'github'; live?: boolean; opening?: string; scope?: Scope }
  | { action: 'copied'; ns: number[] }
  | { action: 'send' }
  | { action: 'post'; ns: number[] };

export class NoteError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const DEFAULT_OPENING = 'Discuss these with me before changing anything.';
// A burst of notes reaches a waiting agent together: this long after the last one.
const QUIET = Number(process.env.UNTANGLE_NOTES_QUIET) >= 0 && process.env.UNTANGLE_NOTES_QUIET ? Number(process.env.UNTANGLE_NOTES_QUIET) : 3000;
// An agent shows as working on the notes for this long after its watch returned them.
const WORKING = 15 * 60_000;
const MAX_BODY = 64 << 10;
const MAX_EVENTS = 500;

/** The notes file of a review: per repository, named like the review's branch. */
export const notesFile = (repoKey: string, key: string) => path.join(cacheRoot(), 'notes', repoKey, encodeURIComponent(key) + '.json');

const short = (sha: string) => sha.slice(0, 7);
const range = (from: number | null, to: number | null) => (to == null ? '' : from != null && from !== to ? `${from}-${to}` : String(to));
// A fence longer than any run of backticks in the code, so the code can't close it.
const fence = (code: string[]) => '`'.repeat(Math.max(3, ...code.map((l) => Math.max(0, ...(l.match(/`+/g) || []).map((r) => r.length + 1)))));
const FENCE_LANG: Record<string, string> = { dart: 'dart', yaml: 'yaml', yml: 'yaml', json: 'json', sql: 'sql', md: 'markdown', ts: 'ts', js: 'js', mjs: 'js', sh: 'sh', py: 'python', kt: 'kotlin', swift: 'swift', java: 'java', go: 'go', rs: 'rust', html: 'html', css: 'css', proto: 'proto' };
const langOf = (p: string) => FENCE_LANG[path.extname(p).slice(1).toLowerCase()] || '';
const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** A file's hunks between two commits, from `git diff -U0`: [old start, old count, new start, new count]. */
type Hunk = [number, number, number, number];
interface FileDiff { to: string | null; hunks: Hunk[]; binary: boolean }

// A path as git prints it in a diff's header: as it is, or quoted with C escapes.
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(["\\tn])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c)) : s);

/** The files a diff changes, by their old path: where each went, and its hunks. */
export function parseDiff(text: string): Map<string, FileDiff> {
  const out = new Map<string, FileDiff>();
  let cur: { from: string | null; to: string | null; hunks: Hunk[]; binary: boolean; deleted: boolean; added: boolean; header: string } | null = null;
  let body = false;
  const flush = () => {
    // A new file was nowhere before.
    if (!cur || cur.added) return;
    // A file with no ---/+++ lines (a rename alone, a binary file) is named by its header.
    if (!cur.from) { const m = /^diff --git a\/(.*) b\/(.*)$/.exec(cur.header); if (m) { cur.from = m[1]; cur.to ??= m[2]; } }
    if (cur.from) out.set(cur.from, { to: cur.deleted ? null : cur.to, hunks: cur.hunks, binary: cur.binary });
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); cur = { from: null, to: null, hunks: [], binary: false, deleted: false, added: false, header: line }; body = false; continue; }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      body = true;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) cur.hunks.push([+m[1], m[2] == null ? 1 : +m[2], +m[3], m[4] == null ? 1 : +m[4]]);
      continue;
    }
    // Past the first hunk, every line is the file's own, whatever it starts with.
    if (body) continue;
    if (line.startsWith('deleted file mode')) cur.deleted = true;
    else if (line.startsWith('new file mode')) cur.added = true;
    else if (line.startsWith('rename from ')) cur.from = unquote(line.slice(12));
    else if (line.startsWith('rename to ')) cur.to = unquote(line.slice(10));
    else if (line.startsWith('--- ')) { const p = unquote(line.slice(4)); if (p !== '/dev/null') cur.from = p.replace(/^a\//, ''); }
    else if (line.startsWith('+++ ')) { const p = unquote(line.slice(4)); if (p === '/dev/null') cur.deleted = true; else cur.to = p.replace(/^b\//, ''); }
    else if (line.startsWith('Binary files ')) cur.binary = true;
  }
  flush();
  return out;
}

/** Where line `l` went through the hunks, or null when they changed it. */
export function mapLine(hunks: Hunk[], l: number): number | null {
  let off = 0;
  for (const [os, oc, , nc] of hunks) {
    if (oc && l >= os && l < os + oc) return null;
    // A pure insertion follows line os.
    if (oc ? os + oc - 1 < l : os < l) off += nc - oc;
  }
  return l + off;
}

/**
 * Where the lines from `from` to `to` went: unchanged lines shift, and an end the hunks changed
 * lands on the lines that replaced it. Null when they're gone, with nothing in their place.
 */
export function follow(hunks: Hunk[], from: number, to: number): { from: number; to: number; changed: boolean } | null {
  const changed = hunks.some(([os, oc]) => (oc ? os <= to && os + oc - 1 >= from : os >= from && os < to));
  const at = (l: number) => hunks.find(([os, oc]) => oc && l >= os && l < os + oc)!;
  let a = mapLine(hunks, from), b = mapLine(hunks, to);
  if (a == null) { const h = at(from); a = h[3] ? h[2] : null; }
  if (b == null) { const h = at(to); b = h[3] ? h[2] + h[3] - 1 : null; }
  if (a == null && b == null) return null;
  const [x, y] = [a ?? b!, b ?? a!];
  return { from: Math.min(x, y), to: Math.max(x, y), changed };
}

export class Notes {
  private data: Stored;
  private ctx: NotesContext | null = null;
  // Bumped on every change, the agents' coming and going included: pages ask again when it moves.
  private rev = 0;
  private closed = false;
  private lastSent = 0;
  private readonly waiters = new Set<() => void>();
  // Watches waiting now, by agent, and when each agent's last watch returned what it read.
  private readonly watching = new Map<string, number>();
  private readonly back = new Map<string, number>();
  private readonly lines = new Map<string, string[] | null>();

  constructor(
    readonly file: string,
    /** Told after each change: the pages hear of it. */
    private readonly changed: () => void = () => {},
  ) {
    this.data = { version: 1, mode: null, live: true, opening: DEFAULT_OPENING, scope: 'open', base: null, head: null, next: 1, seq: 0, notes: [], events: [], agents: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Stored>;
      if (saved && saved.version === 1 && Array.isArray(saved.notes)) this.data = { ...this.data, ...saved };
    } catch {
      // No notes yet.
    }
  }

  /** The review the notes are on now: they move there from the commits they were on. */
  attach(ctx: NotesContext): void {
    this.ctx = ctx;
    this.lines.clear();
    const d = this.data;
    if (d.notes.length && d.head && (d.head !== ctx.head || d.base !== ctx.base)) this.move({ base: d.base || ctx.base, head: d.head }, ctx);
    d.base = ctx.base;
    d.head = ctx.head;
    if (d.notes.length) this.save();
    this.touch();
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.data));
  }

  private touch() {
    this.rev++;
    this.changed();
    this.waiters.forEach((w) => w());
  }

  /** The text of a file at a commit, by line; null when it isn't there. */
  private fileAt(sha: string, p: string): string[] | null {
    const key = sha + ':' + p;
    if (!this.lines.has(key)) {
      if (this.lines.size > 200) this.lines.clear();
      const text = this.ctx ? gitMaybe(this.ctx.repo, 'show', `${sha}:${p}`) : null;
      this.lines.set(key, text == null ? null : text.replace(/\n$/, '').split('\n'));
    }
    return this.lines.get(key)!;
  }

  private codeOf(sha: string, p: string, from: number | null, to: number | null): string[] {
    if (to == null) return [];
    const all = this.fileAt(sha, p) || [];
    return all.slice((from ?? to) - 1, to);
  }

  /** Moves every note from the commits it's on to the review's, through the diffs between them. */
  private move(from: { base: string; head: string }, ctx: NotesContext) {
    const diff = (a: string, b: string) => {
      if (a === b) return new Map<string, FileDiff>();
      // An old head this clone doesn't have may still be on GitHub.
      if (gitMaybe(ctx.repo, 'cat-file', '-e', `${a}^{commit}`) === null) gitMaybe(ctx.repo, 'fetch', '--quiet', '--no-tags', 'origin', a);
      const text = gitMaybe(ctx.repo, '-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', a, b, '--');
      return text == null ? null : parseDiff(text);
    };
    const diffs = { RIGHT: diff(from.head, ctx.head), LEFT: diff(from.base, ctx.base) };
    for (const note of this.data.notes) {
      if (note.gone) continue;
      const sha = note.side === 'LEFT' ? ctx.base : ctx.head;
      const d = diffs[note.side];
      if (!d) {
        // Without the old commit, the lines stay where they were: changed if their text did.
        const now = this.codeOf(sha, note.path, note.startLine, note.line);
        if (now.join('\n') !== note.code.join('\n')) note.changed = true;
        note.code = now;
        continue;
      }
      const f = d.get(note.path);
      if (f && f.to === null) { note.gone = true; continue; }
      if (f) note.path = f.to!;
      if (f && !note.file) {
        const r = f.binary ? null : follow(f.hunks, note.startLine ?? note.line!, note.line!);
        if (!r) { note.gone = true; continue; }
        note.changed ||= r.changed;
        // A line replaced by several leaves its note on all of them.
        note.line = r.to;
        note.startLine = r.from !== r.to ? r.from : null;
        note.startSide = note.startLine == null ? null : note.side;
      } else if (f && (f.hunks.length || f.binary)) note.changed = true;
      note.code = this.codeOf(sha, note.path, note.startLine, note.line);
    }
  }

  private note(n: number): Note {
    const note = this.data.notes.find((x) => x.n === n);
    if (!note) throw new NoteError(`there is no note N${n}${this.data.notes.length ? ` (the notes are ${this.data.notes.map((x) => 'N' + x.n).join(', ')})` : ''}`, 404);
    return note;
  }

  private body(text: unknown): string {
    const body = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
    if (!body) throw new NoteError('a note needs some text');
    if (body.length > MAX_BODY) throw new NoteError('that is too long for a note');
    return body;
  }

  /** A comment, sent to the agents now, or held for later when live review is off (yours only). */
  private comment(by: By, body: string): NoteComment {
    const held = by === null && !this.data.live;
    const c: NoteComment = { id: crypto.randomBytes(6).toString('hex'), by, body, at: new Date().toISOString(), edited: null, sent: held ? null : ++this.data.seq };
    if (!held) this.lastSent = Date.now();
    return c;
  }

  private event(e: Omit<NoteEvent, 'seq'>) {
    this.data.events.push({ ...e, seq: ++this.data.seq });
    if (this.data.events.length > MAX_EVENTS) this.data.events.splice(0, this.data.events.length - MAX_EVENTS);
    this.lastSent = Date.now();
  }

  // ---- What the agent reads: the same text for the copy, `untangle notes` and `untangle watch`.

  private where(note: Note): string {
    if (note.file) return `${note.path} (the whole file)`;
    const at = `${note.path}:${range(note.startLine, note.line)}`;
    return note.side === 'LEFT' ? `${at}, removed lines (numbered as on the base)` : at;
  }

  /** The head of a copy: what the notes are on. */
  header(): string {
    const ctx = this.ctx;
    if (!ctx) return 'My review notes.';
    return `My review notes on ${ctx.name}${ctx.branch ? ` (branch ${ctx.branch}, at ${short(ctx.head)})` : ` (at ${short(ctx.head)})`}. Line numbers are on that commit.`;
  }

  /** One note for the agent: where it is, the change it's in, its code and its thread. */
  noteText(note: Note): string {
    const lines = [`N${note.n} · ${this.where(note)}${note.resolved ? ' (resolved)' : ''}`];
    const change = !note.file && note.line != null && !note.gone && this.ctx ? this.ctx.change(note.path, note.side, note.line) : null;
    if (change) lines.push(`In the change "${change.name}"${change.sha ? ` (${short(change.sha)})` : ''}`);
    if (note.quote) lines.push(`Answering ${note.quote.author} on GitHub (${note.quote.url}):`, ...note.quote.body.split('\n').map((l) => '> ' + l));
    if (note.gone) lines.push(`Gone since ${short(note.wrote.head)}, where I wrote this. The lines below are the ones it was on then.`);
    else if (note.changed) lines.push(`Changed since ${short(note.wrote.head)}, where I wrote this. The lines below are the new ones.`);
    const code = note.gone ? note.wrote.code : note.code;
    if (code.length) { const f = fence(code); lines.push(f + langOf(note.path), ...code, f); }
    const [first, ...replies] = note.comments;
    lines.push(first.body, ...replies.map((c) => `${c.by ?? 'You'}: ${c.body}`));
    return lines.join('\n') + '\n';
  }

  private inScope(scope: Scope): Note[] {
    const open = (n: Note) => !n.resolved;
    return this.data.notes.filter(scope === 'all' ? () => true : scope === 'new' ? (n) => open(n) && !n.copied : open);
  }

  /** The copy for the agent: the head, the opening line, then the notes. */
  exportText(scope: Scope, opening = this.data.opening): string {
    const list = this.inScope(scope);
    return [this.header() + '\n', opening.trim() && opening.trim() + '\n', ...(list.length ? list.map((n) => this.noteText(n)) : ['No notes to send.\n'])].filter(Boolean).join('\n');
  }

  // ---- The page

  /** What the page shows: the settings, the notes with their text, and the agents. */
  view() {
    const d = this.data;
    const read = (note: Note) => {
      const sent = note.comments[0].sent;
      if (sent == null) return 'held';
      const by = Object.entries(d.agents).find(([, a]) => a.seen >= sent);
      return by ? { read: by[0] } : Object.keys(d.agents).length ? 'queued' : null;
    };
    return {
      rev: this.rev, mode: d.mode, live: d.live, opening: d.opening, scope: d.scope, head: d.head, header: this.header(),
      held: d.notes.reduce((k, n) => k + n.comments.filter((c) => c.by === null && c.sent == null).length, 0),
      notes: d.notes.map((n) => ({ ...n, text: this.noteText(n), status: read(n) })),
      agents: this.agents(),
    };
  }

  /** The agents holding the review: waiting for notes now, or working on the last ones. */
  agents(): Array<{ name: string; state: 'watching' | 'working'; since: string }> {
    const now = Date.now();
    return Object.entries(this.data.agents)
      .map(([name]) => {
        if (this.watching.get(name)) return { name, state: 'watching' as const, since: new Date(now).toISOString() };
        const back = this.back.get(name);
        return back && now - back < WORKING ? { name, state: 'working' as const, since: new Date(back).toISOString() } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }

  /** Whether an agent holds the review now: untangle then looks for its commits more often. */
  watched(): boolean {
    return this.agents().length > 0;
  }

  async act(a: NoteAction): Promise<ReturnType<Notes['view']> & { conversation?: unknown }> {
    const d = this.data;
    const ctx = this.ctx;
    if (!ctx) throw new NoteError('the review is still being built', 503);
    let conversation: unknown;
    switch (a.action) {
      case 'add': {
        const body = this.body(a.body);
        const file = !!a.file || a.line == null;
        if (typeof a.path !== 'string') throw new NoteError('which file?');
        // A note on a deleted file is on the base's.
        const side: Side = a.side === 'LEFT' || (file && !this.fileAt(ctx.head, a.path)) ? 'LEFT' : 'RIGHT';
        const sha = side === 'LEFT' ? ctx.base : ctx.head;
        if (!this.fileAt(sha, a.path)) throw new NoteError(`${a.path} is not a file of this review`);
        const line = file ? null : Number(a.line);
        // A note's lines are on one side: the page sends a range across both as its new lines.
        const startLine = file || a.startLine == null || Number(a.startLine) === line ? null : Number(a.startLine);
        if (!file && (!Number.isInteger(line) || line! < 1 || (startLine != null && (!Number.isInteger(startLine) || startLine < 1 || startLine > line!)))) throw new NoteError('which lines?');
        const startSide = startLine == null ? null : side;
        const code = this.codeOf(sha, a.path, startLine, line);
        const q = a.quote && typeof a.quote.thread === 'string' ? { thread: a.quote.thread, author: String(a.quote.author || ''), body: String(a.quote.body || '').slice(0, 4000), url: String(a.quote.url || '') } : null;
        d.notes.push({
          n: d.next++, path: a.path, file, side, line, startSide, startLine, code,
          wrote: { head: ctx.head, path: a.path, line, startLine, code }, changed: false, gone: false,
          resolved: null, copied: false, quote: q, comments: [this.comment(null, body)],
        });
        break;
      }
      case 'reply':
        this.note(a.n).comments.push(this.comment(null, this.body(a.body)));
        break;
      case 'edit': {
        const note = this.note(a.n);
        const c = note.comments.find((x) => x.id === a.id);
        if (!c || c.by !== null) throw new NoteError('only your own comments can be edited');
        c.body = this.body(a.body);
        c.edited = new Date().toISOString();
        if (c.sent != null) this.event({ type: 'edit', n: note.n, by: null, id: c.id });
        break;
      }
      case 'delete': {
        const note = this.note(a.n);
        if (a.id && a.id !== note.comments[0].id) {
          const i = note.comments.findIndex((x) => x.id === a.id && x.by === null);
          if (i < 0) throw new NoteError('only your own comments can be deleted');
          note.comments.splice(i, 1);
          break;
        }
        d.notes.splice(d.notes.indexOf(note), 1);
        if (note.comments[0].sent != null) this.event({ type: 'delete', n: note.n, by: null, sent: note.comments[0].sent });
        break;
      }
      case 'resolve': {
        const note = this.note(a.n);
        if (!!note.resolved === !!a.resolved) break;
        note.resolved = a.resolved ? { by: null, at: new Date().toISOString() } : null;
        if (note.comments[0].sent != null) this.event({ type: a.resolved ? 'resolve' : 'reopen', n: note.n, by: null });
        break;
      }
      case 'settings': {
        if (a.mode === 'local' || a.mode === 'github') d.mode = a.mode;
        if (typeof a.opening === 'string') d.opening = a.opening.slice(0, 4000);
        if (a.scope === 'open' || a.scope === 'new' || a.scope === 'all') d.scope = a.scope;
        if (typeof a.live === 'boolean' && a.live !== d.live) {
          d.live = a.live;
          // Back to live, what was held goes now.
          if (a.live) this.release();
        }
        break;
      }
      case 'copied':
        (Array.isArray(a.ns) ? a.ns : []).forEach((n) => { const note = d.notes.find((x) => x.n === n); if (note) note.copied = true; });
        break;
      case 'send':
        this.release();
        break;
      case 'post': {
        if (!ctx.post) throw new NoteError('Posting needs the pull request on GitHub, through gh (gh auth login).');
        const list = (Array.isArray(a.ns) ? a.ns : []).map((n) => this.note(n)).filter((n) => !n.resolved && !n.gone);
        if (!list.length) throw new NoteError('no open notes to post');
        for (const note of list) {
          const body = note.comments[0].body;
          const p: Post = note.quote ? { thread: note.quote.thread, body }
            : note.file ? { path: note.path, body }
              : { path: note.path, body, line: note.line!, side: note.side, ...(note.startLine != null ? { startLine: note.startLine, startSide: note.startSide || note.side } : {}) };
          try {
            conversation = await ctx.post(p);
          } catch (e) {
            // The ones posted so far have left the notes.
            this.save();
            this.touch();
            throw new NoteError(`N${note.n} could not be posted: ${(e as Error).message}`, 502);
          }
          d.notes.splice(d.notes.indexOf(note), 1);
          if (note.comments[0].sent != null) this.event({ type: 'post', n: note.n, by: null, sent: note.comments[0].sent });
        }
        break;
      }
      default:
        throw new NoteError('no such action');
    }
    this.save();
    this.touch();
    return conversation === undefined ? this.view() : { ...this.view(), conversation };
  }

  /** Sends what live review held: your notes and replies, in the order they were written. */
  private release() {
    const held = this.data.notes.flatMap((n) => n.comments.filter((c) => c.by === null && c.sent == null)).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    held.forEach((c) => { c.sent = ++this.data.seq; });
    if (held.length) this.lastSent = Date.now();
  }

  // ---- The agents

  /** An agent's answer in a note's thread, and its resolving the note when it's done. */
  reply(agent: string, n: number, body: string | null, resolve: boolean): { n: number; resolved: boolean } {
    const note = this.note(n);
    if (body != null) note.comments.push(this.comment(agent, this.body(body)));
    if (resolve && !note.resolved) {
      note.resolved = { by: agent, at: new Date().toISOString() };
      this.event({ type: 'resolve', n, by: agent });
    }
    this.save();
    this.touch();
    return { n, resolved: !!note.resolved };
  }

  /** What an agent hasn't read: comments by others, and what changed on notes it has read. */
  private unseen(agent: string) {
    const seen = this.data.agents[agent]?.seen ?? 0;
    const fresh = (c: NoteComment) => c.sent != null && c.sent > seen && c.by !== agent;
    const knew = (note: Note) => note.comments[0].sent != null && note.comments[0].sent <= seen;
    const notes: Note[] = [], threads: Note[] = [], lines: string[] = [];
    this.data.notes.forEach((note) => {
      if (fresh(note.comments[0])) notes.push(note);
      else if (note.comments.slice(1).some(fresh)) threads.push(note);
    });
    const told = new Set([...notes, ...threads].map((x) => x.n));
    this.data.events.filter((e) => e.seq > seen && e.by !== agent).forEach((e) => {
      const note = this.data.notes.find((x) => x.n === e.n);
      if (e.type === 'delete' || e.type === 'post') { if (e.sent != null && e.sent <= seen) lines.push(`N${e.n} · ${e.type === 'post' ? 'posted to GitHub: it left the notes.' : `${e.by ?? 'you'} deleted it.`}`); return; }
      if (!note || told.has(note.n) || !knew(note)) return;
      if (e.type === 'edit') { const c = note.comments.find((x) => x.id === e.id); if (c) lines.push(`N${note.n} · ${this.where(note)} · ${e.by ?? 'you'} edited ${c === note.comments[0] ? 'the note' : 'a reply'}:\n${c.body}`); return; }
      lines.push(`N${note.n} · ${this.where(note)} · ${e.type === 'resolve' ? `resolved by ${e.by ?? 'you'}` : `reopened by ${e.by ?? 'you'}`}.`);
    });
    const replies = threads.reduce((k, note) => k + note.comments.slice(1).filter(fresh).length, 0);
    return { notes, threads, lines, replies, count: notes.length + replies + lines.length };
  }

  private threadText(note: Note): string {
    const [first, ...rest] = note.comments;
    return [`N${note.n} · ${this.where(note)} · ${rest.length === 1 ? 'a reply' : 'replies'} in its thread`, ...first.body.split('\n').map((l) => '> ' + l), ...rest.map((c) => `${c.by ?? 'You'}: ${c.body}`)].join('\n') + '\n';
  }

  /** Delivers what's new to an agent, as text, and remembers that it read it. */
  private deliver(agent: string) {
    const u = this.unseen(agent);
    const a = this.data.agents[agent];
    const counts = [u.notes.length && plural(u.notes.length, 'note', 'notes'), u.replies && plural(u.replies, 'reply', 'replies'), u.lines.length && plural(u.lines.length, 'change', 'changes')].filter(Boolean).join(' and ');
    const parts: string[] = [];
    if (u.notes.length) {
      if (this.data.opening.trim()) parts.push(this.data.opening.trim() + '\n');
      parts.push(...u.notes.map((n) => this.noteText(n)));
    }
    parts.push(...u.threads.map((n) => this.threadText(n)), ...u.lines.map((l) => l + '\n'));
    const ctx = this.ctx!;
    const text = `untangle: ${counts.replace(/ and (?=[^,]* and )/, ', ')} you haven’t read, on ${ctx.name} at ${short(ctx.head)}. Line numbers are on that commit.\n\n${parts.join('\n')}`;
    const first = !a.told;
    a.seen = this.data.seq;
    a.told = true;
    this.back.set(agent, Date.now());
    this.save();
    return { text, notes: u.notes.length, replies: u.replies, first };
  }

  /**
   * Waits for what an agent hasn't read, a moment after the last of it, then delivers it. Settles
   * early when the review closes, when the wait runs out, or when the agent stops asking.
   */
  watch(agent: string, opts: { timeout: number; signal?: AbortSignal }): Promise<{ text: string; notes: number; replies: number; first: boolean } | { idle: true; first: boolean } | { closed: true }> {
    const d = this.data;
    if (!d.agents[agent]) d.agents[agent] = { seen: 0, first: new Date().toISOString(), told: false };
    this.watching.set(agent, (this.watching.get(agent) || 0) + 1);
    this.touch();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null, quiet: NodeJS.Timeout | null = null;
      const done = (answer: Parameters<typeof resolve>[0] | null) => {
        this.waiters.delete(check);
        if (timer) clearTimeout(timer);
        if (quiet) clearTimeout(quiet);
        opts.signal?.removeEventListener('abort', aborted);
        this.watching.set(agent, (this.watching.get(agent) || 1) - 1);
        if (!this.watching.get(agent)) this.watching.delete(agent);
        this.touch();
        if (answer) resolve(answer);
      };
      const check = () => {
        if (this.closed) return done({ closed: true });
        if (!this.ctx || !this.unseen(agent).count) return;
        const wait = QUIET - (Date.now() - this.lastSent);
        if (wait > 0) { if (!quiet) quiet = setTimeout(() => { quiet = null; check(); }, wait); return; }
        done(this.deliver(agent));
      };
      const aborted = () => done(null);
      if (opts.signal?.aborted) return aborted();
      opts.signal?.addEventListener('abort', aborted);
      if (opts.timeout > 0) timer = setTimeout(() => { const first = !d.agents[agent].told; d.agents[agent].told = true; this.save(); done({ idle: true, first }); }, opts.timeout);
      this.waiters.add(check);
      check();
    });
  }

  /** The review is closing: waiting agents hear so. */
  close(): void {
    this.closed = true;
    this.waiters.forEach((w) => w());
  }

  /** Changes so far: a page whose notes are older asks again. */
  get revision(): number { return this.rev; }
}
