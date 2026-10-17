import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildSteps } from '../../dist/build.js';
import { has } from '../../dist/exec.js';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';
const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const source = ['void greet() {', "  print('hi');", '}', ''].join('\n');

/** Waits until the review is ready and the progress has been printed. */
async function untilReady(run: UntangleRun): Promise<string> {
  const deadline = Date.now() + 120_000;
  let text = '';
  while (Date.now() < deadline) {
    text = run.output();
    if (text.includes('Review at ')) return text;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`untangle never became ready\n${text}`);
}

/** A build prints the checkout paths; a cache hit says so and skips them. */
function outcome(log: string): string {
  const cached = log.includes('using the analysis cached');
  const built = /^    head /m.test(log);
  if (cached && !built) return 'cached';
  if (!cached && built) return 'built';
  return log;
}

function line(log: string, side: 'head' | 'base'): string {
  const match = new RegExp(`^    ${side} (.+)$`, 'm').exec(log);
  return match ? match[1] : '';
}

/** The worktree untangle makes in the cache for a commit of a directory. */
function worktree(cache: string, directory: string, sha: string): RegExp {
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped(path.join(cache, 'worktrees', 'local', path.basename(directory)))}-[0-9a-f]{8}${escaped(path.sep)}${sha.slice(0, 12)}$`);
}

describe('Given a directory on its head commit whose packages are resolved, ', { skip: skipDart }, () => {
  let repo: TempRepo;
  let cache = '';
  let directory = '';
  let start = '';

  before(() => {
    const author = ada('2020-06-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', source);
    start = repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', source.replace('hi', 'hello'));
    repo.commit({ subject: 'Change the greeting', author, committer: author });
    fs.mkdirSync(path.join(repo.dir, '.dart_tool'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.dart_tool', 'package_config.json'), '{"configVersion":2,"packages":[]}\n');
    directory = fs.realpathSync(repo.dir);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(async () => {
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when it is reviewed with verbose, ', () => {
    let log = '';

    before(async () => {
      const run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, quiet: false, args: ['-verbose'] });
      try {
        log = await untilReady(run);
      } finally {
        await run.stop();
      }
    });

    it('then the head is that directory.', () => {
      assert.equal(line(log, 'head'), directory);
    });

    it('then the base is a worktree of the base commit in the cache.', () => {
      assert.match(line(log, 'base'), worktree(cache, directory, start));
    });

    it('then pub get is not run in that directory.', () => {
      assert.equal(fs.existsSync(path.join(repo.dir, 'pubspec.lock')), false);
    });

    it('then pub get and the analysis are logged.', () => {
      const verbose = log.split('\n').filter((row) => row.startsWith('      ')).join('\n').replace(/in \d+ ms/, 'in N ms');
      assert.equal(verbose, [
        '      Resolving dependencies...',
        '      Downloading packages...',
        '      Got dependencies!',
        '      base: 1 files, 1 change blocks, 1 edits, 0 same-change groups (0 edits), 0 chains covering 0 blocks, 1 not in a chain, generated 0 (0 peekable)',
        '         duplicate chain names:',
        '      1 commits, lines attributed in N ms',
      ].join('\n'));
    });
  });

  describe('when it is reviewed without -chains, ', () => {
    let steps = '';
    let ownCache = '';

    before(async () => {
      ownCache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
      const run = await startUntangle(repo.dir, { base: 'main', cacheDir: ownCache, quiet: false, chains: null });
      try {
        steps = [...(await untilReady(run)).matchAll(/^  ✓ (.{16}) /gm)].map((match) => match[1].trim()).join(', ');
      } finally {
        await run.stop();
      }
    });

    after(() => {
      if (ownCache) fs.rmSync(ownCache, { recursive: true, force: true });
    });

    it('then its chains follow the commits: the build replays them, in the steps its page plans.', () => {
      assert.equal(steps, ['branch', ...buildSteps('history'), 'history'].join(', '));
    });
  });

  describe('when the same commits are reviewed again, ', () => {
    let first = '';
    let second = '';
    let ownCache = '';

    before(async () => {
      ownCache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
      const opening = await startUntangle(repo.dir, { base: 'main', cacheDir: ownCache, quiet: false });
      try {
        first = await untilReady(opening);
      } finally {
        await opening.stop();
      }
      const again = await startUntangle(repo.dir, { base: 'main', cacheDir: ownCache, quiet: false });
      try {
        second = await untilReady(again);
      } finally {
        await again.stop();
      }
    });

    after(() => {
      if (ownCache) fs.rmSync(ownCache, { recursive: true, force: true });
    });

    it('then the second review uses the cached analysis.', () => {
      assert.equal(`${outcome(first)}\n${outcome(second)}`, 'built\ncached');
    });
  });

  describe('when a cached review is opened with no-cache, ', () => {
    let again = '';
    let ownCache = '';

    before(async () => {
      ownCache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
      const opening = await startUntangle(repo.dir, { base: 'main', cacheDir: ownCache, quiet: false });
      try {
        await untilReady(opening);
      } finally {
        await opening.stop();
      }
      const rebuilt = await startUntangle(repo.dir, { base: 'main', cacheDir: ownCache, quiet: false, args: ['-no-cache'] });
      try {
        again = await untilReady(rebuilt);
      } finally {
        await rebuilt.stop();
      }
    });

    after(() => {
      if (ownCache) fs.rmSync(ownCache, { recursive: true, force: true });
    });

    it('then it builds again instead of using the cached analysis.', () => {
      assert.equal(outcome(again), 'built');
    });
  });
});

describe('Given a directory with uncommitted changes, ', { skip: skipDart }, () => {
  let repo: TempRepo;
  let cache = '';
  let directory = '';
  let change = '';

  before(() => {
    const author = ada('2020-06-01T15:00:00Z');
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', source);
    repo.commit({ subject: 'Start the package', author, committer: author });
    repo.branch('feature');
    repo.write('lib/app.dart', source.replace('hi', 'hello'));
    change = repo.commit({ subject: 'Change the greeting', author, committer: author });
    fs.mkdirSync(path.join(repo.dir, '.dart_tool'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.dart_tool', 'package_config.json'), '{"configVersion":2,"packages":[]}\n');
    repo.write('lib/app.dart', source.replace('hi', 'hey'));
    directory = fs.realpathSync(repo.dir);
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when it is reviewed, ', () => {
    let log = '';

    before(async () => {
      const run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, quiet: false });
      try {
        log = await untilReady(run);
      } finally {
        await run.stop();
      }
    });

    it('then the head is a worktree of the head commit in the cache.', () => {
      assert.match(line(log, 'head'), worktree(cache, directory, change));
    });

    it('then pub get is not run in that directory.', () => {
      assert.equal(fs.existsSync(path.join(repo.dir, 'pubspec.lock')), false);
    });
  });
});
