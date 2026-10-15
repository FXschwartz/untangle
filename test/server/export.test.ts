import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { jsonScript } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { exportUntangle } from '../helpers/run.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';
const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

describe('Given a branch that changes a greeting, ', { skip: skipDart }, () => {
  let repo: TempRepo | undefined;
  let cacheDir = '';

  before(() => {
    repo = TempRepo.create();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => {
    repo?.remove();
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  describe('when the review is exported, ', () => {
    let html = '';

    before(async () => {
      const file = path.join(cacheDir, 'review.html');
      await exportUntangle(repo!.dir, file, { base: 'main', cacheDir });
      html = fs.readFileSync(file, 'utf8');
    });

    it('then one file holds the review and does not ask a server for it.', () => {
      const config = jsonScript(html, 'd-config') as { served: boolean };
      const model = JSON.stringify(jsonScript(html, 'd-model'));
      assert.equal(
        [`served ${config.served}`, `greeting ${model.includes("print('hi')")}`, `asset ${html.includes('assets/highlight.js')}`].join('\n'),
        'served false\ngreeting true\nasset false',
      );
    });
  });
});
