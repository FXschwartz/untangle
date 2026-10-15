// Builds the git history a browser scenario names. The call lists every subject, person
// and file; this only runs the git commands.
import { TempRepo, type CommitOptions, type Person } from './repo.ts';

export interface StoryStep extends CommitOptions {
  write?: Record<string, string | Buffer>;
  remove?: string[];
  rename?: { from: string; to: string };
}

export interface FeatureHistory {
  repo: TempRepo;
  /** Each step's subject, plus `main` for the base tip the review compares with. */
  sha: Record<string, string>;
}

function apply(repo: TempRepo, sha: Record<string, string>, step: StoryStep): void {
  for (const [file, content] of Object.entries(step.write ?? {})) repo.write(file, content);
  for (const file of step.remove ?? []) repo.delete(file);
  if (step.rename) repo.rename(step.rename.from, step.rename.to);
  sha[step.subject] = repo.commit(step);
}

/**
 * `start` is the first commit on main. `feature` is the branch. `main` lands on main
 * after the branch point, and `merge` brings it back, so the review's base is main's tip.
 * `after` are commits on the branch once main has been merged.
 */
export function featureHistory(opts: {
  start: StoryStep;
  feature: StoryStep[];
  main: StoryStep[];
  merge: { subject: string; author: Person; committer: Person };
  after?: StoryStep[];
}): FeatureHistory {
  const repo = TempRepo.create();
  const sha: Record<string, string> = {};
  apply(repo, sha, opts.start);
  repo.branch('feature');
  for (const step of opts.feature) apply(repo, sha, step);
  repo.checkout('main');
  for (const step of opts.main) apply(repo, sha, step);
  sha.main = repo.rev('HEAD');
  repo.checkout('feature');
  sha[opts.merge.subject] = repo.merge({ ref: 'main', subject: opts.merge.subject, author: opts.merge.author, committer: opts.merge.committer });
  for (const step of opts.after ?? []) apply(repo, sha, step);
  return { repo, sha };
}

/**
 * Records a review of `head` on `branch`, with the tree of `base` so nothing is marked
 * reviewed. The worktree stays on feature.
 */
export function saveReviewedHead(repo: TempRepo, branch: string, head: string, base: string, when: Person): void {
  repo.commitBranch(branch, base, {
    subject: 'Your review',
    body: `Untangle-Base: ${base}\nUntangle-Head: ${head}`,
    author: when,
    committer: when,
  });
}
