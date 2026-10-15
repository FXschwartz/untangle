import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { resolveDirectory, type Target } from '../../dist/target.js';
import { stubGh, useStub, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

function shown(target: Target): string {
  return [
    `pr ${target.pr ? `#${target.pr.number} ${target.pr.title}` : 'none'}`,
    `base ${target.baseRef} ${target.baseSha}`,
    `head ${target.headSha}`,
    `notes ${target.notes.join(' | ') || 'none'}`,
  ].join('\n');
}

describe('Given a branch with no pull request, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let restore = () => {};
  let base: string;
  let head: string;
  let target: Target;

  before(async () => {
    repo = TempRepo.create();
    gh = stubGh();
    restore = useStub(gh);
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', 'void main() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', 'void main() { return; }\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
  });

  after(() => {
    restore();
    repo?.remove();
    gh?.remove();
  });

  describe('when the directory is resolved, ', () => {
    before(async () => {
      target = await resolveDirectory(repo!.dir, null, () => {});
    });

    it('then the review compares the branch with main.', () => {
      assert.equal(shown(target), `pr none\nbase main ${base}\nhead ${head}\nnotes no pull request for this branch: comparing with main`);
    });
  });
});

describe('Given a branch whose pull request gh reports, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let restore = () => {};
  let base: string;
  let head: string;
  let target: Target;

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', 'void main() {}\n');
    base = repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/a.dart', 'void main() { return; }\n');
    head = repo.commit({ subject: 'change', author: ada, committer: ada });
    gh = stubGh([{
      match: ['pr', 'view'],
      stdout: {
        number: 7,
        title: 'Add a greeting',
        url: 'https://github.com/acme/sample/pull/7',
        state: 'OPEN',
        baseRefName: 'main',
        baseRefOid: base,
        headRefName: 'feature',
        headRefOid: head,
      },
    }]);
    restore = useStub(gh);
  });

  after(() => {
    restore();
    repo?.remove();
    gh?.remove();
  });

  describe('when the directory is resolved, ', () => {
    before(async () => {
      target = await resolveDirectory(repo!.dir, null, () => {});
    });

    it('then the review is that pull request, compared with main.', () => {
      assert.equal(shown(target), `pr #7 Add a greeting\nbase main ${base}\nhead ${head}\nnotes none`);
    });
  });
});
