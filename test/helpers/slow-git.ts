// A git that pauses on some commands, so the progress line naming them stays up long enough for a
// test to read it: the page's progress shows only the step that is running.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SlowGit {
  /** The directory to put first on PATH. */
  dir: string;
  remove(): void;
}

export function slowGit(commands: string[]): SlowGit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-git-'));
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const script = [
    '#!/usr/bin/env bash',
    `for arg in "$@"; do case "$arg" in ${commands.join('|')}) sleep 0.3; break;; esac; done`,
    `exec ${JSON.stringify(real)} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'git'), script, { mode: 0o755 });
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
