import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read, rest } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const notes = (count: number) => Array.from({ length: count }, (_, index) => `// note ${index + 1}`).join('\n') + '\n';

describe('Given a served review whose last commit removes the last two lines of the notes, ', { skip, timeout: 240_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let trimmed = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/notes.dart', notes(40));
    repo.commit({ subject: 'Start', author: ada('2020-08-01T15:00:00Z'), committer: ada('2020-08-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/notes.dart', notes(40).replace('// note 1\n', '// first note\n'));
    repo.commit({ subject: 'Rename the first note', author: ada('2020-08-02T15:00:00Z'), committer: ada('2020-08-02T15:00:00Z') });
    repo.write('lib/notes.dart', notes(38).replace('// note 1\n', '// first note\n'));
    trimmed = repo.commit({ subject: 'Trim the notes', author: ada('2020-08-03T15:00:00Z'), committer: ada('2020-08-03T15:00:00Z') });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when the notes are opened from the details of the commit that trimmed them, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-act="history-open"]');
      await page!.until(`!!document.querySelector('.hs-s')`);
      await page!.click(`.hs-main[data-detail="${trimmed}"]`);
      await page!.until(`document.querySelector('.hs-detail')?.dataset.detailOf === ${JSON.stringify(trimmed)}`);
      await page!.click('[data-act="hd-open"][data-p="lib/notes.dart"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"] [data-n].flash')`);
      opened = await read(page!, `[document.querySelector('.code[data-p="lib/notes.dart"] [data-n].flash')?.dataset.n ?? '', document.querySelector('.t-head')?.textContent ?? ''].join('\\n')`);
    });

    it('then the file opens under that commit\'s lens, at the line its removed lines followed.', () => {
      assert.equal(opened, `38\n${trimmed.slice(0, 7)} · Trim the notes`);
    });
  });
});
