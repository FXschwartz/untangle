// Builds the review of a target: checkouts, the diff, the language server's answers and the
// analysis, cached per pair of commits.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, type Model, type RawDefinitions } from '../analysis/analyze.js';
import { reviewDir, tilde } from './cache.js';
import { checkoutAt, packageDirs, pubGet, resolved, worktree } from './checkouts.js';
import { has } from './exec.js';
import { DartServer } from './lsp/dart.js';
import { definitions, slim, type Definitions, type SlimDefinitions } from './pipeline/definitions.js';
import { exportDiff, generatedPatterns } from './pipeline/diff.js';
import { changedUsages, overrides, testCalls } from './pipeline/links.js';
import { headPositions, oldPositions } from './pipeline/positions.js';
import type { Target } from './target.js';
import { ROOT, VERSION } from './version.js';

/** What the page shows: the model, and the language server's answers it embeds. */
export interface ReviewData {
  model: Model;
  defs: SlimDefinitions;
  refs: ReturnType<typeof changedUsages>;
  defsOld: Record<string, SlimDefinitions>;
}

export interface Progress {
  /** Starts a step; the next step (or done) ends it. */
  step(label: string): void;
  /** What the current step is doing now. */
  detail(text: string): void;
  /** A line worth keeping in the narration. */
  note(text: string): void;
  verbose(text: string): void;
}

// What each cached stage depends on: when any of these files changes, the stage runs again.
function fingerprint(files: string[]): string {
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(fs.readFileSync(path.join(ROOT, f)));
  return h.digest('hex').slice(0, 16);
}
const LSP_STAGE = ['dist/pipeline/diff.js', 'dist/pipeline/positions.js', 'dist/pipeline/definitions.js', 'dist/pipeline/links.js', 'dist/lsp/dart.js', 'analysis/adapters.js', 'viewer/core.js'];
const MODEL_STAGE = ['analysis/analyze.js', 'analysis/dart.js'];

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};
const writeJson = (file: string, data: unknown) => fs.writeFileSync(file, JSON.stringify(data));

interface Answers {
  version: string;
  diff: Parameters<typeof analyze>[0]['diff'];
  defs: Definitions;
  defsOld: Definitions;
  calls: Awaited<ReturnType<typeof testCalls>>;
  supers: RawDefinitions;
  headDir: string;
  baseDir: string;
}

export async function buildReview(target: Target, opts: { noCache: boolean; label: string; title: string }, progress: Progress): Promise<ReviewData> {
  const dir = reviewDir(target.repoKey, target.baseSha, target.headSha);
  fs.mkdirSync(dir, { recursive: true });
  const lspVersion = fingerprint(LSP_STAGE), modelVersion = lspVersion + '.' + fingerprint(MODEL_STAGE);

  const cached = !opts.noCache && readJson<{ version: string }>(path.join(dir, 'meta.json'));
  if (cached && cached.version === modelVersion) {
    const data = readJson<ReviewData>(path.join(dir, 'review.json'));
    if (data) {
      progress.note(`using the analysis cached in ${tilde(dir)}`);
      return data;
    }
  }

  let answers = !opts.noCache ? readJson<Answers>(path.join(dir, 'answers.json')) : null;
  // The analysis reads the checkouts too: they must still hold the same commits.
  if (answers && (answers.version !== lspVersion || !checkoutAt(answers.headDir, target.headSha) || !checkoutAt(answers.baseDir, target.baseSha))) answers = null;
  if (answers) progress.note('reusing the language server’s answers; running the analysis again');
  else answers = await askLanguageServer(target, dir, opts.label, lspVersion, progress);

  progress.step('analysis');
  const t0 = Date.now();
  const model = await analyze({
    repo: target.repo,
    headDir: answers.headDir,
    diff: answers.diff,
    defsRaw: answers.defs.raw,
    old: { base: { dir: answers.baseDir, raw: answers.defsOld.raw } },
    calls: answers.calls,
    supers: answers.supers,
    log: progress.verbose,
  });
  const c = model.compares.base;
  c.title = opts.title;
  const changes = c.files.flatMap((f: { blocks: Array<{ id: string; edits: number[] }> }) => f.blocks).filter((b: { edits: number[] }) => b.edits.length);
  const inChain = new Set(c.chains.flatMap((ch: { blocks: string[] }) => ch.blocks));
  progress.note(`${c.chains.length} chains hold ${inChain.size} of ${changes.length} changes; ${c.groups.length} same-change groups (${Date.now() - t0} ms)`);

  const data: ReviewData = { model, defs: slim(answers.defs), refs: changedUsages(answers.diff, answers.headDir, answers.defs.raw), defsOld: { base: slim(answers.defsOld) } };
  writeJson(path.join(dir, 'review.json'), data);
  writeJson(path.join(dir, 'meta.json'), { version: modelVersion, untangle: VERSION, base: target.baseSha, head: target.headSha, builtAt: new Date().toISOString() });
  return data;
}

async function askLanguageServer(target: Target, dir: string, label: string, version: string, progress: Progress): Promise<Answers> {
  progress.step('checkouts');
  const needs = (checkout: string) => packageDirs(target.repo, target.baseSha, target.headSha, checkout);
  // The directory itself serves as the head when its packages are resolved; untangle never
  // runs pub get in it.
  let headDir = target.headDir && needs(target.headDir).every(resolved) ? fs.realpathSync(target.headDir) : null;
  if (target.headDir && !headDir) progress.note('your checkout’s packages aren’t resolved; using a worktree for the head');
  progress.detail('base ' + target.baseSha.slice(0, 7));
  const baseDir = await worktree(target.repo, target.repoKey, target.baseSha);
  if (!headDir) {
    progress.detail('head ' + target.headSha.slice(0, 7));
    headDir = await worktree(target.repo, target.repoKey, target.headSha);
  }
  progress.note(`head ${tilde(headDir)}`);
  progress.note(`base ${tilde(baseDir)}`);

  progress.step('packages');
  for (const [side, checkout] of [['head', headDir], ['base', baseDir]] as const) {
    if (checkout === target.headDir) continue;
    const dirs = needs(checkout).filter((d) => !resolved(d));
    if (!dirs.length) continue;
    progress.detail(`${side}: pub get in ${dirs.length} folder${dirs.length > 1 ? 's' : ''}`);
    const failed = await pubGet(dirs, progress.verbose);
    failed.forEach((d) => progress.note(`pub get failed in ${tilde(d)}; its code resolves partly`));
  }

  progress.step('diff');
  const diff = exportDiff(target.repo, { base: { left: target.baseSha, right: target.headSha, label } }, generatedPatterns(target.repo, target.headSha));
  const files = diff.compares.base.files;
  progress.note(`${files.length} files changed, ${files.filter((f) => !f.hunks).length} of them generated`);

  progress.step('language server');
  if (!has('dart')) throw new Error('untangle needs the Dart SDK on PATH, for `dart language-server`');
  const head = await headPositions(diff, headDir);
  const old = oldPositions(diff, 'base');
  progress.detail('starting the Dart analysis server');
  const server = await DartServer.start([{ name: 'head', dir: headDir }, { name: 'base', dir: baseDir }], { clientVersion: VERSION, log: progress.verbose });
  try {
    // Both sides' packages up front: the server builds its contexts once, before any lookup.
    server.openAll([...Object.keys(head.positions).map((p) => path.join(headDir, p)), ...Object.keys(old.positions).map((p) => path.join(baseDir, p))]);
    const t0 = Date.now();
    const total = head.count + old.count;
    const tick = (offset: number) => (done: number) => { if (done % 200 === 0) progress.detail(`definitions ${offset + done} of ${total}`); };
    const defs = await definitions(server, headDir, head.positions, tick(0));
    const defsOld = await definitions(server, baseDir, old.positions, tick(head.count));
    progress.note(`${total} definitions in ${Math.round((Date.now() - t0) / 1000)} s`);
    progress.detail('calls from changed tests');
    const calls = await testCalls(server, diff, headDir, defs.raw);
    progress.detail('overrides');
    const supers = await overrides(server, diff, headDir, defs.raw);
    const answers: Answers = { version, diff, defs, defsOld, calls, supers, headDir, baseDir };
    writeJson(path.join(dir, 'answers.json'), answers);
    return answers;
  } finally {
    await server.stop();
  }
}
