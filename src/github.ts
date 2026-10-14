// The pull request's conversation on GitHub: review threads, comments, reviews and the pending
// review, read and written through the gh command line. GitHub sees the user's own login (gh's),
// so untangle never handles a token.
import { spawn } from 'node:child_process';
import { has } from './exec.js';

export class GitHubError extends Error {}

/** `gh api <args>` with a JSON body; the answer, parsed when it's JSON. */
function ghApi(args: string[], body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', ...args, '--input', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new GitHubError('GitHub did not answer within 60 s')); }, 60_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new GitHubError(`gh: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: { errors?: Array<{ message: string }> } | null = null;
      try {
        json = out.trim().startsWith('{') ? JSON.parse(out) : null;
      } catch {
        // Not JSON: rendered markdown, or an error below.
      }
      if (json && json.errors && json.errors.length) return reject(new GitHubError(json.errors.map((e) => e.message).join('; ')));
      if (code !== 0) {
        const msg = (err || out).trim().replace(/^gh: /, '');
        return reject(new GitHubError(/gh auth login/.test(msg) ? 'gh is not logged in to GitHub: run `gh auth login`' : msg.split('\n')[0] || `gh exited with ${code}`));
      }
      resolve(json ?? out);
    });
    child.stdin.end(JSON.stringify(body));
  });
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = (await ghApi(['graphql'], { query, variables })) as { data: T };
  return r.data;
}

// The fields the page needs, as fragments, each with the fragments it uses.
const FRAGMENTS: Record<string, [string, string[]]> = {
  Who: ['fragment Who on Actor { login avatarUrl url }', []],
  Reacts: ['fragment Reacts on Reactable { viewerCanReact reactionGroups { content viewerHasReacted reactors { totalCount } } }', []],
  RC: [`fragment RC on PullRequestReviewComment {
    id body bodyHTML createdAt lastEditedAt url state authorAssociation viewerCanUpdate viewerCanDelete
    author { ...Who } ...Reacts
  }`, ['Who', 'Reacts']],
  TH: [`fragment TH on PullRequestReviewThread {
    id isResolved isOutdated isCollapsed path line originalLine startLine originalStartLine diffSide startDiffSide subjectType
    viewerCanResolve viewerCanUnresolve viewerCanReply resolvedBy { login }
    head: comments(first: 1) { nodes { diffHunk originalCommit { oid } } }
    comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...RC } }
  }`, ['RC']],
  IC: [`fragment IC on IssueComment {
    id body bodyHTML createdAt lastEditedAt url authorAssociation viewerCanUpdate viewerCanDelete
    author { ...Who } ...Reacts
  }`, ['Who', 'Reacts']],
  RV: [`fragment RV on PullRequestReview {
    id state body bodyHTML createdAt submittedAt url authorAssociation
    author { ...Who } comments { totalCount }
  }`, ['Who']],
  PR: [`fragment PR on PullRequest {
    id number title url state isDraft locked headRefOid createdAt body bodyHTML viewerDidAuthor reviewDecision
    author { ...Who } ...Reacts
    pendingReviews: reviews(states: PENDING, first: 1) { nodes { id body comments { totalCount } } }
    reviewThreads(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...TH } }
    comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...IC } }
    reviews(first: 100) { pageInfo { hasNextPage endCursor } nodes { ...RV } }
  }`, ['Who', 'Reacts', 'TH', 'IC', 'RV']],
};
/** The fragments a document uses, with theirs (GraphQL refuses a document with unused ones). */
function fragments(...names: string[]): string {
  const seen = new Set<string>();
  const add = (n: string) => { if (seen.has(n)) return; seen.add(n); FRAGMENTS[n][1].forEach(add); };
  names.forEach(add);
  return [...seen].map((n) => FRAGMENTS[n][0]).join('\n');
}

// The pull request, as each mutation returns it: one call does the change and reads the result.
const PR_OF = {
  review: 'pullRequestReview { pullRequest { ...PR } }',
  thread: 'thread { pullRequest { ...PR } }',
  comment: 'comment { pullRequest { ...PR } }',
  reviewComment: 'pullRequestReviewComment { pullRequest { ...PR } }',
  issueComment: 'issueComment { pullRequest { ...PR } }',
  subject: 'subject { ... on PullRequest { ...PR } ... on PullRequestReviewComment { pullRequest { ...PR } } ... on IssueComment { pullRequest { ...PR } } }',
};

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
interface RawPerson { login: string; avatarUrl: string; url: string }
interface RawReacts { viewerCanReact: boolean; reactionGroups: Array<{ content: string; viewerHasReacted: boolean; reactors: { totalCount: number } }> }
interface RawComment extends RawReacts { id: string; body: string; bodyHTML: string; createdAt: string; lastEditedAt: string | null; url: string; state?: string; authorAssociation: string; viewerCanUpdate: boolean; viewerCanDelete: boolean; author: RawPerson | null }
interface RawThread {
  id: string; isResolved: boolean; isOutdated: boolean; isCollapsed: boolean; path: string; line: number | null; originalLine: number | null; startLine: number | null; originalStartLine: number | null;
  diffSide: 'LEFT' | 'RIGHT'; startDiffSide: 'LEFT' | 'RIGHT' | null; subjectType: 'LINE' | 'FILE'; viewerCanResolve: boolean; viewerCanUnresolve: boolean; viewerCanReply: boolean; resolvedBy: { login: string } | null;
  head: { nodes: Array<{ diffHunk: string; originalCommit: { oid: string } | null }> }; comments: Page<RawComment>;
}
interface RawReview { id: string; state: string; body: string; bodyHTML: string; createdAt: string; submittedAt: string | null; url: string; authorAssociation: string; author: RawPerson | null; comments: { totalCount: number } }
interface RawPR extends RawReacts {
  id: string; number: number; title: string; url: string; state: string; isDraft: boolean; locked: boolean; headRefOid: string; createdAt: string; body: string; bodyHTML: string; viewerDidAuthor: boolean; reviewDecision: string | null;
  author: RawPerson | null; pendingReviews: { nodes: Array<{ id: string; body: string; comments: { totalCount: number } }> };
  reviewThreads: Page<RawThread>; comments: Page<RawComment>; reviews: Page<RawReview>;
}

export interface Person { login: string; avatar: string; url: string }
export interface Reaction { content: string; count: number; mine: boolean }
export interface Comment { id: string; author: Person; association: string; html: string; body: string; created: string; edited: string | null; url: string; pending: boolean; canEdit: boolean; canDelete: boolean; canReact: boolean; reactions: Reaction[] }
export interface Thread {
  id: string; path: string; file: boolean; side: 'LEFT' | 'RIGHT'; line: number | null; startSide: 'LEFT' | 'RIGHT' | null; startLine: number | null;
  originalLine: number | null; originalStartLine: number | null; commit: string | null; hunk: string;
  resolved: boolean; outdated: boolean; collapsed: boolean; canResolve: boolean; canUnresolve: boolean; canReply: boolean; resolvedBy: string | null; comments: Comment[];
}
export interface Review { id: string; state: string; author: Person; association: string; html: string; body: string; created: string; url: string; comments: number }
export interface Conversation {
  viewer: Person;
  pr: { id: string; number: number; title: string; url: string; state: string; draft: boolean; locked: boolean; head: string; created: string; author: Person; html: string; body: string; decision: string | null; mine: boolean; canReact: boolean; reactions: Reaction[] };
  pending: { id: string; comments: number } | null;
  threads: Thread[];
  comments: Comment[];
  reviews: Review[];
}

const GHOST: Person = { login: 'ghost', avatar: '', url: 'https://github.com/ghost' };
const person = (a: RawPerson | null): Person => (a ? { login: a.login, avatar: a.avatarUrl, url: a.url } : GHOST);
const reactions = (r: RawReacts): Reaction[] => r.reactionGroups.filter((g) => g.reactors.totalCount || g.viewerHasReacted).map((g) => ({ content: g.content, count: g.reactors.totalCount, mine: g.viewerHasReacted }));
const comment = (c: RawComment): Comment => ({
  id: c.id, author: person(c.author), association: c.authorAssociation, html: c.bodyHTML, body: c.body, created: c.createdAt, edited: c.lastEditedAt, url: c.url,
  pending: c.state === 'PENDING', canEdit: c.viewerCanUpdate, canDelete: c.viewerCanDelete, canReact: c.viewerCanReact, reactions: reactions(c),
});

/** One line of a review thread, as the page anchors it. */
export interface Draft { path: string; body: string; line?: number; side?: 'LEFT' | 'RIGHT'; startLine?: number; startSide?: 'LEFT' | 'RIGHT' }

export type Action =
  | { action: 'thread'; mode: 'single' | 'review'; draft: Draft }
  | { action: 'reply'; mode: 'single' | 'review'; thread: string; body: string }
  | { action: 'edit'; kind: 'issue' | 'review'; id: string; body: string }
  | { action: 'delete'; kind: 'issue' | 'review'; id: string }
  | { action: 'resolve'; thread: string; resolved: boolean }
  | { action: 'react'; subject: string; content: string; on: boolean }
  | { action: 'comment'; body: string }
  | { action: 'submit'; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string }
  | { action: 'discard' }
  | { action: 'preview'; text: string };

/** gh, ready to use: it's on PATH. (Whether it's logged in shows on the first call.) */
export const ghReady = () => has('gh');

/** A pull request's conversation: what the page shows, and what it changes. */
export class PullRequestConversation {
  private viewer: Person | null = null;
  // One change at a time: two quick clicks can't start two pending reviews.
  private queue: Promise<unknown> = Promise.resolve();
  private last: Conversation | null = null;

  constructor(
    private readonly pr: { owner: string; repo: string; number: number },
    /** The commit the review shows: new threads are written against it. */
    private readonly head: string,
  ) {}

  async load(): Promise<Conversation> {
    const d = await graphql<{ viewer: RawPerson; repository: { pullRequest: RawPR | null } }>(
      `query($owner: String!, $repo: String!, $number: Int!) { viewer { ...Who } repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ...PR } } } ${fragments('Who', 'PR')}`,
      { owner: this.pr.owner, repo: this.pr.repo, number: this.pr.number },
    );
    if (!d.repository.pullRequest) throw new GitHubError(`GitHub has no ${this.pr.owner}/${this.pr.repo}#${this.pr.number}`);
    this.viewer = person(d.viewer);
    return this.shape(await this.rest(d.repository.pullRequest));
  }

  /** Carries out a change, and answers with the conversation after it. */
  act(a: Action): Promise<Conversation | { html: string }> {
    if (a.action === 'preview') return this.preview(a.text);
    const run = this.queue.then(() => this.change(a));
    this.queue = run.catch(() => {});
    return run;
  }

  private async preview(text: string): Promise<{ html: string }> {
    const html = await ghApi(['markdown'], { text, mode: 'gfm', context: `${this.pr.owner}/${this.pr.repo}` });
    return { html: String(html) };
  }

  /** A mutation that returns the pull request at `path` in its payload. */
  private async mutate(name: string, input: Record<string, unknown>, payload: string): Promise<Conversation> {
    const d = await graphql<Record<string, unknown>>(`mutation($input: ${name[0].toUpperCase() + name.slice(1)}Input!) { ${name}(input: $input) { ${payload} } } ${fragments('PR')}`, { input });
    // Find the pull request in the payload, wherever the payload keeps it.
    const find = (x: unknown): RawPR | null => {
      if (!x || typeof x !== 'object') return null;
      const o = x as Record<string, unknown>;
      if (typeof o.headRefOid === 'string' && o.reviewThreads) return o as unknown as RawPR;
      for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
      return null;
    };
    const pr = find(d);
    return pr ? this.shape(await this.rest(pr)) : this.load();
  }

  private async pullRequestId(): Promise<string> {
    if (this.last) return this.last.pr.id;
    return (await this.load()).pr.id;
  }

  private async change(a: Exclude<Action, { action: 'preview' }>): Promise<Conversation> {
    const pullRequestId = await this.pullRequestId();
    switch (a.action) {
      case 'thread': {
        const d = a.draft;
        const line = d.line != null ? { line: d.line, side: d.side || 'RIGHT', ...(d.startLine != null && d.startLine !== d.line ? { startLine: d.startLine, startSide: d.startSide || d.side || 'RIGHT' } : {}) } : {};
        // A single comment is a review of its own, submitted at once. GitHub refuses it while a
        // review is pending, so it can never submit the pending review's comments with it.
        if (a.mode === 'single') {
          return this.mutate('addPullRequestReview', { pullRequestId, commitOID: this.head, event: 'COMMENT', threads: [{ path: d.path, body: d.body, ...line }] }, PR_OF.review).catch((e) => {
            throw /one pending review/.test((e as Error).message) ? new GitHubError('You have a review pending on GitHub: add this comment to it, or finish the review first.') : e;
          });
        }
        try {
          // Into the pending review: GitHub starts one when there's none.
          return await this.mutate('addPullRequestReviewThread', { pullRequestId, path: d.path, body: d.body, subjectType: d.line != null ? 'LINE' : 'FILE', ...line }, PR_OF.thread);
        } catch (e) {
          // A rejected thread can leave the pending review it started behind, empty.
          await this.dropEmptyPending();
          throw e;
        }
      }
      case 'reply': {
        // Without a pending review, a reply is posted at once; with one, it joins it.
        if (a.mode === 'review' && !(await this.currentPending())) {
          await graphql(`mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }`, { input: { pullRequestId, commitOID: this.head } });
        }
        return this.mutate('addPullRequestReviewThreadReply', { pullRequestReviewThreadId: a.thread, body: a.body }, PR_OF.comment);
      }
      case 'edit':
        return a.kind === 'issue'
          ? this.mutate('updateIssueComment', { id: a.id, body: a.body }, PR_OF.issueComment)
          : this.mutate('updatePullRequestReviewComment', { pullRequestReviewCommentId: a.id, body: a.body }, PR_OF.reviewComment);
      case 'delete':
        if (a.kind === 'issue') {
          await graphql(`mutation($input: DeleteIssueCommentInput!) { deleteIssueComment(input: $input) { clientMutationId } }`, { input: { id: a.id } });
          return this.load();
        }
        return this.mutate('deletePullRequestReviewComment', { id: a.id }, PR_OF.review);
      case 'resolve':
        return this.mutate(a.resolved ? 'resolveReviewThread' : 'unresolveReviewThread', { threadId: a.thread }, PR_OF.thread);
      case 'react':
        return this.mutate(a.on ? 'addReaction' : 'removeReaction', { subjectId: a.subject, content: a.content }, PR_OF.subject);
      case 'comment':
        return this.mutate('addComment', { subjectId: pullRequestId, body: a.body }, PR_OF.subject);
      case 'submit': {
        const pending = await this.currentPending();
        return pending
          ? this.mutate('submitPullRequestReview', { pullRequestReviewId: pending, event: a.event, body: a.body }, PR_OF.review)
          : this.mutate('addPullRequestReview', { pullRequestId, commitOID: this.head, event: a.event, body: a.body }, PR_OF.review);
      }
      case 'discard': {
        const pending = await this.currentPending();
        return pending ? this.mutate('deletePullRequestReview', { pullRequestReviewId: pending }, PR_OF.review) : this.load();
      }
    }
  }

  /** The viewer's pending review on GitHub now (it may have been started or submitted elsewhere). */
  private async currentPending(): Promise<string | null> {
    const d = await graphql<{ repository: { pullRequest: { reviews: { nodes: Array<{ id: string }> } } } }>(
      'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviews(states: PENDING, first: 1) { nodes { id } } } } }',
      { owner: this.pr.owner, repo: this.pr.repo, number: this.pr.number },
    );
    return d.repository.pullRequest.reviews.nodes[0]?.id || null;
  }

  private async dropEmptyPending(): Promise<void> {
    try {
      const d = await graphql<{ repository: { pullRequest: { reviews: { nodes: Array<{ id: string; body: string; comments: { totalCount: number } }> } } } }>(
        'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviews(states: PENDING, first: 1) { nodes { id body comments { totalCount } } } } } }',
        { owner: this.pr.owner, repo: this.pr.repo, number: this.pr.number },
      );
      const p = d.repository.pullRequest.reviews.nodes[0];
      if (p && !p.comments.totalCount && !p.body) await graphql('mutation($input: DeletePullRequestReviewInput!) { deletePullRequestReview(input: $input) { clientMutationId } }', { input: { pullRequestReviewId: p.id } });
    } catch {
      // Left as it is: GitHub shows it, and it can be discarded.
    }
  }

  /** The pages past the first hundred threads, comments and reviews, and comments in long threads. */
  private async rest(pr: RawPR): Promise<RawPR> {
    const more = async <T>(field: string, fragment: string, page: Page<T>) => {
      let p = page;
      while (p.pageInfo.hasNextPage) {
        const d = await graphql<{ node: Record<string, Page<T>> }>(`query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest { ${field}(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...${fragment} } } } } } ${fragments(fragment)}`, { id: pr.id, after: p.pageInfo.endCursor });
        p = d.node[field];
        page.nodes.push(...p.nodes);
      }
    };
    await more('reviewThreads', 'TH', pr.reviewThreads);
    await more('comments', 'IC', pr.comments);
    await more('reviews', 'RV', pr.reviews);
    for (const t of pr.reviewThreads.nodes) {
      let p = t.comments;
      while (p.pageInfo.hasNextPage) {
        const d = await graphql<{ node: { comments: Page<RawComment> } }>(`query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...RC } } } } } ${fragments('RC')}`, { id: t.id, after: p.pageInfo.endCursor });
        p = d.node.comments;
        t.comments.nodes.push(...p.nodes);
      }
    }
    return pr;
  }

  private shape(pr: RawPR): Conversation {
    const pending = pr.pendingReviews.nodes[0];
    this.last = {
      viewer: this.viewer || GHOST,
      pr: {
        id: pr.id, number: pr.number, title: pr.title, url: pr.url, state: pr.state, draft: pr.isDraft, locked: pr.locked, head: pr.headRefOid, created: pr.createdAt,
        author: person(pr.author), html: pr.bodyHTML, body: pr.body, decision: pr.reviewDecision, mine: pr.viewerDidAuthor, canReact: pr.viewerCanReact, reactions: reactions(pr),
      },
      pending: pending ? { id: pending.id, comments: pending.comments.totalCount } : null,
      threads: pr.reviewThreads.nodes.map((t) => ({
        id: t.id, path: t.path, file: t.subjectType === 'FILE', side: t.diffSide, line: t.line, startSide: t.startDiffSide, startLine: t.startLine,
        originalLine: t.originalLine, originalStartLine: t.originalStartLine, commit: t.head.nodes[0]?.originalCommit?.oid || null, hunk: t.head.nodes[0]?.diffHunk || '',
        resolved: t.isResolved, outdated: t.isOutdated, collapsed: t.isCollapsed, canResolve: t.viewerCanResolve, canUnresolve: t.viewerCanUnresolve, canReply: t.viewerCanReply,
        resolvedBy: t.resolvedBy?.login || null, comments: t.comments.nodes.map(comment),
      })),
      comments: pr.comments.nodes.map(comment),
      reviews: pr.reviews.nodes.filter((r) => r.state !== 'PENDING').map((r) => ({
        id: r.id, state: r.state, author: person(r.author), association: r.authorAssociation, html: r.bodyHTML, body: r.body, created: r.submittedAt || r.createdAt, url: r.url, comments: r.comments.totalCount,
      })),
    };
    return this.last;
  }
}
