import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TempRepo, type Person } from '../helpers/repo.ts';
import type { NotesContext, Post } from '../../dist/notes.js';

// A burst of notes reaches an agent this long after the last one.
process.env.UNTANGLE_NOTES_QUIET = '150';
const { Notes, follow, mapLine, parseDiff } = await import('../../dist/notes.js');

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const short = (sha: string) => sha.slice(0, 7);

const v1 = ['void greet() {', "  print('hi');", '}', ''].join('\n');
const v2 = ['/// Greets someone.', 'void greet(String name) {', "  final message = 'Hello, $name!';", '  print(message);', '}', ''].join('\n');
const v3 = ['/// Greets someone.', 'void greet(String name) {', "  print('Hello, $name!');", '}', ''].join('\n');

/** main has v1; feature has v2, then v3 (which drops lib/todo.dart and splits a line of lib/list.dart in three). */
function greeting() {
  const repo = TempRepo.create();
  repo.write('lib/app.dart', v1);
  repo.write('lib/todo.dart', '// Later.\n');
  repo.write('lib/list.dart', 'final a = 1;\nfinal all = [a, b, c];\nfinal c = 3;\n');
  const base = repo.commit({ subject: 'Start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.branch('feature');
  repo.write('lib/app.dart', v2);
  repo.write('lib/todo.dart', '// Later.\n// Sooner.\n');
  const head = repo.commit({ subject: 'Greet by name', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  repo.write('lib/app.dart', v3);
  repo.delete('lib/todo.dart');
  repo.write('lib/list.dart', 'final a = 1;\nfinal all = [\n  a, b, c,\n];\nfinal c = 3;\n');
  const next = repo.commit({ subject: 'Inline the message', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
  return { repo, base, head, next };
}

function context(repo: TempRepo, base: string, head: string, posted: Post[] = []): NotesContext {
  return {
    repo: repo.dir, base, head, name: 'acme/app#7', branch: 'feature',
    change: (p, side, line) => (p === 'lib/app.dart' && side === 'RIGHT' && line === 3 ? { name: 'Greet by name', sha: head } : null),
    post: async (x) => { posted.push(x); return { posted: posted.length }; },
  };
}

describe('Given a diff that changes, renames, deletes and adds files, ', () => {
  const text = [
    'diff --git a/lib/a.dart b/lib/a.dart',
    'index 1..2 100644',
    '--- a/lib/a.dart',
    '+++ b/lib/a.dart',
    '@@ -3,2 +3 @@ void a() {',
    "--- a removed line that looks like a header",
    '-  b();',
    '+  c();',
    '@@ -10,0 +11,2 @@',
    '+x',
    '+y',
    'diff --git a/lib/old.dart b/lib/new.dart',
    'similarity index 100%',
    'rename from lib/old.dart',
    'rename to lib/new.dart',
    'diff --git a/lib/gone.dart b/lib/gone.dart',
    'deleted file mode 100644',
    '--- a/lib/gone.dart',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
    'diff --git a/lib/fresh.dart b/lib/fresh.dart',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/lib/fresh.dart',
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');

  it('when it is read, then each old file says where it went and its hunks, and a new file has no old one.', () => {
    assert.deepEqual(Object.fromEntries(parseDiff(text)), {
      'lib/a.dart': { to: 'lib/a.dart', hunks: [[3, 2, 3, 1], [10, 0, 11, 2]], binary: false },
      'lib/old.dart': { to: 'lib/new.dart', hunks: [], binary: false },
      'lib/gone.dart': { to: null, hunks: [[1, 1, 0, 0]], binary: false },
    });
  });
});

describe('Given hunks that replace lines 3 and 4 with one line, and add two lines after line 10, ', () => {
  const hunks: Array<[number, number, number, number]> = [[3, 2, 3, 1], [10, 0, 11, 2]];

  it('when lines are followed, then the lines above stay, the lines between shift up one, and the lines after the insertion down one more.', () => {
    assert.deepEqual([1, 2, 5, 10, 11].map((l) => mapLine(hunks, l)), [1, 2, 4, 9, 12]);
  });

  it('when a replaced line is followed, then it has no place of its own.', () => {
    assert.equal(mapLine(hunks, 4), null);
  });

  it('when a range over the replaced lines is followed, then it lands on the line that replaced them, changed.', () => {
    assert.deepEqual(follow(hunks, 3, 4), { from: 3, to: 3, changed: true });
  });

  it('when a range around the insertion is followed, then it stretches over the new lines, changed.', () => {
    assert.deepEqual(follow(hunks, 9, 11), { from: 8, to: 12, changed: true });
  });

  it('when a range the hunks don’t touch is followed, then it shifts, unchanged.', () => {
    assert.deepEqual(follow(hunks, 6, 8), { from: 5, to: 7, changed: false });
  });

  it('when lines a hunk only removed are followed, then they are gone.', () => {
    assert.equal(follow([[3, 2, 2, 0]], 3, 4), null);
  });
});

describe('Given notes on the greeting’s message and print, and a note on a file the next commit deletes, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  const posted: Post[] = [];

  before(async () => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'pr-7.json'));
    notes.attach(context(g.repo, g.base, g.head, posted));
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 3, body: 'Why a local?' });
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', startLine: 4, line: 5, body: 'Print it once.' });
    await notes.act({ action: 'reply', n: 2, body: 'And flush.' });
    await notes.act({ action: 'add', path: 'lib/todo.dart', side: 'RIGHT', line: 2, body: 'Sooner than what?' });
    await notes.act({ action: 'resolve', n: 3, resolved: true });
    await notes.act({ action: 'add', path: 'lib/list.dart', side: 'RIGHT', line: 2, body: 'One per line?' });
    await notes.act({ action: 'resolve', n: 4, resolved: true });
  });

  after(() => {
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when the open notes are copied, then each comes with its lines, its code, the change it is in and its thread.', () => {
    assert.equal(notes.exportText('open'), [
      `My review notes on acme/app#7 (branch feature, at ${short(g.head)}). Line numbers are on that commit.`,
      '',
      'Discuss these with me before changing anything.',
      '',
      'N1 · lib/app.dart:3',
      `In the change "Greet by name" (${short(g.head)})`,
      '```dart',
      "  final message = 'Hello, $name!';",
      '```',
      'Why a local?',
      '',
      'N2 · lib/app.dart:4-5',
      '```dart',
      '  print(message);',
      '}',
      '```',
      'Print it once.',
      'You: And flush.',
      '',
    ].join('\n'));
  });

  it('when all the notes are copied, then the resolved ones come too, said so.', () => {
    assert.match(notes.exportText('all'), /\nN3 · lib\/todo\.dart:2 \(resolved\)\n```dart\n\/\/ Sooner\.\n```\nSooner than what\?\n\nN4 · lib\/list\.dart:2 \(resolved\)\n/);
  });

  it('when the notes are read again from their file, then they are the same.', () => {
    const again = new Notes(notes.file);
    again.attach(context(g.repo, g.base, g.head));
    assert.equal(again.exportText('all'), notes.exportText('all'));
  });

  describe('and the review moves to the next commit, ', () => {
    let moved: InstanceType<typeof Notes>;

    before(() => {
      moved = new Notes(notes.file);
      moved.attach(context(g.repo, g.base, g.next));
    });

    it('when the notes are listed, then the message’s note is on the line that replaced it, the print’s on the lines after, the split line’s on its three, all changed, and the deleted file’s note is gone.', () => {
      const view = moved.view();
      assert.deepEqual(view.notes.map((n) => [n.n, n.path, n.startLine, n.line, n.changed, n.gone, n.code]), [
        [1, 'lib/app.dart', null, 3, true, false, ["  print('Hello, $name!');"]],
        [2, 'lib/app.dart', 3, 4, true, false, ["  print('Hello, $name!');", '}']],
        [3, 'lib/todo.dart', null, 2, false, true, ['// Sooner.']],
        [4, 'lib/list.dart', 2, 4, true, false, ['final all = [', '  a, b, c,', '];']],
      ]);
    });

    it('when the message’s note is copied, then it says its lines changed since it was written, and shows the new ones.', () => {
      const n1 = moved.view().notes[0];
      assert.equal(n1.text, [
        `N1 · lib/app.dart:3`,
        `In the change "Greet by name" (${short(g.next)})`,
        `Changed since ${short(g.head)}, where I wrote this. The lines below are the new ones.`,
        '```dart',
        "  print('Hello, $name!');",
        '```',
        'Why a local?',
        '',
      ].join('\n'));
    });

    it('when the gone note is copied, then it shows the lines it was written on.', () => {
      assert.equal(moved.view().notes[2].text, [
        'N3 · lib/todo.dart:2 (resolved)',
        `Gone since ${short(g.head)}, where I wrote this. The lines below are the ones it was on then.`,
        '```dart',
        '// Sooner.',
        '```',
        'Sooner than what?',
        '',
      ].join('\n'));
    });
  });

  it('when the open notes are posted to GitHub, then each goes into the pending review on its lines, and leaves the notes.', async () => {
    const out = await notes.act({ action: 'post', ns: [1, 2] });
    assert.deepEqual(posted, [
      { path: 'lib/app.dart', body: 'Why a local?', line: 3, side: 'RIGHT' },
      { path: 'lib/app.dart', body: 'Print it once.', line: 5, side: 'RIGHT', startLine: 4, startSide: 'RIGHT' },
    ]);
    assert.deepEqual([out.notes.map((n) => n.n), out.conversation], [[3, 4], { posted: 2 }]);
  });
});

describe('Given notes an agent watches, ', () => {
  let g: ReturnType<typeof greeting>;
  let dir = '';
  let notes: InstanceType<typeof Notes>;
  let pushed = 0;

  before(() => {
    g = greeting();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-notes-'));
    notes = new Notes(path.join(dir, 'feature.json'), () => { pushed++; });
    notes.attach(context(g.repo, g.base, g.head));
  });

  after(() => {
    notes.close();
    g.repo.remove();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('when two notes come in a burst, then the waiting watch gets both at once, with the opening line, and says how to go on the first time.', async () => {
    const waiting = notes.watch('Claude Code', { timeout: 10_000 });
    assert.deepEqual(notes.agents().map((a) => [a.name, a.state]), [['Claude Code', 'watching']]);
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 3, body: 'Why a local?' });
    await new Promise((r) => setTimeout(r, 60));
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 4, body: 'Flush after it.' });
    const got = await waiting;
    assert.ok('text' in got);
    assert.deepEqual([got.notes, got.replies, got.first], [2, 0, true]);
    assert.equal(got.text.split('\n').slice(0, 3).join('\n'), `untangle: 2 notes you haven’t read, on acme/app#7 at ${short(g.head)}. Line numbers are on that commit.\n\nDiscuss these with me before changing anything.`);
    assert.match(got.text, /\nN1 · lib\/app\.dart:3\n[\s\S]*\nN2 · lib\/app\.dart:4\n/);
  });

  it('when the page lists the notes, then the agent read them, and works on them.', () => {
    const view = notes.view();
    assert.deepEqual([view.notes.map((n) => n.status), view.agents.map((a) => [a.name, a.state])], [[{ read: 'Claude Code' }, { read: 'Claude Code' }], [['Claude Code', 'working']]]);
  });

  it('when the agent answers and resolves a note, then the page shows its answer and who resolved it, and its own watch doesn’t get them back.', async () => {
    notes.reply('Claude Code', 2, 'Done in abc1234.', true);
    const n2 = notes.view().notes[1];
    assert.deepEqual([n2.comments.map((c) => [c.by, c.body]), n2.resolved?.by], [[[null, 'Flush after it.'], ['Claude Code', 'Done in abc1234.']], 'Claude Code']);
    const again = await notes.watch('Claude Code', { timeout: 300 });
    assert.deepEqual(again, { idle: true, first: false });
  });

  it('when you answer, reopen and edit, then the next watch gets your reply and what changed on the notes it read.', async () => {
    await notes.act({ action: 'reply', n: 1, body: 'Keep the doc comment.' });
    await notes.act({ action: 'resolve', n: 2, resolved: false });
    await notes.act({ action: 'edit', n: 2, id: notes.view().notes[1].comments[0].id, body: 'Flush after it, always.' });
    const got = await notes.watch('Claude Code', { timeout: 5_000 });
    assert.ok('text' in got);
    assert.equal(got.text.slice(got.text.indexOf('\n\n') + 2), [
      'N1 · lib/app.dart:3 · a reply in its thread',
      '> Why a local?',
      'You: Keep the doc comment.',
      '',
      'N2 · lib/app.dart:4 · reopened by you.',
      '',
      'N2 · lib/app.dart:4 · you edited the note:',
      'Flush after it, always.',
      '',
    ].join('\n'));
  });

  it('when live review is off, then a new note waits, held, until you send it.', async () => {
    await notes.act({ action: 'settings', live: false });
    await notes.act({ action: 'add', path: 'lib/app.dart', side: 'RIGHT', line: 2, body: 'Name it person?' });
    assert.deepEqual([notes.view().held, notes.view().notes[2].status], [1, 'held']);
    assert.deepEqual(await notes.watch('Claude Code', { timeout: 300 }), { idle: true, first: false });
    await notes.act({ action: 'send' });
    const got = await notes.watch('Claude Code', { timeout: 5_000 });
    assert.ok('text' in got && /\nN3 · lib\/app\.dart:2\n/.test(got.text));
    assert.equal(notes.view().held, 0);
  });

  it('when another agent watches for the first time, then it gets every note, the first agent’s answer with them.', async () => {
    const got = await notes.watch('Codex', { timeout: 5_000 });
    assert.ok('text' in got);
    assert.deepEqual([got.notes, got.first, /\nClaude Code: Done in abc1234\.\n/.test(got.text)], [3, true, true]);
  });

  it('when the agent stops asking, then it is no longer watching, but still working on what it read.', async () => {
    const stop = new AbortController();
    const state = () => notes.agents().find((a) => a.name === 'Codex')?.state;
    void notes.watch('Codex', { timeout: 10_000, signal: stop.signal });
    const waiting = state();
    stop.abort();
    assert.deepEqual([waiting, state()], ['watching', 'working']);
  });

  it('when the review closes, then a waiting watch hears so.', async () => {
    const waiting = notes.watch('Claude Code', { timeout: 10_000 });
    notes.close();
    assert.deepEqual(await waiting, { closed: true });
    assert.ok(pushed > 0);
  });
});
