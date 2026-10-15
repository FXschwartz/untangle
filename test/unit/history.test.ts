import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { broughtBy, diffHunks, hasCommit, readHistory, reviewedHead, sinceRows, type History } from '../../dist/history.js';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { reviewFiles, type ReviewFile } from '../helpers/review-files.ts';

/** The identity of commits whose author is not what the test is about. */
const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

const seconds = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));

function dated(date: string): Person {
  return { name: ada.name, email: ada.email, date };
}

let suiteCache: string | undefined;

before(() => {
  suiteCache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-suite-'));
  process.env.UNTANGLE_CACHE = suiteCache;
});

after(() => {
  if (suiteCache) fs.rmSync(suiteCache, { recursive: true, force: true });
  delete process.env.UNTANGLE_CACHE;
});

function hunkText(hunks: Map<string, Array<[number, number]>>): string {
  return [...hunks].map(([file, ranges]) => `${file} ${ranges.map(([start, count]) => `${start}+${count}`).join(' ')}`).join('\n');
}

function commitFiles(history: History, subject: string): string {
  const commit = history.commits.find((item) => item.subject === subject);
  if (!commit) throw new Error(`no commit ${subject}`);
  return commit.files.map((file) => {
    const target = history.paths[file[0]];
    const from = file.length === 5 ? ` from ${history.paths[file[4]]}` : '';
    return `${file[1]} ${target} added ${file[2]} removed ${file[3]}${from}`;
  }).sort().join('\n');
}

function placement(history: History, subject: string, names: Map<string, string>): string {
  const commit = history.commits.find((item) => item.subject === subject);
  if (!commit) throw new Error(`no commit ${subject}`);
  const name = (sha: string) => names.get(sha) ?? history.commits.find((item) => item.sha === sha)?.subject ?? sha;
  const parents = commit.parents.map(name).join(', ') || 'none';
  const outside = commit.outside.map(name).join(', ') || 'none';
  return `${subject} parents: ${parents} outside: ${outside}`;
}

function attributed(files: ReviewFile[], history: History): string {
  return files.map((file, fileIndex) => {
    const hunks = history.rows[fileIndex];
    const body = (file.hunks ?? []).map((hunk, hunkIndex) => hunk.rows.map((row, rowIndex) => {
      const mark = hunks?.[hunkIndex]?.[rowIndex];
      const who = mark == null || mark < 0 ? '-' : history.commits[mark]?.subject ?? String(mark);
      return `${row[0]}${row[1]} [${who}]`;
    }).join('\n')).join('\n');
    return `${file.p}\n${body}`;
  }).join('\n\n');
}

function sinceText(files: ReviewFile[], rows: Record<number, Record<number, number[]>>): string {
  const lines: string[] = [];
  for (const [fileIndex, hunks] of Object.entries(rows)) {
    for (const [hunkIndex, rowIndexes] of Object.entries(hunks)) {
      const file = files[Number(fileIndex)];
      const shown = rowIndexes.map((rowIndex) => {
        const row = file.hunks?.[Number(hunkIndex)]?.rows[rowIndex];
        return row ? `${row[0]}${row[1]}` : `row ${rowIndex}`;
      }).join(', ');
      lines.push(`${file.p} hunk ${hunkIndex} rows ${rowIndexes.join(',')} ${shown}`);
    }
  }
  return lines.join('\n');
}

function broughtText(result: { commits: Array<{ subject: string; author: string; at: number }>; more: boolean } | null): string {
  if (result == null) return 'none';
  const lines = result.commits.map((commit) => `${commit.subject} | ${commit.author} | ${commit.at}`);
  lines.push(result.more ? 'more' : 'no more');
  return lines.join('\n');
}

describe('Given a unified diff that changes one file, removes another and adds a third, ', () => {
  const text = [
    'diff --git a/lib/kept.dart b/lib/kept.dart',
    'index 1111111..2222222 100644',
    '--- a/lib/kept.dart',
    '+++ b/lib/kept.dart',
    '@@ -1,2 +1,3 @@',
    ' alpha',
    '-beta',
    '+gamma',
    '+delta',
    'diff --git a/lib/removed.dart b/lib/removed.dart',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/lib/removed.dart',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-one',
    '-two',
    'diff --git a/lib/added.dart b/lib/added.dart',
    'new file mode 100644',
    'index 0000000..4444444',
    '--- /dev/null',
    '+++ b/lib/added.dart',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
  ].join('\n');

  it(
    'when the new side is read, '
    + 'then each file lists the hunks under its new path.',
    () => {
      assert.equal(hunkText(diffHunks(text, 'plus')), 'lib/kept.dart 1+3\nlib/added.dart 1+2');
    },
  );

  it(
    'when the old side is read, '
    + 'then each file lists the hunks under its old path.',
    () => {
      assert.equal(hunkText(diffHunks(text, 'minus')), 'lib/kept.dart 1+2\nlib/removed.dart 1+2');
    },
  );
});

describe('Given a diff whose hunk removes a line "-- a/lib/other.dart", ', () => {
  // Git prints a removed line "-- a/lib/other.dart" as "--- a/lib/other.dart".
  const text = [
    'diff --git a/lib/a.dart b/lib/a.dart',
    '--- a/lib/a.dart',
    '+++ b/lib/a.dart',
    '@@ -1,2 +1,1 @@',
    ' kept',
    '--- a/lib/other.dart',
    '@@ -8 +7 @@',
    '-before',
    '+after',
    'diff --git a/lib/b.dart b/lib/b.dart',
    '--- a/lib/b.dart',
    '+++ b/lib/b.dart',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');

  it(
    'when the new side is read, '
    + 'then the removed line is not a file header.',
    () => {
      assert.equal(hunkText(diffHunks(text, 'plus')), 'lib/a.dart 1+1 7+1\nlib/b.dart 1+1');
    },
  );

  it(
    'when the old side is read, '
    + 'then the removed line is not a file header.',
    () => {
      assert.equal(hunkText(diffHunks(text, 'minus')), 'lib/a.dart 1+2 8+1\nlib/b.dart 1+1');
    },
  );
});

describe('Given three commits on top of a commit called start, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'one\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', 'one\ntwo\n');
    repo.commit({ subject: 'first', author: ada, committer: ada });
    repo.write('lib/a.dart', 'one\ntwo\nthree\n');
    repo.commit({ subject: 'second', author: ada, committer: ada });
    repo.write('lib/a.dart', 'one\ntwo\nthree\nfour\n');
    head = repo.commit({ subject: 'third', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when its history is read, ', () => {
    let history: History;

    before(async () => {
      history = await readHistory(repo!.dir, base, head, [], null);
    });

    it('then the commits are listed newest first.', () => {
      assert.equal(history.commits.map((commit) => commit.subject).join('\n'), 'third\nsecond\nfirst');
    });

    it('then each commit\'s parents inside the review are separate from the parent outside it.', () => {
      const names = new Map([[base, 'start']]);
      assert.equal(
        ['third', 'second', 'first'].map((subject) => placement(history, subject, names)).join('\n'),
        [
          'third parents: second outside: none',
          'second parents: first outside: none',
          'first parents: none outside: start',
        ].join('\n'),
      );
    });
  });
});

describe('Given a commit authored by Ada Review and committed by Grace Commit, ', () => {
  const author: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
  const committer: Person = { name: 'Grace Commit', email: 'grace@example.com', date: '2020-06-02T03:04:05Z' };
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'base\n');
    base = repo.commit({ subject: 'start', author, committer: author });
    repo.write('lib/a.dart', 'changed\n');
    head = repo.commit({ subject: 'the change', author, committer });
  });

  after(() => repo?.remove());

  it(
    'when its history is read, '
    + 'then the author and the committer are each recorded with their own time.',
    async () => {
      const history = await readHistory(repo!.dir, base, head, [], null);
      const commit = history.commits[0];
      assert.equal(
        [commit.author, commit.email, String(commit.at), commit.committer, commit.cemail, String(commit.cat)].join('\n'),
        [author.name, author.email, seconds(author.date), committer.name, committer.email, seconds(committer.date)].join('\n'),
      );
    },
  );
});

describe('Given a branch that edits a file and then merges two files added on main, ', () => {
  const addsBAt = '2020-06-03T00:00:00Z';
  const addsCAt = '2020-06-04T00:00:00Z';
  let repo: TempRepo | undefined;
  let start: string;
  let main: string;
  let merge: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'a\n');
    start = repo.commit({ subject: 'start', author: dated('2020-06-01T00:00:00Z'), committer: dated('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', 'a\nfeature\n');
    repo.commit({ subject: 'feature edits a', author: dated('2020-06-02T00:00:00Z'), committer: dated('2020-06-02T00:00:00Z') });
    repo.checkout('main');
    repo.write('lib/b.dart', 'b\n');
    repo.commit({ subject: 'main adds b', author: dated(addsBAt), committer: dated(addsBAt) });
    repo.write('lib/c.dart', 'c\n');
    main = repo.commit({ subject: 'main adds c', author: dated(addsCAt), committer: dated(addsCAt) });
    repo.checkout('feature');
    merge = repo.merge({ ref: 'main', subject: 'merge main', author: dated('2020-06-05T00:00:00Z'), committer: dated('2020-06-05T00:00:00Z') });
  });

  after(() => repo?.remove());

  describe('when its history is read against main, ', () => {
    let history: History;

    before(async () => {
      history = await readHistory(repo!.dir, main, merge, [], null);
    });

    it('then the merge\'s parent on the branch is inside the review and its main parent is outside it.', () => {
      const names = new Map([[start, 'start'], [main, 'main']]);
      assert.equal(placement(history, 'merge main', names), 'merge main parents: feature edits a outside: main');
    });

    it('then the merge brought the two commits main added.', () => {
      const commit = history.commits.find((item) => item.subject === 'merge main');
      assert.equal(commit?.brought, 2);
    });

    it('then the merge lists the two files main added.', () => {
      assert.equal(commitFiles(history, 'merge main'), 'A lib/b.dart added 1 removed 0\nA lib/c.dart added 1 removed 0');
    });

    it('then the branch\'s own commit lists only the file it changed.', () => {
      assert.equal(commitFiles(history, 'feature edits a'), 'M lib/a.dart added 1 removed 0');
    });
  });

  describe('when the commits the merge brought are listed, ', () => {
    let listed: Awaited<ReturnType<typeof broughtBy>>;

    before(async () => {
      listed = await broughtBy(repo!.dir, merge);
    });

    it('then those two commits are listed newest first.', () => {
      assert.equal(
        broughtText(listed),
        [
          `main adds c | ${ada.name} | ${seconds(addsCAt)}`,
          `main adds b | ${ada.name} | ${seconds(addsBAt)}`,
          'no more',
        ].join('\n'),
      );
    });
  });

  describe('when only the newest brought commit is asked for, ', () => {
    let listed: Awaited<ReturnType<typeof broughtBy>>;

    before(async () => {
      listed = await broughtBy(repo!.dir, merge, 1);
    });

    it('then that commit is listed and more remain.', () => {
      assert.equal(broughtText(listed), `main adds c | ${ada.name} | ${seconds(addsCAt)}\nmore`);
    });
  });
});

describe('Given a branch that adds a file, edits it, removes another and renames a third, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/gone.dart', 'gone\n');
    repo.write('lib/old.dart', 'alpha\nbeta\ngamma\ndelta\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/added.dart', 'one\ntwo\n');
    repo.commit({ subject: 'adds a file', author: ada, committer: ada });
    repo.write('lib/added.dart', 'one\nTWO\n');
    repo.commit({ subject: 'edits the file', author: ada, committer: ada });
    repo.delete('lib/gone.dart');
    repo.commit({ subject: 'removes a file', author: ada, committer: ada });
    repo.rename('lib/old.dart', 'lib/new.dart');
    head = repo.commit({ subject: 'renames a file', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  describe('when its history is read, ', () => {
    let history: History;

    before(async () => {
      history = await readHistory(repo!.dir, base, head, [], null);
    });

    it('then the adding commit lists the new file as added, with the lines it added.', () => {
      assert.equal(commitFiles(history, 'adds a file'), 'A lib/added.dart added 2 removed 0');
    });

    it('then the editing commit lists that file as modified, with the lines it changed.', () => {
      assert.equal(commitFiles(history, 'edits the file'), 'M lib/added.dart added 1 removed 1');
    });

    it('then the removing commit lists the file as deleted, with the lines it removed.', () => {
      assert.equal(commitFiles(history, 'removes a file'), 'D lib/gone.dart added 0 removed 1');
    });

    it('then the renaming commit lists the new path as renamed from the old one.', () => {
      assert.equal(commitFiles(history, 'renames a file'), 'R lib/new.dart added 0 removed 0 from lib/old.dart');
    });

    it('then the add and the edit name one shared path.', () => {
      const added = history.commits.find((commit) => commit.subject === 'adds a file');
      const edited = history.commits.find((commit) => commit.subject === 'edits the file');
      const addedIndex = added?.files[0]?.[0];
      const editedIndex = edited?.files[0]?.[0];
      assert.equal(
        [
          addedIndex == null ? 'missing' : history.paths[addedIndex],
          String(addedIndex === editedIndex),
          String(history.paths.filter((item) => item === 'lib/added.dart').length),
        ].join('\n'),
        'lib/added.dart\ntrue\n1',
      );
    });
  });
});

describe('Given a commit that adds a binary file, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'a\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('assets/blob.bin', Buffer.from([0, 1, 2, 3, 0]));
    head = repo.commit({ subject: 'adds a binary', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when its history is read, '
    + 'then the file\'s added and removed counts are -1.',
    async () => {
      const history = await readHistory(repo!.dir, base, head, [], null);
      assert.equal(commitFiles(history, 'adds a binary'), 'A assets/blob.bin added -1 removed -1');
    },
  );
});

describe('Given two commits, one dropping a line and adding another, the next replacing a line, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;
  let files: ReviewFile[];

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'keep\ndrop-early\nold\ntail\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'keep\nold\nfrom-first\ntail\n');
    repo.commit({ subject: 'drops a line and adds one', author: ada, committer: ada });
    repo.write('lib/a.dart', 'keep\nfresh\nfrom-first\ntail\n');
    head = repo.commit({ subject: 'replaces old', author: ada, committer: ada });
    files = reviewFiles(repo.dir, base, head);
  });

  after(() => repo?.remove());

  it(
    'when the history of those hunks is read, '
    + 'then each added row names the commit that wrote it and each removed row the commit that removed it.',
    async () => {
      const history = await readHistory(repo!.dir, base, head, files, null);
      assert.equal(
        attributed(files, history),
        [
          'lib/a.dart',
          ' keep [-]',
          '-drop-early [drops a line and adds one]',
          '-old [replaces old]',
          '+fresh [replaces old]',
          '+from-first [drops a line and adds one]',
          ' tail [-]',
        ].join('\n'),
      );
    },
  );
});

describe('Given a review of two commits and the head of the first, ', () => {
  let repo: TempRepo | undefined;
  let base: string;
  let head: string;
  let older: string;
  let files: ReviewFile[];

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'keep\ngone-already\ngone-later\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'keep\ngone-later\nadded-early\n');
    older = repo.commit({ subject: 'first', author: ada, committer: ada });
    repo.write('lib/a.dart', 'keep\nadded-early\nadded-late\n');
    head = repo.commit({ subject: 'second', author: ada, committer: ada });
    files = reviewFiles(repo.dir, base, head);
  });

  after(() => repo?.remove());

  it(
    'when the rows changed since that head are read, '
    + 'then they are the lines the second commit changed.',
    async () => {
      const rows = await sinceRows(repo!.dir, base, head, older, files);
      assert.ok(rows);
      assert.equal(sinceText(files, rows), 'lib/a.dart hunk 0 rows 2,4 -gone-later, +added-late');
    },
  );
});

describe('Given a sha that is not in the repository, ', () => {
  let repo: TempRepo | undefined;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'a\n');
    repo.commit({ subject: 'start', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when the rows since that sha are asked, '
    + 'then there are none.',
    async () => {
      const missing = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const rows = await sinceRows(repo!.dir, repo!.rev('HEAD'), repo!.rev('HEAD'), missing, []);
      assert.equal(rows, null);
    },
  );
});

describe('Given history.json recording these commits with a subject the repository does not, ', () => {
  let repo: TempRepo | undefined;
  let cacheDir = '';
  let base: string;
  let head: string;

  before(async () => {
    repo = TempRepo.create();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-history-'));
    repo.write('lib/a.dart', 'one\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'two\n');
    head = repo.commit({ subject: 'the change', author: ada, committer: ada });
    await readHistory(repo.dir, base, head, [], cacheDir);
    const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'history.json'), 'utf8')) as History;
    saved.commits[0].subject = 'from the cache';
    fs.writeFileSync(path.join(cacheDir, 'history.json'), JSON.stringify(saved));
  });

  after(() => {
    repo?.remove();
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    'when the history is read again, '
    + 'then the commits are the ones history.json recorded.',
    async () => {
      const history = await readHistory(repo!.dir, base, head, [], cacheDir);
      assert.equal(history.commits.map((commit) => commit.subject).join('\n'), 'from the cache');
    },
  );
});

describe('Given history.json for an older head, ', () => {
  let repo: TempRepo | undefined;
  let cacheDir = '';
  let base: string;
  let second: string;

  before(async () => {
    repo = TempRepo.create();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-history-'));
    repo.write('lib/a.dart', 'one\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'two\n');
    const first = repo.commit({ subject: 'first', author: ada, committer: ada });
    await readHistory(repo.dir, base, first, [], cacheDir);
    const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, 'history.json'), 'utf8')) as History;
    saved.commits[0].subject = 'from the cache';
    fs.writeFileSync(path.join(cacheDir, 'history.json'), JSON.stringify(saved));
    repo.write('lib/a.dart', 'three\n');
    second = repo.commit({ subject: 'second', author: ada, committer: ada });
  });

  after(() => {
    repo?.remove();
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    'when the history is read for the newer head, '
    + 'then the commits are the newer head\'s.',
    async () => {
      const history = await readHistory(repo!.dir, base, second, [], cacheDir);
      assert.equal(
        `${history.head}\n${history.commits.map((commit) => commit.subject).join('\n')}`,
        `${second}\nsecond\nfirst`,
      );
    },
  );
});

describe('Given a marks branch whose newest save names this head and whose two earlier saves name older heads, ', () => {
  const oldestSave = '2020-07-01T00:00:00Z';
  const previousSave = '2020-07-02T00:00:00Z';
  const currentSave = '2020-07-03T00:00:00Z';
  let repo: TempRepo | undefined;
  let previous: string;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'one\n');
    const oldest = repo.commit({ subject: 'oldest', author: ada, committer: ada });
    repo.write('lib/a.dart', 'two\n');
    previous = repo.commit({ subject: 'previous', author: ada, committer: ada });
    repo.write('lib/a.dart', 'three\n');
    head = repo.commit({ subject: 'head', author: ada, committer: ada });
    repo.branch('untangle/feature');
    repo.commit({
      subject: 'Save the oldest review',
      body: `Untangle-Head: ${oldest}\n`,
      allowEmpty: true,
      author: dated(oldestSave),
      committer: dated(oldestSave),
    });
    repo.commit({
      subject: 'Save the previous review',
      body: `Untangle-Head: ${previous}\n`,
      allowEmpty: true,
      author: dated(previousSave),
      committer: dated(previousSave),
    });
    repo.commit({
      subject: 'Save this review',
      body: `Untangle-Head: ${head}\n`,
      allowEmpty: true,
      author: dated(currentSave),
      committer: dated(currentSave),
    });
  });

  after(() => repo?.remove());

  it(
    'when the reviewed head is read, '
    + 'then it is the newest save of another head, at that save\'s time.',
    () => {
      const found = reviewedHead(repo!.dir, 'untangle/feature', head);
      assert.equal(found ? `${found.head} ${found.at}` : 'none', `${previous} ${seconds(previousSave)}`);
    },
  );
});

describe('Given a marks branch whose only save names this head, ', () => {
  let repo: TempRepo | undefined;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'one\n');
    head = repo.commit({ subject: 'head', author: ada, committer: ada });
    repo.branch('untangle/feature');
    repo.commit({
      subject: 'Save this review',
      body: `Untangle-Head: ${head}\n`,
      allowEmpty: true,
      author: ada,
      committer: ada,
    });
  });

  after(() => repo?.remove());

  it(
    'when the reviewed head is read, '
    + 'then there is no earlier review.',
    () => {
      assert.equal(reviewedHead(repo!.dir, 'untangle/feature', head), null);
    },
  );
});

describe('Given a repository with no marks branch, ', () => {
  let repo: TempRepo | undefined;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'one\n');
    head = repo.commit({ subject: 'head', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when the reviewed head is read, '
    + 'then there is no earlier review.',
    () => {
      assert.equal(reviewedHead(repo!.dir, 'untangle/missing', head), null);
    },
  );
});

describe('Given a commit that is not a merge, ', () => {
  let repo: TempRepo | undefined;
  let head: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'a\n');
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.write('lib/a.dart', 'b\n');
    head = repo.commit({ subject: 'the change', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when the commits it brought are listed, '
    + 'then none are.',
    async () => {
      assert.equal(broughtText(await broughtBy(repo!.dir, head)), 'no more');
    },
  );
});

describe('Given a sha that is not a commit, ', () => {
  let repo: TempRepo | undefined;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'a\n');
    repo.commit({ subject: 'start', author: ada, committer: ada });
  });

  after(() => repo?.remove());

  it(
    'when the commits it brought are listed, '
    + 'then there is nothing to list.',
    async () => {
      assert.equal(broughtText(await broughtBy(repo!.dir, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')), 'none');
    },
  );
});

describe('Given a repository with one commit, ', () => {
  let repo: TempRepo | undefined;
  let sha: string;
  let tree: string;

  before(() => {
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'a\n');
    sha = repo.commit({ subject: 'start', author: ada, committer: ada });
    tree = repo.rev('HEAD^{tree}');
  });

  after(() => repo?.remove());

  it(
    'when its full sha is asked, '
    + 'then it is a commit.',
    () => {
      assert.equal(hasCommit(repo!.dir, sha), true);
    },
  );

  it(
    'when its seven-character prefix is asked, '
    + 'then it is a commit.',
    () => {
      assert.equal(hasCommit(repo!.dir, sha.slice(0, 7)), true);
    },
  );

  it(
    'when a six-character prefix is asked, '
    + 'then it is not a commit.',
    () => {
      assert.equal(hasCommit(repo!.dir, sha.slice(0, 6)), false);
    },
  );

  it(
    'when an unknown sha is asked, '
    + 'then it is not a commit.',
    () => {
      assert.equal(hasCommit(repo!.dir, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false);
    },
  );

  it(
    'when its tree is asked, '
    + 'then it is not a commit.',
    () => {
      assert.equal(hasCommit(repo!.dir, tree), false);
    },
  );
});
