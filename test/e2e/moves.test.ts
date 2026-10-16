import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

describe('Given an unchanged declaration moved next to separate import edits, ', { skip: e2eSkip(), timeout: 180_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;
  let client: ReviewClient;

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-10-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/old.dart', "import 'dart:async';\n\nenum Page { days, months, years }\n\nvoid stay() {}\n");
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/old.dart', 'void stay() {}\n');
    repo.write('lib/new.dart', "import 'dart:math';\n\nenum Page { days, months, years }\n");
    repo.commit({ subject: 'Move page', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    client = reviewClient(run.url);
    await waitForReview(client);
    page = await launchBrowser();
    await page.reducedMotion(true);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function readMove(layout: string) {
    await client.call('state', { method: 'PUT', body: { rev: { base: [] }, layout } });
    await page.goto(run.url);
    await page.until(`!!document.querySelector('[data-tab="files"]')`);
    await page.click('[data-tab="files"]');
    await page.click('#vw-side [data-open="lib/old.dart"]');
    await page.until(`!!document.querySelector('.mv-away')`);
    const removed = await page.eval(`(() => {
      const marker = document.querySelector('.mv-away');
      const edit = document.querySelector('.code .del');
      return { afterImport: !!(edit.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING), label: marker.textContent };
    })()`) as { afterImport: boolean; label: string };

    await page.click('#vw-side [data-open="lib/new.dart"]');
    await page.until(`!!document.querySelector('.mv-head')`);
    const folded = await page.eval(`(() => { const row = document.querySelector('.mv-head').nextElementSibling; return { className: row.className, body: row.textContent }; })()`) as { className: string; body: string };
    await page.click('.mv-head [data-act="toggle-move"]');
    const added = await page.eval(`(() => {
      const marker = document.querySelector('.mv-head');
      const edit = document.querySelector('.code .add');
      return {
        afterImport: !!(edit.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING),
        body: marker.nextElementSibling.querySelector('.tx').textContent,
        label: marker.textContent,
      };
    })()`) as { afterImport: boolean; body: string; label: string };

    return { removed, folded, added };
  }

  describe('when the move is read in unified layout, ', () => {
    let result: Awaited<ReturnType<typeof readMove>>;

    before(async () => { result = await readMove('unified'); });

    it('then the moved-away annotation stays after the unrelated import edit.', () => {
      assert.equal(result.removed.afterImport, true);
      assert.ok(result.removed.label.includes('Old lines 3–4'));
    });

    it('then the moved-from annotation immediately precedes its folded or expanded body.', () => {
      assert.equal(result.added.afterImport, true);
      assert.ok(result.folded.className.includes('mv'), JSON.stringify(result));
      assert.equal(result.added.body, 'enum Page { days, months, years }');
      assert.ok(result.added.label.includes('Line 3'));
    });
  });

  describe('when the move is read in split layout, ', () => {
    let result: Awaited<ReturnType<typeof readMove>>;

    before(async () => { result = await readMove('split'); });

    it('then the moved-away annotation stays after the unrelated import edit.', () => {
      assert.equal(result.removed.afterImport, true);
      assert.ok(result.removed.label.includes('Old lines 3–4'));
    });

    it('then the moved-from annotation immediately precedes its folded or expanded body.', () => {
      assert.equal(result.added.afterImport, true);
      assert.ok(result.folded.className.includes('mv'), JSON.stringify(result));
      assert.equal(result.added.body, 'enum Page { days, months, years }');
      assert.ok(result.added.label.includes('Line 3'));
    });
  });
});
