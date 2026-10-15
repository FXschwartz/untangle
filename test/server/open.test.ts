import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { browsersOpened, startUntangle, type UntangleRun } from '../helpers/run.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

function script(file: string, log: string): void {
  fs.writeFileSync(file, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\n') + '\\n');\n`, { mode: 0o755 });
}

function packageRepo(): TempRepo {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  repo.commit({ subject: 'start', author: ada, committer: ada });
  repo.branch('feature');
  repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
  repo.commit({ subject: 'change', author: ada, committer: ada });
  return repo;
}

/** Waits until untangle has printed a line, and fails with what it printed if it never does. */
async function said(run: UntangleRun, line: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (run.output().split('\n').some((printed) => printed.trim() === line)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`untangle never said "${line}"\n${run.output()}`);
}

async function opened(log: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim()) return fs.readFileSync(log, 'utf8').trim();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return '';
}

describe('Given a repository, and BROWSER set to a stub, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let dir = '';
  let log = '';
  let stub = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-browser-'));
    log = path.join(dir, 'opened.txt');
    stub = path.join(dir, 'browser');
    script(stub, log);
    repo = packageRepo();
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('when it is reviewed without -no-open, ', () => {
    let run: UntangleRun | undefined;
    let recorded = '';
    let others = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh, open: true, quiet: false, args: ['-verbose'], env: { BROWSER: stub } });
      recorded = await opened(log);
      await said(run, 'opened in the browser');
      others = browsersOpened();
    });

    after(async () => {
      await run?.stop();
    });

    it('then the stub is asked to open the review’s URL.', () => {
      assert.equal(recorded, run!.url);
    });

    it('then no other browser is opened.', () => {
      assert.equal(others, '');
    });
  });
});

describe('Given a repository, in an Orca terminal whose CLI is a stub, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let dir = '';
  let log = '';
  let stub = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-orca-'));
    log = path.join(dir, 'opened.txt');
    stub = path.join(dir, 'orca');
    script(stub, log);
    repo = packageRepo();
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('when it is reviewed without -no-open, ', () => {
    let run: UntangleRun | undefined;
    let recorded = '';
    let others = '';

    before(async () => {
      run = await startUntangle(repo!.dir, {
        base: 'main',
        cacheDir: cache,
        gh,
        open: true,
        quiet: false,
        args: ['-verbose'],
        env: { ORCA_CLI_COMMAND: stub, ORCA_WORKTREE_ID: 'wt-9' },
      });
      recorded = await opened(log);
      // Only once untangle has heard back from Orca: stopping it sooner can end the stub first.
      await said(run, 'opened in Orca’s browser');
      others = browsersOpened();
    });

    after(async () => {
      await run?.stop();
    });

    it('then Orca is asked for a tab in this worktree.', () => {
      assert.equal(recorded, `tab\ncreate\n--url\n${run!.url}\n--worktree\nid:wt-9`);
    });

    it('then no other browser is opened.', () => {
      assert.equal(others, '');
    });
  });
});
