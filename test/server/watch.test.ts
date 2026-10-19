import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { reviewClient, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { runsIn, stopRuns, untangleCommand } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 120_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

interface NotesView { notes: Array<{ n: number; resolved: { by: string | null } | null; comments: Array<{ by: string | null; body: string }> }>; agents: Array<{ name: string; state: string }> }

describe('Given a branch no review is running for, and an agent that watches it, ', { timeout: 300_000 }, () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let opened = '';
  let client: ReviewClient;
  let head = '';
  let first: { code: number | null; out: string; err: string };
  // The page's browser, as the review opens it: the link goes to a file.
  const env = (): NodeJS.ProcessEnv => ({ UNTANGLE_NOTES_QUIET: '100', BROWSER: path.join(cache, 'browser.sh') });
  const command = (args: string[]) => untangleCommand(args, { cacheDir: cache, gh: gh!, cwd: repo!.dir, env: env() });

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    head = repo.commit({ subject: 'Say hello', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    opened = path.join(cache, 'opened.txt');
    fs.writeFileSync(path.join(cache, 'browser.sh'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    const watching = command(['watch', '-agent', 'Codex', '-no-open', '-port', '0', '-base', 'main']);
    const run = await until('the review watch starts', () => runsIn(cache)[0]);
    client = reviewClient(run.url);
    await client.open();
    await until('the review', async () => (await client.call('notes')).status === 200);
    await until('the agent to watch', async () => ((await client.call('notes')).data as NotesView).agents.some((a) => a.state === 'watching'));
    const added = await client.call('notes', { method: 'POST', head, body: { action: 'add', path: 'lib/a.dart', side: 'RIGHT', line: 2, body: 'Why hello?' } });
    assert.equal(added.status, 200);
    first = await watching;
  });

  after(async () => {
    if (cache) await stopRuns(cache);
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it(
    'when a note is written on the review’s page, '
    + 'then the watch prints it with its code and ends, saying how to go on.',
    () => {
      const out = first.out;
      assert.deepEqual([first.code, out.split('\n').slice(0, 2)], [0, ['untangle: starting the review of this directory…', `untangle: feature against main is open at ${runsIn(cache)[0].url}.`]]);
      assert.ok(out.includes([
        `untangle: 1 note you haven’t read, on ${path.basename(repo!.dir)} at ${head.slice(0, 7)}. Line numbers are on that commit.`,
        '',
        'Discuss these with me before changing anything.',
        '',
        'N1 · lib/a.dart:2',
        `In the change "Say hello" (${head.slice(0, 7)})`,
        '```dart',
        "  print('hello');",
        '```',
        'Why hello?',
        '',
      ].join('\n')), out);
      assert.match(out, /\nuntangle: answer in a note’s thread with untangle reply -agent Codex N2 'your answer'; add -resolve once you’ve made the change\./);
    },
  );

  it(
    'when the agent answers and resolves the note, '
    + 'then the page’s notes show its answer, and that it resolved the note.',
    async () => {
      const r = await command(['reply', '-agent', 'Codex', '-resolve', 'N1', 'Because', 'it', 'greets.']);
      assert.deepEqual([r.code, r.out], [0, 'untangle: answered N1 and resolved it.\n']);
      const view = (await client.call('notes')).data as NotesView;
      assert.deepEqual(view.notes.map((n) => [n.n, n.resolved?.by, n.comments.map((c) => [c.by, c.body])]), [[1, 'Codex', [[null, 'Why hello?'], ['Codex', 'Because it greets.']]]]);
    },
  );

  it(
    'when the agent asks for every note, '
    + 'then they print as Copy for agent gives them.',
    async () => {
      const r = await command(['notes', '-all']);
      assert.deepEqual([r.code, r.out.split('\n').slice(0, 5)], [0, [`My review notes on ${path.basename(repo!.dir)} (branch feature, at ${head.slice(0, 7)}). Line numbers are on that commit.`, '', 'Discuss these with me before changing anything.', '', 'N1 · lib/a.dart:2 (resolved)']]);
    },
  );

  it(
    'when the agent answers a note there isn’t, '
    + 'then it hears which notes there are.',
    async () => {
      const r = await command(['reply', '-agent', 'Codex', 'N7', 'Hi.']);
      assert.deepEqual([r.code, r.err], [1, 'untangle: there is no note N7 (the notes are N1)\n']);
    },
  );

  it(
    'when the review is stopped while another watch waits, '
    + 'then the review’s page had opened for it, the watch says the review closed, and the review is gone.',
    async () => {
      const url = runsIn(cache)[0].url;
      const waiting = command(['watch', '-agent', 'Codex']);
      await until('the second watch', async () => ((await client.call('notes')).data as NotesView).agents.some((a) => a.state === 'watching'));
      const stopped = await command(['stop']);
      const w = await waiting;
      assert.deepEqual([stopped.code, stopped.out, w.code, w.out.split('\n').slice(-2)], [0, 'untangle: closed the review of feature against main.\n', 0, ['untangle: the review of feature against main is closed (its page closed, or untangle stop ran): there’s nothing more to watch.', '']]);
      assert.equal(fs.readFileSync(opened, 'utf8'), url + '\n');
      await until('the review to stop', () => runsIn(cache).length === 0, 10_000);
    },
  );

  it(
    'when a killed review left its run file, its process id now another’s, '
    + 'then the commands don’t take it for running, and the file goes.',
    async () => {
      const port = await new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
      const file = path.join(cache, 'run', `${process.pid}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${port}/?token=gone`, token: 'gone', dir: fs.realpathSync(repo!.dir), pr: null, started: new Date().toISOString() }));
        const r = await command(['notes']);
        assert.deepEqual([r.code, r.err, fs.existsSync(file)], [1, 'untangle: no review of this directory is running: untangle watch starts one\n', false]);
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
  );

  it(
    'when the agent answers with no review running, '
    + 'then it hears how to start one.',
    async () => {
      const r = await command(['reply', 'N1', 'Hi.']);
      assert.deepEqual([r.code, r.err], [1, 'untangle: no review of this directory is running: untangle watch starts one\n']);
    },
  );
});
