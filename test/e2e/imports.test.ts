import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-09-01T15:00:00Z' };

describe('Given a library that exports an unchanged file and starts exporting another by its package, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/src/texts.dart', "import 'words.dart';\n\nString hello() => word;\n");
    repo.write('lib/src/words.dart', "const word = 'hello';\n");
    repo.write('lib/src/extra.dart', 'int extra() => 1;\n');
    repo.write('lib/all.dart', "export 'src/texts.dart';\n");
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/all.dart', "export 'src/texts.dart';\nexport 'package:sample/src/extra.dart';\n");
    repo.commit({ subject: 'Export the extra', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openLibrary() {
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.click('[data-open="lib/all.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/all.dart"] .ref.uri[data-n="2"]')`);
  }

  describe('when the new export\'s URI is clicked, ', () => {
    let target: string;

    before(async () => {
      await openLibrary();
      await page.click('.code[data-p="lib/all.dart"] .ref.uri[data-n="2"]');
      await page.until(`!!document.querySelector('.peek .pk-loc')`);
      target = await read(page, `document.querySelector('.peek .pk-loc').textContent`);
    });

    it('then a peek shows the top of the file it names.', () => {
      assert.equal(target, 'lib/src/extra.dart:1');
    });
  });

  describe('when the unchanged export\'s URI is Ctrl-clicked, ', () => {
    let opened: string;

    before(async () => {
      await openLibrary();
      await page.click('.code[data-p="lib/all.dart"] .ref.uri[data-n="1"]', { ctrl: true });
      await page.until(`!!document.querySelector('.code.src .ln[data-n="1"]')`);
      opened = await read(page, `document.querySelector('.code.src .ln[data-n="1"] .tx').textContent`);
    });

    it('then the file it names opens at its top.', () => {
      assert.equal(opened, "import 'words.dart';");
    });
  });

  describe('when an import\'s URI in that file is Ctrl-clicked, ', () => {
    let opened: string;

    before(async () => {
      await openLibrary();
      await page.click('.code[data-p="lib/all.dart"] .ref.uri[data-n="1"]', { ctrl: true });
      await page.until(`!!document.querySelector('.code.src .ref.live.uri')`);
      await page.click('.code.src .ref.live.uri', { ctrl: true });
      await page.until(`(document.querySelector('.code.src .ln[data-n="1"] .tx')?.textContent || '').startsWith('const word')`, 30_000);
      opened = await read(page, `document.querySelector('.code.src .ln[data-n="1"] .tx').textContent`);
    });

    it('then the language server opens the file it names.', () => {
      assert.equal(opened, "const word = 'hello';");
    });
  });
});
