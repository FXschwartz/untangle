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

describe('Given a generated Invoice class and a Receipt model whose generated Dart file is missing, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;
  const invoice = 'lib/src/models/invoice.spy.yaml';
  const receipt = 'lib/src/models/receipt.spy.yaml';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write(invoice, 'class: Invoice\nfields:\n  amount: int\n');
    repo.write(receipt, 'class: Receipt\nfields:\n  amount: int\n');
    repo.write('lib/src/generated/invoice.dart', 'class Invoice {\n  final int amount = 0;\n}\n');
    repo.write('lib/app.dart', "import 'src/generated/invoice.dart';\nimport 'src/generated/receipt.dart';\nInvoice? before;\nReceipt? oldReceipt;\n");
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', "import 'src/generated/invoice.dart';\nimport 'src/generated/receipt.dart';\nInvoice? after;\nReceipt? newReceipt;\n");
    repo.write(invoice, '### Current invoice.\nclass: Invoice\nfields:\n  amount: int\n');
    repo.commit({ subject: 'Rename values', author, committer: author });
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

  async function openApp() {
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.click('[data-open="lib/app.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/app.dart"] .ref[data-n="3"]')`);
  }

  describe('when the generated class on an added line is clicked, ', () => {
    let target: string;

    before(async () => {
      await openApp();
      await page.click('.ref[data-n="3"][data-col="0"]');
      await page.until(`!!document.querySelector('.peek .pk-loc')`);
      target = await read(page, `document.querySelector('.peek .pk-loc').textContent`);
    });

    it('then the saved definition points to the current YAML declaration.', () => {
      assert.equal(target, `${invoice}:2`);
    });
  });

  describe('when the generated class on a removed line is clicked, ', () => {
    let target: string;

    before(async () => {
      await openApp();
      await page.click('.ref[data-o="3"][data-col="0"]');
      target = await read(page, `document.querySelector('.peek .pk-loc').textContent`);
    });

    it('then the saved definition points to the base YAML declaration.', () => {
      assert.equal(target, `${invoice}:1`);
    });
  });

  describe('when a class without generated Dart code is Ctrl-clicked, ', () => {
    let declaration: string;

    before(async () => {
      await openApp();
      await page.click('.ref[data-n="4"][data-col="0"]', { ctrl: true });
      await page.until(`!!document.querySelector('.code.src .ln')`);
      declaration = await read(page, `document.querySelector('.code.src .ln[data-n="1"] .tx').textContent`);
    });

    it('then the unchanged model file opens directly at its definition.', () => {
      assert.equal(declaration, 'class: Receipt');
    });
  });

  describe('when a resolved generated class is Cmd-clicked, ', () => {
    let declaration: string;

    before(async () => {
      await openApp();
      await page.click('.ref[data-n="3"][data-col="0"]', { meta: true });
      await page.until(`!!document.querySelector('.code[data-p="${invoice}"]')`);
      declaration = await read(page, `document.querySelector('.code[data-p="${invoice}"]').textContent`);
    });

    it('then the changed YAML model opens in its diff.', () => {
      assert.ok(declaration.includes('class: Invoice'));
    });
  });

  describe('when a live lookup asks about either revision, ', () => {
    let targets: string[];

    before(async () => {
      const client = reviewClient(run.url);
      await client.open();
      const head = await client.call('definition', { query: { side: 'head', p: 'lib/app.dart', l: '3', c: '0' } });
      const base = await client.call('definition', { query: { side: 'base', p: 'lib/app.dart', l: '3', c: '0' } });
      const missing = await client.call('definition', { query: { side: 'head', p: 'lib/app.dart', l: '4', c: '0' } });
      targets = [head, base, missing].map((response) => {
        const t = (response.data as { target: { side: string; p: string; l: number } }).target;
        return `${t.side}:${t.p}:${t.l}`;
      });
    });

    it('then live answers agree with saved YAML targets, including the missing generated class.', () => {
      assert.deepEqual(targets, [`head:${invoice}:2`, `base:${invoice}:1`, `head:${receipt}:1`]);
    });
  });
});
