import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { ROOT, VERSION } from '../../dist/version.js';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, untangleCommand } from '../helpers/run.ts';

const ada: Person = { name: 'Ada Lovelace', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };

// The stand-in's build: dist/cli.js is cli.mjs, with HEAD replaced by the commit it was built at.
const BUILD = [
  "import { execFileSync } from 'node:child_process';",
  "import fs from 'node:fs';",
  "const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim();",
  "fs.mkdirSync('dist', { recursive: true });",
  "fs.writeFileSync('dist/cli.js', fs.readFileSync('cli.mjs', 'utf8').replace('HEAD', head), { mode: 0o755 });",
  '',
].join('\n');
const cli = (name: string, more = '') => `#!/usr/bin/env node\n${more}console.log(\`${name} at HEAD: \${process.argv.slice(2).join(' ')}\`);\n`;

// untangle upgrade against stand-ins. untangle's repository is a package named untangle, whose build
// writes a cli.js that says the commit it was built at and what it was asked. npm's global folder,
// its cache, untangle's cache and the home are the test's own, and git's insteadOf sends the clone
// of untangle's GitHub URL to the stand-in.
describe('Given untangle’s repository and npm’s global folder, both stand-ins, ', () => {
  let gh: GhStub;
  let work: TempRepo;
  let origin: TempRepo;
  let home = '';
  const clone = () => path.join(home, 'cache', 'untangle');
  // On PATH: npm's global bin first, then node, npm and git alone, so no other untangle answers.
  const env = (): NodeJS.ProcessEnv => {
    const tools = path.join(home, 'tools');
    const bins = [path.join(home, 'npm', 'bin'), tools, '/usr/bin', '/bin'];
    return {
      HOME: home,
      PATH: bins.join(path.delimiter),
      npm_config_prefix: path.join(home, 'npm'),
      npm_config_cache: path.join(home, 'npm-cache'),
      npm_config_update_notifier: 'false',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${origin.dir}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/marcelomendoncasoares/untangle.git',
    };
  };
  const upgrade = () => untangleCommand(['upgrade'], { cacheDir: path.join(home, 'cache'), gh, cwd: home, env: env() });
  // The narration without the steps' times.
  const told = (err: string) => err.split('\n').filter(Boolean).map((l) => l.replace(/^(\s+[✓✗] \S+)\s.*$/, '$1'));
  const npm = (args: string[]) => execFileSync('npm', args, { cwd: work.dir, env: { ...process.env, ...env() }, stdio: 'ignore' });
  const commit = (subject: string, files: Record<string, string>) => {
    Object.entries(files).forEach(([f, text]) => work.write(f, text));
    const sha = work.commit({ subject, author: ada, committer: ada });
    work.push('origin', 'main');
    return sha.slice(0, 7);
  };
  const untangle = (...args: string[]) => execFileSync('untangle', args, { env: { ...process.env, ...env() }, encoding: 'utf8' });
  let first = '';

  before(() => {
    gh = stubGh();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-upgrade-'));
    const tools = path.join(home, 'tools');
    fs.mkdirSync(tools);
    const which = (cmd: string) => execFileSync('which', [cmd], { encoding: 'utf8' }).trim();
    fs.symlinkSync(process.execPath, path.join(tools, 'node'));
    fs.symlinkSync(fs.realpathSync(which('npm')), path.join(tools, 'npm'));
    fs.symlinkSync(which('git'), path.join(tools, 'git'));
    origin = TempRepo.bare();
    work = TempRepo.create();
    work.remoteAdd('origin', origin.dir);
    work.write('package.json', `${JSON.stringify({ name: 'untangle', version: '0.1.0', private: true, bin: { untangle: 'dist/cli.js' }, scripts: { build: 'node build.mjs' }, dependencies: { dep: 'file:dep' } }, null, 2)}\n`);
    work.write('dep/package.json', '{ "name": "dep", "version": "1.0.0" }\n');
    work.write('build.mjs', BUILD);
    work.write('cli.mjs', cli('untangle'));
    work.write('.gitignore', 'node_modules/\ndist/\n');
    npm(['install', '--package-lock-only', '--no-audit', '--no-fund']);
    first = commit('A package named untangle', { 'package-lock.json': fs.readFileSync(path.join(work.dir, 'package-lock.json'), 'utf8') });
  });

  after(() => {
    gh.remove();
    work.remove();
    origin.remove();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it(
    'when untangle upgrade runs for the first time, '
    + 'then it clones untangle into the cache, installs its packages, builds it and links it, and the untangle command runs it.',
    async () => {
      const r = await upgrade();
      assert.deepEqual([r.code, told(r.err), r.out, untangle('hello'), fs.realpathSync(path.join(home, 'npm', 'bin', 'untangle'))], [0, [
        `untangle ${VERSION}`,
        '  Upgrading untangle',
        '  github.com/marcelomendoncasoares/untangle → ~/cache/untangle',
        '  … clone',
        '  ✓ clone',
        `    at ${first}`,
        '  … packages',
        '  ✓ packages',
        '  … build',
        '  ✓ build',
        '  … link',
        '  ✓ link',
        '    untangle now runs from ~/cache/untangle',
      ], '', `untangle at ${first}: hello\n`, fs.realpathSync(path.join(clone(), 'dist', 'cli.js'))]);
    },
  );

  it(
    'when untangle has a new commit, and Claude has the untangle skill, '
    + 'then the upgrade pulls it and builds it, without installing the same packages again, and the new untangle updates the skill.',
    async () => {
      fs.mkdirSync(path.join(home, '.claude', 'skills', 'untangle'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'skills', 'untangle', 'SKILL.md'), 'An older skill\n');
      const second = commit('Says it’s the second', { 'cli.mjs': cli('untangle 2') });
      const r = await upgrade();
      assert.deepEqual([r.code, told(r.err).slice(3), r.out, untangle('hello')], [0, [
        '  … pull',
        '  ✓ pull',
        `    1 new commit: ${first} → ${second}`,
        '  … build',
        '  ✓ build',
        '  … link',
        '  ✓ link',
      ], `untangle 2 at ${second}: skill -update\n`, `untangle 2 at ${second}: hello\n`]);
    },
  );

  it(
    'when the new commits change untangle’s packages, '
    + 'then they are installed again.',
    async () => {
      const second = work.rev('HEAD').slice(0, 7);
      work.write('dep/package.json', '{ "name": "dep", "version": "1.0.1" }\n');
      npm(['install', '--package-lock-only', '--no-audit', '--no-fund']);
      const third = commit('A newer dep', { 'package-lock.json': fs.readFileSync(path.join(work.dir, 'package-lock.json'), 'utf8') });
      const r = await upgrade();
      assert.deepEqual([r.code, told(r.err).slice(3, 8), JSON.parse(fs.readFileSync(path.join(clone(), 'node_modules', 'dep', 'package.json'), 'utf8')).version], [0, [
        '  … pull',
        '  ✓ pull',
        `    1 new commit: ${second} → ${third}`,
        '  … packages',
        '  ✓ packages',
      ], '1.0.1']);
    },
  );

  it(
    'when untangle has nothing new, '
    + 'then the upgrade says it’s up to date, and builds and links it again.',
    async () => {
      const head = work.rev('HEAD').slice(0, 7);
      const r = await upgrade();
      assert.deepEqual([r.code, told(r.err).slice(3)], [0, [
        '  … pull',
        '  ✓ pull',
        `    up to date, at ${head}`,
        '  … build',
        '  ✓ build',
        '  … link',
        '  ✓ link',
      ]]);
    },
  );

  it(
    'when the clone has a commit that untangle doesn’t, and untangle another, '
    + 'then the upgrade stops before building and says how to drop it; dropped, the next upgrade takes untangle’s.',
    async () => {
      const git = (...args: string[]) => execFileSync('git', ['-C', clone(), ...args], { env: { ...process.env, ...env(), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' }, encoding: 'utf8' });
      fs.appendFileSync(path.join(clone(), 'build.mjs'), '// mine\n');
      git('commit', '-qam', 'Mine');
      const fourth = commit('Theirs', { 'cli.mjs': cli('untangle 4') });
      const stopped = await upgrade();
      git('reset', '-q', '--hard', 'origin/HEAD');
      const again = await upgrade();
      assert.deepEqual([stopped.code, told(stopped.err).slice(3), again.code, untangle('hello')], [1, [
        '  … pull',
        '  ✗ pull',
        '  error: ~/cache/untangle has commits or changes of its own, so it can’t take origin’s: git -C ~/cache/untangle reset --hard origin/HEAD drops them.',
        '    fatal: Not possible to fast-forward, aborting.',
      ], 0, `untangle 4 at ${fourth}: hello\n`]);
    },
  );

  it(
    'when untangle’s build fails, '
    + 'then the upgrade says what the build printed last.',
    async () => {
      commit('Breaks the build', { 'build.mjs': "console.error('Error: the build broke');\nprocess.exit(3);\n" });
      const r = await upgrade();
      const lines = told(r.err);
      assert.deepEqual([r.code, lines.slice(6, 9), lines.includes('    Error: the build broke')], [1, [
        '  … build',
        '  ✗ build',
        '  error: npm run build failed (exit 3):',
      ], true]);
    },
  );

  it(
    'when the new untangle has no skill -update, '
    + 'then the upgrade says that untangle skill -install updates the skill.',
    async () => {
      const head = commit('An untangle from before skill -update', { 'build.mjs': BUILD, 'cli.mjs': cli('untangle', "if (process.argv.includes('-update')) process.exit(2);\n") });
      const r = await upgrade();
      assert.deepEqual([r.code, r.out, untangle('hello')], [0, 'untangle: this untangle can’t update its skill where it’s installed: untangle skill -install does, for every agent here.\n', `untangle at ${head}: hello\n`]);
    },
  );
});

// A review that starts says when GitHub's main, looked up at most once a day (git ls-remote, here
// to a stand-in), has commits the untangle running it doesn't.
describe('Given a package to review, and untangle’s main on GitHub as a stand-in, ', { skip: has('dart') ? false : 'dart is not on PATH' }, () => {
  let repo: TempRepo;
  let github: TempRepo;
  let work: TempRepo;
  let cache = '';
  let newer = '';
  // The untangle under test: the one the review runs.
  const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const lookedUp = () => path.join(cache, 'upgrade.json');
  const notice = (main: string) => `    a newer untangle is on GitHub (main is at ${main.slice(0, 7)}, this one at ${head.slice(0, 7)}): untangle upgrade brings it`;

  /** Starts the review, waits until it's up and a moment more, and stops it: what it printed. */
  async function review(): Promise<string> {
    const run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, quiet: false, env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${github.dir}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/marcelomendoncasoares/untangle.git',
    } });
    try {
      const deadline = Date.now() + 60_000;
      while (!run.output().includes('Review at ') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1500));
      return run.output();
    } finally {
      await run.stop();
    }
  }
  const told = (out: string) => out.split('\n').filter((l) => l.includes('untangle upgrade'));

  before(() => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/app.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'Start', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('lib/app.dart', "void greet(String name) {\n  print(name);\n}\n");
    repo.commit({ subject: 'Greet by name', author: ada, committer: ada });
    // GitHub's main: a commit this untangle doesn't have.
    github = TempRepo.bare();
    work = TempRepo.create();
    work.remoteAdd('origin', github.dir);
    work.write('README.md', 'A newer untangle\n');
    newer = work.commit({ subject: 'A newer untangle', author: ada, committer: ada });
    work.push('origin', 'main');
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  });

  after(() => {
    repo.remove();
    github.remove();
    work.remove();
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when main was looked up today, with commits this untangle doesn’t have, '
    + 'then the review says, once it’s up, that untangle upgrade brings them, without asking GitHub again.',
    async () => {
      const today = { checked: new Date().toISOString(), main: 'f'.repeat(40) };
      fs.writeFileSync(lookedUp(), JSON.stringify(today));
      const out = await review();
      assert.deepEqual([told(out), out.indexOf('Review at ') < out.indexOf('untangle upgrade'), JSON.parse(fs.readFileSync(lookedUp(), 'utf8'))], [[notice('f'.repeat(40))], true, today]);
    },
  );

  it(
    'when main, looked up today, is this untangle’s commit, '
    + 'then the review says nothing of upgrading.',
    async () => {
      fs.writeFileSync(lookedUp(), JSON.stringify({ checked: new Date().toISOString(), main: head }));
      assert.deepEqual(told(await review()), []);
    },
  );

  it(
    'when main was looked up more than a day ago, '
    + 'then git ls-remote asks GitHub again, the review says what main is now, and that answer is kept for a day.',
    async () => {
      fs.writeFileSync(lookedUp(), JSON.stringify({ checked: new Date(Date.now() - 25 * 3600_000).toISOString(), main: head }));
      const out = await review();
      const kept = JSON.parse(fs.readFileSync(lookedUp(), 'utf8')) as { checked: string; main: string };
      assert.deepEqual([told(out), kept.main, Date.now() - Date.parse(kept.checked) < 120_000], [[notice(newer)], newer, true]);
    },
  );
});
