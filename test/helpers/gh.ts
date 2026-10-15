// Puts a stub `gh` first on PATH. It records the calls it gets and answers either
// "no pull request" or the canned replies given here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GhReply {
  /** Leading arguments, in order. The first reply whose prefix matches is used. */
  match: string[];
  /** When set, the call's stdin must contain this text. */
  stdinIncludes?: string;
  stdout?: string | unknown;
  stderr?: string;
  code?: number;
}

export interface GhCall {
  args: string[];
  stdin: string;
}

export interface GhStub {
  readonly binDir: string;
  /** PATH, the call log and the reply config for the process under test. */
  readonly env: NodeJS.ProcessEnv;
  calls(): GhCall[];
  /** Later calls answer these replies. The stub reads the file on every call. */
  setReplies(next: GhReply[]): void;
  remove(): void;
}

const stubSource = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gh-stub.mjs');

function stdoutOf(value: string | unknown | undefined): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function stubGh(replies: GhReply[] = []): GhStub {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-gh-'));
  const log = path.join(binDir, 'calls.log');
  const config = path.join(binDir, 'replies.json');
  fs.writeFileSync(config, JSON.stringify({
    replies: replies.map((reply) => ({
      match: reply.match,
      stdinIncludes: reply.stdinIncludes,
      stdout: stdoutOf(reply.stdout),
      stderr: reply.stderr,
      code: reply.code,
    })),
  }));
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(stubSource)} "$@"\n`, { mode: 0o755 });
  return {
    binDir,
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      UNTANGLE_GH_LOG: log,
      UNTANGLE_GH_CONFIG: config,
    },
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as GhCall);
    },
    /** Later calls answer these replies. The stub reads the file on every call. */
    setReplies(next: GhReply[]) {
      fs.writeFileSync(config, JSON.stringify({
        replies: next.map((reply) => ({
          match: reply.match,
          stdinIncludes: reply.stdinIncludes,
          stdout: stdoutOf(reply.stdout),
          stderr: reply.stderr,
          code: reply.code,
        })),
      }));
    },
    remove() {
      fs.rmSync(binDir, { recursive: true, force: true });
    },
  };
}

/** Puts the stub on PATH for this process, and points it at its replies. Returns a restore. */
export function useStub(gh: GhStub): () => void {
  const previous = {
    PATH: process.env.PATH,
    UNTANGLE_GH_LOG: process.env.UNTANGLE_GH_LOG,
    UNTANGLE_GH_CONFIG: process.env.UNTANGLE_GH_CONFIG,
  };
  process.env.PATH = String(gh.env.PATH);
  process.env.UNTANGLE_GH_LOG = String(gh.env.UNTANGLE_GH_LOG);
  process.env.UNTANGLE_GH_CONFIG = String(gh.env.UNTANGLE_GH_CONFIG);
  return () => {
    for (const key of ['PATH', 'UNTANGLE_GH_LOG', 'UNTANGLE_GH_CONFIG'] as const) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
