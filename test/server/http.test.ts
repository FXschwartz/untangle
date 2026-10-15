import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { reviewClient, waitForReview, jsonScript, type ReviewClient } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';
const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const later: Person = { ...ada, date: '2020-06-02T00:00:00Z' };

interface OpenReview {
  repo: TempRepo;
  cacheDir: string;
  run: UntangleRun;
  client: ReviewClient;
  html: string;
  stop(): Promise<void>;
}

async function serve(prepare: (repo: TempRepo) => void, args?: string[]): Promise<OpenReview> {
  const repo = TempRepo.create();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  let run: UntangleRun | undefined;
  try {
    repo.write('pubspec.yaml', pubspec);
    prepare(repo);
    run = await startUntangle(repo.dir, { base: 'main', cacheDir, args });
    const client = reviewClient(run.url);
    const html = await waitForReview(client);
    return {
      repo, cacheDir, run, client, html,
      stop: async () => {
        await run?.stop();
        repo.remove();
        fs.rmSync(cacheDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await run?.stop();
    repo.remove();
    fs.rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function stateText(cacheDir: string): string {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name === 'state.json') found.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(cacheDir);
  return found.join('\n');
}

interface Model {
  compares: { base: { files: Array<{ p: string; hunks: Array<{ rows: Array<[string, string]> }> }>; edits: Array<{ id: number }> } };
}

function hitText(html: string, rows: Record<string, Record<string, number[]>>): string {
  const model = jsonScript(html, 'd-model') as Model;
  const lines: string[] = [];
  for (const [fileIndex, hunks] of Object.entries(rows)) {
    for (const [hunkIndex, indexes] of Object.entries(hunks)) {
      for (const index of indexes) {
        const row = model.compares.base.files[Number(fileIndex)].hunks[Number(hunkIndex)].rows[index];
        lines.push(`${row[0]}${row[1]}`);
      }
    }
  }
  return lines.join('\n');
}

describe('Given a served review of two commits, ', { skip: skipDart }, () => {
  let review: OpenReview | undefined;
  let first: string;

  before(async () => {
    review = await serve((repo) => {
      repo.write('lib/a.dart', "void greet() {\n  print('one');\n}\n");
      repo.commit({ subject: 'start', author: ada, committer: ada });
      repo.branch('feature');
      repo.write('lib/a.dart', "void greet() {\n  print('two');\n}\n");
      first = repo.commit({ subject: 'first', author: later, committer: later });
      repo.write('lib/a.dart', "void greet() {\n  print('three');\n}\n");
      repo.commit({ subject: 'second', author: later, committer: later });
    });
  });

  after(() => review?.stop());

  it('when a request has no token, then it is refused.', async () => {
    const url = new URL(review!.run.url);
    const res = await fetch(`${url.origin}${url.pathname}`, { redirect: 'manual' });
    assert.equal(res.status, 403);
  });

  it('when the printed link is opened, then the page carries the review.', () => {
    const model = jsonScript(review!.html, 'd-model') as Model;
    assert.equal(model.compares.base.files.map((item) => item.p).join('\n'), 'lib/a.dart');
  });

  it('when the history is asked, then there is no earlier review and no GitHub.', async () => {
    const out = await review!.client.call('history');
    assert.equal(JSON.stringify(out.data), JSON.stringify({ review: null, github: null, githubError: null, ghosts: [] }));
  });

  it('when the rows since the first commit are asked, then they are the second commit\'s line.', async () => {
    const out = await review!.client.call('since', { query: { from: first } });
    const data = out.data as { rows?: Record<string, Record<string, number[]>> };
    const rows = data.rows ?? {};
    assert.equal(`${out.status}\n${hitText(review!.html, rows)}`, '200\n+  print(\'three\');');
  });

  it('when the commits a non-merge brought are asked, then there are none.', async () => {
    const head = (jsonScript(review!.html, 'd-config') as { head: string }).head;
    const out = await review!.client.call('brought', { query: { sha: head } });
    assert.equal(JSON.stringify(out.data), JSON.stringify({ commits: [], more: false }));
  });
});

describe('Given a served review of one change, ', { skip: skipDart }, () => {
  let review: OpenReview | undefined;

  before(async () => {
    review = await serve((repo) => {
      repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
      repo.commit({ subject: 'start', author: ada, committer: ada });
      repo.branch('feature');
      repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
      repo.commit({ subject: 'change', author: later, committer: later });
    });
  });

  after(() => review?.stop());

  describe('when the change is marked reviewed, ', () => {
    let message: string;
    let text: string;

    before(async () => {
      const model = jsonScript(review!.html, 'd-model') as Model;
      await review!.client.call('state', { method: 'PUT', body: { rev: { base: model.compares.base.edits.map((edit) => edit.id) } } });
      message = git(review!.repo.dir, ['log', '-1', '--format=%B', 'untangle/feature']).replace(/\n$/, '');
      text = git(review!.repo.dir, ['show', 'untangle/feature:lib/a.dart']);
    });

    it('then the marks branch names this head and holds the new line.', () => {
      const head = (jsonScript(review!.html, 'd-config') as { head: string }).head;
      assert.equal(message.includes(`Untangle-Head: ${head}`) && text.includes("print('hi')"), true);
    });
  });
});

describe('Given a served review whose change was marked reviewed, ', { skip: skipDart }, () => {
  let review: OpenReview | undefined;

  before(async () => {
    review = await serve((repo) => {
      repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
      repo.commit({ subject: 'start', author: ada, committer: ada });
      repo.branch('feature');
      repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
      repo.commit({ subject: 'change', author: later, committer: later });
    });
    const model = jsonScript(review.html, 'd-model') as Model;
    await review.client.call('state', { method: 'PUT', body: { rev: { base: model.compares.base.edits.map((edit) => edit.id) } } });
  });

  after(() => review?.stop());

  describe('when the marks are reset, ', () => {
    let text: string;

    before(async () => {
      await review!.client.call('state', { method: 'PUT', body: { rev: { base: [] } } });
      text = git(review!.repo.dir, ['show', 'untangle/feature:lib/a.dart']);
    });

    it('then the branch holds the line from before the change.', () => {
      assert.equal(text.includes("print('hello')") && !text.includes("print('hi')"), true);
    });
  });
});

describe('Given a served review of two edits in one function, ', { skip: skipDart }, () => {
  let review: OpenReview | undefined;

  before(async () => {
    review = await serve((repo) => {
      repo.write('lib/a.dart', "void greet() {\n  print('hello');\n  print('world');\n}\n");
      repo.commit({ subject: 'start', author: ada, committer: ada });
      repo.branch('feature');
      repo.write('lib/a.dart', "void greet() {\n  print('hi');\n  print('earth');\n}\n");
      repo.commit({ subject: 'change', author: later, committer: later });
    });
  });

  after(() => review?.stop());

  describe('when one of the two edits is marked, ', () => {
    let saved: string;
    let branch: string;

    before(async () => {
      const model = jsonScript(review!.html, 'd-model') as Model;
      await review!.client.call('state', { method: 'PUT', body: { rev: { base: [model.compares.base.edits[0].id] } } });
      saved = stateText(review!.cacheDir);
      try {
        branch = git(review!.repo.dir, ['rev-parse', '--verify', 'untangle/feature']);
      } catch {
        branch = 'none';
      }
    });

    it('then the partial mark stays next to the analysis and the branch is not written.', () => {
      const state = JSON.parse(saved) as { partial: number[] };
      assert.equal(`${state.partial.join(',')}\n${branch.trim() === 'none' ? 'none' : 'written'}`, '0\nnone');
    });
  });
});

describe('Given a served review under /rev/, ', { skip: skipDart }, () => {
  let review: OpenReview | undefined;

  before(async () => {
    review = await serve((repo) => {
      repo.write('lib/a.dart', 'void main() {}\n');
      repo.commit({ subject: 'start', author: ada, committer: ada });
      repo.branch('feature');
      repo.write('lib/a.dart', 'void main() { return; }\n');
      repo.commit({ subject: 'change', author: later, committer: later });
    }, ['-base-path', '/rev/']);
  });

  after(() => review?.stop());

  it('when the printed link is opened, then the review is served from that path.', async () => {
    const url = new URL(review!.run.url);
    const root = await fetch(url.origin + '/', { redirect: 'manual' });
    assert.equal(`${url.pathname}\n${root.status}\n${review!.html.includes('id="d-model"')}`, '/rev/\n404\ntrue');
  });
});

describe('Given a served review that then gains a commit, ', { skip: skipDart }, () => {
  let review: OpenReview | undefined;
  let oldHead: string;

  before(async () => {
    review = await serve((repo) => {
      repo.write('lib/a.dart', "void greet() {\n  print('one');\n}\n");
      repo.commit({ subject: 'start', author: ada, committer: ada });
      repo.branch('feature');
      repo.write('lib/a.dart', "void greet() {\n  print('two');\n}\n");
      repo.commit({ subject: 'change', author: later, committer: later });
    });
    const model = jsonScript(review.html, 'd-model') as Model;
    await review.client.call('state', { method: 'PUT', body: { rev: { base: model.compares.base.edits.map((edit) => edit.id) } } });
    oldHead = (jsonScript(review.html, 'd-config') as { head: string }).head;
    review.repo.write('lib/a.dart', "void greet() {\n  print('three');\n}\n");
    review.repo.commit({ subject: 'again', author: later, committer: later });
    await review.client.call('refresh', { method: 'POST' });
    const deadline = Date.now() + 90_000;
    let state = '';
    while (Date.now() < deadline) {
      const out = await review.client.call('refresh');
      state = (out.data as { state?: string }).state ?? '';
      if (state === 'ready' || state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (state !== 'ready') throw new Error(`refresh ${state}`);
  });

  after(() => review?.stop());

  describe('when a page left on the old head asks for the history, ', () => {
    let stale: { status: number; text: string };

    before(async () => {
      stale = await review!.client.call('history', { head: oldHead });
    });

    it('then it is told to reload.', () => {
      const body = JSON.parse(stale.text) as { error: string; moved: string };
      assert.equal(
        `${stale.status}\n${body.error}\n${/^[0-9a-f]{40}$/.test(body.moved) && body.moved !== oldHead}`,
        `409\nuntangle now reviews ${body.moved.slice(0, 7)}: reload the page.\ntrue`,
      );
    });
  });

  describe('when the history is asked for the new head, ', () => {
    let history: string;

    before(async () => {
      const current = await review!.client.call('history');
      history = JSON.stringify((current.data as { review: { head: string } | null }).review?.head ?? 'none');
    });

    it('then it names the head that was reviewed.', () => {
      assert.equal(history, JSON.stringify(oldHead));
    });
  });
});
