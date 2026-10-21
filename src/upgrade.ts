// untangle upgrade: the latest untangle, from a clone of its own in the cache. The first upgrade
// clones it and later ones pull it. npm then installs its packages, builds it and links it, so the
// untangle command runs it, and the new untangle rewrites its skill where it's installed. A review
// says, as it starts, when an upgrade would bring a newer untangle.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cacheRoot, selfDir, tilde } from './cache.js';
import { CommandError, git, gitAsync, gitMaybe, has, runAsync } from './exec.js';
import { Narrator } from './narrate.js';
import { listRuns } from './runs.js';
import { skillFiles } from './skill.js';
import { ROOT, VERSION } from './version.js';

const SOURCE = 'https://github.com/marcelomendoncasoares/untangle.git';

// A failed step shows the last lines its command printed: they say what went wrong.
const TAIL = 12;

class StepError extends Error {
  constructor(message: string, readonly lines: string[]) {
    super(message);
  }
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The untangle that the untangle command on PATH runs, through npm's links: its folder. */
function commandRoot(): string | null {
  for (const bin of (process.env.PATH || '').split(path.delimiter)) {
    if (!bin || !fs.existsSync(path.join(bin, 'untangle'))) continue;
    const cli = real(path.join(bin, 'untangle'));
    return cli.endsWith(path.join('dist', 'cli.js')) ? path.dirname(path.dirname(cli)) : null;
  }
  return null;
}

export async function upgrade(): Promise<number> {
  const dir = selfDir();
  const cloned = fs.existsSync(path.join(dir, '.git'));
  // The origin as its config has it, before git's insteadOf rewrites it.
  const origin = (cloned && gitMaybe(dir, 'config', '--get', 'remote.origin.url')?.trim()) || SOURCE;
  const say = new Narrator({ quiet: false, verbose: false, color: true });
  say.header([`untangle ${VERSION}`]);
  say.title('Upgrading untangle', `${origin.replace(/^https:\/\//, '').replace(/\.git$/, '')} → ${tilde(dir)}`);
  // npm is a script on Windows (npm.cmd), which only a shell starts.
  const npm = (args: string[], cwd?: string, onLine?: (line: string) => void) => (process.platform === 'win32'
    ? runAsync(['npm', ...args].join(' '), [], { cwd, onLine, shell: true })
    : runAsync('npm', args, { cwd, onLine }));
  // An npm command in the clone: what it prints shows on its step's line, and its last lines when it fails.
  const inClone = async (args: string[]) => {
    const tail: string[] = [];
    try {
      await npm(args, dir, (line) => {
        if (tail.push(line) > TAIL) tail.shift();
        say.detail(line);
      });
    } catch (e) {
      const code = (e as CommandError).code;
      throw new StepError(`npm ${args.filter((a) => !a.startsWith('-')).join(' ')} failed${code != null ? ` (exit ${code})` : ''}:`, tail);
    }
  };
  // Where the untangle command ran from, before this upgrade links the clone.
  const was = commandRoot();
  try {
    if (!has('npm')) throw new Error('npm isn’t on PATH: untangle installs its packages, builds and links with npm');
    let before: string | null = null;
    if (!cloned) {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${tilde(dir)} isn’t a clone of untangle: remove it, and untangle upgrade clones untangle there`);
      say.step('clone');
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await runAsync('git', ['clone', '--quiet', SOURCE, dir]);
    } else {
      say.step('pull');
      before = git(dir, 'rev-parse', 'HEAD').trim();
      await gitAsync(dir, ['fetch', '--quiet']);
      await gitAsync(dir, ['merge', '--ff-only', '--quiet', '@{upstream}']).catch((e: CommandError) => {
        throw new StepError(`${tilde(dir)} has commits or changes of its own, so it can’t take origin’s: git -C ${tilde(dir)} reset --hard origin/HEAD drops them.`, e.stderr.trim().split('\n').filter((l) => !l.startsWith('hint:')));
      });
    }
    const after = git(dir, 'rev-parse', 'HEAD').trim();
    const added = before ? Number(git(dir, 'rev-list', '--count', `${before}..${after}`)) : 0;
    say.note(!before ? `at ${after.slice(0, 7)}` : added ? `${added} new commit${added > 1 ? 's' : ''}: ${before.slice(0, 7)} → ${after.slice(0, 7)}` : `up to date, at ${after.slice(0, 7)}`);
    // Its packages, when they changed, or when their last install didn't finish.
    if (!before || !fs.existsSync(path.join(dir, 'node_modules', '.package-lock.json')) || git(dir, 'diff', '--name-only', before, after, '--', 'package.json', 'package-lock.json').trim()) {
      say.step('packages');
      await inClone(['ci', '--include=dev', '--no-audit', '--no-fund']);
    }
    say.step('build');
    await inClone(['run', 'build']);
    say.step('link');
    await inClone(['link', '--no-audit', '--no-fund']);
    const now = commandRoot();
    const moved = now !== was;
    if (now === real(dir) && moved) say.note(`untangle now runs from ${tilde(dir)}${was ? `, not ${tilde(was)}` : ''}`);
    // Another untangle, earlier on PATH than npm's.
    if (now && now !== real(dir)) say.note(`but untangle on PATH runs ${tilde(now)}, which comes before npm’s link to this one`);
    const running = listRuns().length;
    if (running && (moved || added || !before)) say.note(running === 1 ? 'the review running now keeps the old untangle until it’s started again' : `the ${running} reviews running now keep the old untangle until they’re started again`);
    say.finish();
  } catch (e) {
    say.fail((e as Error).message);
    if (e instanceof StepError) e.lines.forEach((line) => say.note(line));
    if (was && was !== real(dir)) say.note(`untangle still runs from ${tilde(was)}`);
    return 1;
  }
  // The skill is the new untangle's to write.
  const files = skillFiles();
  if (!fs.existsSync(files.claude) && !fs.existsSync(files.codex)) return 0;
  const r = spawnSync(process.execPath, [path.join(dir, 'dist', 'cli.js'), 'skill', '-update'], { encoding: 'utf8' });
  // An untangle from before skill -update refuses the flag.
  if (r.status === 2) {
    process.stdout.write('untangle: this untangle can’t update its skill where it’s installed: untangle skill -install does, for every agent here.\n');
    return 0;
  }
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || (r.error ? `untangle: ${r.error.message}\n` : ''));
  return r.status === 0 ? 0 : 1;
}

// GitHub's main, once looked up, stands for a day: reviews start with one lookup a day at most.
const DAY = 24 * 60 * 60_000;
const lookedUp = () => path.join(cacheRoot(), 'upgrade.json');

/** GitHub's main, as git ls-remote tells it at most a day before; null when it can't be told. */
async function githubMain(): Promise<string | null> {
  try {
    const was = JSON.parse(fs.readFileSync(lookedUp(), 'utf8')) as { checked?: unknown; main?: unknown };
    if (typeof was.main === 'string' && /^[0-9a-f]{40}$/.test(was.main) && Date.now() - Date.parse(String(was.checked)) < DAY) return was.main;
  } catch {
    // Not looked up yet.
  }
  // Never a prompt for a login, in the review's terminal: the repository is public.
  const out = await runAsync('git', ['ls-remote', SOURCE, 'refs/heads/main'], { env: { GIT_TERMINAL_PROMPT: '0' }, timeout: 15_000 }).catch(() => '');
  const main = /^([0-9a-f]{40})\trefs\/heads\/main$/m.exec(out)?.[1] ?? null;
  if (main) {
    try {
      fs.mkdirSync(cacheRoot(), { recursive: true });
      fs.writeFileSync(lookedUp(), JSON.stringify({ checked: new Date().toISOString(), main }) + '\n');
    } catch {
      // Looked up again next time.
    }
  }
  return main;
}

/** The line that says an upgrade brings a newer untangle, when GitHub's main has commits this one doesn't. */
export async function upgradeNotice(): Promise<string | null> {
  const head = fs.existsSync(path.join(ROOT, '.git')) ? gitMaybe(ROOT, 'rev-parse', 'HEAD')?.trim() : null;
  if (!head) return null;
  const main = await githubMain();
  // Main's commit is in this untangle's history: it's as new, or newer (a clone being worked on).
  if (!main || main === head || gitMaybe(ROOT, 'merge-base', '--is-ancestor', main, head) !== null) return null;
  return `a newer untangle is on GitHub (main is at ${main.slice(0, 7)}, this one at ${head.slice(0, 7)}): untangle upgrade brings it`;
}
