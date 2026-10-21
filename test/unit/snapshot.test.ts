import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { fileHunks } from '../../dist/pipeline/diff.js';
import { dropMarks, marksRef, moveMarks, Snapshot, type ModelCompare } from '../../dist/snapshot.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

/** git, and not a mergiraf that happens to be installed for the user. */
const gitOnly = '/usr/bin:/bin';

function usePath(value: string): () => void {
  const previous = process.env.PATH;
  process.env.PATH = value;
  return () => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  };
}

/** A mergiraf that records its arguments and writes a clean merge or conflict markers. */
function stubMergiraf(mode: 'clean' | 'conflict'): { path: string; log: string; remove(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-mergiraf-'));
  const log = path.join(dir, 'calls.log');
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '../helpers/mergiraf-stub.mjs');
  const script = `#!/usr/bin/env bash\nexport MERGIRAF_LOG=${JSON.stringify(log)}\nexport MERGIRAF_MODE=${mode}\nexec node ${JSON.stringify(source)} "$@"\n`;
  fs.writeFileSync(path.join(dir, 'mergiraf'), script, { mode: 0o755 });
  return { path: `${dir}${path.delimiter}${gitOnly}`, log, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const file = 'lib/a.dart';
const marks = 'refs/untangle/marks/feature';

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
    new Snapshot(repo.dir, marks, base, head, model).save(new Set(['the-change']), 'Review the change');
  });

  after(() => repo?.remove());

  describe('when the marks are read, ', () => {
    let message: string;
    let text: string;
    let reviewed: string;
    let branches: string;

    before(() => {
      message = git(repo!.dir, ['log', '-1', '--format=%B', 'untangle/marks/feature']).trimEnd();
      text = execFileSync('git', ['-C', repo!.dir, 'show', `untangle/marks/feature:${file}`], { encoding: 'utf8' });
      branches = git(repo!.dir, ['branch', '--format=%(refname:short)']);
      reviewed = [...new Snapshot(repo!.dir, marks, base, head, model).load(null).reviewed].sort().join(' ');
    });

    it('then the commit names the base and the head.', () => {
      assert.equal(message, `Review the change\n\nUntangle-Base: ${base}\nUntangle-Head: ${head}`);
    });

    it('then their ref holds the new line, and git takes it by its short name.', () => {
      assert.equal(text, 'alpha\nnew\nomega\n');
    });

    it('then they aren’t a branch: the repository’s branches are its own.', () => {
      assert.equal(branches, 'feature\nmain');
    });

    it('then the change is reviewed.', () => {
      assert.equal(reviewed, 'the-change');
    });
  });
});

describe('Given reviews’ keys, ', () => {
  it('when their marks are named, then each is a ref under refs/untangle/marks/, and a key that makes no ref name goes by review.', () => {
    const repo = TempRepo.create();
    try {
      assert.deepEqual(['pr-82', 'feat/x y', 'a..b', 'x.lock', '.'].map((key) => marksRef(repo.dir, key)), [
        'refs/untangle/marks/pr-82',
        'refs/untangle/marks/feat/x-y',
        'refs/untangle/marks/a-b',
        'refs/untangle/marks/review',
        'refs/untangle/marks/review',
      ]);
    } finally {
      repo.remove();
    }
  });
});

describe('Given marks an older untangle kept on the branch untangle/feature, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;
  let model: ModelCompare;
  const branches = () => git(repo!.dir, ['branch', '--format=%(refname:short)']);

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    model = compare(repo.dir, base, head, [block(hunksOf(repo.dir, base, head), 'new', 'the-change')]);
    new Snapshot(repo.dir, 'refs/heads/untangle/feature', base, head, model).save(new Set(['the-change']), 'Review the change');
  });

  after(() => repo?.remove());

  describe('when its review starts, ', () => {
    let reviewed: string;
    let left: string;

    before(() => {
      moveMarks(repo!.dir, marksRef(repo!.dir, 'feature'));
      reviewed = [...new Snapshot(repo!.dir, marks, base, head, model).load(null).reviewed].join(' ');
      left = branches();
    });

    it('then the marks are in their ref, and the review reads them there.', () => {
      assert.equal(reviewed, 'the-change');
    });

    it('then the branch is gone.', () => {
      assert.equal(left, 'feature\nmain');
    });
  });

  describe('when the review is forgotten, ', () => {
    before(() => {
      dropMarks(repo!.dir, marks);
    });

    it('then its marks go.', () => {
      assert.equal(git(repo!.dir, ['for-each-ref', 'refs/untangle/']), '');
    });
  });
});

describe('Given marks an older untangle kept on a branch, checked out in a worktree, ', () => {
  let repo: TempRepo | undefined;
  let other = '';
  let tip = '';

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    const base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    const head = repo.commit({ subject: 'change', author: ada, committer: ada });
    new Snapshot(repo.dir, 'refs/heads/untangle/feature', base, head, compare(repo.dir, base, head, [block(hunksOf(repo.dir, base, head), 'new', 'the-change')])).save(new Set(['the-change']), 'Review the change');
    tip = git(repo.dir, ['rev-parse', 'untangle/feature']);
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-other-'));
    git(repo.dir, ['worktree', 'add', '--quiet', path.join(other, 'wt'), 'untangle/feature']);
  });

  after(() => {
    repo?.remove();
    if (other) fs.rmSync(other, { recursive: true, force: true });
  });

  describe('when its review starts, then forgotten, ', () => {
    let moved = '';
    let kept = '';

    before(() => {
      moveMarks(repo!.dir, marks);
      moved = git(repo!.dir, ['rev-parse', marks]);
      dropMarks(repo!.dir, marks);
      kept = git(repo!.dir, ['rev-parse', 'untangle/feature']);
    });

    it('then the marks move to their ref, and the branch stays where it’s checked out.', () => {
      assert.deepEqual([moved, kept], [tip, tip]);
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
    new Snapshot(repo.dir, marks, base, head1, compare(repo.dir, base, head1, [block(first, 'MARKED', 'marked')])).save(new Set(['marked']), 'Review the first line');
    repo.write(file, 'alpha\nMARKED\nbeta\n\ngamma\nCHANGED\ndelta\n');
    head2 = repo.commit({ subject: 'change another', author: ada, committer: ada });
    const second = hunksOf(repo.dir, base, head2);
    model = compare(repo.dir, base, head2, [block(second, 'MARKED', 'marked'), block(second, 'CHANGED', 'changed')]);
  });

  after(() => repo?.remove());

  describe('when the marks are read for the new head, ', () => {
    let reviewed: string;

    before(() => {
      const loaded = new Snapshot(repo!.dir, marks, base, head2, model).load(null);
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
    new Snapshot(repo.dir, marks, oldBase, head, marked).save(new Set(['the-change']), 'Review the change');
    repo.checkout('main');
    repo.write(file, 'alpha\nother\nomega\n');
    moved = repo.commit({ subject: 'rebase', author: ada, committer: ada });
    repo.checkout('feature');
    model = compare(repo.dir, moved, head, [block(hunksOf(repo.dir, moved, head), 'new', 'the-change')]);
  });

  after(() => repo?.remove());

  describe('when the marks are replayed onto the new base, ', () => {
    let result: string;
    let restore = () => {};

    before(() => {
      restore = usePath(gitOnly);
      const loaded = new Snapshot(repo!.dir, marks, moved, head, model).load(null);
      result = `reviewed ${[...loaded.reviewed].join(' ') || 'none'}\nconflicts ${(loaded.replayed?.conflicts ?? []).join(' ') || 'none'}`;
    });

    after(() => restore());

    it('then the conflicting file goes back to unreviewed.', () => {
      assert.equal(result, 'reviewed none\nconflicts lib/a.dart');
    });
  });
});

describe('Given reviewed marks on a file the new base deletes, ', () => {
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
    new Snapshot(repo.dir, marks, oldBase, head, compare(repo.dir, oldBase, head, [block(hunksOf(repo.dir, oldBase, head), 'new', 'the-change')])).save(new Set(['the-change']), 'Review the change');
    repo.checkout('main');
    repo.delete(file);
    moved = repo.commit({ subject: 'delete the file', author: ada, committer: ada });
    repo.checkout('feature');
    const hunks = hunksOf(repo.dir, moved, head);
    model = compare(repo.dir, moved, head, [block(hunks, 'new', 'the-change')]);
  });

  after(() => repo?.remove());

  describe('when the marks are replayed onto the new base, ', () => {
    let result: string;
    let restore = () => {};

    before(() => {
      restore = usePath(gitOnly);
      const loaded = new Snapshot(repo!.dir, marks, moved, head, model).load(null);
      result = `reviewed ${[...loaded.reviewed].join(' ') || 'none'}\nconflicts ${loaded.replayed?.conflicts.join(' ') || 'none'}`;
    });

    after(() => restore());

    it('then the file conflicts and its change goes back to unreviewed.', () => {
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
    new Snapshot(repo.dir, marks, oldBase, head, compare(repo.dir, oldBase, head, [block(hunksOf(repo.dir, oldBase, head), 'new', 'the-change')])).save(new Set(['the-change']), 'Review the change');
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
    let restore = () => {};

    before(() => {
      restore = usePath(gitOnly);
      const loaded = new Snapshot(repo!.dir, marks, moved, head, model).load(null);
      result = `reviewed ${[...loaded.reviewed].sort().join(' ') || 'none'}\nconflicts ${(loaded.replayed?.conflicts ?? []).join(' ') || 'none'}`;
    });

    after(() => restore());

    it('then the change stays reviewed and nothing conflicts.', () => {
      assert.equal(result, 'reviewed the-change\nconflicts none');
    });
  });
});

describe('Given reviewed marks whose base changes the same line, and mergiraf is a clean merge, ', () => {
  let repo: TempRepo | undefined;
  let head: string;
  let moved: string;
  let model: ModelCompare;
  let mergiraf: ReturnType<typeof stubMergiraf> | undefined;

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    const oldBase = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    new Snapshot(repo.dir, marks, oldBase, head, compare(repo.dir, oldBase, head, [block(hunksOf(repo.dir, oldBase, head), 'new', 'the-change')])).save(new Set(['the-change']), 'Review the change');
    repo.checkout('main');
    repo.write(file, 'alpha\nother\nomega\n');
    moved = repo.commit({ subject: 'rebase', author: ada, committer: ada });
    repo.checkout('feature');
    model = compare(repo.dir, moved, head, [block(hunksOf(repo.dir, moved, head), 'new', 'the-change')]);
    mergiraf = stubMergiraf('clean');
  });

  after(() => {
    mergiraf?.remove();
    repo?.remove();
  });

  describe('when the marks are replayed onto the new base, ', () => {
    let result: string;
    let asked: string;
    let restore = () => {};

    before(() => {
      restore = usePath(mergiraf!.path);
      const loaded = new Snapshot(repo!.dir, marks, moved, head, model).load(null);
      result = `reviewed ${[...loaded.reviewed].join(' ') || 'none'}\nconflicts ${(loaded.replayed?.conflicts ?? []).join(' ') || 'none'}`;
      // Each call's arguments, with its temporary files by name.
      asked = fs.readFileSync(mergiraf!.log, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as string[]).map((arg) => (path.isAbsolute(arg) ? path.basename(arg) : arg)).join(' ')).join('\n');
    });

    after(() => restore());

    it('then the mark is kept.', () => {
      assert.equal(result, 'reviewed the-change\nconflicts none');
    });

    it('then mergiraf merges the file\'s three versions once.', () => {
      assert.equal(asked, 'merge base.dart ours.dart theirs.dart -o merged.dart -p lib/a.dart');
    });
  });
});

describe('Given reviewed marks whose base changes the same line, and mergiraf leaves conflict markers, ', () => {
  let repo: TempRepo | undefined;
  let head: string;
  let moved: string;
  let model: ModelCompare;
  let mergiraf: ReturnType<typeof stubMergiraf> | undefined;

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    const oldBase = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    new Snapshot(repo.dir, marks, oldBase, head, compare(repo.dir, oldBase, head, [block(hunksOf(repo.dir, oldBase, head), 'new', 'the-change')])).save(new Set(['the-change']), 'Review the change');
    repo.checkout('main');
    repo.write(file, 'alpha\nother\nomega\n');
    moved = repo.commit({ subject: 'rebase', author: ada, committer: ada });
    repo.checkout('feature');
    model = compare(repo.dir, moved, head, [block(hunksOf(repo.dir, moved, head), 'new', 'the-change')]);
    mergiraf = stubMergiraf('conflict');
  });

  after(() => {
    mergiraf?.remove();
    repo?.remove();
  });

  describe('when the marks are replayed onto the new base, ', () => {
    let result: string;
    let restore = () => {};

    before(() => {
      restore = usePath(mergiraf!.path);
      const loaded = new Snapshot(repo!.dir, marks, moved, head, model).load(null);
      result = `reviewed ${[...loaded.reviewed].join(' ') || 'none'}\nconflicts ${(loaded.replayed?.conflicts ?? []).join(' ') || 'none'}`;
    });

    after(() => restore());

    it('then the merge falls back to git and the file goes back to unreviewed.', () => {
      assert.equal(result, 'reviewed none\nconflicts lib/a.dart');
    });
  });
});

function failingMergiraf(): { path: string; remove(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-mergiraf-'));
  fs.writeFileSync(path.join(dir, 'mergiraf'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  return { path: `${dir}${path.delimiter}${gitOnly}`, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('Given reviewed marks whose base gains a line above the change, and mergiraf fails, ', () => {
  let repo: TempRepo | undefined;
  let head: string;
  let moved: string;
  let model: ModelCompare;
  let mergiraf: ReturnType<typeof failingMergiraf> | undefined;

  before(() => {
    repo = TempRepo.create();
    repo.write(file, 'alpha\nold\nomega\n');
    const oldBase = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write(file, 'alpha\nnew\nomega\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    new Snapshot(repo.dir, marks, oldBase, head, compare(repo.dir, oldBase, head, [block(hunksOf(repo.dir, oldBase, head), 'new', 'the-change')])).save(new Set(['the-change']), 'Review the change');
    repo.checkout('main');
    repo.write(file, 'prefix\nalpha\nold\nomega\n');
    moved = repo.commit({ subject: 'move the base', author: ada, committer: ada });
    repo.checkout('feature');
    const hunks = hunksOf(repo.dir, moved, head);
    model = compare(repo.dir, moved, head, [block(hunks, 'new', 'the-change')]);
    mergiraf = failingMergiraf();
  });

  after(() => {
    mergiraf?.remove();
    repo?.remove();
  });

  describe('when the marks are replayed onto the new base, ', () => {
    let reviewed: string;
    let restore = () => {};

    before(() => {
      restore = usePath(mergiraf!.path);
      const loaded = new Snapshot(repo!.dir, marks, moved, head, model).load(null);
      reviewed = [...loaded.reviewed].sort().join(' ') || 'none';
    });

    after(() => restore());

    it('then the change stays reviewed.', () => {
      assert.equal(reviewed, 'the-change');
    });
  });
});
