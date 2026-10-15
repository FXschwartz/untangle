import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { SlimDefinitions } from '../../dist/pipeline/definitions.js';
import type { LiveTarget } from '../../dist/live.js';
import { reviewClient, waitForReview, jsonScript } from '../helpers/http.ts';
import { pubspec } from '../helpers/review.ts';
import { TempRepo, type Person } from '../helpers/repo.ts';
import { startUntangle, type UntangleRun } from '../helpers/run.ts';

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const app = 'packages/app/lib/app.dart';
const value = 'packages/core/lib/value.dart';
const helper = 'packages/core/lib/helper.dart';

function workspace() {
  const repo = TempRepo.create();
  repo.write('pubspec.yaml', ['name: sample_workspace', 'environment:', '  sdk: ">=3.6.0 <4.0.0"', 'workspace:', '  - packages/app', '  - packages/core', ''].join('\n'));
  repo.write('packages/core/pubspec.yaml', ['name: sample_core', 'resolution: workspace', 'environment:', '  sdk: ">=3.6.0 <4.0.0"', ''].join('\n'));
  repo.write('packages/app/pubspec.yaml', ['name: sample_app', 'resolution: workspace', 'environment:', '  sdk: ">=3.6.0 <4.0.0"', 'dependencies:', '  sample_core: any', ''].join('\n'));
  repo.write(helper, 'int helper() => 7;\n');
  repo.write(value, "import 'helper.dart';\n\nint value() => helper();\nint oldValue() => helper();\n");
  repo.write('packages/app/lib/catalog.dart', 'class WorkspaceNeedle {}\n');
  repo.write(app, "import 'package:sample_core/value.dart';\n\nint run() => oldValue();\nString label() => 'before';\n");
  repo.commit({ subject: 'Start the workspace', author: ada, committer: ada });
  repo.branch('feature');
  repo.write(app, "import 'package:sample_core/value.dart';\n\nint run() => value();\nString label() => 'after';\n");
  repo.commit({ subject: 'Change the app', author: ada, committer: ada });
  return repo;
}

async function serve(repo: TempRepo) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-packages-'));
  let run: UntangleRun | undefined;
  try {
    run = await startUntangle(repo.dir, { base: 'main', cacheDir: cache, quiet: false, args: ['-no-cache', '-verbose'] });
    const client = reviewClient(run.url);
    const html = await waitForReview(client);
    return {
      client, html, run,
      async remove() {
        await run!.stop();
        fs.rmSync(cache, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await run?.stop();
    fs.rmSync(cache, { recursive: true, force: true });
    throw error;
  }
}

type Served = Awaited<ReturnType<typeof serve>>;

function embedded(defs: SlimDefinitions, file: string, line: number, col: number): string {
  const entry = defs.defs[file]?.[line]?.find(([at]) => at === col);
  if (!entry) return 'no definition';
  const target = defs.targets[entry[2]];
  return `${target.w} ${target.p}:${target.l}`;
}

function location(target: LiveTarget | null): string {
  if (!target) return 'no definition';
  return `${target.side} ${target.w} ${target.p}:${target.l}:${target.c}`;
}

describe('Given two workspace packages with a change only in the app, ', () => {
  let repo: TempRepo;
  let served: Served;

  before(() => { repo = workspace(); });
  after(async () => {
    await served?.remove();
    repo?.remove();
  });

  describe('when the workspace is reviewed, ', () => {
    let head = '';
    let base = '';
    let sdk = '';

    before(async () => {
      served = await serve(repo);
      const defs = jsonScript(served.html, 'd-defs') as SlimDefinitions;
      const old = jsonScript(served.html, 'd-defs-old') as Record<string, SlimDefinitions>;
      head = embedded(defs, app, 3, 13);
      base = embedded(old.base, app, 3, 13);
      const string = defs.defs[app]?.[4]?.find(([at]) => at === 0);
      if (!string) throw new Error('String has no definition');
      const target = defs.targets[string[2]];
      sdk = `${target.w} ${target.p}`;
    });

    it('then the page links the changed use to the unchanged core file.', () => {
      assert.equal(head, 'repo packages/core/lib/value.dart:3');
    });

    it('then the page links the removed use to the old declaration.', () => {
      assert.equal(base, 'repo packages/core/lib/value.dart:4');
    });

    it('then the SDK type has a dart library label.', () => {
      assert.equal(sdk, 'sdk dart:core/string.dart');
    });
  });
});

describe('Given a served workspace review whose core files are unchanged, ', () => {
  let repo: TempRepo;
  let served: Served;

  before(async () => {
    repo = workspace();
    served = await serve(repo);
  });
  after(async () => {
    await served?.remove();
    repo?.remove();
  });

  describe('when a definition inside the unopened core file is followed, ', () => {
    let answer = '';

    before(async () => {
      const response = await served.client.call('definition', { query: { side: 'head', p: value, l: '3', c: '15' } });
      answer = `${response.status}\n${location((response.data as { target: LiveTarget | null }).target)}`;
    });

    it('then the onward jump reaches the unchanged helper file.', () => {
      assert.equal(answer, '200\nhead repo packages/core/lib/helper.dart:1:4');
    });
  });
});

describe('Given a served workspace review with a removed call, ', () => {
  let repo: TempRepo;
  let served: Served;

  before(async () => {
    repo = workspace();
    served = await serve(repo);
  });
  after(async () => {
    await served?.remove();
    repo?.remove();
  });

  describe('when the removed call is followed at the base, ', () => {
    let answer = '';

    before(async () => {
      const response = await served.client.call('definition', { query: { side: 'base', p: app, l: '3', c: '13' } });
      answer = `${response.status}\n${location((response.data as { target: LiveTarget | null }).target)}`;
    });

    it('then the jump reaches the old declaration in the base checkout.', () => {
      assert.equal(answer, '200\nbase repo packages/core/lib/value.dart:4:4');
    });
  });
});

describe('Given a served workspace review with a class in an unchanged app file, ', () => {
  let repo: TempRepo;
  let served: Served;

  before(async () => {
    repo = workspace();
    served = await serve(repo);
  });
  after(async () => {
    await served?.remove();
    repo?.remove();
  });

  describe('when symbols are searched for WorkspaceNeedle, ', () => {
    let answer = '';

    before(async () => {
      const response = await served.client.call('symbols', { query: { q: 'WorkspaceNeedle' } });
      const symbols = (response.data as { symbols: Array<{ name: string; p: string; l: number; c: number }> }).symbols;
      answer = `${response.status}\n${symbols.map((symbol) => `${symbol.name} ${symbol.p}:${symbol.l}:${symbol.c}`).join('\n')}`;
    });

    it('then the unchanged class is found at the head.', () => {
      assert.equal(answer, '200\nWorkspaceNeedle packages/app/lib/catalog.dart:1:0');
    });
  });
});

describe('Given a served review with an external String definition, ', () => {
  let repo: TempRepo;
  let served: Served;
  let query: Record<string, string>;

  before(async () => {
    repo = workspace();
    served = await serve(repo);
    const response = await served.client.call('definition', { query: { side: 'head', p: app, l: '4', c: '0' } });
    const target = (response.data as { target: LiveTarget }).target;
    const declaration = target.code.findIndex((line) => line.includes('implements Comparable'));
    if (declaration < 0 || target.ext == null) throw new Error('String does not expose its Comparable declaration');
    query = { ext: String(target.ext), l: String(target.s + declaration), c: String(target.code[declaration].indexOf('Comparable')) };
  });
  after(async () => {
    await served?.remove();
    repo?.remove();
  });

  describe('when Comparable is followed from the SDK snippet, ', () => {
    let answer = '';

    before(async () => {
      const response = await served.client.call('definition', { query });
      const target = (response.data as { target: LiveTarget }).target;
      answer = `${response.status}\n${target.w} ${target.p}`;
    });

    it('then the onward jump reaches the SDK declaration.', () => {
      assert.equal(answer, '200\nsdk dart:core/comparable.dart');
    });
  });
});

describe('Given a package whose only changed file is excluded from analysis, ', () => {
  let repo: TempRepo;
  let served: Served;

  before(() => {
    repo = TempRepo.create();
    repo.write('pubspec.yaml', pubspec);
    repo.write('analysis_options.yaml', 'analyzer:\n  exclude:\n    - test/fixtures/**\n');
    repo.write('lib/value.dart', 'class Value {}\n');
    repo.write('test/fixtures/sample.dart', "import '../../lib/value.dart';\nValue before() => Value();\n");
    repo.commit({ subject: 'Start the excluded fixture', author: ada, committer: ada });
    repo.branch('feature');
    repo.write('test/fixtures/sample.dart', "import '../../lib/value.dart';\nValue after() => Value();\n");
    repo.commit({ subject: 'Change the excluded fixture', author: ada, committer: ada });
  });
  after(async () => {
    await served?.remove();
    repo?.remove();
  });

  describe('when the package is reviewed, ', () => {
    let answers = '';

    before(async () => {
      served = await serve(repo);
      const defs = jsonScript(served.html, 'd-defs') as SlimDefinitions;
      const old = jsonScript(served.html, 'd-defs-old') as Record<string, SlimDefinitions>;
      answers = [embedded(defs, 'test/fixtures/sample.dart', 2, 0), embedded(old.base, 'test/fixtures/sample.dart', 2, 0)].join('\n');
    });

    it('then the build completes with both excluded-file uses resolving as before.', () => {
      assert.equal(answers, 'repo lib/value.dart:1\nrepo lib/value.dart:1');
    });
  });
});
