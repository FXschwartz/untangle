// Temp git repositories with a fixed identity, so a review's history does not depend on
// who runs the tests or when.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Person {
  name: string;
  email: string;
  /** A git date: an ISO timestamp or seconds since the epoch. */
  date: string;
}

export interface CommitOptions {
  subject: string;
  body?: string;
  author: Person;
  committer: Person;
  /** A commit that changes no file, such as a mark on the review branch. */
  allowEmpty?: boolean;
}

function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function identityEnv(author: Person, committer: Person): NodeJS.ProcessEnv {
  return gitEnv({
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: author.date,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: committer.date,
  });
}

function runGit(repo: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: opts.env ?? gitEnv(),
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const failed = error as { status?: number | null; stderr?: string };
    throw new Error(`git ${args.join(' ')} failed (${failed.status ?? 'no exit'}): ${String(failed.stderr ?? error).trim()}`);
  }
}

/** A throwaway repository. `remove` deletes it. */
export class TempRepo {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static create(): TempRepo {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-repo-'));
    const repo = new TempRepo(dir);
    runGit(dir, ['init', '-b', 'main']);
    return repo;
  }

  remove(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Writes a file and stages it. A buffer with a zero byte is a binary file. */
  write(file: string, content: string | Buffer): void {
    const full = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    runGit(this.dir, ['add', '--', file]);
  }

  delete(file: string): void {
    runGit(this.dir, ['rm', '--', file]);
  }

  rename(from: string, to: string): void {
    fs.mkdirSync(path.dirname(path.join(this.dir, to)), { recursive: true });
    runGit(this.dir, ['mv', '--', from, to]);
  }

  commit(opts: CommitOptions): string {
    const body = opts.body == null ? '' : opts.body.endsWith('\n') ? opts.body : `${opts.body}\n`;
    const message = opts.body == null ? `${opts.subject}\n` : `${opts.subject}\n\n${body}`;
    const args = ['commit'];
    if (opts.allowEmpty) args.push('--allow-empty');
    args.push('-F', '-');
    runGit(this.dir, args, { env: identityEnv(opts.author, opts.committer), input: message });
    return this.rev('HEAD');
  }

  /** Creates the branch at the current commit and switches to it. */
  branch(name: string): void {
    runGit(this.dir, ['checkout', '-b', name]);
  }

  checkout(name: string): void {
    runGit(this.dir, ['checkout', name]);
  }

  /** Merges `ref` with a merge commit even when git could fast-forward. */
  merge(opts: { ref: string; subject: string; author: Person; committer: Person }): string {
    runGit(this.dir, ['merge', '--no-ff', '-m', opts.subject, opts.ref], { env: identityEnv(opts.author, opts.committer) });
    return this.rev('HEAD');
  }

  rev(ref: string): string {
    return runGit(this.dir, ['rev-parse', '--verify', ref]);
  }
}
