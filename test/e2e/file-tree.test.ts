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
    repo.write('.review.yaml', 'generated:\n  - "**/generated/**"\n  - "**/migrations/**"\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/first/a.txt', 'First\n');
    repo.write('lib/last/b.txt', 'Last\n');
    repo.write('lib/generated/model.g.dart', 'const generated = 1;\n');
    repo.write('server/migrations/1/up.sql', 'CREATE TABLE example (id integer);\n');
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

  describe('when the Files tab first shows generated files and migrations, ', () => {
    let sections: unknown;

    before(async () => {
      sections = await page.eval(`[...document.querySelectorAll('[data-act="file-section"]')].map(button => [button.textContent, button.getAttribute('aria-expanded'), document.getElementById(button.getAttribute('aria-controls')).hidden])`);
    });

    it('then the two sections start collapsed with their own expansion buttons.', () => {
      assert.deepEqual(sections, [
        ['Generated, not reviewed1 · Expand', 'false', true],
        ['Migrations, not reviewed1 · Expand', 'false', true],
      ]);
    });
  });

  describe('when generated files are expanded, ', () => {
    let files: unknown;

    before(async () => {
      await page.click('[data-section="generated"]');
      files = await page.eval(`[...document.querySelectorAll('#files-generated [data-open], #files-migrations [data-open]')].map(row => row.dataset.open)`);
    });

    it('then only generated files are revealed.', () => {
      assert.deepEqual(files, ['lib/generated/model.g.dart']);
    });
  });

  describe('when migrations are also expanded, ', () => {
    let files: unknown;

    before(async () => {
      await page.click('[data-section="migrations"]');
      files = await page.eval(`[...document.querySelectorAll('#files-generated [data-open], #files-migrations [data-open]')].map(row => row.dataset.open)`);
    });

    it('then each section holds its own files.', () => {
      assert.deepEqual(files, ['lib/generated/model.g.dart', 'server/migrations/1/up.sql']);
    });
  });

  describe('when generated files are collapsed again, ', () => {
    let sections: unknown;

    before(async () => {
      await page.click('[data-section="generated"]');
      sections = await page.eval(`[...document.querySelectorAll('[data-act="file-section"]')].map(button => [button.dataset.section, button.getAttribute('aria-expanded'), document.getElementById(button.getAttribute('aria-controls')).hidden])`);
    });

    it('then migrations stay expanded.', () => {
      assert.deepEqual(sections, [['generated', 'false', true], ['migrations', 'true', false]]);
    });
  });
});

// A file's name in the Files tab, and the color it's drawn in, named by the page's own colors.
const named = `(() => {
  const ink = (name) => { const probe = document.createElement('i'); probe.style.color = 'var(--' + name + ')'; document.body.appendChild(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; };
  const inks = ['text', 'text-3', 'add-ink', 'add-no', 'del-ink', 'del-no'].map((name) => [name, ink(name)]);
  return [...document.querySelectorAll('#vw-side .sb-row.tr:not(.dir)')].map((row) => {
    const nm = getComputedStyle(row.querySelector('.nm'));
    return row.querySelector('.nm').textContent + ' ' + (inks.find(([, color]) => color === nm.color) || [nm.color])[0] + (nm.textDecorationLine === 'line-through' ? ', struck' : '');
  }).join('\\n');
})()`;

describe('Given a file added, one changed and one deleted, ', { skip: browserSkip(), timeout: 120_000 }, () => {
  let repo: TempRepo;
  let run: UntangleRun;
  let page: Browser;
  let cache: string;

  before(async () => {
    const author = { name: 'Ada Review', email: 'ada@example.com', date: '2020-10-01T00:00:00Z' };
    repo = TempRepo.create();
    repo.write('lib/changed.txt', 'Before\n');
    repo.write('lib/deleted.txt', 'Gone soon\n');
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/added.txt', 'New\n');
    repo.write('lib/changed.txt', 'After\n');
    repo.delete('lib/deleted.txt');
    repo.commit({ subject: 'Add, change and delete', author, committer: author });
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

  describe('when the Files tab is opened, ', () => {
    let files: string;
    let titles: string;

    before(async () => {
      await page.click('[data-tab="files"]');
      await page.until(`!!document.querySelector('[data-open="lib/added.txt"]')`);
      files = await page.eval(named) as string;
      titles = await page.eval(`[...document.querySelectorAll('#vw-side [data-open]')].map((row) => row.title).join('\\n')`) as string;
    });

    it('then the added file is green, the deleted one red and struck through, and the changed one as it was.', () => {
      assert.equal(files, ['added.txt add-ink', 'changed.txt text', 'deleted.txt del-ink, struck'].join('\n'));
    });

    it('then each says so when hovered.', () => {
      assert.equal(titles, ['lib/added.txt: added, 1 change', 'lib/changed.txt: 1 change', 'lib/deleted.txt: deleted, 1 change'].join('\n'));
    });
  });

  describe('when the added and the deleted files are marked reviewed, ', () => {
    let files: string;

    before(async () => {
      for (const file of ['lib/added.txt', 'lib/deleted.txt']) {
        await page.click(`[data-open="${file}"]`);
        await page.until(`!!document.querySelector('[data-act="mark-file"]') && (document.querySelector('.crumbs b')?.title === ${JSON.stringify(file)})`);
        await page.click('[data-act="mark-file"]');
        await page.until(`document.querySelector('[data-open="${file}"]')?.classList.contains('done')`);
      }
      files = await page.eval(named) as string;
    });

    it('then they keep their hues, dimmed as the names of reviewed files are.', () => {
      assert.equal(files, ['added.txt add-no', 'changed.txt text', 'deleted.txt del-no, struck'].join('\n'));
    });
  });
});
