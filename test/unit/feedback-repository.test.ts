import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { reviewFeedbackRepo } from '../../dist/feedback.js';
import type { Target } from '../../dist/target.js';
import { TempRepo, type Person } from '../helpers/repo.ts';

let repo: TempRepo | null = null;
const author: Person = { name: 'Ada', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
afterEach(() => { repo?.remove(); repo = null; });

function target(): Target {
  repo = TempRepo.create();
  repo.write('a.txt', 'a');
  const sha = repo.commit({ subject: 'Start', author, committer: author });
  repo.remoteAdd('origin', 'git@github.com:fork/widget.git');
  repo.remoteAdd('upstream', 'https://github.com/acme/widget.git');
  return { repo: repo.dir, repoKey: 'github.com/fork/widget', pr: null, baseRef: 'main', baseSha: sha, headSha: sha, headDir: repo.dir, notes: [] };
}

describe('Given a branch in a fork, ', () => {
  describe('when the selected comparison comes from upstream, ', () => {
    it('then feedback names upstream rather than the fork.', async () => {
      const review = target();
      review.baseRemote = 'upstream';
      assert.equal(await reviewFeedbackRepo(review, repo!.dir, null), 'acme/widget');
    });
  });

  describe('when an explicit remote base has slashes in its branch name, ', () => {
    it('then feedback still identifies the remote correctly.', async () => {
      const review = target();
      execFileSync('git', ['-C', repo!.dir, 'update-ref', 'refs/remotes/upstream/release/stable', review.headSha]);
      review.baseRef = 'upstream/release/stable';
      assert.equal(await reviewFeedbackRepo(review, repo!.dir, review.baseRef), 'acme/widget');
    });
  });

  describe('when the base is a local branch without an upstream, ', () => {
    it('then feedback keeps the repository unknown.', async () => {
      const review = target();
      assert.equal(await reviewFeedbackRepo(review, repo!.dir, null), null);
    });
  });

  describe('when the selected remote is not GitHub, ', () => {
    it('then feedback does not mistake a host containing github.com for GitHub.', async () => {
      const review = target();
      repo!.config('remote.upstream.url', 'https://other-github.com/acme/widget.git');
      review.baseRemote = 'upstream';
      assert.equal(await reviewFeedbackRepo(review, repo!.dir, null), null);
    });
  });
});

describe('Given a pull request still being resolved, ', () => {
  describe('when feedback is opened before the review exists, ', () => {
    it('then the pull request’s URL identifies its repository.', async () => {
      assert.equal(await reviewFeedbackRepo(null, 'https://github.com/acme/widget/pull/9', null), 'acme/widget');
    });
  });
});
