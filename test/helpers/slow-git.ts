// A git that pauses on some commands, or holds them, so the step of the build running them stays
// up long enough for a test to read it.
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

/**
 * A git that holds some commands until release(): the build waits there, with its page up.
 * Removing it lets them go too, so none is left waiting after an untangle that stopped by itself.
 */
export function heldGit(commands: string[]): SlowGit & { release(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-git-'));
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const gate = path.join(dir, 'released');
  const script = [
    '#!/usr/bin/env bash',
    `for arg in "$@"; do case "$arg" in ${commands.join('|')}) while [ -d ${JSON.stringify(dir)} ] && [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.05; done; break;; esac; done`,
    `exec ${JSON.stringify(real)} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'git'), script, { mode: 0o755 });
  return { dir, release: () => fs.writeFileSync(gate, ''), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
