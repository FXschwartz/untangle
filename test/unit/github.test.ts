import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { GitHubError, PullRequestConversation, type CommitFacts, type Conversation } from '../../dist/github.js';
import { stubGh, useStub, type GhCall, type GhStub } from '../helpers/gh.ts';

const head = 'a'.repeat(40);
const beforeSha = 'b'.repeat(40);
const afterSha = 'c'.repeat(40);
const ada = { login: 'ada', avatarUrl: 'https://example.test/ada', url: 'https://github.com/ada' };
const grace = { login: 'grace', avatarUrl: 'https://example.test/grace', url: 'https://github.com/grace' };

const page: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null };

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

describe('Given a pull request whose comments and a thread continue on a second page, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};

  before(() => {
    const first = conversation();
    const pr = first.data.repository.pullRequest;
    pr.comments = { pageInfo: { hasNextPage: true, endCursor: 'C1' }, nodes: [comment('ISSUE_1', 'First comment.', ada)] };
    pr.reviewThreads.nodes[0].comments = { pageInfo: { hasNextPage: true, endCursor: 'T1' }, nodes: [comment('COMMENT_1', 'First thread note.', grace)] };
    const second = { data: { node: { comments: { pageInfo: page, nodes: [comment('PAGE_2', 'Second page.', ada)] } } } };
    gh = stubGh([
      { match: ['api', 'graphql'], stdinIncludes: 'after: $after', stdout: second },
      { match: ['api', 'graphql'], stdout: first },
    ]);
    restore = useStub(gh);
  });

  after(() => {
    restore();
    gh?.remove();
  });

  it(
    'when the conversation is read, '
    + 'then both pages of comments and of the thread are listed.',
    async () => {
      const loaded = await new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head).load();
      assert.equal(shown(loaded), [
        '#7 Add a greeting',
        'thread lib/a.dart:2 First thread note. / Second page.',
        'comment First comment.; Second page.',
        'review APPROVED ada Ship it.',
      ].join('\n'));
    },
  );
});

describe('Given a pull request with people and an organization team, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};

  before(() => {
    gh = stubGh([
      {
        match: ['api', 'graphql'],
        stdinIncludes: 'mentionableUsers',
        stdout: { data: { repository: { mentionableUsers: { nodes: [{ login: 'grace', name: 'Grace Commit', avatarUrl: 'https://example.test/grace' }] } } } },
      },
      {
        match: ['api', 'graphql'],
        stdinIncludes: 'organization(login:',
        stdout: { data: { organization: { teams: { nodes: [{ combinedSlug: 'acme/eng', name: 'Engineering', avatarUrl: 'https://example.test/eng' }] } } } },
      },
      { match: ['api', 'graphql'], stdout: conversation() },
    ]);
    restore = useStub(gh);
  });

  after(() => {
    restore();
    gh?.remove();
  });

  it(
    'when @ is asked for, '
    + 'then the person and the team are suggested.',
    async () => {
      const github = new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head);
      const answer = await github.act({ action: 'suggest', kind: '@', query: 'g' });
      const items = 'items' in answer ? answer.items.map((item) => `${item.kind} ${item.value}`).join('\n') : '';
      assert.equal(items, 'user grace\nteam acme/eng');
    },
  );
});

describe('Given a pull request with a conversation comment, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};
  let github: PullRequestConversation;

  before(async () => {
    gh = stubGh([
      { match: ['api', 'graphql'], stdinIncludes: 'deleteIssueComment', stdout: { data: { deleteIssueComment: { clientMutationId: 'x' } } } },
      { match: ['api', 'graphql'], stdout: conversation() },
    ]);
    restore = useStub(gh);
    github = new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head);
    await github.load();
  });

  after(() => {
    restore();
    gh?.remove();
  });

  it(
    'when the conversation comment is deleted, '
    + 'then GitHub is asked to delete that comment.',
    async () => {
      await github.act({ action: 'delete', kind: 'issue', id: 'ISSUE_1' });
      assert.equal(mutation(gh!.calls(), 'deleteIssueComment'), '{"id":"ISSUE_1"}');
    },
  );
});

describe('Given a new thread GitHub rejects after starting an empty pending review, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};
  let github: PullRequestConversation;

  before(async () => {
    const emptyPending = {
      data: {
        repository: {
          pullRequest: {
            reviews: { nodes: [{ id: 'PEND', body: '', comments: { totalCount: 0 } }] },
          },
        },
      },
    };
    gh = stubGh([
      { match: ['api', 'graphql'], stdinIncludes: 'addPullRequestReviewThread', code: 1, stderr: 'rejected\n' },
      { match: ['api', 'graphql'], stdinIncludes: 'pullRequest(number: $number) { reviews(states: PENDING', stdout: emptyPending },
      { match: ['api', 'graphql'], stdinIncludes: 'deletePullRequestReview', stdout: { data: { deletePullRequestReview: { clientMutationId: 'x' } } } },
      { match: ['api', 'graphql'], stdout: conversation() },
    ]);
    restore = useStub(gh);
    github = new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head);
    await github.load();
  });

  after(() => {
    restore();
    gh?.remove();
  });

  describe('when the thread is sent, ', () => {
    let error = '';

    before(async () => {
      try {
        await github.act({ action: 'thread', mode: 'review', draft: { path: 'lib/a.dart', body: 'No.', line: 2, side: 'RIGHT' } });
      } catch (e) {
        error = (e as Error).message;
      }
    });

    it('then the empty pending review is dropped and the rejection stands.', () => {
      assert.equal(`${mutation(gh!.calls(), 'deletePullRequestReview')}\n${error}`, '{"pullRequestReviewId":"PEND"}\nrejected');
    });
  });
});

describe('Given GitHub refusing the API, ', () => {
  let gh: GhStub | undefined;
  let restore = () => {};

  before(() => {
    gh = stubGh([{ match: ['api', 'graphql'], code: 1, stderr: 'GitHub is down\n' }]);
    restore = useStub(gh);
  });

  after(() => {
    restore();
    gh?.remove();
  });

  describe('when the conversation is loaded, ', () => {
    let message = '';

    before(async () => {
      try {
        await new PullRequestConversation({ owner: 'acme', repo: 'sample', number: 7 }, head).load();
        message = 'loaded';
      } catch (error) {
        message = error instanceof GitHubError ? error.message : String(error);
      }
    });

    it('then the error is the message gh printed.', () => {
      assert.equal(message, 'GitHub is down');
    });
  });
});
