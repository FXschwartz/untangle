import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { difference, normalize, sdkTargets, unionDifferences } from './compare.ts';
import { latestMessageMs, summarizeTraffic } from './traffic.ts';

const temporary = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `untangle-${name}-`));
const remove = (root: string) => { if (root) fs.rmSync(root, { recursive: true, force: true }); };
const shim = fileURLToPath(new URL('./dart-shim.mjs', import.meta.url));

function frame(body: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(body));
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]);
}

describe('Given fragmented UTF-8 protocol frames, ', () => {
  let root = '';
  let fake = '';
  let request: Buffer;
  let response: Buffer;

  before(() => {
    root = temporary('shim');
    fake = path.join(root, 'real-dart.mjs');
    request = frame({ jsonrpc: '2.0', id: 7, method: 'textDocument/definition', params: { textDocument: { uri: 'file:///fixture/é.dart' } } });
    response = frame({ jsonrpc: '2.0', id: 7, result: ['é'] });
    fs.writeFileSync(path.join(root, 'response'), response);
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const input = [];
process.stdin.on('data', (chunk) => input.push(chunk));
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.TEST_ROOT + '/input', Buffer.concat(input));
  fs.writeFileSync(process.env.TEST_ROOT + '/args', JSON.stringify(process.argv.slice(2)));
  const reply = fs.readFileSync(process.env.TEST_ROOT + '/response');
  process.stdout.write(reply.subarray(0, 19));
  setTimeout(() => process.stdout.end(reply.subarray(19), () => process.exit(37)), 5);
});
`, { mode: 0o755 });
  });
  after(() => remove(root));

  describe('when the shim forwards the exchange, ', () => {
    let received = '';
    let forwarded = '';
    let exit = '';
    let args = '';
    let metadata = '';

    before(async () => {
      const log = path.join(root, 'traffic.jsonl');
      const child = spawn(process.execPath, [shim, 'language-server', '--protocol=lsp'], {
        env: { ...process.env, TEST_ROOT: root, BENCH_REAL_DART: fake, BENCH_DART_CACHE: root + '/cache', BENCH_LSP_LOG: log },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk) => output.push(chunk));
      const closed = once(child, 'close');
      for (let i = 0; i < request.length; i += 3) child.stdin.write(request.subarray(i, i + 3));
      child.stdin.end();
      const [code, signal] = await closed;
      received = Buffer.concat(output).toString('hex');
      forwarded = fs.readFileSync(path.join(root, 'input')).toString('hex');
      exit = `${code} ${signal}`;
      args = JSON.parse(fs.readFileSync(path.join(root, 'args'), 'utf8')).join('\n');
      const messages = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const answer = messages[1];
      metadata = [messages.length, answer.method, answer.id, answer.empty, answer.size, answer.bytes].join(' ');
    });

    it('then the response bytes survive unchanged.', () => {
      assert.equal(received, response.toString('hex'));
    });

    it('then the request bytes survive unchanged.', () => {
      assert.equal(forwarded, request.toString('hex'));
    });

    it('then the child exit status survives.', () => {
      assert.equal(exit, '37 null');
    });

    it('then the analyzer cache argument is added.', () => {
      assert.equal(args, `language-server\n--protocol=lsp\n--cache=${root}/cache`);
    });

    it('then the response metadata describes the complete frame.', () => {
      assert.equal(metadata, '2 textDocument/definition 7 false 1 6');
    });
  });
});

describe('Given equivalent checkout roots and a changed target column, ', () => {
  let first: Record<string, unknown>;
  let second: Record<string, unknown>;

  before(() => {
    first = { location: ['/scratch/first/head/lib/a.dart', 3, 4], uri: 'file:///scratch/first/base/lib/b.dart' };
    second = { location: ['/scratch/second/head/lib/a.dart', 3, 5], uri: 'file:///scratch/second/base/lib/b.dart' };
  });

  describe('when the normalized answers are compared, ', () => {
    let actual = '';

    before(() => {
      actual = JSON.stringify(difference(
        normalize(first, { headDir: '/scratch/first/head', baseDir: '/scratch/first/base' }) as Record<string, unknown>,
        normalize(second, { headDir: '/scratch/second/head', baseDir: '/scratch/second/base' }) as Record<string, unknown>,
      ));
    });

    it('then the real target change remains detectable.', () => {
      assert.equal(actual, '{"same":1,"missing":0,"extra":0,"different":1,"examples":{"missing":[],"extra":[],"different":[{"key":"location","a":["<head>/lib/a.dart",3,4],"b":["<head>/lib/a.dart",3,5]}]}}');
    });
  });
});

describe('Given lost and added answers, ', () => {
  let first: Record<string, unknown>;
  let second: Record<string, unknown>;

  before(() => {
    first = { missing: [1, 2, 3], same: null };
    second = { extra: [4, 5, 6], same: null };
  });

  describe('when the answers are compared, ', () => {
    let actual = '';

    before(() => { actual = JSON.stringify(difference(first, second)); });

    it('then both changes are counted and listed.', () => {
      assert.equal(actual, '{"same":1,"missing":1,"extra":1,"different":0,"examples":{"missing":[{"key":"missing","a":[1,2,3]}],"extra":[{"key":"extra","b":[4,5,6]}],"different":[]}}');
    });
  });
});

describe('Given a non-server Dart command, ', () => {
  let root = '';
  let fake = '';

  before(() => {
    root = temporary('passthrough');
    fake = path.join(root, 'dart.mjs');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)), () => process.exit(19));\n', { mode: 0o755 });
  });
  after(() => remove(root));

  describe('when it runs through the shim, ', () => {
    let actual = '';

    before(async () => {
      const child = spawn(process.execPath, [shim, 'pub', 'get', '--offline'], {
        env: { ...process.env, BENCH_REAL_DART: fake }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk) => output.push(chunk));
      const [code] = await once(child, 'close');
      actual = `${code}\n${Buffer.concat(output).toString()}`;
    });

    it('then its arguments and exit code are unchanged.', () => {
      assert.equal(actual, '19\n["pub","get","--offline"]');
    });
  });
});

describe('Given a detached shim and a running server, ', () => {
  let root = '';
  let child: ChildProcessWithoutNullStreams;
  let realPid = 0;
  let closed: Promise<unknown[]>;

  before(async () => {
    root = temporary('signal');
    const fake = path.join(root, 'dart.mjs');
    fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write(String(process.pid) + "\\n");\nsetInterval(() => {}, 1000);\n', { mode: 0o755 });
    child = spawn(process.execPath, [shim, 'language-server'], {
      detached: true, env: { ...process.env, BENCH_REAL_DART: fake, BENCH_DART_CACHE: root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    closed = once(child, 'close');
    const [data] = await once(child.stdout, 'data');
    realPid = Number(data.toString().trim());
  });
  after(() => {
    if (child?.exitCode == null && child?.signalCode == null && child?.pid) process.kill(-child.pid, 'SIGKILL');
    remove(root);
  });

  describe('when their group receives SIGTERM, ', () => {
    let exit = '';
    let server = '';

    before(async () => {
      process.kill(-child.pid!, 'SIGTERM');
      const [code, signal] = await closed;
      exit = `${code} ${signal}`;
      try {
        process.kill(realPid, 0);
        server = 'still running';
      } catch (error) {
        server = (error as NodeJS.ErrnoException).code ?? String(error);
      }
    });

    it('then the shim exits on SIGTERM.', () => {
      assert.equal(exit, 'null SIGTERM');
    });

    it('then the server is gone.', () => {
      assert.equal(server, 'ESRCH');
    });
  });
});

describe('Given complementary baseline answers and an extra candidate target, ', () => {
  let baselines: Array<Record<string, Record<string, unknown>>>;
  let candidate: Record<string, Record<string, unknown>>;

  before(() => {
    baselines = [{ definitions: { first: ['a.dart', 1, 2] } }, { definitions: { second: ['b.dart', 3, 4] } }];
    candidate = { definitions: { first: ['a.dart', 1, 2], second: ['b.dart', 3, 4], extra: ['c.dart', 5, 6] } };
  });

  describe('when the candidate is compared with their union, ', () => {
    let actual = '';

    before(() => {
      const compared = unionDifferences(baselines, candidate);
      actual = [compared.passes, compared.sections.definitions.same, compared.sections.definitions.extra, JSON.stringify(compared.conflicts)].join(' ');
    });

    it('then preserving both targets passes with the extra counted.', () => {
      assert.equal(actual, 'true 2 1 []');
    });
  });
});

describe('Given a target found only by the second baseline, ', () => {
  let baselines: Array<Record<string, Record<string, unknown>>>;

  before(() => {
    baselines = [{ definitions: {} }, { definitions: { found: ['a.dart', 1, 2] } }];
  });

  describe('when a candidate without that target is compared, ', () => {
    let actual = '';

    before(() => {
      const compared = unionDifferences(baselines, { definitions: {} });
      actual = `${compared.passes} ${compared.sections.definitions.missing}`;
    });

    it('then the missing target fails the union comparison.', () => {
      assert.equal(actual, 'false 1');
    });
  });
});

describe('Given conflicting baseline targets, ', () => {
  let baselines: Array<Record<string, Record<string, unknown>>>;

  before(() => {
    baselines = [{ definitions: { found: ['a.dart', 1, 2] } }, { definitions: { found: ['b.dart', 1, 2] } }];
  });

  describe('when the candidate matches one of them, ', () => {
    let actual = '';

    before(() => {
      const compared = unionDifferences(baselines, baselines[0]);
      actual = `${compared.passes}\n${JSON.stringify(compared.conflicts)}`;
    });

    it('then the conflict fails the comparison and is reported.', () => {
      assert.equal(actual, 'false\n[{"section":"definitions","key":"found","a":["a.dart",1,2],"b":["b.dart",1,2]}]');
    });
  });
});

describe('Given a live request with an earlier wall clock, ', () => {
  let root = '';
  let file = '';

  before(() => {
    root = temporary('clock');
    file = path.join(root, 'traffic.jsonl');
    const rows = [
      { ms: 1, epochMs: 1000, direction: 'client', kind: 'request', method: 'initialize', id: 0 },
      { ms: 2, epochMs: 1001, direction: 'client', kind: 'request', method: 'textDocument/definition', id: 1, uri: 'file:///head/lib/a.dart', position: { line: 0, character: 0 } },
      { ms: 3, epochMs: 1002, direction: 'server', kind: 'response', method: 'textDocument/definition', id: 1, uri: 'file:///head/lib/a.dart', requestMs: 2, durationMs: 1, empty: false },
      { ms: 100, epochMs: 999, direction: 'client', kind: 'request', method: 'textDocument/definition', id: 2, uri: 'file:///head/lib/b.dart', position: { line: 0, character: 0 } },
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  });
  after(() => remove(root));

  describe('when traffic is split at the saved monotonic boundary, ', () => {
    let requests = '';
    let stage = '';

    before(async () => {
      const actual = await summarizeTraffic(file, 50, { headDir: '/head', baseDir: '/base' }, 0, true);
      requests = JSON.stringify(actual.methods['textDocument/definition']);
      stage = JSON.stringify(actual.stages.headDefinitions);
    });

    it('then the live request stays out of batch request counts.', () => {
      assert.equal(requests, '{"requests":1,"responses":1,"empty":0,"errors":0}');
    });

    it('then the live request stays out of batch stage timing.', () => {
      assert.equal(stage, '{"startMs":2,"endMs":3,"durationMs":1,"requests":1,"empty":0}');
    });
  });
});

describe('Given a partially written final log line, ', () => {
  let root = '';
  let file = '';

  before(() => {
    root = temporary('boundary');
    file = path.join(root, 'traffic.jsonl');
    fs.writeFileSync(file, '{"ms":1}\n{"ms":2}\n{"ms":');
  });
  after(() => remove(root));

  describe('when a traffic boundary is saved, ', () => {
    let actual = '';

    before(() => { actual = String(latestMessageMs(file)); });

    it('then it uses the last complete message.', () => {
      assert.equal(actual, '2');
    });
  });
});

function sdkCopies() {
  const root = temporary('sdk-alias');
  const sdk = path.join(root, 'bin/cache/dart-sdk/lib/core/a.dart');
  const flutter = path.join(root, 'bin/cache/pkg/sky_engine/lib/core/a.dart');
  fs.mkdirSync(path.dirname(sdk), { recursive: true });
  fs.mkdirSync(path.dirname(flutter), { recursive: true });
  fs.writeFileSync(sdk, 'class A {}\n');
  return { root, sdk, flutter };
}

type Copies = ReturnType<typeof sdkCopies>;

describe('Given identical SDK source copies, ', () => {
  let files: Copies;

  before(() => {
    files = sdkCopies();
    fs.writeFileSync(files.flutter, 'class A {}\n');
  });
  after(() => remove(files.root));

  describe('when targets at the same position are compared, ', () => {
    let actual = '';

    before(() => {
      const canonical = sdkTargets();
      const compared = difference({ target: canonical([files.sdk, 1, 0]) }, { target: canonical([files.flutter, 1, 0]) });
      actual = `${compared.same} ${compared.different}`;
    });

    it('then the source copies are equivalent.', () => {
      assert.equal(actual, '1 0');
    });
  });
});

describe('Given SDK source copies with different bytes, ', () => {
  let files: Copies;

  before(() => {
    files = sdkCopies();
    fs.writeFileSync(files.flutter, 'class B {}\n');
  });
  after(() => remove(files.root));

  describe('when targets at the same position are compared, ', () => {
    let actual = '';

    before(() => {
      const canonical = sdkTargets();
      const compared = difference({ target: canonical([files.sdk, 1, 0]) }, { target: canonical([files.flutter, 1, 0]) });
      actual = `${compared.same} ${compared.different}`;
    });

    it('then the changed source is detected.', () => {
      assert.equal(actual, '0 1');
    });
  });
});

describe('Given an SDK target whose Flutter copy is missing, ', () => {
  let files: Copies;

  before(() => { files = sdkCopies(); });
  after(() => remove(files.root));

  describe('when the targets are compared, ', () => {
    let actual = '';

    before(() => {
      const canonical = sdkTargets();
      const compared = difference({ target: canonical([files.sdk, 1, 0]) }, { target: canonical([files.flutter, 1, 0]) });
      actual = `${compared.same} ${compared.different}`;
    });

    it('then the missing copy cannot establish equivalence.', () => {
      assert.equal(actual, '0 1');
    });
  });
});

describe('Given identical SDK copies with different target positions, ', () => {
  let files: Copies;

  before(() => {
    files = sdkCopies();
    fs.writeFileSync(files.flutter, 'class A {}\n');
  });
  after(() => remove(files.root));

  describe('when the targets are compared, ', () => {
    let actual = '';

    before(() => {
      const canonical = sdkTargets();
      const compared = difference({ target: canonical([files.sdk, 1, 0]) }, { target: canonical([files.flutter, 1, 1]) });
      actual = `${compared.same} ${compared.different}`;
    });

    it('then the changed position is detected.', () => {
      assert.equal(actual, '0 1');
    });
  });
});
