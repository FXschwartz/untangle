import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fileHunks } from '../../dist/pipeline/diff.js';
import { Snapshot, type ModelCompare } from '../../dist/snapshot.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const file = 'lib/a.dart';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).replace(/\n$/, '');
}

function hunksOf(repo: string, base: string, head: string) {
  return fileHunks(repo, base, head, file).map((hunk) => ({
    o: hunk.o,
    n: hunk.n,
    rows: hunk.l.map((line) => [line[0] ?? ' ', line.slice(1)] as [string, string]),
  }));
}

/** The changed run that contains `text`, as one block. */
function block(hunks: ReturnType<typeof hunksOf>, text: string, id: string) {
  for (let hi = 0; hi < hunks.length; hi++) {
    const rows = hunks[hi].rows;
    const hit = rows.findIndex((row) => row[1] === text);
    if (hit < 0) continue;
    let first = hit;
    while (first > 0 && rows[first - 1][0] !== ' ') first--;
    let last = hit;
    while (last + 1 < rows.length && rows[last + 1][0] !== ' ') last++;
    return { id, hunk: hi, first, len: last - first + 1, edits: [0] };
  }
  throw new Error(`no row ${text}`);
}

function compare(repo: string, base: string, head: string, blocks: ModelCompare['files'][0]['blocks']): ModelCompare {
  return { files: [{ p: file, s: 'M', hunks: hunksOf(repo, base, head), blocks }], generated: [] };
}

describe('Given a one-line change that has been marked reviewed, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;
  let model: ModelCompare;

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    model = compare(repo.dir, base, head, [block(hunksOf(repo.dir, base, head), 'new', 'the-change')]);
    new Snapshot(repo.dir, 'untangle/feature', base, head, model).save(new Set(['the-change']), 'Review the change');
  });

  after(() => repo?.remove());

  describe('when the marks branch is read, ', () => {
    let message: string;
    let text: string;
    let reviewed: string;

    before(() => {
      message = git(repo!.dir, ['log', '-1', '--format=%B', 'untangle/feature']).trimEnd();
      text = execFileSync('git', ['-C', repo!.dir, 'show', `untangle/feature:${file}`], { encoding: 'utf8' });
      reviewed = [...new Snapshot(repo!.dir, 'untangle/feature', base, head, model).load(null).reviewed].sort().join(' ');
    });

    it('then the commit names the base and the head.', () => {
      assert.equal(message, `Review the change\n\nUntangle-Base: ${base}\nUntangle-Head: ${head}`);
    });

    it('then the branch holds the new line.', () => {
      assert.equal(text, 'alpha\nnew\nomega\n');
    });

    it('then the change is reviewed.', () => {
      assert.equal(reviewed, 'the-change');
    });
  });
});

describe('Given a reviewed line and a later commit that changes another line, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head2: string;
  let model: ModelCompare;

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\none\nbeta\n\ngamma\nsame\ndelta\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nMARKED\nbeta\n\ngamma\nsame\ndelta\n');
    const head1 = repo.commit({ subject: 'mark this', author: ada, committer: ada });
    const first = hunksOf(repo.dir, base, head1);
    new Snapshot(repo.dir, 'untangle/feature', base, head1, compare(repo.dir, base, head1, [block(first, 'MARKED', 'marked')])).save(new Set(['marked']), 'Review the first line');
    repo.write(file, 'alpha\nMARKED\nbeta\n\ngamma\nCHANGED\ndelta\n');
    head2 = repo.commit({ subject: 'change another', author: ada, committer: ada });
    const second = hunksOf(repo.dir, base, head2);
    model = compare(repo.dir, base, head2, [block(second, 'MARKED', 'marked'), block(second, 'CHANGED', 'changed')]);
  });

  after(() => repo?.remove());

  describe('when the marks are read for the new head, ', () => {
    let reviewed: string;

    before(() => {
      const loaded = new Snapshot(repo!.dir, 'untangle/feature', base, head2, model).load(null);
      reviewed = [...loaded.reviewed].sort().join(' ');
    });

    it('then the reviewed line stays reviewed and the new line does not.', () => {
      assert.equal(reviewed, 'marked');
    });
  });
});

describe('Given reviewed marks whose base then changes the same line, ', () => {
  let repo: TempRepo | undefined;
  let head: string;
  let moved: string;
  let model: ModelCompare;

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    const oldBase = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    const marked = compare(repo.dir, oldBase, head, [block(hunksOf(repo.dir, oldBase, head), 'new', 'the-change')]);
    new Snapshot(repo.dir, 'untangle/feature', oldBase, head, marked).save(new Set(['the-change']), 'Review the change');
    repo.checkout('main');
    repo.write(file, 'alpha\nother\nomega\n');
    moved = repo.commit({ subject: 'rebase', author: ada, committer: ada });
    repo.checkout('feature');
    model = compare(repo.dir, moved, head, [block(hunksOf(repo.dir, moved, head), 'new', 'the-change')]);
  });

  after(() => repo?.remove());

  describe('when the marks are replayed onto the new base, ', () => {
    let result: string;

    before(() => {
      const loaded = new Snapshot(repo!.dir, 'untangle/feature', moved, head, model).load(null);
      result = `reviewed ${[...loaded.reviewed].join(' ') || 'none'}\nconflicts ${(loaded.replayed?.conflicts ?? []).join(' ') || 'none'}`;
    });

    it('then the conflicting file goes back to unreviewed.', () => {
      assert.equal(result, 'reviewed none\nconflicts lib/a.dart');
    });
  });
});

describe('Given reviewed marks whose base gains a line above the change, ', () => {
  let repo: TempRepo | undefined;
  let head: string;
  let moved: string;
  let model: ModelCompare;

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    const oldBase = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    new Snapshot(repo.dir, 'untangle/feature', oldBase, head, compare(repo.dir, oldBase, head, [block(hunksOf(repo.dir, oldBase, head), 'new', 'the-change')])).save(new Set(['the-change']), 'Review the change');
    repo.checkout('main');
    repo.write(file, 'prefix\nalpha\nold\nomega\n');
    moved = repo.commit({ subject: 'move the base', author: ada, committer: ada });
    repo.checkout('feature');
    const hunks = hunksOf(repo.dir, moved, head);
    model = compare(repo.dir, moved, head, [block(hunks, 'new', 'the-change')]);
  });

  after(() => repo?.remove());

  describe('when the marks are replayed onto the new base, ', () => {
    let result: string;

    before(() => {
      const loaded = new Snapshot(repo!.dir, 'untangle/feature', moved, head, model).load(null);
      result = `reviewed ${[...loaded.reviewed].sort().join(' ') || 'none'}\nconflicts ${(loaded.replayed?.conflicts ?? []).join(' ') || 'none'}`;
    });

    it('then the change stays reviewed and nothing conflicts.', () => {
      assert.equal(result, 'reviewed the-change\nconflicts none');
    });
  });
});
