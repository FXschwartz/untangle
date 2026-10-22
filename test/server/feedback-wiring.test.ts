import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { feedbackFixture, type FeedbackFixture } from './feedback-fixture.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { heldGit } from '../helpers/slow-git.ts';
import { reviewClient } from '../helpers/http.ts';
import { startUntangle, stopRuns, untangleCommand, type UntangleRun } from '../helpers/run.ts';

let f: FeedbackFixture;
let repo: TempRepo | null = null;
let run: UntangleRun | null = null;
let held: ReturnType<typeof heldGit> | null = null;
const asset = fileURLToPath(new URL('../../dist/feedback-panel.js', import.meta.url));
let oldAsset: Buffer | null = null;
let changedAsset = false;
const author: Person = { name: 'Ada', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

afterEach(async () => {
  held?.release();
  await run?.stop();
  run = null;
  held?.remove();
  held = null;
  if (f) await stopRuns(f.env.UNTANGLE_CACHE);
  await f?.remove();
  repo?.remove();
  repo = null;
  if (changedAsset) {
    if (oldAsset) fs.writeFileSync(asset, oldAsset);
    else fs.rmSync(asset, { force: true });
    changedAsset = false;
  }
});

function repository() {
  repo = TempRepo.create();
  repo.write('a.txt', 'First\n');
  repo.commit({ subject: 'Start', author, committer: author });
  repo.branch('feature');
  repo.write('a.txt', 'Second\n');
  repo.commit({ subject: 'Change', author, committer: author });
}

function assetFile(content: string | null) {
  oldAsset = fs.existsSync(asset) ? fs.readFileSync(asset) : null;
  changedAsset = true;
  if (content === null) fs.rmSync(asset, { force: true });
  else fs.writeFileSync(asset, content);
}

async function assetResponse(url: string) {
  const target = new URL(url);
  return fetch(new URL('assets/feedback-panel.js', target), { headers: { 'x-untangle-token': target.searchParams.get('token')! } });
}

describe('Given a review whose checkout is still being built, ', () => {
  describe('when the page opens Feedback, ', () => {
    it('then authenticated context and drafts answer before the session exists.', async () => {
      f = await feedbackFixture();
      repository();
      held = heldGit(['init']);
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: f.env.UNTANGLE_CACHE, gh: f.gh, env: { ...f.env, PATH: `${held.dir}${path.delimiter}${f.gh.env.PATH}` } });
      const page = reviewClient(run.url);
      await page.open();
      assert.equal((await page.call('metrics')).status, 503);
      const reply = await page.call('feedback');
      assert.equal(reply.status, 200, reply.text);
      assert.deepEqual((reply.data as { review: unknown }).review, { repo: null, public: null });
      const draft = await page.call('feedback/draft', { method: 'POST', body: { kind: 'bug', text: 'The build is held', details: [], running: [] } });
      assert.equal(draft.status, 200);
      const bare = new URL('api/feedback', run.url);
      assert.equal((await fetch(bare)).status, 403);
    });
  });

  describe('when the picture bundle is built, ', () => {
    it('then the review serves it with JavaScript’s content type.', async () => {
      f = await feedbackFixture();
      repository();
      assetFile('window.untangleFeedbackPanel = true;');
      held = heldGit(['init']);
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: f.env.UNTANGLE_CACHE, gh: f.gh, env: { ...f.env, PATH: `${held.dir}${path.delimiter}${f.gh.env.PATH}` } });
      const response = await assetResponse(run.url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(await response.text(), 'window.untangleFeedbackPanel = true;');
    });
  });
});

describe('Given the Reviews page, ', () => {
  describe('when its Feedback button opens, ', () => {
    it('then it gets context without a review and can hold and clear an agent draft.', async () => {
      f = await feedbackFixture();
      const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cwd: f.root, cacheDir: f.env.UNTANGLE_CACHE, gh: f.gh, env: f.env });
      assert.equal(started.code, 0, started.err);
      const url = /http:\/\/\S+/.exec(started.out)![0];
      const page = reviewClient(url);
      await page.open();
      const reply = await page.call('feedback');
      assert.equal(reply.status, 200, reply.text);
      assert.equal((reply.data as { review: unknown }).review, null);
      assert.equal((await page.call('feedback/draft', { method: 'POST', body: { kind: 'idea', text: 'Manager idea', details: [], running: [] } })).status, 200);
      assert.equal(((await page.call('feedback')).data as { draft: { text: string } }).draft.text, 'Manager idea');
      assert.deepEqual((await page.call('feedback/draft', { method: 'DELETE' })).data, { ok: true });
      assert.equal((await fetch(new URL('api/feedback', url))).status, 403);
    });
  });

  describe('when the picture bundle exists, ', () => {
    it('then the manager serves that same bundle.', async () => {
      f = await feedbackFixture();
      assetFile('window.untangleFeedbackPanel = true;');
      const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cwd: f.root, cacheDir: f.env.UNTANGLE_CACHE, gh: f.gh, env: f.env });
      assert.equal(started.code, 0, started.err);
      const response = await assetResponse(/http:\/\/\S+/.exec(started.out)![0]);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'window.untangleFeedbackPanel = true;');
    });
  });

  describe('when the picture bundle has not been built, ', () => {
    it('then the asset request returns not found.', async () => {
      f = await feedbackFixture();
      assetFile(null);
      const started = await untangleCommand(['reviews', '-no-open', '-port', '0'], { cwd: f.root, cacheDir: f.env.UNTANGLE_CACHE, gh: f.gh, env: f.env });
      assert.equal(started.code, 0, started.err);
      assert.equal((await assetResponse(/http:\/\/\S+/.exec(started.out)![0])).status, 404);
    });
  });
});
