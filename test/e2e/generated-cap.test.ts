import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const tooMany = '20,002 changed lines: too many to show here';

describe('Given a served review of a generated file with 20,002 changed lines, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-04-01T15:00:00Z');
    const later = ada('2020-04-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.write('lib/app.g.dart', 'const generated = 0;\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.write('lib/app.g.dart', `${Array.from({ length: 20_001 }, (_, index) => `const generated = ${index + 1};`).join('\n')}\n`);
    repo.commit({ subject: 'Change', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    client = reviewClient(run.url);
    await waitForReview(client);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the generated file is asked for, ', () => {
    let answer: string;

    before(async () => {
      const out = await client!.call('generated', { query: { p: 'lib/app.g.dart' } });
      const error = (out.data as { error?: string }).error ?? out.text;
      answer = `${out.status} ${error}`;
    });

    it('then the answer is 413 and says there are too many lines to show.', () => {
      assert.equal(answer, `413 ${tooMany}`);
    });
  });

  describe('when the file is opened from the Files tab, ', () => {
    let shown: string;

    before(async () => {
      page = await launchBrowser();
      await page.reducedMotion(true);
      await page.goto(run!.url);
      await page.until(`!!document.querySelector('.t-head')`, 30_000);
      await rest(page);
      await page.click('[data-tab="files"]');
      await page.click('[data-section="generated"]');
      await page.until(`!!document.querySelector('[data-open="lib/app.g.dart"]')`);
      await page.click('[data-open="lib/app.g.dart"]');
      await page.until(`(document.querySelector('.empty')?.textContent || '').includes(${JSON.stringify(tooMany)})`);
      shown = await read(page, `document.querySelector('.empty')?.textContent ?? ''`);
    });

    it('then the page shows that there are too many lines to show.', () => {
      assert.equal(shown, `Couldn\u2019t load this file\u2019s diff: ${tooMany}`);
    });
  });
});
