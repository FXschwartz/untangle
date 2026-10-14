// Checkouts of both sides for the language server: git worktrees that share objects with the
// repository, with their Dart packages resolved.
import fs from 'node:fs';
import path from 'node:path';
import { worktreeDir } from './cache.js';
import { git, gitAsync, gitMaybe, has, runAsync } from './exec.js';

/** A detached worktree of a commit, made once and reused. */
export async function worktree(repo: string, repoKey: string, sha: string): Promise<string> {
  const dir = worktreeDir(repoKey, sha);
  if (gitMaybe(dir, 'rev-parse', 'HEAD')?.trim() === sha) return fs.realpathSync(dir);
  // A leftover of an earlier run (interrupted, say) is ours to replace. --force covers a
  // worktree whose folder is gone but which git still lists.
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await gitAsync(repo, ['worktree', 'add', '--quiet', '--force', '--detach', dir, sha]);
  return fs.realpathSync(dir);
}

/**
 * The package folders the language server needs resolved: the root of a pub workspace, or else
 * each package that holds a changed Dart file.
 */
export function packageDirs(repo: string, base: string, head: string, checkout: string): string[] {
  const root = path.join(checkout, 'pubspec.yaml');
  if (fs.existsSync(root) && /^workspace:/m.test(fs.readFileSync(root, 'utf8'))) return [checkout];
  const changed = git(repo, 'diff', '--no-renames', '--name-only', base, head, '--', '*.dart').split('\n').filter(Boolean);
  const dirs = new Set<string>();
  for (const f of changed) {
    let p = path.dirname(f);
    while (p !== '.' && !fs.existsSync(path.join(checkout, p, 'pubspec.yaml'))) p = path.dirname(p);
    if (fs.existsSync(path.join(checkout, p, 'pubspec.yaml'))) dirs.add(path.join(checkout, p));
  }
  return [...dirs].sort();
}

export const resolved = (dir: string) => fs.existsSync(path.join(dir, '.dart_tool', 'package_config.json'));

/** Whether a checkout still holds exactly a commit: that commit checked out, nothing uncommitted. */
export const checkoutAt = (dir: string, sha: string) =>
  gitMaybe(dir, 'rev-parse', 'HEAD')?.trim() === sha && gitMaybe(dir, 'status', '--porcelain', '--untracked-files=no')?.trim() === '';

/** `dart pub get`, or `flutter pub get` when a package needs Flutter. Returns the folders that failed. */
export async function pubGet(dirs: string[], log: (line: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const dir of dirs.filter((d) => !resolved(d))) {
    try {
      await runAsync('dart', ['pub', 'get'], { cwd: dir, onLine: log });
    } catch {
      try {
        if (!has('flutter')) throw new Error('no flutter');
        await runAsync('flutter', ['pub', 'get'], { cwd: dir, onLine: log });
      } catch {
        failed.push(dir);
      }
    }
  }
  return failed;
}
