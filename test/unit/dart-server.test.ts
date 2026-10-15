import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DartServer, type Location } from '../../dist/lsp/dart.js';

interface Event { method: string; params: { textDocument?: { uri: string } } }

async function protocol() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-protocol-'));
  const originalPath = process.env.PATH;
  fs.mkdirSync(path.join(root, 'bin'));
  fs.symlinkSync(fileURLToPath(new URL('../helpers/dart-stub.mjs', import.meta.url)), path.join(root, 'bin/dart'));
  process.env.PATH = path.join(root, 'bin') + path.delimiter + originalPath;
  for (const name of ['one', 'two']) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pubspec.yaml'), `name: ${name}\n`);
    fs.writeFileSync(path.join(dir, 'lib/a.dart'), 'class A {}\n');
    fs.writeFileSync(path.join(dir, 'lib/b.dart'), 'class B {}\n');
  }
  let held: () => void = () => {};
  const log: string[] = [];
  const server = await DartServer.start([{ name: 'head', dir: root }], { clientVersion: 'test', log: (line) => {
    log.push(line);
    if (line === 'held') held();
  } });
  process.env.PATH = originalPath;
  const file = (name: string) => path.join(root, name);
  const events = () => server.request<Event[]>('test/events', {});
  return {
    server, file, events, log,
    async hold(method: string) {
      const waiting = new Promise<void>((resolve) => { held = resolve; });
      await server.request('test/hold', { method });
      return { waiting };
    },
    describe(answer: Location | null) {
      if (!answer) return 'empty';
      return `${path.relative(root, answer.path)}:${answer.line}:${answer.col}`;
    },
    files(rows: Event[], method: string) {
      return rows.filter((row) => row.method === method).map((row) => path.relative(root, fileURLToPath(row.params.textDocument!.uri))).join('\n');
    },
    async remove() {
      await server.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

type Protocol = Awaited<ReturnType<typeof protocol>>;

describe('Given a package whose representative is held by the server, ', () => {
  let stub: Protocol;
  let waiting: Promise<void>;
  let lookup: Promise<Location | null>;

  before(async () => {
    stub = await protocol();
    ({ waiting } = await stub.hold('textDocument/documentSymbol'));
    await stub.server.request('test/definitions', { answers: ['empty'] });
  });
  after(async () => {
    await stub.server.request('test/release', {});
    await lookup;
    await stub.remove();
  });

  describe('when a definition is requested, ', () => {
    let requests = '';

    before(async () => {
      lookup = stub.server.definition(stub.file('one/lib/a.dart'), 0, 0);
      await waiting;
      requests = stub.files(await stub.events(), 'textDocument/definition');
    });

    it('then the definition waits for the representative to resolve.', () => {
      assert.equal(requests, '');
    });
  });
});

describe('Given an empty definition waiting for its package to resolve, ', () => {
  let stub: Protocol;
  let lookup: Promise<Location | null>;

  before(async () => {
    stub = await protocol();
    const { waiting } = await stub.hold('textDocument/documentSymbol');
    await stub.server.request('test/definitions', { answers: ['empty'] });
    lookup = stub.server.definition(stub.file('one/lib/a.dart'), 0, 0);
    await waiting;
  });
  after(async () => { await stub.remove(); });

  describe('when the representative finishes resolving, ', () => {
    let result = '';

    before(async () => {
      await stub.server.request('test/release', {});
      const answer = await lookup;
      const requests = stub.files(await stub.events(), 'textDocument/definition');
      result = `${stub.describe(answer)}\n${requests}`;
    });

    it('then the empty answer is returned after one request.', () => {
      assert.equal(result, 'empty\none/lib/a.dart');
    });
  });
});

describe('Given a definition emptied while another package loads, ', () => {
  let stub: Protocol;
  let lookup: Promise<Location | null>;

  before(async () => {
    stub = await protocol();
    await stub.server.loadAll([stub.file('one/lib/a.dart')]);
    await stub.server.request('test/definitions', { answers: ['empty', 'location'] });
    const { waiting } = await stub.hold('textDocument/definition');
    lookup = stub.server.definition(stub.file('one/lib/b.dart'), 0, 0);
    await waiting;
    await stub.server.loadAll([stub.file('two/lib/a.dart')]);
  });
  after(async () => { await stub.remove(); });

  describe('when the interrupted answer arrives, ', () => {
    let result = '';
    let opened = '';

    before(async () => {
      await stub.server.request('test/release', {});
      const answer = await lookup;
      const rows = await stub.events();
      result = `${stub.describe(answer)}\n${stub.files(rows, 'textDocument/definition')}`;
      opened = stub.files(rows, 'textDocument/didOpen');
    });

    it('then the lookup is retried and returns its target.', () => {
      assert.equal(result, 'one/lib/b.dart:0:0\none/lib/b.dart\none/lib/b.dart');
    });

    it('then only the package representatives have been opened.', () => {
      assert.equal(opened, 'one/lib/a.dart\ntwo/lib/a.dart');
    });
  });
});

describe('Given a definition rejected while another package loads, ', () => {
  let stub: Protocol;
  let lookup: Promise<Location | null>;

  before(async () => {
    stub = await protocol();
    await stub.server.loadAll([stub.file('one/lib/a.dart')]);
    await stub.server.request('test/definitions', { answers: ['error', 'location'] });
    const { waiting } = await stub.hold('textDocument/definition');
    lookup = stub.server.definition(stub.file('one/lib/b.dart'), 0, 0);
    await waiting;
    await stub.server.loadAll([stub.file('two/lib/a.dart')]);
  });
  after(async () => { await stub.remove(); });

  describe('when the interrupted error arrives, ', () => {
    let result = '';

    before(async () => {
      await stub.server.request('test/release', {});
      const answer = await lookup;
      result = `${stub.describe(answer)}\n${stub.files(await stub.events(), 'textDocument/definition')}`;
    });

    it('then the lookup is retried and returns its target.', () => {
      assert.equal(result, 'one/lib/b.dart:0:0\none/lib/b.dart\none/lib/b.dart');
    });
  });
});

describe('Given dense work interleaved with work in a representative, ', () => {
  let stub: Protocol;
  let items: string[];

  before(async () => {
    stub = await protocol();
    await stub.server.loadAll([stub.file('one/lib/a.dart')]);
    items = [stub.file('one/lib/b.dart'), stub.file('one/lib/a.dart'), ...Array.from({ length: 255 }, () => stub.file('one/lib/b.dart'))];
  });
  after(async () => { await stub.remove(); });

  describe('when the files are queried in groups, ', () => {
    let results = '';
    let closed = '';

    before(async () => {
      const answers = await stub.server.askFiles(items, (file) => file, async (file) => path.basename(file));
      results = `${answers.slice(0, 3).join(' ')}\n${answers.slice(3).every((answer) => answer === 'b.dart')}\n${answers.length}`;
      closed = stub.files(await stub.events(), 'textDocument/didClose');
    });

    it('then the results retain the caller order.', () => {
      assert.equal(results, 'b.dart a.dart b.dart\ntrue\n257');
    });

    it('then only the temporary file is closed.', () => {
      assert.equal(closed, 'one/lib/b.dart');
    });
  });
});

describe('Given a failing query in a temporary file, ', () => {
  let stub: Protocol;
  let items: string[];

  before(async () => {
    stub = await protocol();
    await stub.server.loadAll([stub.file('one/lib/a.dart')]);
    items = Array.from({ length: 256 }, () => stub.file('one/lib/b.dart'));
  });
  after(async () => { await stub.remove(); });

  describe('when the query rejects, ', () => {
    let failure = '';
    let closed = '';

    before(async () => {
      failure = await stub.server.askFiles(items, (file) => file, async () => { throw new Error('lookup failed'); }).then(() => 'no error', (error: Error) => error.message);
      closed = stub.files(await stub.events(), 'textDocument/didClose');
    });

    it('then the failure is preserved.', () => {
      assert.equal(failure, 'lookup failed');
    });

    it('then only the temporary file is closed.', () => {
      assert.equal(closed, 'one/lib/b.dart');
    });
  });
});

describe('Given a representative whose readiness probe errors once, ', () => {
  let stub: Protocol;

  before(async () => {
    stub = await protocol();
    await stub.server.request('test/probe', { behavior: 'error once' });
    await stub.server.request('test/definitions', { answers: ['location'] });
  });
  after(async () => { await stub.remove(); });

  describe('when its package is loaded for a definition, ', () => {
    let answer = '';
    let probes = '';
    let log = '';

    before(async () => {
      answer = stub.describe(await stub.server.definition(stub.file('one/lib/a.dart'), 0, 0));
      probes = stub.files(await stub.events(), 'textDocument/documentSymbol');
      log = stub.log.join('\n');
    });

    it('then the probe is attempted twice.', () => {
      assert.equal(probes, 'one/lib/a.dart\none/lib/a.dart');
    });

    it('then the definition is returned.', () => {
      assert.equal(answer, 'one/lib/a.dart:0:0');
    });

    it('then the successful retry needs no verbose warning.', () => {
      assert.equal(log, '');
    });
  });
});

describe('Given a representative whose readiness probe errors twice, ', () => {
  let stub: Protocol;

  before(async () => {
    stub = await protocol();
    await stub.server.request('test/probe', { behavior: 'error twice' });
    await stub.server.request('test/definitions', { answers: ['location'] });
  });
  after(async () => { await stub.remove(); });

  describe('when its package is loaded for a definition, ', () => {
    let answer = '';
    let probes = '';
    let log = '';

    before(async () => {
      answer = stub.describe(await stub.server.definition(stub.file('one/lib/a.dart'), 0, 0));
      probes = stub.files(await stub.events(), 'textDocument/documentSymbol');
      log = stub.log.join('\n');
    });

    it('then the probe stops after its second attempt.', () => {
      assert.equal(probes, 'one/lib/a.dart\none/lib/a.dart');
    });

    it('then the definition is still returned.', () => {
      assert.equal(answer, 'one/lib/a.dart:0:0');
    });

    it('then the skipped probe is explained in verbose output.', () => {
      assert.equal(log, `could not resolve ${stub.file('one/lib/a.dart')}: file cannot be resolved`);
    });
  });
});
