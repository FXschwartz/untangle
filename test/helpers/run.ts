// Starts untangle on a fixture and stops only that process. The review's cache is the
// directory the caller passes, never the user's. -port 0 picks a free port.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubGh, type GhStub } from './gh.ts';

export interface UntangleRun {
  url: string;
  /** Ends the process untangle started, and the processes it started. */
  stop(): Promise<void>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repoRoot, 'dist/cli.js');

function untangleEnv(cacheDir: string, gh: GhStub): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, UNTANGLE_CACHE: cacheDir, ...gh.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  // No user git config: marks commits stay untangle <untangle@localhost>, with no signing or hooks.
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_COUNT = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, name);
  } catch {
    try {
      child.kill(name);
    } catch {
      // Already gone.
    }
  }
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => signal(child, 'SIGKILL'), 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    signal(child, 'SIGTERM');
  });
}

function spawnUntangle(args: string[], cacheDir: string, gh: GhStub): ChildProcess {
  return spawn(process.execPath, [cli, ...args], {
    detached: true,
    env: untangleEnv(cacheDir, gh),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A stub the caller didn't pass: the default answer is that there is no pull request. */
function ownedGh(gh: GhStub | undefined): { gh: GhStub; release(): void } {
  if (gh) return { gh, release() {} };
  const owned = stubGh();
  return { gh: owned, release: () => owned.remove() };
}

function collect(child: ChildProcess): { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
  return { out: () => out, err: () => err };
}

function leading(base: string | null | undefined): string[] {
  return base ? ['-base', base] : [];
}

/** Serves the directory with `-port 0 -no-open` and resolves with the printed URL. */
export async function startUntangle(dir: string, opts: { base?: string | null; cacheDir: string; gh?: GhStub; args?: string[] }): Promise<UntangleRun> {
  const { gh, release } = ownedGh(opts.gh);
  const child = spawnUntangle([...leading(opts.base), '-no-open', '-port', '0', '-quiet', ...(opts.args ?? []), dir], opts.cacheDir, gh);
  const text = collect(child);
  try {
    const url = await waitForUrl(child, text);
    return {
      url,
      stop: async () => {
        await stopProcess(child);
        release();
      },
    };
  } catch (error) {
    await stopProcess(child);
    release();
    throw error;
  }
}

/** Writes the review with `-export` and resolves when untangle exits. */
export async function exportUntangle(dir: string, htmlFile: string, opts: { base?: string | null; cacheDir: string; gh?: GhStub; args?: string[] }): Promise<void> {
  const { gh, release } = ownedGh(opts.gh);
  const child = spawnUntangle([...leading(opts.base), '-no-open', '-export', htmlFile, '-quiet', ...(opts.args ?? []), dir], opts.cacheDir, gh);
  const text = collect(child);
  const timer = setTimeout(() => signal(child, 'SIGKILL'), 180_000);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) throw new Error(`untangle export exited ${code}\n${text.err()}\n${text.out()}`);
  } finally {
    clearTimeout(timer);
    await stopProcess(child);
    release();
  }
}

function waitForUrl(child: ChildProcess, text: { out: () => string; err: () => string }): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url!);
    };
    const timer = setTimeout(() => finish(new Error(`untangle did not print a URL\n${text.err()}\n${text.out()}`)), 60_000);
    const look = () => {
      const match = /^http:\/\/127\.0\.0\.1:\d+\/\S*/m.exec(text.out());
      if (match) finish(null, match[0].trim());
    };
    child.stdout?.on('data', look);
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      look();
      finish(new Error(`untangle exited ${code} before printing a URL\n${text.err()}\n${text.out()}`));
    });
  });
}
