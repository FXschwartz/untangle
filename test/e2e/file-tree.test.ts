import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { browserSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

describe('Given two sibling folders with a file in each, ', { skip: browserSkip(), timeout: 120_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-10-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('README.txt', 'Start\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/first/a.txt', 'First\n');
    repo.write('lib/last/b.txt', 'Last\n');
    repo.commit({ subject: 'Add folders', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('[data-tab="files"]')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the file tree is expanded, ', () => {
    let guides: unknown;

    before(async () => {
      await page.click('[data-tab="files"]');
      guides = await page.eval(`[...document.querySelectorAll('#vw-side .tr')].map(row => ({
        name: row.querySelector('.nm').textContent,
        guides: [...row.querySelectorAll('.ig')].map(line => [line.style.left, line.classList.contains('elbow')])
      }))`);
    });

    it('then each parent guide ends at its last child, and does not continue through that child’s descendants.', () => {
      assert.deepEqual(guides, [
        { name: 'lib', guides: [] },
        { name: 'first', guides: [['14px', false]] },
        { name: 'a.txt', guides: [['14px', false], ['28px', true]] },
        { name: 'last', guides: [['14px', true]] },
        { name: 'b.txt', guides: [['28px', true]] },
      ]);
    });
  });

  describe('when the last folder is collapsed, ', () => {
    let guides: unknown;

    before(async () => {
      await page.click('[data-dir="lib/last"]');
      guides = await page.eval(`[...document.querySelectorAll('#vw-side [data-dir="lib/last"] .ig')].map(line => [line.style.left, line.classList.contains('elbow')])`);
    });

    it('then the outer guide still closes at that folder.', () => {
      assert.deepEqual(guides, [['14px', true]]);
    });
  });
});
