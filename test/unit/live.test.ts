import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { changedSince, LiveSession, openInEditor } from '../../dist/live.js';
import type { Target } from '../../dist/target.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const quiet = { step() {}, detail() {}, note() {}, verbose() {} };

function targetOf(repo: TempRepo, base: string, head: string): Target {
  return { repo: repo.dir, repoKey: 'local/fixture', pr: null, baseRef: 'main', baseSha: base, headSha: head, headDir: null, notes: [] };
}

describe('Given a file whose second line was replaced, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'Alpha\nold\nomega\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'Alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when the lines changed since the base are read, '
    + 'then the new line is the range.',
    () => {
      const ranges = changedSince(repo!.dir, base, head);
      assert.equal(
        Object.entries(ranges).map(([file, list]) => `${file} ${list.map(([first, last]) => `${first}-${last}`).join(' ')}`).join('\n'),
        'lib/a.dart 2-2',
      );
    },
  );

  describe('when the head file is read, ', () => {
    let text: string;

    before(async () => {
      const out = await new LiveSession(targetOf(repo!, base, head), quiet, null).file({ side: 'head', p: 'lib/a.dart' });
      if ('error' in out) throw new Error(out.error);
      text = out.text;
    });

    it('then the text is the head version.', () => {
      assert.equal(text, 'Alpha\nnew\nomega\n');
    });
  });

  it(
    'when a missing file is read, '
    + 'then the answer says it is not there.',
    async () => {
      const out = await new LiveSession(targetOf(repo!, base, head), quiet, null).file({ side: 'head', p: 'lib/missing.dart' });
      assert.equal('error' in out ? out.error : out.text, `lib/missing.dart doesn't exist at ${head.slice(0, 7)}`);
    },
  );

  it(
    'when the head is searched for "old", '
    + 'then there is no hit.',
    () => {
      const found = new LiveSession(targetOf(repo!, base, head), quiet, null).search('head', 'old');
      assert.equal(found.results.map((row) => `${row.p}:${row.l}:${row.text}`).join('\n'), '');
    },
  );

  it(
    'when the head is searched for "new", '
    + 'then the line is returned.',
    () => {
      const found = new LiveSession(targetOf(repo!, base, head), quiet, null).search('head', 'new');
      assert.equal(found.results.map((row) => `${row.p}:${row.l}:${row.text}`).join('\n'), 'lib/a.dart:2:new');
    },
  );

  it(
    'when a lowercase query searches a capitalized line, '
    + 'then the line is returned.',
    () => {
      const found = new LiveSession(targetOf(repo!, base, head), quiet, null).search('base', 'alpha');
      assert.equal(found.results.map((row) => `${row.p}:${row.l}:${row.text}`).join('\n'), 'lib/a.dart:1:Alpha');
    },
  );
});

describe('Given a head file of three lines, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'one\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'one\ntwo\nthree\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when its line count is read, '
    + 'then the file has three lines.',
    () => {
      const counts = new LiveSession(targetOf(repo!, base, head), quiet, null).lineCounts(['lib/a.dart', 'lib/missing.dart']);
      assert.equal(Object.entries(counts).map(([file, count]) => `${file} ${count}`).join('\n'), 'lib/a.dart 3');
    },
  );
});

describe('Given a review whose language server has not been started, ', () => {
  let repo: TempRepo | undefined;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void main() {}\n');
    head = repo.commit({ subject: 'start', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when its state is read, '
    + 'then the language server is off.',
    () => {
      const state = new LiveSession(targetOf(repo!, head, head), quiet, null).state();
      assert.equal(`${state.state} ${state.pid}`, 'off null');
    },
  );
});

describe('Given an editor command that records where it was asked to open, ', () => {
  const marker = path.join(os.tmpdir(), `untangle-editor-${process.pid}`);

  after(() => fs.rmSync(marker, { force: true }));

  it(
    'when a location is opened, '
    + 'then the command receives the file, the line and the column.',
    async () => {
      const script = "require('fs').writeFileSync(process.argv[1], [process.argv[2], process.argv[3], process.argv[4]].join(' '))";
      openInEditor(`node -e ${JSON.stringify(script)} ${JSON.stringify(marker)} {file} {line} {col}`, '/work/lib/a.dart', 4, 2);
      const deadline = Date.now() + 2_000;
      let text = '';
      while (Date.now() < deadline && !text) {
        text = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
        if (!text) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(text, '/work/lib/a.dart 4 3');
    },
  );
});
