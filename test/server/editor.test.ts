import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { jsonScript, reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

describe('Given a review launched inside Orca without an editor override, ', () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let client: ReviewClient;
  let cache: string;
  let html: string;
  let log: string;
  let failure: string;

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-10-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('lib/a file.txt', 'Before\n');
    repo.write('removed.txt', 'Removed\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a file.txt', 'After\n');
    repo.delete('removed.txt');
    repo.commit({ subject: 'Change', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-orca-editor-'));
    log = path.join(cache, 'opened.json');
    failure = path.join(cache, 'fail');
    const cli = path.join(cache, 'orca stub.mjs');
    fs.writeFileSync(cli, `#!/usr/bin/env node
import fs from 'node:fs';
if (fs.existsSync(${JSON.stringify(failure)})) {
  process.stderr.write('The worktree is unavailable');
  process.exit(2);
}
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
`, { mode: 0o755 });
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, env: { ORCA_CLI_COMMAND: cli, ORCA_WORKTREE_ID: 'another-worktree' } });
    client = reviewClient(run.url);
    html = await waitForReview(client);
  });

  after(async () => {
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('when the page is configured, then editor actions are routed through Orca.', () => {
    assert.deepEqual((jsonScript(html, 'd-config') as { editor: unknown }).editor, { mode: 'orca' });
  });

  it('when a file is opened, then Orca focuses its working copy in the reviewed worktree, with paths passed intact.', async () => {
    const response = await client.call('open', { method: 'POST', body: { side: 'head', p: 'lib/a file.txt', l: 2, c: 3 } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { opened: path.join(repo.dir, 'lib/a file.txt') });
    assert.deepEqual(JSON.parse(fs.readFileSync(log, 'utf8')), {
      args: ['file', 'open', '--path', 'lib/a file.txt', '--worktree', 'path:' + repo.dir, '--focus', '--json'],
      cwd: repo.dir,
    });
  });

  it('when the working copy no longer has a file, then the review reports that without opening another file.', async () => {
    const response = await client.call('open', { method: 'POST', body: { side: 'base', p: 'removed.txt' } });
    assert.equal(response.status, 404);
    assert.match(response.text, /absent from the working copy/);
  });

  it('when a path leaves the reviewed worktree, then the editor request is rejected.', async () => {
    const response = await client.call('open', { method: 'POST', body: { side: 'head', p: '../other.txt' } });
    assert.equal(response.status, 400);
  });

  it('when Orca rejects the open request, then the page receives the error.', async () => {
    fs.writeFileSync(failure, 'fail');
    const response = await client.call('open', { method: 'POST', body: { side: 'head', p: 'lib/a file.txt' } });
    assert.equal(response.status, 502);
    assert.match(response.text, /The worktree is unavailable/);
  });
});
