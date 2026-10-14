// One served review: what the page is configured with, and the answers to its API calls.
import fs from 'node:fs';
import path from 'node:path';
import type { Progress, ReviewData } from './build.js';
import { reviewDir } from './cache.js';
import { LiveSession, openInEditor, type Side } from './live.js';
import { Metrics } from './metrics.js';
import type { PageConfig } from './page.js';
import { fileHunks, generatedPatterns } from './pipeline/diff.js';
import { writeAtomic } from './server.js';
import { Snapshot, snapshotBranch } from './snapshot.js';
import type { Target } from './target.js';
import '../viewer/core.js';

const C = globalThis.ReviewCore;

// A generated file's diff past this many changed lines isn't shown.
const GENERATED_MAX_LINES = 20_000;

interface Edit { id: number; b: string }
interface Block { id: string; edits: number[] }

/** How the page opens a location in the editor: a link it builds, or a command untangle runs. */
export type Editor = { mode: 'uri'; template: string } | { mode: 'command'; template: string };

/** The editor from -editor or UNTANGLE_EDITOR, else VS Code's link (through WSL when untangle runs in it). */
export function editorFrom(option: string | null): Editor {
  const t = option || process.env.UNTANGLE_EDITOR || '';
  if (t) return t.includes('://') ? { mode: 'uri', template: t } : { mode: 'command', template: t };
  const wsl = process.env.WSL_DISTRO_NAME;
  return { mode: 'uri', template: wsl ? `vscode://vscode-remote/wsl+${wsl}{file}:{line}:{col}` : 'vscode://file{file}:{line}:{col}' };
}

export class ReviewSession {
  readonly snapshot: Snapshot;
  private readonly blocks = new Map<string, Block>();
  private readonly edits: Edit[];
  private readonly stateFile: string;
  private partial = new Set<number>();
  private view: { layout?: string; showReviewedDiff?: boolean } = {};
  private snapshotInfo: { branch: string; commit: string | null; note: string | null };
  private readonly generatedRx: RegExp[];
  // Blocks the snapshot branch holds.
  private reviewed: Set<string>;
  private readonly metrics = new Metrics();

  constructor(
    private readonly target: Target,
    private readonly data: ReviewData,
    readonly live: LiveSession,
    private readonly editor: Editor,
    private readonly page: { key: string; url: string | null; where: string; snapshotKey: string },
    progress: Progress,
  ) {
    const c = data.model.compares.base;
    c.files.forEach((f: { blocks: Block[] }) => f.blocks.forEach((b) => this.blocks.set(b.id, b)));
    this.edits = c.edits;
    this.generatedRx = generatedPatterns(target.repo, target.headSha).map((g) => C.globToRegExp(g));
    this.snapshot = new Snapshot(target.repo, snapshotBranch(target.repo, page.snapshotKey), target.baseSha, target.headSha, c);
    // Marks on parts of a change, the layout, and the blocks of the last commit this review wrote
    // live next to the review, for these commits only.
    this.stateFile = path.join(reviewDir(target.repoKey, target.baseSha, target.headSha), 'state.json');
    let saved: { partial?: number[]; layout?: string; showReviewedDiff?: boolean; snapshot?: { commit: string; blocks: string[] } } = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      // No marks yet.
    }
    const loaded = this.snapshot.load(saved.snapshot || null);
    let note: string | null = null;
    if (loaded.replayed) {
      note = `replayed onto ${target.baseSha.slice(0, 7)}${loaded.replayed.conflicts.length ? `; ${loaded.replayed.conflicts.length} file${loaded.replayed.conflicts.length > 1 ? 's' : ''} conflicted and went back to unreviewed` : ''}`;
      progress.note(`your review on ${this.snapshot.branch} was ${note}`);
    }
    this.snapshotInfo = { branch: this.snapshot.branch, commit: loaded.commit, note };
    this.reviewed = loaded.reviewed;
    this.partial = new Set((saved.partial || []).filter((id: number) => this.edits[id] && !this.reviewed.has(this.edits[id].b)));
    this.view = { layout: saved.layout, showReviewedDiff: saved.showReviewedDiff };
  }

  /** Edits marked reviewed: the snapshot's blocks, and marks on parts of a change. */
  private rev(): number[] {
    const out = new Set(this.partial);
    this.reviewed.forEach((id) => this.blocks.get(id)?.edits.forEach((e) => out.add(e)));
    return [...out].sort((a, b) => a - b);
  }

  config(): PageConfig {
    const roots = this.live.roots;
    return {
      served: true,
      key: this.page.key,
      url: this.page.url,
      where: this.page.where,
      state: { rev: { base: this.rev() }, layout: this.view.layout, showReviewedDiff: this.view.showReviewedDiff },
      roots,
      editor: this.editor.mode === 'uri' ? { mode: 'uri', template: this.editor.template } : { mode: 'command' },
      snapshot: this.snapshotInfo,
      head: this.target.headSha,
      base: this.target.baseSha,
    };
  }

  private saveState(body: { rev?: { base?: number[] }; layout?: string; showReviewedDiff?: boolean }) {
    const rev = new Set((body.rev?.base || []).filter((id) => Number.isInteger(id) && this.edits[id]));
    const reviewed = new Set([...this.blocks.values()].filter((b) => b.edits.length && b.edits.every((e) => rev.has(e))).map((b) => b.id));
    if (this.snapshot.differs(reviewed)) {
      const total = [...this.blocks.values()].filter((b) => b.edits.length).length;
      const saved = this.snapshot.save(reviewed, `Review: ${reviewed.size} of ${total} changes reviewed`);
      this.snapshotInfo = { ...this.snapshotInfo, commit: saved.commit };
      this.reviewed = reviewed;
    }
    this.partial = new Set([...rev].filter((id) => !reviewed.has(this.edits[id].b)));
    this.view = { layout: body.layout, showReviewedDiff: body.showReviewedDiff };
    writeAtomic(this.stateFile, JSON.stringify({ partial: [...this.partial], ...this.view, snapshot: this.snapshotInfo.commit ? { commit: this.snapshotInfo.commit, blocks: [...this.reviewed] } : undefined }));
    return { snapshot: this.snapshotInfo };
  }

  private generated(p: string) {
    const g = this.data.model.compares.base.generated.find((x: { p: string }) => x.p === p);
    if (!g) return { status: 404, data: { error: `${p} is not a generated file of this review` } };
    if (g.hunks) return { data: { hunks: g.hunks } };
    if (g.a + g.d > GENERATED_MAX_LINES) return { status: 413, data: { error: `${(g.a + g.d).toLocaleString('en-US')} changed lines: too many to show here` } };
    return { data: { hunks: fileHunks(this.target.repo, this.target.baseSha, this.target.headSha, p).map((h) => ({ o: h.o, n: h.n, h: h.h, rows: h.l.map((l) => [l[0], l.slice(1)]) })) } };
  }

  /** The page's API. */
  async call(route: string, method: string, q: URLSearchParams, body: unknown): Promise<{ status?: number; data: unknown }> {
    const where = () => ({ side: q.get('side') || undefined, p: q.get('p') || undefined, ext: q.has('ext') ? Number(q.get('ext')) : undefined });
    if (route === 'metrics' && method === 'GET') return { data: this.metrics.sample(this.live.state()) };
    if (route === 'state' && method === 'PUT') return { data: this.saveState((body || {}) as Parameters<ReviewSession['saveState']>[0]) };
    if (route === 'generated' && method === 'GET') return this.generated(q.get('p') || '');
    if (route === 'definition' && method === 'GET') {
      const target = await this.live.definition(where(), Number(q.get('l')), Number(q.get('c')));
      return { data: { target } };
    }
    if (route === 'file' && method === 'GET') {
      const w = where();
      const out = await this.live.file(w);
      if ('error' in out) return { status: 404, data: out };
      const p = w.p || out.abs || '';
      return { data: { ...out, generated: !!w.p && this.generatedRx.some((rx) => rx.test(w.p!)), lang: C.langOf(p) } };
    }
    if (route === 'search' && method === 'GET') {
      const side = (q.get('side') === 'base' ? 'base' : 'head') as Side;
      const term = q.get('q') || '';
      if (term.trim().length < 2) return { data: { results: [], truncated: false } };
      const out = this.live.search(side, term);
      return { data: { ...out, results: out.results.map((r) => ({ ...r, generated: this.generatedRx.some((rx) => rx.test(r.p)) })) } };
    }
    if (route === 'open' && method === 'POST') {
      if (this.editor.mode !== 'command') return { status: 400, data: { error: 'no editor command: start untangle with -editor' } };
      const b = (body || {}) as { side?: string; p?: string; ext?: number; l?: number; c?: number };
      const file = await this.live.absolute(b);
      if (!file) return { status: 404, data: { error: 'not a file of this review' } };
      openInEditor(this.editor.template, file, b.l || 1, b.c || 0);
      return { data: { opened: file } };
    }
    if (route === 'roots' && method === 'GET') {
      // The checkouts, made when the review came from the cache: links to the editor need them.
      const { headDir, baseDir } = await this.live.checkouts();
      return { data: { head: headDir, base: baseDir } };
    }
    return { status: 404, data: { error: `no such call: ${method} ${route}` } };
  }
}
