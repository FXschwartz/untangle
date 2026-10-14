import { execFileSync, spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${command} failed${code != null ? ` (exit ${code})` : ''}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
  }
}

/** Runs a command and returns its stdout. Throws CommandError when it fails. */
export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  try {
    return execFileSync(cmd, args, { cwd: opts.cwd, input: opts.input, env: opts.env ? { ...process.env, ...opts.env } : undefined, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string };
    throw new CommandError([cmd, ...args].join(' '), err.status ?? null, String(err.stderr ?? ''));
  }
}

/** Runs a command without blocking. Resolves with its output, or rejects with CommandError. */
export function runAsync(cmd: string, args: string[], opts: { cwd?: string; onLine?: (line: string) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const lines = (chunk: string) => opts.onLine && chunk.split(/\r?\n|\r/).filter(Boolean).forEach(opts.onLine);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; lines(d); });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; lines(d); });
    child.on('error', (e) => reject(new CommandError([cmd, ...args].join(' '), null, e.message)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new CommandError([cmd, ...args].join(' '), code, err || out))));
  });
}

/** Whether a command exists on PATH. */
export function has(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]);
export const gitAsync = (cwd: string, args: string[], onLine?: (line: string) => void) => runAsync('git', ['-C', cwd, ...args], { onLine });

/** git, or null when it fails. */
export function gitMaybe(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}
