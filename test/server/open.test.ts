import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

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

async function opened(log: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim()) return fs.readFileSync(log, 'utf8').trim();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return '';
}

describe('Given a review started without -no-open and BROWSER set to a stub, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';
  let dir = '';
  let recorded = '';

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'when the review is served, '
    + 'then the stub is asked to open the review’s URL.',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-browser-'));
      const log = path.join(dir, 'opened.txt');
      const stub = path.join(dir, 'browser');
      script(stub, log);
      repo = packageRepo();
      gh = stubGh();
      cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
      run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, open: true, env: { BROWSER: stub } });
      recorded = await opened(log);
      assert.equal(recorded, run.url);
    },
  );
});

describe('Given a review started inside Orca, whose CLI is a stub, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';
  let dir = '';
  let recorded = '';

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it(
    'when the review is served, '
    + 'then Orca is asked for a tab in this worktree.',
    async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-orca-'));
      const log = path.join(dir, 'opened.txt');
      const stub = path.join(dir, 'orca');
      script(stub, log);
      execFileSync('which', [stub], { stdio: 'ignore' });
      repo = packageRepo();
      gh = stubGh();
      cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
      run = await startUntangle(repo.dir, {
        base: 'main',
        cacheDir: cache,
        gh,
        open: true,
        env: { ORCA_CLI_COMMAND: stub, ORCA_WORKTREE_ID: 'wt-9' },
      });
      recorded = await opened(log);
      assert.equal(recorded, `tab\ncreate\n--url\n${run.url}\n--worktree\nid:wt-9`);
    },
  );
});
