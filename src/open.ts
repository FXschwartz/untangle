// Opens a URL in the default browser, without waiting for it.
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

function command(url: string): [string, string[]] | null {
  if (process.env.BROWSER) return [process.env.BROWSER, [url]];
  if (process.platform === 'darwin') return ['open', [url]];
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]];
  if (isWsl()) {
    if (has('wslview')) return ['wslview', [url]];
    const explorer = has('explorer.exe') ? 'explorer.exe' : fs.existsSync('/mnt/c/Windows/explorer.exe') ? '/mnt/c/Windows/explorer.exe' : null;
    if (explorer) return [explorer, [url]];
  }
  return has('xdg-open') ? ['xdg-open', [url]] : null;
}

/** Whether a browser was asked to open the URL. */
export function openBrowser(url: string): boolean {
  const cmd = command(url);
  if (!cmd) return false;
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
