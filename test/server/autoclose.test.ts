import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';
const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A repository whose feature branch changes a greeting. */
function greeting(): TempRepo {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
  repo.commit({ subject: 'Start', author: ada, committer: ada });
  repo.branch('feature');
  repo.write('lib/app.dart', "void greet() {\n  print('hello');\n}\n");
  repo.commit({ subject: 'Say hello', author: ada, committer: ada });
  return repo;
}

/** A page that opens and closes, the way the review's page tells untangle. */
async function openAndClose(client: ReviewClient): Promise<void> {
  await client.call('presence', { method: 'POST', body: { id: 'page', open: true } });
  await client.call('presence', { method: 'POST', body: { id: 'page', open: false } });
}

describe('Given a review served as untangle serves it by default, ', { skip: skipDart, timeout: 120_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let cache = '';

  before(async () => {
    repo = greeting();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, autoclose: null, quiet: false });
  });

  after(async () => {
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when its page opens and closes, ', () => {
    let seen = '';

    before(async () => {
      const client = reviewClient(run!.url);
      await waitForReview(client);
      await openAndClose(client);
      const closed = Date.now();
      const code = await Promise.race([run!.exited, sleep(20_000).then(() => 'still serving')]);
      const waited = Date.now() - closed;
      const said = run!.output().split('\n').filter((line) => /page|Ctrl\+C/.test(line)).map((line) => line.trim());
      seen = [`exit ${code}`, waited >= 4500 ? 'a moment after' : `after ${waited} ms`, ...said].join('\n');
    });

    it('then untangle stops a moment later, as it said it would, and says why.', () => {
      assert.equal(seen, [
        'exit 0',
        'a moment after',
        'Closing its page stops untangle, as Ctrl+C does.',
        'The review’s page closed, so untangle stops (-autoclose=false keeps it serving).',
      ].join('\n'));
    });
  });
});

describe('Given a review served with -autoclose=false, ', { skip: skipDart, timeout: 120_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let cache = '';

  before(async () => {
    repo = greeting();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, autoclose: false });
  });

  after(async () => {
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when its page opens and closes, ', () => {
    let seen = '';

    before(async () => {
      const client = reviewClient(run!.url);
      await waitForReview(client);
      await openAndClose(client);
      const outcome = await Promise.race([run!.exited.then((code) => `exit ${code}`), sleep(6500).then(() => 'still serving')]);
      seen = `${outcome}, status ${(await client.call('status')).status}`;
    });

    it('then untangle keeps serving.', () => {
      assert.equal(seen, 'still serving, status 200');
    });
  });
});
