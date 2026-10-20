import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { e2eSkip, launchBrowser, type Browser } from '../helpers/browser.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, waitForReview } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';
import { read } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

const beforeApp = ['void greet() {', "  print('hi');", '}', '', 'void main() {', '  greet();', '}', ''].join('\n');
const afterApp = ['void greet(String name) {', '  print(name);', '}', '', 'void main() {', "  greet('ada');", '}', ''].join('\n');

// What the page's saves of marks did: whether each asked to outlive the page, and what untangle
// answered (0: it never got there). A save can be made to fail on its way, to be refused, or to be
// padded past the 64 KB a browser lets outlive the page (untangle ignores the padding).
const recorder = `(() => {
  const realFetch = window.fetch, realJson = JSON.stringify;
  Object.assign(window, { __saves: [], __fail: 0, __refuse: null, __pad: 0 });
  JSON.stringify = (v, ...rest) => realJson(v && v.rev && v.cmarks && window.__pad ? { ...v, pad: 'x'.repeat(window.__pad) } : v, ...rest);
  window.fetch = (url, init) => {
    if (!String(url).endsWith('api/state') || !init || init.method !== 'PUT') return realFetch(url, init);
    const save = { keepalive: !!init.keepalive, bytes: String(init.body).length, status: null };
    window.__saves.push(save);
    if (window.__fail > 0) { window.__fail--; save.status = 0; return Promise.reject(new TypeError('Failed to fetch')); }
    if (window.__refuse) { const status = window.__refuse; window.__refuse = null; save.status = status; return Promise.resolve(new Response('{}', { status, headers: { 'content-type': 'application/json' } })); }
    return realFetch(url, init).then((r) => { save.status = r.status; return r; }, (e) => { save.status = 0; throw e; });
  };
  return true;
})()`;
const saves = `JSON.stringify(window.__saves.map((s) => [s.keepalive ? 'keepalive' : 'plain', s.bytes > 65536 ? 'over 64 KB' : 'small', s.status]))`;
const banner = `document.querySelector('#viewer').classList.contains('unsaved') ? 'Marks not saved: ' + document.querySelector('.t-unsaved').title : 'saved'`;

describe('Given a served review of a branch with two changes, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let cache = '';
  let block = '';
  // Marks or unmarks the first change, and waits for its save to be answered (or to fail).
  const mark = async (then = '') => {
    const n = Number(await page!.eval('window.__saves.length'));
    await page!.eval(`(() => { document.querySelector('.tick[data-block="${block}"]').click(); ${then} return true; })()`);
    await page!.until(`window.__saves.length > ${n} && window.__saves[${n}].status !== null`);
  };

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', beforeApp);
    repo.commit({ subject: 'Start the package', author: ada('2020-06-01T15:00:00Z'), committer: ada('2020-06-01T15:00:00Z') });
    repo.branch('feature');
    repo.write('lib/app.dart', afterApp);
    repo.commit({ subject: 'Name the greeting', author: ada('2020-06-02T15:00:00Z'), committer: ada('2020-06-02T15:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh, base: 'main' });
    await waitForReview(reviewClient(run.url));
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(run.url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.click('[data-tab="files"]');
    await page.until(`!!document.querySelector('[data-open="lib/app.dart"]')`);
    await page.click('[data-open="lib/app.dart"]');
    await page.until(`!!document.querySelector('.code[data-p="lib/app.dart"] .tick')`);
    block = await read(page, `document.querySelector('.code[data-p="lib/app.dart"] .tick').dataset.block`);
    await page.eval(recorder);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when a change is marked, ', () => {
    let shown = '';

    before(async () => {
      await mark();
      shown = await read(page!, `${saves} + ' | ' + (${banner})`);
    });

    it('then the marks go as a plain request, and untangle takes them.', () => {
      assert.equal(shown, '[["plain","small",200]] | saved');
    });
  });

  describe('when the marks are over 64 KB, as a big review’s are, ', () => {
    let shown = '';

    before(async () => {
      await page!.eval('window.__saves = []; window.__pad = 70000');
      await mark();
      shown = await read(page!, `${saves} + ' | ' + (${banner})`);
    });

    it('then untangle still takes them.', () => {
      assert.equal(shown, '[["plain","over 64 KB",200]] | saved');
    });
  });

  describe('when the page may go away right after a mark, ', () => {
    let shown = '';

    before(async () => {
      await page!.eval('window.__saves = []');
      await mark(`window.dispatchEvent(new Event('pagehide'));`);
      await page!.eval('window.__pad = 0');
      await mark(`window.dispatchEvent(new Event('pagehide'));`);
      shown = await read(page!, saves);
    });

    it('then the marks ask to outlive the page only when they fit in 64 KB.', () => {
      assert.equal(shown, '[["plain","over 64 KB",200],["keepalive","small",200]]');
    });
  });

  describe('when a save doesn’t get there, ', () => {
    let failed = '', later = '';

    before(async () => {
      await page!.eval('window.__saves = []; window.__fail = 1');
      await mark();
      failed = await read(page!, banner);
      await page!.until(`window.__saves.length === 2 && window.__saves[1].status === 200`, 15_000);
      later = await read(page!, `${saves} + ' | ' + (${banner})`);
    });

    it('then the page says untangle doesn’t answer, and sends the marks again a little later.', () => {
      assert.deepEqual([failed, later], ['Marks not saved: untangle doesn’t answer: is it still running?', '[["plain","small",0],["plain","small",200]] | saved']);
    });
  });

  describe('when untangle refuses the marks, ', () => {
    let shown = '';

    before(async () => {
      await page!.eval('window.__saves = []; window.__refuse = 403');
      await mark();
      shown = await read(page!, banner);
    });

    it('then the page says why.', () => {
      assert.equal(shown, 'Marks not saved: This page is from another run of untangle: open the link it printed.');
    });
  });
});
