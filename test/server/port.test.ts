import http from 'node:http';
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

function holdPort(): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', () => resolve(null));
    server.listen(7778, '127.0.0.1', () => resolve(server));
  });
}

describe('Given port 7778 is already taken, ', () => {
  let holder: http.Server | null = null;
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (holder) await new Promise<void>((resolve) => holder!.close(() => resolve()));
  });

  it(
    'when untangle is started without a port, '
    + 'then the review is served on another port.',
    async () => {
      holder = await holdPort();
      repo = TempRepo.create();
      repo.write('pubspec.yaml', pubspec);
      repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
      repo.commit({ subject: 'start', author: ada, committer: ada });
      repo.branch('feature');
      repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
      repo.commit({ subject: 'change', author: ada, committer: ada });
      gh = stubGh();
      cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
      run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, port: null });
      const port = new URL(run.url).port;
      assert.equal(port === '7778' ? run.url : 'other', 'other');
    },
  );
});
