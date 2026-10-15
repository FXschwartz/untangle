import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { reviewClient, waitForReview, jsonScript, type ReviewClient } from '../helpers/http.ts';
import { pullRequestGh } from '../helpers/pull-request.ts';
import { stubGh, type GhStub } from '../helpers/gh.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const ada = (date: string): Person => ({ name: 'Ada Review', email: 'ada@example.com', date });

interface Model {
  compares: { base: { files: Array<{ blocks: Array<{ edits: number[] }> }> } };
}

function dartRepo(): { repo: TempRepo; head: string } {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', pubspec);
  repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
  repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
  repo.branch('feature');
  repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
  const head = repo.commit({ subject: 'change', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
  return { repo, head };
}

describe('Given a served review and an editor command, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';
  let dir = '';
  let opened = '';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-editor-'));
    const log = path.join(dir, 'opened.txt');
    const stub = path.join(dir, 'edit');
    fs.writeFileSync(stub, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('\\n'));\n`, { mode: 0o755 });
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, args: ['-editor', `${stub} {file} {line} {col}`] });
    const client = reviewClient(run.url);
    await waitForReview(client);
    await client.call('open', { method: 'POST', body: { side: 'head', p: 'lib/a.dart', l: 2, c: 3 } });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !fs.existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 50));
    opened = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('then the editor is run with the file, the line and the column.', () => {
    const lines = opened.split('\n');
    assert.equal(`${lines[0]?.endsWith(`${path.sep}lib${path.sep}a.dart`) ? 'file' : opened}\n${lines[1]}\n${lines[2]}`, 'file\n2\n4');
  });
});

describe('Given a review opened again from the cache, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let first: UntangleRun | undefined;
  let second: UntangleRun | undefined;
  let cache = '';
  let roots = '';
  let file = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    await waitForReview(reviewClient(first.url));
    await first.stop();
    first = undefined;
    second = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    const client = reviewClient(second.url);
    await waitForReview(client);
    const root = await client.call('roots');
    const data = root.data as { head?: string; base?: string };
    const headOk = !!data.head && fs.existsSync(data.head);
    const baseOk = !!data.base && fs.existsSync(data.base);
    roots = headOk && baseOk ? 'open' : JSON.stringify(data);
    const source = await client.call('file', { query: { side: 'head', p: 'lib/a.dart' } });
    const text = (source.data as { text?: string }).text ?? '';
    file = text.includes("print('hello')") ? 'file' : text;
  });

  after(async () => {
    await first?.stop();
    await second?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('then whole files and the editor’s checkouts still open.', () => {
    assert.equal(`${roots}\n${file}`, 'open\nfile');
  });
});

describe('Given reviewed marks whose base then gains a commit, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let base = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    try {
      const client = reviewClient(first.url);
      const model = jsonScript(await waitForReview(client), 'd-model') as Model;
      const edits = model.compares.base.files.flatMap((file) => file.blocks.flatMap((block) => block.edits));
      await client.call('state', { method: 'PUT', body: { rev: { base: edits } } });
    } finally {
      await first.stop();
    }
    repo.checkout('main');
    repo.write('lib/note.dart', 'void note() {}\n');
    base = repo.commit({ subject: 'note', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
    repo.checkout('feature');
    repo.merge({ ref: 'main', subject: 'merge main', author: ada('2020-06-04T00:00:00Z'), committer: ada('2020-06-04T00:00:00Z') });
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle opens the review again, ', () => {
    let run: UntangleRun | undefined;
    let note = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh });
      const config = jsonScript(await waitForReview(reviewClient(run.url)), 'd-config') as { snapshot: { note: string | null } };
      note = config.snapshot.note ?? 'no note';
    });

    after(async () => {
      await run?.stop();
    });

    it('then the marks panel says the review was replayed onto the new base.', () => {
      assert.equal(note, `replayed onto ${base.slice(0, 7)}`);
    });
  });
});

describe('Given reviewed marks on a file the new base deletes, and the branch rebased to add it back, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let cache = '';
  let base = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    const first = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh });
    try {
      const client = reviewClient(first.url);
      const model = jsonScript(await waitForReview(client), 'd-model') as Model;
      const edits = model.compares.base.files.flatMap((file) => file.blocks.flatMap((block) => block.edits));
      await client.call('state', { method: 'PUT', body: { rev: { base: edits } } });
    } finally {
      await first.stop();
    }
    repo.checkout('main');
    repo.delete('lib/a.dart');
    base = repo.commit({ subject: 'delete the file', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
    repo.resetBranch('feature', base);
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'change', author: ada('2020-06-04T00:00:00Z'), committer: ada('2020-06-04T00:00:00Z') });
  });

  after(() => {
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when untangle opens the review again, ', () => {
    let run: UntangleRun | undefined;
    let note = '';
    let reviewed = '';

    before(async () => {
      run = await startUntangle(repo!.dir, { base: 'main', cacheDir: cache, gh });
      const config = jsonScript(await waitForReview(reviewClient(run.url)), 'd-config') as { snapshot: { note: string | null }; state: { rev: { base: number[] } } };
      note = config.snapshot.note ?? 'no note';
      reviewed = config.state.rev.base.join(' ') || 'nothing';
    });

    after(async () => {
      await run?.stop();
    });

    it('then the marks panel says the file conflicted and went back to unreviewed.', () => {
      assert.equal(note, `replayed onto ${base.slice(0, 7)}; 1 file conflicted and went back to unreviewed`);
    });

    it('then nothing is reviewed.', () => {
      assert.equal(reviewed, 'nothing');
    });
  });
});

describe('Given a force push whose old head is not in the review, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';
  let ghost = '';
  let old = '';

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    repo.write('lib/a.dart', "void greet() {\n  print('dropped');\n}\n");
    old = repo.commit({ subject: 'dropped', author: ada('2020-06-03T00:00:00Z'), committer: ada('2020-06-03T00:00:00Z') });
    repo.checkout('HEAD~1');
    gh = pullRequestGh({
      number: 7,
      title: 'Add a greeting',
      url: 'https://github.com/acme/sample/pull/7',
      base: 'main',
      baseSha: repo.rev('main'),
      head: 'feature',
      headSha: repo.rev('HEAD'),
      pushes: [{ actor: 'ada', before: old, after: repo.rev('HEAD'), at: '2020-06-03T15:00:00Z' }],
    });
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { cacheDir: cache, gh });
    const client: ReviewClient = reviewClient(run.url);
    await waitForReview(client);
    const history = await client.call('history');
    const data = history.data as { ghosts?: Array<{ sha: string }> };
    ghost = (data.ghosts ?? []).some((item) => item.sha === old) ? 'listed' : JSON.stringify(data.ghosts ?? history.data);
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('then that old head is listed with the commits.', () => {
    assert.equal(ghost, 'listed');
  });
});

describe('Given a package whose dependency cannot be resolved, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';
  let progress = '';

  before(async () => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', ['name: sample', 'environment:', '  sdk: ">=3.0.0 <4.0.0"', 'dependencies:', '  missing:', '    path: ../missing_pkg', ''].join('\n'));
    repo.write('lib/a.dart', "void greet() {\n  print('hi');\n}\n");
    repo.commit({ subject: 'start', author: ada('2020-06-01T00:00:00Z'), committer: ada('2020-06-01T00:00:00Z') });
    repo.branch('feature');
    repo.write('lib/a.dart', "void greet() {\n  print('hello');\n}\n");
    repo.commit({ subject: 'change', author: ada('2020-06-02T00:00:00Z'), committer: ada('2020-06-02T00:00:00Z') });
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, quiet: false });
    const html = await waitForReview(reviewClient(run.url));
    const out = run.output();
    progress = out.includes('pub get failed') && html.includes('id="d-model"') ? 'failed and served' : out;
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  it('then the progress says pub get failed and the review is still served.', () => {
    assert.equal(progress, 'failed and served');
  });
});

describe('Given a served review whose branch has not moved, ', () => {
  let repo: TempRepo | undefined;
  let gh: GhStub | undefined;
  let run: UntangleRun | undefined;
  let cache = '';
  let client: ReviewClient | undefined;

  before(async () => {
    const built = dartRepo();
    repo = built.repo;
    gh = stubGh();
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, gh, quiet: false });
    client = reviewClient(run.url);
    await waitForReview(client);
  });

  after(async () => {
    await run?.stop();
    gh?.remove();
    repo?.remove();
    if (cache) fs.rmSync(cache, { recursive: true, force: true });
  });

  describe('when it is refreshed, ', () => {
    let answer: string;

    before(async () => {
      const refresh = await client!.call('refresh', { method: 'POST' });
      const data = refresh.data as { state?: string };
      answer = `${data.state ?? JSON.stringify(refresh.data)}\n${run!.output().includes('up to date') ? 'up to date' : run!.output()}`;
    });

    it('then it answers current and the progress says up to date.', () => {
      assert.equal(answer, 'current\nup to date');
    });
  });
});
