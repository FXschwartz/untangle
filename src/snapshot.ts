// The reviewed snapshot: your review as a git ref of the repository reviewed, the base plus every
// change you marked reviewed. It isn't a branch, so branch lists leave it out, and
// `git diff untangle/marks/<key> <head>` shows what's left. Marks come back from its content, not
// from a list of ids, so a push to the pull request only brings back what changed since you
// looked. When the base moves (a rebase), it's replayed onto the new base with a 3-way merge
// (mergiraf first, when it's installed); regions that still conflict go back to unreviewed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandError, git, gitMaybe, has, run } from './exec.js';

type Row = [string, string, ...unknown[]];
interface Block { id: string; hunk: number; first: number; len: number; edits: number[]; movedTo?: { b: string } }
interface File { p: string; s: string; hunks: Array<{ o: number; n: number; rows: Row[] }>; blocks: Block[] }
/** The part of a comparison's model the snapshot needs. */
export interface ModelCompare { files: File[]; generated: Array<{ p: string; s: string }> }

interface Entry { mode: string; blob: string }

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const ZERO = '0'.repeat(40);

/** Where reviews keep their marks: refs that aren't branches. */
export const MARKS = 'refs/untangle/marks/';

/** The ref of a review's marks: named for its pull request's number, or the branch it reviews. */
export function marksRef(repo: string, key: string): string {
  const ref = MARKS + key.replace(/[^\w./-]+/g, '-').replace(/\.{2,}|\/{2,}/g, '-').replace(/^[-./]+|[-./]+$/g, '');
  return gitMaybe(repo, 'check-ref-format', ref) !== null ? ref : MARKS + 'review';
}

/** The branch older untangles kept a review's marks on. */
const oldBranch = (ref: string) => 'untangle/' + ref.slice(MARKS.length);

/**
 * Moves a review's marks from the branch older untangles kept them on. The branch stays while
 * it's checked out, or when it holds marks the ref doesn't.
 */
export function moveMarks(repo: string, ref: string): void {
  const branch = oldBranch(ref);
  const old = gitMaybe(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`)?.trim();
  if (!old) return;
  if (!gitMaybe(repo, 'rev-parse', '--verify', '--quiet', ref)) gitMaybe(repo, 'update-ref', ref, old, ZERO);
  if (gitMaybe(repo, 'merge-base', '--is-ancestor', old, ref) !== null) gitMaybe(repo, 'branch', '-D', branch);
}

/** Removes a review's marks: their ref, and the branch an older untangle kept them on, unless it's checked out. */
export function dropMarks(repo: string, ref: string): void {
  gitMaybe(repo, 'update-ref', '-d', ref);
  gitMaybe(repo, 'branch', '-D', oldBranch(ref));
}

function diffHunks(text: string): Array<{ a: number; b: number; c: number; d: number }> {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) out.push({ a: +m[1], b: m[2] == null ? 1 : +m[2], c: +m[3], d: m[4] == null ? 1 : +m[4] });
  }
  return out;
}

export class Snapshot {
  /** The ref's short name, as git diff takes it: untangle/marks/pr-168. */
  readonly name: string;
  private readonly trees = new Map<string, Map<string, Entry>>();
  private readonly byId = new Map<string, Block>();
  // The reviewed blocks the ref holds now.
  private current = new Set<string>();

  constructor(
    private readonly repo: string,
    readonly ref: string,
    private readonly baseSha: string,
    private readonly headSha: string,
    private readonly model: ModelCompare,
  ) {
    this.name = ref.replace(/^refs\//, '');
    model.files.forEach((f) => f.blocks.forEach((b) => this.byId.set(b.id, b)));
  }

  /** Path -> mode and blob, for a whole tree. */
  private tree(rev: string): Map<string, Entry> {
    let t = this.trees.get(rev);
    if (!t) {
      t = new Map();
      for (const row of git(this.repo, 'ls-tree', '-r', '-z', rev).split('\0')) {
        if (!row) continue;
        const tab = row.indexOf('\t');
        const [mode, , blob] = row.slice(0, tab).split(' ');
        t.set(row.slice(tab + 1), { mode, blob });
      }
      this.trees.set(rev, t);
    }
    return t;
  }

  private blob(sha: string | undefined): string {
    return sha ? git(this.repo, 'cat-file', 'blob', sha) : '';
  }

  /** The ref's commit, and the base and head it was written for. */
  tip(): { commit: string; tree: string; base: string | null; head: string | null } | null {
    const commit = gitMaybe(this.repo, 'rev-parse', '--verify', '--quiet', this.ref + '^{commit}')?.trim();
    if (!commit) return null;
    const message = git(this.repo, 'log', '-1', '--format=%B', commit);
    const trailer = (k: string) => (new RegExp(`^${k}: ([0-9a-f]{40})$`, 'm').exec(message) || [])[1] || null;
    return { commit, tree: git(this.repo, 'rev-parse', commit + '^{tree}').trim(), base: trailer('Untangle-Base'), head: trailer('Untangle-Head') };
  }

  /** Whether a block is in the snapshot when these blocks are reviewed. Blocks with nothing to review (layout, moved code) follow along. */
  private applied(b: Block, reviewed: Set<string>): boolean {
    if (b.edits.length) return reviewed.has(b.id);
    const to = b.movedTo && this.byId.get(b.movedTo.b);
    return to && to.edits.length ? reviewed.has(to.id) : true;
  }

  /** A file's content with some of its blocks applied to the base version. */
  private content(f: File, apply: (b: Block) => boolean): string {
    const base = this.blob(this.tree(this.baseSha).get(f.p)?.blob);
    const lines = base === '' ? [] : base.split('\n');
    const blockOf = new Map<string, Block>();
    f.blocks.forEach((b) => { for (let i = b.first; i < b.first + b.len; i++) blockOf.set(b.hunk + ':' + i, b); });
    const out: string[] = [];
    let next = 0;
    f.hunks.forEach((h, hi) => {
      // Lines before the hunk, as in the base. A hunk at -0 (an added file) starts at 0.
      const start = Math.max(0, h.o - (h.rows.some((r) => r[0] !== '+') ? 1 : 0));
      while (next < start) out.push(lines[next++]);
      h.rows.forEach((r, ri) => {
        const b = blockOf.get(hi + ':' + ri);
        if (r[0] === ' ') { out.push(lines[next++]); return; }
        const take = b ? apply(b) : false;
        if (r[0] === '-') { if (!take) out.push(lines[next]); next++; } else if (take) out.push(r[1]);
      });
    });
    while (next < lines.length) out.push(lines[next++]);
    let text = out.join('\n');
    // An added file has no base to carry its final newline: take the head's.
    if (base === '' && text && !text.endsWith('\n') && this.blob(this.tree(this.headSha).get(f.p)?.blob).endsWith('\n')) text += '\n';
    return text;
  }

  private writeTree(base: string, changes: Map<string, Entry | null>): string {
    const index = path.join(os.tmpdir(), `untangle-index-${process.pid}-${Date.now()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      run('git', ['-C', this.repo, 'read-tree', base], { env });
      const lines = [...changes].map(([p, e]) => (e ? `${e.mode} ${e.blob}\t${p}` : `0 ${ZERO}\t${p}`));
      if (lines.length) run('git', ['-C', this.repo, 'update-index', '-z', '--index-info'], { env, input: lines.join('\0') + '\0' });
      return run('git', ['-C', this.repo, 'write-tree'], { env }).trim();
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  private hashBlob(text: string): string {
    return run('git', ['-C', this.repo, 'hash-object', '-w', '--stdin'], { input: text }).trim();
  }

  /**
   * The snapshot tree for a set of reviewed blocks. A file whose blocks didn't change keeps the
   * ref's version, which may hold what you reviewed before a push changed it; the others are
   * the base with their reviewed blocks applied. Generated files are taken from the head.
   */
  treeFor(reviewed: Set<string>): string {
    const base = this.tree(this.baseSha), head = this.tree(this.headSha);
    const tip = this.tip(), snap = tip && tip.base === this.baseSha ? this.tree(tip.commit) : null;
    const changes = new Map<string, Entry | null>();
    for (const f of this.model.files) {
      const apply = (b: Block) => this.applied(b, reviewed);
      if (snap && f.blocks.every((b) => apply(b) === this.applied(b, this.current))) {
        if (snap.get(f.p)?.blob !== base.get(f.p)?.blob) changes.set(f.p, snap.get(f.p) ?? null);
        continue;
      }
      const all = f.blocks.every(apply), none = !f.blocks.some(apply);
      if (none) continue;
      if (all) changes.set(f.p, head.get(f.p) ?? null);
      else changes.set(f.p, { mode: (base.get(f.p) || head.get(f.p) || { mode: '100644' }).mode, blob: this.hashBlob(this.content(f, apply)) });
    }
    for (const g of this.model.generated) changes.set(g.p, head.get(g.p) ?? null);
    return this.writeTree(this.baseSha, changes);
  }

  private commit(tree: string, parent: string | null, subject: string, base: string): string {
    const env: NodeJS.ProcessEnv = {};
    if (!gitMaybe(this.repo, 'config', 'user.email')?.trim()) Object.assign(env, { GIT_AUTHOR_NAME: 'untangle', GIT_AUTHOR_EMAIL: 'untangle@localhost', GIT_COMMITTER_NAME: 'untangle', GIT_COMMITTER_EMAIL: 'untangle@localhost' });
    const message = `${subject}\n\nUntangle-Base: ${base}\nUntangle-Head: ${this.headSha}\n`;
    return run('git', ['-C', this.repo, 'commit-tree', tree, ...(parent ? ['-p', parent] : ['-p', base]), '-F', '-'], { env, input: message }).trim();
  }

  private update(commit: string, old: string | null) {
    git(this.repo, 'update-ref', '-m', 'untangle: review marks', this.ref, commit, old ?? ZERO);
  }

  /** Whether a set of reviewed blocks differs from what the ref holds. */
  differs(reviewed: Set<string>): boolean {
    return reviewed.size !== this.current.size || [...reviewed].some((id) => !this.current.has(id));
  }

  /** Writes the ref for a set of reviewed blocks: a commit when its tree changes. */
  save(reviewed: Set<string>, subject: string): { commit: string | null; changed: boolean } {
    const tip = this.tip();
    const tree = this.treeFor(reviewed);
    this.current = new Set(reviewed);
    if (tip && tip.tree === tree && tip.base === this.baseSha) return { commit: tip.commit, changed: false };
    const commit = this.commit(tree, tip?.commit ?? null, subject, this.baseSha);
    this.update(commit, tip?.commit ?? null);
    return { commit, changed: true };
  }

  /**
   * The blocks the ref holds. When its commit is the one this review last wrote, they are the
   * blocks written then (`known`): identical code in two places can't tell them apart otherwise.
   * Else a block is reviewed when the snapshot no longer has its removed lines (compared with the
   * base) and has its added lines as the head does (compared with the head). When the ref was
   * written for another base, it is replayed onto this one first.
   */
  load(known: { commit: string; blocks: string[] } | null = null): { reviewed: Set<string>; commit: string | null; replayed: { conflicts: string[] } | null } {
    let tip = this.tip();
    let replayed: { conflicts: string[] } | null = null;
    if (!tip) return { reviewed: new Set(), commit: null, replayed };
    if (known && known.commit === tip.commit && tip.base === this.baseSha) {
      this.current = new Set(known.blocks.filter((id) => this.byId.has(id)));
      return { reviewed: new Set(this.current), commit: tip.commit, replayed };
    }
    if (tip.base && tip.base !== this.baseSha) {
      const r = this.replay(tip.commit, tip.base);
      const commit = this.commit(r.tree, tip.commit, `Replay the review onto ${this.baseSha.slice(0, 7)}`, this.baseSha);
      this.update(commit, tip.commit);
      replayed = { conflicts: r.conflicts };
      tip = this.tip()!;
    }
    const snap = this.tree(tip.commit), base = this.tree(this.baseSha), head = this.tree(this.headSha);
    const reviewed = new Set<string>();
    for (const f of this.model.files) {
      const blocks = f.blocks.filter((b) => b.edits.length);
      if (!blocks.length) continue;
      const s = snap.get(f.p)?.blob, b0 = base.get(f.p)?.blob, h = head.get(f.p)?.blob;
      if (s === h) { blocks.forEach((b) => reviewed.add(b.id)); continue; }
      if (s === b0) continue;
      // Base lines the snapshot removed or replaced, and head lines it doesn't have yet. The
      // histogram diff anchors on unique lines, and blank lines and lone brackets, which a diff
      // can pair with any of their copies, only count in a block that has nothing else.
      const gone = new Set<number>(), missing = new Set<number>();
      for (const k of diffHunks(git(this.repo, 'diff', '--histogram', '-U0', b0 ?? EMPTY_BLOB, s ?? EMPTY_BLOB))) for (let x = k.a; x < k.a + k.b; x++) gone.add(x);
      for (const k of diffHunks(git(this.repo, 'diff', '--histogram', '-U0', s ?? EMPTY_BLOB, h ?? EMPTY_BLOB))) for (let x = k.c; x < k.c + k.d; x++) missing.add(x);
      const rowsOf = new Map<string, Array<{ t: string; line: number; text: string }>>(blocks.map((b) => [b.id, []]));
      f.hunks.forEach((hk, hi) => {
        let o = hk.o, n = hk.n;
        hk.rows.forEach((r, ri) => {
          const b = blocks.find((x) => x.hunk === hi && ri >= x.first && ri < x.first + x.len);
          if (b && r[0] !== ' ') rowsOf.get(b.id)!.push({ t: r[0], line: r[0] === '-' ? o : n, text: r[1] });
          if (r[0] !== '+') o++;
          if (r[0] !== '-') n++;
        });
      });
      const plain = (text: string) => /^[\s{}()[\];,]*$/.test(text);
      rowsOf.forEach((rows, id) => {
        const telling = rows.filter((r) => !plain(r.text));
        if ((telling.length ? telling : rows).every((r) => (r.t === '-' ? gone.has(r.line) : !missing.has(r.line)))) reviewed.add(id);
      });
    }
    this.current = reviewed;
    return { reviewed, commit: tip.commit, replayed };
  }

  /** The snapshot's changes to its old base, merged onto the current base, file by file. */
  private replay(commit: string, oldBase: string): { tree: string; conflicts: string[] } {
    const was = this.tree(oldBase), snap = this.tree(commit), now = this.tree(this.baseSha);
    const changes = new Map<string, Entry | null>(), conflicts: string[] = [];
    const paths = new Set([...was.keys(), ...snap.keys()].filter((p) => was.get(p)?.blob !== snap.get(p)?.blob));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-replay-'));
    try {
      for (const p of paths) {
        const w = was.get(p), s = snap.get(p), n = now.get(p);
        if (w?.blob === n?.blob) { changes.set(p, s ?? null); continue; }
        if (!s || !n) { conflicts.push(p); continue; }
        const ext = path.extname(p);
        const files = ['base', 'ours', 'theirs'].map((k) => path.join(tmp, k + ext));
        fs.writeFileSync(files[0], this.blob(w?.blob));
        fs.writeFileSync(files[1], this.blob(n.blob));
        fs.writeFileSync(files[2], this.blob(s.blob));
        let merged: string | null = null;
        if (has('mergiraf')) {
          const out = path.join(tmp, 'merged' + ext);
          try {
            run('mergiraf', ['merge', files[0], files[1], files[2], '-o', out, '-p', p]);
            const text = fs.readFileSync(out, 'utf8');
            if (!/^<{7}( |$)/m.test(text)) merged = text;
          } catch {
            // Conflicts or an unknown language: git's line merge below.
          }
        }
        if (merged == null) {
          let clean = true;
          try {
            run('git', ['merge-file', '-q', '-p', files[1], files[0], files[2]]);
          } catch (e) {
            if (!(e instanceof CommandError) || (e.code ?? -1) < 0) throw e;
            clean = false;
          }
          if (!clean) conflicts.push(p);
          // Conflicting regions keep the new base: they go back to unreviewed.
          merged = run('git', ['merge-file', '-q', '-p', '--ours', files[1], files[0], files[2]]);
        }
        changes.set(p, { mode: n.mode, blob: this.hashBlob(merged) });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { tree: this.writeTree(this.baseSha, changes), conflicts };
  }
}
