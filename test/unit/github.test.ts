import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { PullRequestConversation, type CommitFacts, type Conversation } from '../../dist/github.js';
import { stubGh, useStub, type GhCall, type GhStub } from '../helpers/gh.ts';

const head = 'a'.repeat(40);
const beforeSha = 'b'.repeat(40);
const afterSha = 'c'.repeat(40);
const ada = { login: 'ada', avatarUrl: 'https://example.test/ada', url: 'https://github.com/ada' };
const grace = { login: 'grace', avatarUrl: 'https://example.test/grace', url: 'https://github.com/grace' };

const page = { hasNextPage: false, endCursor: null };

function comment(id: string, body: string, author: typeof ada) {
  return {
    id, body, bodyHTML: `<p>${body}</p>`, createdAt: '2020-06-01T00:00:00Z', lastEditedAt: null, url: `https://github.com/${id}`,
    state: 'SUBMITTED', authorAssociation: 'MEMBER', viewerCanUpdate: false, viewerCanDelete: false, author,
    viewerCanReact: true, reactionGroups: [],
  };
}

function conversation() {
  return {
    data: {
      viewer: ada,
      repository: {
        pullRequest: {
          id: 'PR_1', number: 7, title: 'Add a greeting', url: 'https://github.com/acme/sample/pull/7', state: 'OPEN',
          isDraft: false, locked: false, headRefOid: head, createdAt: '2020-06-01T00:00:00Z', body: 'Please look.', bodyHTML: '<p>Please look.</p>',
          viewerDidAuthor: false, reviewDecision: 'REVIEW_REQUIRED', author: grace, viewerCanReact: true, reactionGroups: [],
          pendingReviews: { nodes: [] },
          reviewThreads: {
            pageInfo: page,
            nodes: [{
              id: 'THREAD_1', isResolved: false, isOutdated: false, isCollapsed: false, path: 'lib/a.dart', line: 2,
              originalLine: 2, startLine: null, originalStartLine: null, diffSide: 'RIGHT', startDiffSide: null, subjectType: 'LINE',
              viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, resolvedBy: null,
              head: { nodes: [{ diffHunk: '@@ -1 +1 @@\n+print', originalCommit: { oid: head } }] },
              comments: { pageInfo: page, nodes: [comment('COMMENT_1', 'Why this name?', grace)] },
            }],
          },
          comments: { pageInfo: page, nodes: [comment('ISSUE_1', 'Looks interesting.', ada)] },
          reviews: {
            pageInfo: page,
            nodes: [{
              id: 'REVIEW_1', state: 'APPROVED', body: 'Ship it.', bodyHTML: '<p>Ship it.</p>', createdAt: '2020-06-02T00:00:00Z',
              submittedAt: '2020-06-02T00:00:00Z', url: 'https://github.com/review/1', authorAssociation: 'MEMBER', author: ada, comments: { totalCount: 1 },
            }],
          },
        },
      },
    },
  };
}

function commits() {
  return {
    data: {
      repository: {
        pullRequest: {
          commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { state: 'SUCCESS' } } }] },
          reviews: {
            nodes: [
              { state: 'PENDING', submittedAt: null, url: 'https://github.com/review/pending', author: ada, commit: { oid: head } },
              { state: 'APPROVED', submittedAt: '2020-06-02T00:00:00Z', url: 'https://github.com/review/1', author: ada, commit: { oid: head } },
            ],
          },
          timelineItems: {
            nodes: [{
              createdAt: '2020-06-03T00:00:00Z', actor: { login: 'ada' },
              beforeCommit: { oid: beforeSha }, afterCommit: { oid: afterSha },
            }],
          },
        },
      },
    },
  };
}

function shown(value: Conversation): string {
  return [
    `#${value.pr.number} ${value.pr.title}`,
    `thread ${value.threads.map((thread) => `${thread.path}:${thread.line} ${thread.comments.map((item) => item.body).join(' / ')}`).join('; ')}`,
    `comment ${value.comments.map((item) => item.body).join('; ')}`,
    `review ${value.reviews.map((item) => `${item.state} ${item.author.login} ${item.body}`).join('; ')}`,
  ].join('\n');
}

function facts(value: CommitFacts): string {
  return [
    ...Object.entries(value.checks).map(([sha, state]) => `check ${state} ${sha}`),
    ...value.reviews.map((item) => `review ${item.state} ${item.author.login} ${item.sha}`),
    ...value.pushes.map((item) => `push ${item.actor} ${item.before} → ${item.after}`),
  ].join('\n');
}

function mutation(calls: GhCall[], name: string): string {
  const call = calls.find((item) => item.stdin.includes(`${name}(input:`));
  if (!call) throw new Error(`no ${name} call`);
  const body = JSON.parse(call.stdin) as { variables: { input: unknown } };
  return JSON.stringify(body.variables.input);
}

describe('Given a pull request with a thread, a comment and a review, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};

  before(() => {
    gh = stubGh([
      { match: ['api', 'graphql'], stdinIncludes: 'statusCheckRollup', stdout: commits() },
      { match: ['api', 'graphql'], stdout: conversation() },
    ]);
    restore = useStub(gh);
  });

  after(() => {
    restore();
    gh?.remove();
  });

  it(
    'when the conversation is read, '
    + 'then the thread, the comment and the review are listed.',
    async () => {
      const loaded = await new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head).load();
      assert.equal(shown(loaded), [
        '#7 Add a greeting',
        'thread lib/a.dart:2 Why this name?',
        'comment Looks interesting.',
        'review APPROVED ada Ship it.',
      ].join('\n'));
    },
  );
});

describe('Given GitHub reports a check, a review and a force push, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};

  before(() => {
    gh = stubGh([{ match: ['api', 'graphql'], stdout: commits() }]);
    restore = useStub(gh);
  });

  after(() => {
    restore();
    gh?.remove();
  });

  it(
    'when the commit facts are read, '
    + 'then the check and the submitted review and the force push are listed, and the pending review is not.',
    async () => {
      const read = await new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head).commits();
      assert.equal(facts(read), [
        `check SUCCESS ${head}`,
        `review APPROVED ada ${head}`,
        `push ada ${beforeSha} → ${afterSha}`,
      ].join('\n'));
    },
  );
});

describe('Given a pull request, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};
  let github: PullRequestConversation;

  beforeEach(async () => {
    const body = conversation();
    body.data.repository.pullRequest.reviews.nodes = [];
    gh = stubGh([{ match: ['api', 'graphql'], stdout: body }]);
    restore = useStub(gh);
    github = new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head);
    await github.load();
  });

  afterEach(() => {
    restore();
    gh?.remove();
  });

  it(
    'when a comment is posted, '
    + 'then the comment body is what gh is asked to send.',
    async () => {
      await github.act({ action: 'comment', body: 'Looks good' });
      assert.equal(mutation(gh!.calls(), 'addComment'), '{"subjectId":"PR_1","body":"Looks good"}');
    },
  );

  it(
    'when a reply is posted, '
    + 'then the reply body and its thread are what gh is asked to send.',
    async () => {
      await github.act({ action: 'reply', mode: 'single', thread: 'THREAD_1', body: 'Because it reads clearly.' });
      assert.equal(mutation(gh!.calls(), 'addPullRequestReviewThreadReply'), '{"pullRequestReviewThreadId":"THREAD_1","body":"Because it reads clearly."}');
    },
  );

  it(
    'when a review is submitted, '
    + 'then the verdict and its text are what gh is asked to send.',
    async () => {
      await github.act({ action: 'submit', event: 'APPROVE', body: 'Ship it.' });
      assert.equal(mutation(gh!.calls(), 'addPullRequestReview'), `{"pullRequestId":"PR_1","commitOID":"${head}","event":"APPROVE","body":"Ship it."}`);
    },
  );
});
