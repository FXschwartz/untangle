import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rehomeCheckouts, worktree } from '../../dist/checkouts.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** The folders git lists as the repository's worktrees. */
const worktrees = (repo: string) => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => fs.realpathSync(l.slice(9)));
const hourAgo = () => new Date(Date.now() - 3600_000);

describe('Given a repository reviewed in its directory, ', () => {
  let repo: TempRepo | undefined;
  let cache = '';
  let first = '';
  let second = '';
  const checkout = (key: string, sha: string) => path.join(cache, 'worktrees', key, sha.slice(0, 12));

  before(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    process.env.UNTANGLE_CACHE = cache;
    repo = TempRepo.create();
    repo.write('lib/a.dart', 'void a() {}\n');
    first = repo.commit({ subject: 'first', author: ada, committer: ada });
    repo.write('lib/a.dart', 'void b() {}\n');
    second = repo.commit({ subject: 'second', author: ada, committer: ada });
  });

  after(() => {
    delete process.env.UNTANGLE_CACHE;
    repo?.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when a checkout of a commit is made, ', () => {
    let dir = '';

    before(async () => {
      dir = await worktree(repo!.dir, 'local/app', first);
    });

    it('then it holds the commit in the cache, with nothing uncommitted, and git works in it.', () => {
      assert.equal(dir, fs.realpathSync(checkout('local/app', first)));
      assert.deepEqual([fs.readFileSync(path.join(dir, 'lib/a.dart'), 'utf8'), git(dir, 'rev-parse', 'HEAD'), git(dir, 'status', '--porcelain'), git(dir, 'log', '-1', '--format=%s')], ['void a() {}\n', first, '', 'first']);
    });

    it('then it’s a repository of its own, which the repository doesn’t list among its worktrees.', () => {
      assert.ok(fs.statSync(path.join(dir, '.git')).isDirectory());
      assert.deepEqual(worktrees(repo!.dir), [fs.realpathSync(repo!.dir)]);
    });
  });

  describe('when a clone of the repository asks for the same commit, ', () => {
    let clone = '';
    let dir = '';

    before(async () => {
      clone = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-clone-'));
      git(clone, 'clone', '--quiet', repo!.dir, 'app');
      dir = await worktree(path.join(clone, 'app'), 'local/app', first);
    });

    after(() => fs.rmSync(clone, { recursive: true, force: true }));

    it('then it gets the same checkout, which borrows from both.', () => {
      assert.equal(dir, fs.realpathSync(checkout('local/app', first)));
      const borrowed = fs.readFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), 'utf8').trim().split('\n');
      assert.deepEqual(borrowed.map((d) => path.basename(path.dirname(path.dirname(d)))), [path.basename(repo!.dir), 'app']);
    });
  });

  describe('when checkouts an older untangle made as worktrees of the repository are rehomed: one an hour ago, linked by relative paths, with a file pub get left, one a minute ago, ', () => {
    let old = '';
    let recent = '';
    let then: Date;

    before(async () => {
      old = checkout('local/app', second);
      git(repo!.dir, '-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '--quiet', '--detach', old, second);
      fs.mkdirSync(path.join(old, '.dart_tool'));
      fs.writeFileSync(path.join(old, '.dart_tool', 'package_config.json'), '{}');
      then = hourAgo();
      fs.utimesSync(old, then, then);
      recent = checkout('github.com/acme/app', first);
      git(repo!.dir, 'worktree', 'add', '--quiet', '--detach', recent, first);
      await rehomeCheckouts();
    });

    it('then the old one is a repository of its own at its commit, with nothing uncommitted, its files kept, and its age.', () => {
      assert.ok(fs.statSync(path.join(old, '.git')).isDirectory());
      assert.deepEqual([git(old, 'rev-parse', 'HEAD'), git(old, 'status', '--porcelain', '--untracked-files=no'), fs.readFileSync(path.join(old, '.dart_tool', 'package_config.json'), 'utf8')], [second, '', '{}']);
      assert.equal(Math.round(fs.statSync(old).mtimeMs / 1000), Math.round(then.getTime() / 1000));
    });

    it('then the repository lists only the recent one, which an older untangle may still be making.', () => {
      assert.deepEqual(worktrees(repo!.dir), [fs.realpathSync(repo!.dir), fs.realpathSync(recent)]);
    });
  });
});

describe('Given untangle’s clone of a repository, ', () => {
  let repo: TempRepo | undefined;
  let cache = '';
  let sha = '';
  let clone = '';
  let dir = '';

  before(async () => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    process.env.UNTANGLE_CACHE = cache;
    repo = TempRepo.create();
    repo.write('a.txt', 'a\n');
    sha = repo.commit({ subject: 'first', author: ada, committer: ada });
    clone = path.join(cache, 'repos', 'github.com', 'acme', 'app.git');
    git(cache, 'clone', '--quiet', '--bare', repo.dir, clone);
    dir = await worktree(clone, 'github.com/acme/app', sha);
    fs.utimesSync(dir, hourAgo(), hourAgo());
    await rehomeCheckouts('github.com/acme/app');
  });

  after(() => {
    delete process.env.UNTANGLE_CACHE;
    repo?.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('when a checkout is made and the checkouts are rehomed, then it stays a worktree of the clone: nobody else lists them.', () => {
    assert.deepEqual([fs.statSync(path.join(dir, '.git')).isFile(), worktrees(clone).includes(dir), git(dir, 'rev-parse', 'HEAD')], [true, true, sha]);
  });
});

describe('Given a partial clone, which fetches what it lacks from its remote, ', () => {
  let origin: TempRepo | undefined;
  let cache = '';
  let clone = '';
  let sha = '';
  let dir = '';

  before(async () => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    process.env.UNTANGLE_CACHE = cache;
    origin = TempRepo.create();
    origin.write('a.txt', 'a\n');
    sha = origin.commit({ subject: 'first', author: ada, committer: ada });
    origin.write('a.txt', 'b\n');
    origin.commit({ subject: 'second', author: ada, committer: ada });
    git(origin.dir, 'config', 'uploadpack.allowFilter', 'true');
    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-partial-'));
    git(clone, 'clone', '--quiet', '--filter=blob:none', 'file://' + origin.dir, 'app');
    clone = path.join(clone, 'app');
    dir = await worktree(clone, 'local/app', sha);
  });

  after(() => {
    delete process.env.UNTANGLE_CACHE;
    origin?.remove();
    fs.rmSync(path.dirname(clone), { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('when a checkout of an older commit is made, then it’s a worktree of the clone, which can fetch its files.', () => {
    assert.deepEqual([fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), worktrees(clone).includes(dir)], ['a\n', true]);
  });
});
