import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';
const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T15:00:00Z' };

describe('Given a tiny Dart package, ', { skip: skipDart }, () => {
  let repo: TempRepo;
  let cache = '';
  let run: UntangleRun | undefined;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'Change', author: ada, committer: ada });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, args: ['-host', '127.0.0.2'] });
  });

  after(async () => {
    await run?.stop();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when it is served on 127.0.0.2, ', () => {
    it('then the review answers there and not on 127.0.0.1.', async () => {
      const url = new URL(run!.url);
      const there = await fetch(run!.url, { redirect: 'manual' });
      let refused = false;
      try {
        await fetch(`http://127.0.0.1:${url.port}/`, { signal: AbortSignal.timeout(2_000) });
      } catch {
        refused = true;
      }
      assert.equal(`${url.hostname}\n${there.status}\n${refused ? 'refused' : 'open'}`, '127.0.0.2\n302\nrefused');
    });
  });
});
