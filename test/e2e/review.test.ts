import { execFileSync } from 'node:child_process';
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
import { read, rest, waitForSave } from './page.ts';

const skip = e2eSkip();
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

const greetBefore = [
  'void greet() {',
  "  print('hi');",
  '}',
  '',
  'void main() {',
  '  greet();',
  '}',
  '',
  'void wave() {',
  "  print('yo');",
  '}',
  '',
  'void run() {',
  '  wave();',
  '}',
  '',
].join('\n');

const greetAfter = [
  'void greet(String name) {',
  '  print(name);',
  '}',
  '',
  'void main() {',
  "  greet('ada');",
  '}',
  '',
  'void wave(String name) {',
  '  print(name);',
  '}',
  '',
  'void run() {',
  "  wave('ada');",
  '}',
  '',
].join('\n');

const pads = Array.from({ length: 44 }, (_, index) => `// pad ${index + 1}`);
const notesBefore = ['// start', ...pads, ''].join('\n');
const notesAfter = ['// changed', ...pads, ''].join('\n');

const pill = `document.querySelector('.pill-n')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`;
const crumbs = `document.querySelector('.crumbs')?.textContent ?? ''`;
const fits = `(() => { const root = document.documentElement; const box = document.querySelector('#viewer'); return root.scrollWidth <= root.clientWidth && (!box || box.scrollWidth <= box.clientWidth) ? 'fits' : root.scrollWidth + ' > ' + root.clientWidth; })()`;
const tail = `[(document.querySelector('.hh-tail .hh-tx')?.textContent ?? ''), (document.querySelector('.hh-tail .mo')?.textContent ?? '')].join('\\n')`;

async function chain(page: Browser, name: string): Promise<void> {
  await page.click('[data-tab="chains"]');
  await page.until(`!!document.querySelector('[data-chain]')`);
  const id = await read(page, `([...document.querySelectorAll('[data-chain]')].find((el) => (el.textContent || '').includes(${JSON.stringify(name)})) || {}).dataset?.chain ?? ''`);
  if (!id) throw new Error(`no chain ${name}`);
  await page.click(`[data-chain="${id}"]`);
  await page.until(`(document.querySelector('.crumbs')?.textContent || '').includes(${JSON.stringify(name)})`);
}

async function openFile(page: Browser, file: string): Promise<void> {
  await page.click('[data-tab="files"]');
  await page.until(`!!document.querySelector(${JSON.stringify(`[data-open="${file}"]`)})`);
  await page.click(`[data-open="${file}"]`);
  await page.until(`!!document.querySelector(${JSON.stringify(`.code[data-p="${file}"]`)})`);
}

describe('Given a served review of a greeting and a wave, a 45-line notes file and a generated file, with reduced motion and the language server running, ', { skip, timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let run: UntangleRun | undefined;
  let page: Browser | undefined;
  let client: ReviewClient | undefined;
  let cache = '';
  let url = '';
  let head = '';

  before(async () => {
    const author = ada('2020-03-01T15:00:00Z');
    const later = ada('2020-03-02T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', greetBefore);
    repo.write('lib/notes.dart', notesBefore);
    repo.write('lib/app.g.dart', 'const generated = 1;\n');
    repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', greetAfter);
    repo.write('lib/notes.dart', notesAfter);
    repo.write('lib/only/nested/added.dart', 'void addedFile() {}\n');
    repo.write('lib/app.g.dart', 'const generated = 2;\n');
    head = repo.commit({ subject: 'Name the greetings', author: later, committer: later });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache });
    url = run.url;
    client = reviewClient(url);
    await waitForReview(client);
    page = await launchBrowser();
    await page.reducedMotion(true);
    await page.goto(url);
    await page.until(`!!document.querySelector('.t-head')`, 30_000);
    await page.until(`document.querySelector('#lsp-dot')?.classList.contains('ready')`, 180_000);
  });

  after(async () => {
    await page?.close();
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  async function fresh(): Promise<void> {
    await page!.eval(`localStorage.setItem('untangle:ui', JSON.stringify({ side: 272, sideOff: false, minimap: true, graph: true, filesList: false }))`);
    await page!.goto(url);
    await page!.until(`!!document.querySelector('.t-head')`, 30_000);
  }

  async function clearMarks(): Promise<void> {
    await client!.call('state', { method: 'PUT', body: { rev: { base: [] }, cmarks: [] } });
    await fresh();
  }

  describe('when the greeting chain is opened, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      shown = await read(page!, `[${pill}, document.querySelector('.pill-act')?.textContent ?? '', document.querySelector('.fv-head .strip') ? 'pinned' : 'loose', [...document.querySelectorAll('.fv-head .strip .nm')].map((el) => el.textContent).join(' | '), document.querySelector('.graph-box') ? 'graph' : 'no graph'].join('\\n')`);
    });

    it('then the pill counts the two changes, with the members pinned under the header and the graph shown.', () => {
      assert.equal(shown, '1 of 2\nMark and go to the nextSpace\npinned\ngreet | app.dart\ngraph');
    });
  });

  describe('when j lands on the first change, ', () => {
    let landed: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      landed = await read(page!, pill);
    });

    it('then the pill stays on the first change.', () => {
      assert.equal(landed, '1 of 2');
    });
  });

  describe('when j is pressed again, ', () => {
    let next: string;

    before(async () => {
      await fresh();
      await chain(page!, 'greet(name)');
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '2'`);
      next = await read(page!, pill);
    });

    it('then the pill is on the second change.', () => {
      assert.equal(next, '2 of 2');
    });
  });

  describe('when k is pressed, ', () => {
    let back: string;

    before(async () => {
      await fresh();
      await chain(page!, 'greet(name)');
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      await page!.key('j');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '2'`);
      await page!.key('k');
      await page!.until(`document.querySelector('.pill-n b')?.textContent === '1'`);
      back = await read(page!, pill);
    });

    it('then the pill is back on the first change.', () => {
      assert.equal(back, '1 of 2');
    });
  });

  describe('when n is pressed, ', () => {
    let next: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.key('n');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('wave(name)')`);
      next = await read(page!, crumbs);
    });

    it('then the review moves to the wave chain.', () => {
      assert.equal(next, 'Map/wave(name)');
    });
  });

  describe('when p is pressed, ', () => {
    let back: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.key('n');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('wave(name)')`);
      await page!.key('p');
      await page!.until(`(document.querySelector('.crumbs')?.textContent || '').includes('greet(name)')`);
      back = await read(page!, crumbs);
    });

    it('then the review moves back to the greeting.', () => {
      assert.equal(back, 'Map/greet(name)');
    });
  });

  describe('when ? is pressed, ', () => {
    let listed: string;

    before(async () => {
      await rest(page!);
      await page!.key('?');
      await page!.until(`document.querySelector('.keys') && !document.querySelector('.keys').hidden`);
      listed = await read(page!, `document.querySelector('.keys')?.textContent ?? ''`);
    });

    it('then the keys are listed.', () => {
      assert.equal(listed.includes('Next and previous change to review') && listed.includes('Mark the change reviewed and go to the next one') && listed.includes('Next and previous chain'), true);
    });
  });

  describe('when Escape is pressed on the key list, ', () => {
    let closed: string;

    before(async () => {
      await rest(page!);
      await page!.key('?');
      await page!.until(`document.querySelector('.keys') && !document.querySelector('.keys').hidden`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('.keys') || document.querySelector('.keys').hidden`);
      closed = await read(page!, `!document.querySelector('.keys') || document.querySelector('.keys').hidden ? 'closed' : 'open'`);
    });

    it('then the list closes.', () => {
      assert.equal(closed, 'closed');
    });
  });

  describe('when Ctrl K is pressed, ', () => {
    let opened: string;

    before(async () => {
      await rest(page!);
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      opened = await read(page!, `document.querySelector('.pal-list')?.textContent ?? ''`);
    });

    it('then Jump to lists the greeting chain and the file.', () => {
      assert.equal(opened.includes('greet(name)') && opened.includes('app.dart'), true);
    });
  });

  describe('when Tab is pressed in Jump to, ', () => {
    let narrowed: string;

    before(async () => {
      await rest(page!);
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      await page!.key('Tab');
      await page!.until(`(document.querySelector('.pal-scope')?.textContent || '').startsWith('Chains')`);
      narrowed = await read(page!, `[document.querySelector('.pal-scope')?.textContent ?? '', document.querySelector('.pal-list')?.textContent ?? ''].join('\\n')`);
    });

    it('then the list narrows to chains.', () => {
      assert.equal(narrowed.startsWith('Chains\n') && !narrowed.includes('Files'), true);
    });
  });

  describe('when Escape is pressed in Jump to, ', () => {
    let closed: string;

    before(async () => {
      await rest(page!);
      await page!.key('k', { ctrl: true });
      await page!.until(`document.querySelector('.pal') && !document.querySelector('.pal').hidden`);
      await page!.key('Escape');
      await page!.until(`!document.querySelector('.pal') || document.querySelector('.pal').hidden`);
      closed = await read(page!, `!document.querySelector('.pal') || document.querySelector('.pal').hidden ? 'closed' : 'open'`);
    });

    it('then Jump to closes.', () => {
      assert.equal(closed, 'closed');
    });
  });

  describe('when the marks panel is opened, ', () => {
    let note: string;

    before(async () => {
      await rest(page!);
      await page!.click('[aria-label="Marks"]');
      await page!.until(`!!document.querySelector('.mi-note')`);
      note = await read(page!, `[document.querySelector('.mi-note')?.textContent ?? '', document.querySelector('.mi-foot button')?.textContent ?? ''].join('\\n')`);
    });

    it('then it says marks are kept on untangle/feature, and offers to reset them.', () => {
      assert.equal(note, `Your marks are kept on the branch untangle/feature. git diff untangle/feature ${head.slice(0, 7)} shows what’s left.\nReset all marks…`);
    });
  });

  describe('when Space is pressed on the greeting, ', () => {
    let folded: string;
    let next: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec-h b');
      await page!.key(' ');
      await waitForSave(page!);
      folded = await read(page!, `([...document.querySelectorAll('.sec')].find((el) => el.querySelector('.sec-h b')?.textContent === 'greet')?.querySelector('.hh-sum')?.textContent) ?? ''`);
      next = await read(page!, pill);
    });

    after(async () => {
      await clearMarks();
    });

    it('then the hunk is already folded into its divider.', () => {
      assert.equal(folded.includes('reviewed'), true);
    });

    it('then the pill is on the next change.', () => {
      assert.equal(next, '1 of 1');
    });
  });

  describe('when Shift Space is pressed on the greeting, ', () => {
    let members: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec-h b');
      await page!.key(' ', { shift: true });
      await waitForSave(page!);
      members = await read(page!, `[...document.querySelectorAll('.sec')].map((el) => (el.querySelector('.sec-h b')?.textContent ?? '') + ' ' + ((el.querySelector('.hh-sum')?.textContent || '').includes('reviewed') ? 'reviewed' : 'open')).join('\\n')`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then that member is reviewed and the call stays open.', () => {
      assert.equal(members, 'greet reviewed\napp.dart open');
    });
  });

  describe('when the greeting is marked and the page is reloaded, ', () => {
    let reviewed: string;
    let saved: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec-h b');
      await page!.key(' ');
      await waitForSave(page!);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await chain(page!, 'greet(name)');
      reviewed = await read(page!, `([...document.querySelectorAll('.sec')].find((el) => el.querySelector('.sec-h b')?.textContent === 'greet')?.querySelector('.hh-sum')?.textContent) ?? ''`);
      await page!.click('[aria-label="Marks"]');
      await page!.until(`(document.querySelector('.mi-note')?.textContent || '').includes('untangle/feature')`);
      saved = await read(page!, `document.querySelector('.mi-note')?.textContent ?? ''`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then the greeting is still reviewed.', () => {
      assert.equal(reviewed.includes('reviewed'), true);
    });

    it('then the mark is on the branch untangle/feature.', () => {
      const message = execFileSync('git', ['-C', repo!.dir, 'log', '-1', '--format=%B', 'untangle/feature'], { encoding: 'utf8' });
      assert.equal(saved.includes('untangle/feature') && message.includes(`Untangle-Head: ${head}`), true);
    });
  });

  describe('when Reset all marks is clicked, ', () => {
    let afterReset: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('.sec .tick');
      await waitForSave(page!);
      await page!.click('[aria-label="Marks"]');
      await page!.until(`!!document.querySelector('[data-act="reset"]')`);
      await page!.click('[data-act="reset"]');
      await page!.until(`!(document.querySelector('.sec .hh-sum')?.textContent || '').includes('reviewed')`);
      afterReset = await read(page!, `([...document.querySelectorAll('.sec')].find((el) => el.querySelector('.sec-h b')?.textContent === 'greet')?.querySelector('.tick')?.getAttribute('aria-pressed')) ?? 'missing'`);
    });

    after(async () => {
      await clearMarks();
    });

    it('then the greeting is unreviewed again.', () => {
      assert.equal(afterReset, 'false');
    });
  });

  describe('when a member of the greeting graph is clicked, ', () => {
    let beforeScroll: string;
    let shown: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      beforeScroll = await read(page!, `String(document.querySelector('#vw-main').scrollTop)`);
      const labelsBefore = await read(page!, `document.querySelectorAll('.g-elabel').length`);
      await page!.click('g.g-node[aria-label="app.dart, top level"]', { scroll: false });
      await page!.until(`!!document.querySelector('.focus-bar')`);
      const afterScroll = await read(page!, `String(document.querySelector('#vw-main').scrollTop)`);
      const label = await read(page!, `[...document.querySelectorAll('.g-elabel')].map((el) => el.textContent).join(' | ')`);
      const bar = await read(page!, `document.querySelector('.focus-bar')?.textContent ?? ''`);
      shown = `${labelsBefore}\n${beforeScroll} ${afterScroll}\n${label}\n${bar}`;
    });

    it('then only that member\'s code stays where it was, and its arrow is named.', () => {
      assert.equal(shown, `0\n${beforeScroll} ${beforeScroll}\nname\nShowing only app.dart · 1 changeShow all 2 members`);
    });
  });

  describe('when the graph icon is clicked, and the page is reloaded, ', () => {
    let hidden: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.click('[data-act="graph"]');
      await page!.until(`!document.querySelector('.graph-box')`);
      await page!.goto(url);
      await page!.until(`!!document.querySelector('.t-head')`, 30_000);
      await chain(page!, 'greet(name)');
      hidden = await read(page!, `[document.querySelector('.graph-box') ? 'graph' : 'no graph', document.querySelector('[data-act="graph"]')?.getAttribute('aria-pressed') ?? ''].join('\\n')`);
    });

    after(async () => {
      await fresh();
    });

    it('then the graph stays hidden.', () => {
      assert.equal(hidden, 'no graph\nfalse');
    });
  });

  describe('when the Files tab is opened, ', () => {
    let tree: string;

    before(async () => {
      await rest(page!);
      await page!.click('[data-tab="files"]');
      await page!.until(`(document.querySelector('#vw-side')?.textContent || '').includes('Generated')`);
      tree = await read(page!, `[...document.querySelectorAll('#vw-side .sb-row.dir, #vw-side .sb-row.tr, #vw-side .sb-group')].map((el) => el.classList.contains('sb-group') ? el.textContent : (el.classList.contains('dir') ? 'dir ' : 'file ') + (el.querySelector('.nm')?.textContent ?? '')).join('\\n')`);
    });

    it('then a folder that holds only a folder is shown with it, and the generated file is set aside.', () => {
      assert.equal(tree, [
        'dir lib',
        'dir only/nested',
        'file added.dart',
        'file app.dart',
        'file notes.dart',
        'Generated, not reviewed1',
        'dir lib',
        'file app.g.dart',
      ].join('\n'));
    });
  });

  describe('when the notes file\'s divider is opened, ', () => {
    let first: string;
    let second: string;
    let last: string;

    before(async () => {
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      await page!.until(`!!document.querySelector('.hh-tail')`);
      first = await read(page!, tail);
      await page!.click('.hh-tail .mo');
      await page!.until(`document.querySelector('.hh-tail .hh-tx')?.textContent === '21 lines below'`);
      second = await read(page!, tail);
      await page!.click('.hh-tail .mo');
      await page!.until(`document.querySelector('.hh-tail .mo')?.textContent === '1 line'`);
      last = await read(page!, tail);
    });

    it('then the divider offers 20 more lines.', () => {
      assert.equal(first, '41 lines below\n20 lines');
    });

    it('then the next divider offers 20 more lines.', () => {
      assert.equal(second, '21 lines below\n20 lines');
    });

    it('then the last divider offers the remaining line.', () => {
      assert.equal(last, '1 line below\n1 line');
    });
  });

  describe('when Show the whole file is chosen, ', () => {
    let shown: string;

    before(async () => {
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="whole"]')`);
      await page!.click('[data-act="whole"]');
      await page!.until(`!!document.querySelector('.code[data-p="lib/notes.dart"]') && !document.querySelector('.hh-tail') && (document.querySelector('.code[data-p="lib/notes.dart"]')?.textContent || '').includes('// pad 44')`);
      shown = await read(page!, `document.querySelector('.hh-tail') ? 'tail' : 'whole'`);
    });

    it('then every line of the notes file is on the page.', () => {
      assert.equal(shown, 'whole');
    });
  });

  describe('when greet on the changed call is clicked, ', () => {
    let definition: string;
    let inner: string;
    let back: string;
    let closed: string;

    before(async () => {
      await rest(page!);
      await chain(page!, 'greet(name)');
      await page!.clickIn('.ref', 'greet', "greet('ada')");
      await page!.until(`(document.querySelector('.peek .pk-loc')?.textContent || '').includes('lib/app.dart')`);
      definition = await read(page!, `document.querySelector('.peek .pk-h')?.textContent ?? ''`);
      await page!.clickIn('.peek .ref.live', 'print', 'print(');
      await page!.until(`document.querySelector('[data-act="peek-back"]')`);
      inner = await read(page!, `document.querySelector('.peek .pk-loc')?.textContent ?? ''`);
      await page!.click('[data-act="peek-back"]');
      await page!.until(`(document.querySelector('.peek .pk-loc')?.textContent || '').includes('lib/app.dart') && !document.querySelector('[data-act="peek-back"]')`);
      back = await read(page!, `document.querySelector('.peek .pk-loc')?.textContent ?? ''`);
      await page!.click('.sb-prog');
      await page!.until(`!document.querySelector('.peek')`);
      closed = await read(page!, `document.querySelector('.peek') ? 'open' : 'closed'`);
    });

    it('then a peek shows where greet is defined.', () => {
      assert.equal(definition.includes('Definition') && definition.includes('lib/app.dart'), true);
    });

    it('then a name in the peek replaces it.', () => {
      assert.equal(inner.startsWith('dart:'), true);
    });

    it('then Back returns to greet.', () => {
      assert.equal(back.includes('lib/app.dart'), true);
    });

    it('then a click outside closes the peek.', () => {
      assert.equal(closed, 'closed');
    });
  });

  describe('when the sidebar is dragged wider, ', () => {
    let widths: string;

    before(async () => {
      await rest(page!);
      const start = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      await page!.drag('#vw-split', 80, 0);
      await page!.until(`document.querySelector('#vw-split')?.getAttribute('aria-valuenow') === '${Number(start) + 80}'`);
      const next = await read(page!, `document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''`);
      widths = `${start}\n${next}`;
    });

    after(async () => {
      await fresh();
    });

    it('then the sidebar grows by that distance.', () => {
      assert.equal(widths, '272\n352');
    });
  });

  describe('when the sidebar splitter is double-clicked, ', () => {
    let hidden: string;

    before(async () => {
      await rest(page!);
      await page!.doubleClick('#vw-split');
      await page!.until(`document.querySelector('#viewer')?.classList.contains('side-off')`);
      hidden = await read(page!, `[document.querySelector('#viewer')?.classList.contains('side-off') ? 'hidden' : 'shown', document.querySelector('#vw-split')?.getAttribute('aria-valuenow') ?? ''].join('\\n')`);
    });

    after(async () => {
      await fresh();
    });

    it('then the sidebar hides.', () => {
      assert.equal(hidden, 'hidden\n0');
    });
  });

  describe('when the minimap is clicked below the code on screen, ', () => {
    let moved: string;

    before(async () => {
      await fresh();
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      await page!.click('[data-act="menu"][data-menu="view"]');
      await page!.until(`!!document.querySelector('[data-act="whole"]')`);
      await page!.click('[data-act="whole"]');
      await page!.until(`(document.querySelector('.code[data-p="lib/notes.dart"]')?.textContent || '').includes('// pad 44')`);
      await page!.until(`document.querySelector('#vw-mini') && !document.querySelector('#vw-mini').hidden`);
      const beforeScroll = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      await page!.clickRatio('#vw-mini', 0.5, 0.92);
      await page!.until(`document.querySelector('#vw-main').scrollTop > ${beforeScroll}`);
      const afterScroll = Number(await page!.eval(`document.querySelector('#vw-main').scrollTop`));
      moved = afterScroll > beforeScroll ? 'moved' : `${beforeScroll} ${afterScroll}`;
    });

    it('then the code moves there.', () => {
      assert.equal(moved, 'moved');
    });
  });

  describe('when the language server\'s dot is shown, ', () => {
    let popover: string;

    before(async () => {
      await page!.click('#vw-lsp');
      popover = await read(page!, `(() => {
        const pop = document.querySelector('#lsp-pop');
        const shown = pop ? getComputedStyle(pop).display : '';
        const pid = document.querySelector('#lsp-pid')?.textContent ?? '';
        const rss = document.querySelector('[data-m="rss"]')?.textContent ?? '';
        const cpu = document.querySelector('[data-m="cpu"]')?.textContent ?? '';
        const server = document.querySelector('[data-m="lspRss"]')?.textContent ?? '';
        const serverCpu = document.querySelector('[data-m="lspCpu"]')?.textContent ?? '';
        const kind = (value, pattern, name) => pattern.test(value) ? name : value;
        return [shown, document.querySelector('#lsp-state')?.textContent ?? '', kind(pid, /^pid \\d+$/, 'pid'), kind(rss, /^\\d+(\\.\\d+)? (KB|MB|GB)$/, 'memory'), kind(cpu, /^\\d+\\.\\d%$/, 'cpu'), kind(server, /^\\d+(\\.\\d+)? (KB|MB|GB)$/, 'server memory'), kind(serverCpu, /^\\d+\\.\\d%$/, 'server cpu')].join('\\n');
      })()`);
    });

    it('then its popover names the running server, its pid, and the memory and CPU.', () => {
      assert.equal(popover, 'grid\nDart analysis server, running\npid\nmemory\ncpu\nserver memory\nserver cpu');
    });
  });

  describe('when the greeting chain is opened at 760 pixels wide, ', () => {
    let fit: string;

    before(async () => {
      await page!.setViewport(760, 900);
      await rest(page!);
      await chain(page!, 'greet(name)');
      fit = await read(page!, fits);
    });

    after(async () => {
      await page?.setViewport(1400, 900);
    });

    it('then the page does not scroll sideways.', () => {
      assert.equal(fit, 'fits');
    });
  });

  describe('when the notes file is opened at 480 pixels wide, ', () => {
    let fit: string;

    before(async () => {
      await page!.setViewport(480, 800);
      await rest(page!);
      await openFile(page!, 'lib/notes.dart');
      fit = await read(page!, fits);
    });

    after(async () => {
      await page?.setViewport(1400, 900);
    });

    it('then the page does not scroll sideways.', () => {
      assert.equal(fit, 'fits');
    });
  });
});
