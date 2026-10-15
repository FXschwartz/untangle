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
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

// VS Code's Dark+ theme (shiki/themes/dark-plus), not the page's stylesheet.
const darkPlus = {
  string: '#CE9178',
  function: '#DCDCAA',
  control: '#C586C0',
  variable: '#9CDCFE',
};

function rgb(hex: string): string {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

const sample = `(() => {
  const pick = (selector, text) => [...document.querySelectorAll(selector)].find((el) => el.textContent === text);
  const paint = (el) => {
    const theme = [...el.classList].find((name) => /^k\\d+$/.test(name));
    const rule = theme && [...(document.querySelector('style')?.sheet?.cssRules || [])].find((item) => item.selectorText === '.' + theme);
    return [getComputedStyle(el).color, rule ? rule.style.color.toLowerCase() : ''].join(' ');
  };
  const syn = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
  const string = [...document.querySelectorAll('.t-str')].find((el) => (el.textContent || '').includes('hi'));
  const fn = pick('.t-fn', 'greet');
  const word = pick('.t-kw', 'return');
  const name = [...document.querySelectorAll('.t-id')].find((el) => el.textContent === 'name' && ![...el.classList].some((item) => /^k\\d+$/.test(item)));
  if (!string || !fn || !word || !name) return ['missing', !!string, !!fn, !!word, !!name].join(' ');
  return [paint(string), paint(fn), paint(word), getComputedStyle(name).color, syn('--syn-str'), syn('--syn-fn'), syn('--syn-kw'), syn('--syn-id')].join('\\n');
})()`;

describe('Given a served review of a greeting with a return, ', { skip, timeout: 180_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';

  before(async () => {
    const author = ada('2020-09-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author, committer: author });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet(String name) {\n  if (name.isEmpty) return;\n  print('hi');\n}\n");
    repo.commit({ subject: 'Return early', author, committer: author });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.click('[data-open="lib/a.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/a.dart"]')`);
    await page.until(`!!document.querySelector('.t-str[class*=" k"]')`);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when highlighting has loaded, ', () => {
    let colors: string;

    before(async () => {
      colors = await read(page!, sample);
    });

    it('then a string, a function, a control keyword and a plain variable use Dark+ and the syntax variables.', () => {
      const [string, fn, word, name, synStr, synFn, synKw, synId] = colors.split('\n');
      const theme = (line: string, hex: string) => line.trim() === rgb(hex) || line.trim().startsWith(`${rgb(hex)} `);
      assert.equal([
        theme(string, darkPlus.string) ? 'string' : string,
        theme(fn, darkPlus.function) ? 'function' : fn,
        theme(word, darkPlus.control) ? 'control' : word,
        name === rgb(darkPlus.variable) ? 'variable' : name,
        synStr === darkPlus.string.toLowerCase() ? 'syn-str' : synStr,
        synFn === darkPlus.function.toLowerCase() ? 'syn-fn' : synFn,
        synKw === darkPlus.control.toLowerCase() ? 'syn-kw' : synKw,
        synId === darkPlus.variable.toLowerCase() ? 'syn-id' : synId,
      ].join('\n'), 'string\nfunction\ncontrol\nvariable\nsyn-str\nsyn-fn\nsyn-kw\nsyn-id');
    });
  });
});
