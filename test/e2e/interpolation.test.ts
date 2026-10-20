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

const app = (greeting: string) => [
  'String greet(String name) {',
  `  return ${greeting};`,
  '}',
  '',
  ...Array.from({ length: 10 }, (_, index) => `// pad ${index + 1}`),
  '',
  'String shout(String word) {',
  "  return '${word.toUpperCase()}!';",
  '}',
  '',
].join('\n');

/** Each token of a line in a string, after its opening quote: its text, kind and whether it's a link. */
const tokensOf = (selector: string) => `(() => {
  const tx = document.querySelector(${JSON.stringify(selector)});
  const all = [...tx.children];
  const from = all.findIndex((el) => el.classList.contains('t-str'));
  return all.slice(from + 1).map((el) => el.textContent + ' ' + ['t-str', 't-op', 't-id', 't-ty', 't-fn'].filter((name) => el.classList.contains(name)).join('') + (el.classList.contains('ref') ? ' ref' : '')).join('\\n');
})()`;

describe('Given a served review of a greeting that interpolates its name, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let url = '';

  before(async () => {
    const author = ada('2020-09-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', app("'Hello'"));
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a.dart', app("'Hello $name, ${name.length} letters'"));
    repo.commit({ subject: 'Greet by name', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    await waitForReview(reviewClient(url));
    page = await launchBrowser();
    await page.reducedMotion(true);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function openApp(): Promise<void> {
    await rest(page!);
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
    await page!.click('[data-tab="files"]');
    await page!.click('[data-open="lib/a.dart"]');
    await page!.until(`!!document.querySelector('.code[data-p="lib/a.dart"] .ln[data-n="2"]')`);
  }

  describe('when the changed line is shown, ', () => {
    let tokens: string;
    let color: string;

    before(async () => {
      await openApp();
      await page!.until(`!!document.querySelector('.t-str[class*=" k"]')`);
      tokens = await read(page!, tokensOf('.code[data-p="lib/a.dart"] .ln[data-n="2"] .tx'));
      color = await read(page!, `getComputedStyle([...document.querySelectorAll('.code[data-p="lib/a.dart"] .ln[data-n="2"] .ref')].find((el) => el.textContent === 'name')).color`);
    });

    it('then the names in its interpolations are code, each a link to its definition.', () => {
      assert.equal(tokens, [
        'Hello t-str',
        '$ t-op',
        'name t-id ref',
        ', t-str',
        '${ t-op',
        'name t-id ref',
        '. t-op',
        'length t-id ref',
        '} t-op',
        'letters t-str',
        "' t-str",
        '; t-op',
      ].join('\n'));
    });

    it('then an interpolated name has the color of a variable.', () => {
      assert.equal(color, 'rgb(156, 220, 254)');
    });
  });

  describe('when the interpolated name is clicked, ', () => {
    let peek: string;

    before(async () => {
      await openApp();
      await page!.clickIn('.code[data-p="lib/a.dart"] .ln[data-n="2"] .ref', 'name', "'Hello $name");
      await page!.until(`!!document.querySelector('.peek .pk-loc')`);
      peek = await read(page!, `document.querySelector('.peek .pk-h b').textContent + ' ' + document.querySelector('.peek .pk-loc').textContent`);
    });

    it('then the peek shows where the name is defined.', () => {
      assert.equal(peek, 'Definition lib/a.dart:1');
    });
  });

  describe('when a name interpolated away from the changes is clicked, ', () => {
    let peek: string;

    before(async () => {
      await openApp();
      await page!.until(`document.querySelector('#lsp-dot')?.classList.contains('ready')`, 180_000);
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="whole"]')`);
      await page!.click('[data-act="whole"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/a.dart"] .ln[data-n="17"] .ref.live')`);
      await page!.clickIn('.code[data-p="lib/a.dart"] .ref.live', 'word', '${word.toUpperCase()}');
      await page!.until(`!!document.querySelector('.peek .pk-h') && !(document.querySelector('.peek')?.textContent || '').includes('looking it up')`, 120_000);
      peek = await read(page!, `document.querySelector('.peek .pk-h b').textContent + ' ' + document.querySelector('.peek .pk-loc').textContent`);
    });

    it('then the language server says where it is defined.', () => {
      assert.equal(peek, 'Definition lib/a.dart:16');
    });
  });
});
