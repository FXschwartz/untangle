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

  for (const layout of ['unified', 'split']) {
    describe(`when the move is read in ${layout} layout, `, () => {
      before(async () => {
        await client.call('state', { method: 'PUT', body: { rev: { base: [] }, layout } });
        await page.goto(run.url);
        await page.until(`!!document.querySelector('[data-tab="files"]')`);
        await page.click('[data-tab="files"]');
      });

      for (const [file, marker, local] of [['old', 'mv-away', 'Old lines 3–4'], ['new', 'mv-head', 'Line 3']]) {
        it(`then the ${file} file's annotation precedes the import edits and identifies the moved lines.`, async () => {
          await page.click(`#vw-side [data-open="lib/${file}.dart"]`);
          await page.until(`!!document.querySelector('.${marker}')`);
          const result = await page.eval(`(() => {
            const marker = document.querySelector('.${marker}');
            const edit = document.querySelector('.code .add, .code .del');
            return { above: !!(marker.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING), label: marker.textContent };
          })()`) as { above: boolean; label: string };
          assert.equal(result.above, true);
          assert.ok(result.label.includes(local), result.label);
        });
      }
    });
  }
});
