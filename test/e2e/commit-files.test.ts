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
  let earlier = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/notes.dart', notes(40));
    repo.write('old-name.md', 'A document that keeps its content when renamed.\n');
    repo.write('image.bin', Buffer.from([0, 1, 2]));
    repo.commit({ subject: 'Start', author: ada('2020-08-01T15:00:00Z'), committer: ada('2020-08-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/notes.dart', notes(40).replace('// note 1\n', '// first note\n'));
    repo.write('lib/transient.dart', 'void transient() {}\n');
    repo.rename('old-name.md', 'new-name.md');
    repo.write('image.bin', Buffer.from([0, 1, 3]));
    earlier = repo.commit({ subject: 'Rename the first note', author: ada('2020-08-02T15:00:00Z'), committer: ada('2020-08-02T15:00:00Z') });
    repo.write('lib/notes.dart', notes(38).replace('// note 1\n', '// first note\n'));
    repo.delete('lib/transient.dart');
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
      await page!.until(`!!document.querySelector('.hs-detail .peek [data-peek-code$=":diff"]')`);
      opened = await read(page!, `[document.querySelector('.peek .pk-ln.del.hit')?.dataset.o ?? '', document.querySelector('.fv-head .crumbs')?.textContent ?? '', document.querySelector('.hs-detail')?.dataset.detailOf ?? ''].join('\\n')`);
    });

    it('then the file opens at the deletion in a peek while History and its commit stay open.', () => {
      assert.equal(opened, `39\nHistory\n${trimmed}`);
    });

    it('then clicking the same file again closes the window and leaves the commit open.', async () => {
      await page!.click('[data-act="hd-open"][data-p="lib/notes.dart"]');
      await page!.until(`!document.querySelector('.hs-detail .peek')`);
      assert.equal(await read(page!, `document.querySelector('.hs-detail')?.dataset.detailOf`), trimmed);
    });
  });

  describe('when an earlier version of the notes is opened, ', () => {
    it('then the window shows only that commit’s diff, with both versions of the changed line.', async () => {
      await page!.click(`.hs-main[data-detail="${earlier}"]`);
      await page!.until(`document.querySelector('.hs-detail')?.dataset.detailOf === ${JSON.stringify(earlier)}`);
      await page!.click('[data-act="hd-open"][data-p="lib/notes.dart"]');
      await page!.until(`!!document.querySelector('.peek [data-peek-code$=":diff"]')`);
      const text = await read(page!, `document.querySelector('.peek .pk-code').textContent`);
      assert.ok(!text.includes('// note 40'));
      assert.ok(text.includes('// first note'));
      assert.equal(await read(page!, `document.querySelector('.peek .pk-ln.del[data-o="1"] .tx').textContent`), '// note 1');
      assert.equal(await read(page!, `document.querySelector('.peek .pk-ln.add[data-n="1"] .tx').textContent`), '// first note');
    });
  });

  describe('when a file added and then removed within the review is opened, ', () => {
    it('then its historical content is available even though it is absent from the final diff.', async () => {
      await page!.click('[data-act="hd-open"][data-p="lib/transient.dart"]');
      await page!.until(`!!document.querySelector('.peek [data-peek-code$=":diff"]')`);
      assert.equal(await read(page!, `document.querySelector('.peek .pk-ln.add .tx').textContent`), 'void transient() {}');
    });

    it('then the deletion shows the removed code in red, with that commit named.', async () => {
      await page!.click(`.hs-main[data-detail="${trimmed}"]`);
      await page!.until(`document.querySelector('.hs-detail')?.dataset.detailOf === ${JSON.stringify(trimmed)}`);
      await page!.click('[data-act="hd-open"][data-p="lib/transient.dart"]');
      await page!.until(`!!document.querySelector('.peek [data-peek-code$=":diff"]')`);
      assert.equal(await read(page!, `document.querySelector('.peek .pk-ln.del .tx').textContent`), 'void transient() {}');
      assert.equal(await read(page!, `document.querySelector('.peek .pk-src').textContent`), `Commit ${trimmed.slice(0, 7)}`);
    });
  });

  describe('when a commit file request names a file outside that commit, ', () => {
    it('then the server rejects it.', async () => {
      const client = reviewClient(run!.url);
      await client.open();
      const response = await client.call('commit-file', { query: { sha: trimmed, p: 'pubspec.yaml' } });
      assert.equal(response.status, 404);
    });
  });

  describe('when a changed file has no textual hunks, ', () => {
    it('then a pure rename identifies its original path.', async () => {
      await page!.click(`.hs-main[data-detail="${earlier}"]`);
      await page!.until(`document.querySelector('.hs-detail')?.dataset.detailOf === ${JSON.stringify(earlier)}`);
      await page!.click('[data-act="hd-open"][data-p="new-name.md"]');
      await page!.until(`document.querySelector('.peek .pk-foot')?.textContent === 'Renamed from old-name.md'`);
      assert.equal(await read(page!, `String(!!document.querySelector('.peek .pk-code'))`), 'false');
    });

    it('then a binary change is identified without trying to render its bytes.', async () => {
      await page!.click('[data-act="hd-open"][data-p="image.bin"]');
      await page!.until(`document.querySelector('.peek .pk-foot')?.textContent === 'Binary file changed'`);
      assert.equal(await read(page!, `String(!!document.querySelector('.peek .pk-code'))`), 'false');
    });
  });

});
