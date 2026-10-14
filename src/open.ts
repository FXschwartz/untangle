// Opens a URL in a browser: Orca's when untangle runs in one of Orca's terminals, else the
// default one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { has } from './exec.js';

const isWsl = () => {
  try {
    return process.platform === 'linux' && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
};

// A Windows program from WSL: on PATH, or where Windows keeps it (WSL often leaves Windows off PATH).
function windowsProgram(name: string, dirs: string[]): string | null {
  if (has(name)) return name;
  return dirs.map((d) => `/mnt/c/Windows/${d}/${name}`).find((p) => fs.existsSync(p)) || null;
}

function command(url: string): { cmd: string; args: string[]; cwd?: string } | null {
  if (process.platform === 'darwin') return { cmd: 'open', args: [url] };
  if (process.platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url.replace(/[&^|<>%]/g, '^$&')] };
  if (isWsl()) {
    // The Windows default browser: wslview when it's there, else Windows' own launchers.
    // (explorer.exe takes a URL with a query for a path, and opens a folder instead.)
    if (has('wslview')) return { cmd: 'wslview', args: [url] };
    const cwd = fs.existsSync('/mnt/c') ? '/mnt/c' : undefined;
    const ps = windowsProgram('powershell.exe', ['System32/WindowsPowerShell/v1.0']);
    if (ps) return { cmd: ps, args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`], cwd };
    const cmd = windowsProgram('cmd.exe', ['System32']);
    if (cmd) return { cmd, args: ['/c', 'start', url.replace(/[&^|<>%]/g, '^$&')], cwd };
  }
  return has('xdg-open') ? { cmd: 'xdg-open', args: [url] } : null;
}

// Inside Orca, its CLI opens a tab in Orca's browser, in the terminal's worktree.
function inOrca(url: string): Promise<boolean> {
  const cli = process.env.ORCA_CLI_COMMAND;
  if (!cli || !has(cli)) return Promise.resolve(false);
  const args = ['tab', 'create', '--url', url];
  if (process.env.ORCA_WORKTREE_ID) args.push('--worktree', 'id:' + process.env.ORCA_WORKTREE_ID);
  return new Promise((resolve) => {
    const child = spawn(cli, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 20_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

function launch(c: { cmd: string; args: string[]; cwd?: string }): boolean {
  try {
    const child = spawn(c.cmd, c.args, { stdio: 'ignore', detached: true, cwd: c.cwd });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the URL: with $BROWSER when it's set, in Orca's browser when untangle runs inside Orca
 * (falling back when that fails), else in the default browser. Says where, or null.
 */
export async function openBrowser(url: string): Promise<'orca' | 'browser' | null> {
  if (process.env.BROWSER) return launch({ cmd: process.env.BROWSER, args: [url] }) ? 'browser' : null;
  if (await inOrca(url)) return 'orca';
  const c = command(url);
  return c && launch(c) ? 'browser' : null;
}
