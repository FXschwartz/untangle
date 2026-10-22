import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Analyzer, type FileFacts } from '../../dist/analyzer/client.js';
import { has } from '../../dist/exec.js';
import { buildDartReview, type BuiltReview } from '../helpers/review.ts';

const skip = has('dart') ? false : 'dart is not on PATH';

describe('Given an object pattern, a callback, and two mixins overriding a superclass, ', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-analyzer-'));
  const file = path.join(root, 'lib/example.dart');
  let analyzer: Analyzer;
  let facts: FileFacts;

  before(() => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: example\nenvironment:\n  sdk: ">=3.12.0 <4.0.0"\n');
    fs.writeFileSync(file, `class Request {
  Request(this.amount);
  final int amount;
}

int compare(Request a, Request b) => a.amount.compareTo(b.amount);

int inspect(Request request, List<Request> requests) {
  requests.sort(compare);
  final Request(amount: value) = request;
  return value;
}

class Base {
  int get value => 0;
  void update() {}
}

mixin First on Base {
  @override
  int get value => 1;
  @override
  void update() {}
}

mixin Second on Base {
  @override
  int get value => 2;
  @override
  void update() {}
}

class Combined extends Base with First, Second {
  @override
  int get value => super.value;
  @override
  void update() => super.update();
}
`);
  });

  after(async () => {
    await analyzer?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('when the production extractor resolves the file, ', () => {
    before(async () => {
      analyzer = await Analyzer.start([file]);
      facts = (await analyzer.file(file))!;
    });

    it('then the object-pattern label resolves to its field.', () => {
      const field = facts.declarations.find((declaration) => declaration.name === 'amount' && declaration.kind === 'FIELD')!;
      assert.equal(facts.references['10:16'].target.join(':'), field.id);
    });

    it('then passing a callback retains reachability to that function.', () => {
      const caller = facts.declarations.find((declaration) => declaration.name === 'inspect')!;
      const callback = facts.declarations.find((declaration) => declaration.name === 'compare')!;
      assert.ok(facts.calls[caller.id].some((target) => target.join(':') === callback.id));
    });

    it('then overrides resolve to the last applicable mixin.', () => {
      const owner = facts.declarations.find((declaration) => declaration.name === 'Combined')!;
      const mixin = facts.declarations.find((declaration) => declaration.name === 'Second')!;
      const members = facts.declarations.filter((declaration) => declaration.owner === owner.id && ['GETTER', 'METHOD'].includes(declaration.kind));
      const targets = facts.declarations.filter((declaration) => declaration.owner === mixin.id && ['GETTER', 'METHOD'].includes(declaration.kind));

      assert.equal(members.length, 2);
      assert.deepEqual(members.map((member) => facts.supers[member.position].join(':')), targets.map((member) => member.id));
    });

    it('then valid modern code has no analyzer errors.', () => {
      assert.deepEqual(facts.diagnostics.filter((diagnostic) => diagnostic.severity === 'ERROR'), []);
    });
  });
});

describe('Given a library that imports one file and exports another by its package, ', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-analyzer-'));
  const file = path.join(root, 'lib/all.dart');
  let analyzer: Analyzer;
  let facts: FileFacts;

  before(() => {
    fs.mkdirSync(path.join(root, 'lib/src'), { recursive: true });
    fs.mkdirSync(path.join(root, '.dart_tool'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: example\nenvironment:\n  sdk: ">=3.12.0 <4.0.0"\n');
    fs.writeFileSync(path.join(root, '.dart_tool/package_config.json'), JSON.stringify({ configVersion: 2, packages: [{ name: 'example', rootUri: '../', packageUri: 'lib/', languageVersion: '3.12' }] }));
    fs.writeFileSync(path.join(root, 'lib/src/a.dart'), 'int a() => 1;\n');
    fs.writeFileSync(path.join(root, 'lib/src/b.dart'), 'int b() => 2;\n');
    fs.writeFileSync(file, "import 'src/a.dart';\nexport 'package:example/src/b.dart' show b;\nimport 'src/generated/missing.dart';\n\nint all() => a();\n");
  });

  after(async () => {
    await analyzer?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('when the production extractor resolves the file, ', () => {
    before(async () => {
      analyzer = await Analyzer.start([file]);
      facts = (await analyzer.file(file))!;
    });

    it('then each URI refers to the top of the file it names, and one naming a missing file to nothing.', () => {
      const uris = ['1:7', '2:7', '3:7'].map((at) => facts.references[at]).map((r) => r && `${r.kind} ${path.relative(root, r.target[0])}:${r.target[1]}:${r.target[2]}`);
      assert.deepEqual(uris, ['uri lib/src/a.dart:0:0', 'uri lib/src/b.dart:0:0', undefined]);
    });
  });
});

describe('Given a package whose template folder has a # in its name, as {{#auth}}, ', { skip }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-analyzer-'));
  const template = path.join(root, 'lib/src/{{#auth}}auth{{!auth}}/endpoint.dart');
  const plain = path.join(root, 'lib/plain.dart');
  const log: string[] = [];
  let analyzer: Analyzer;
  let facts: Array<FileFacts | null>;
  let calls: FileFacts['calls'];

  before(() => {
    fs.mkdirSync(path.dirname(template), { recursive: true });
    fs.mkdirSync(path.join(root, '.dart_tool'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: example\nenvironment:\n  sdk: ">=3.12.0 <4.0.0"\n');
    fs.writeFileSync(path.join(root, '.dart_tool/package_config.json'), JSON.stringify({ configVersion: 2, packages: [{ name: 'example', rootUri: '../', packageUri: 'lib/', languageVersion: '3.12' }] }));
    fs.writeFileSync(template, 'class Endpoint {}\n');
    fs.writeFileSync(plain, 'class Plain {}\n');
  });

  after(async () => {
    await analyzer?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('when the production extractor resolves a file of that folder, then another, ', () => {
    before(async () => {
      analyzer = await Analyzer.start([template, plain], (line) => log.push(line));
      facts = [await analyzer.file(template), await analyzer.file(plain)];
      calls = await analyzer.calls(template);
    });

    it('then the analyzer won’t resolve the first, which has neither facts nor calls.', () => {
      assert.deepEqual([facts[0], calls, log.filter((line) => line.startsWith(template))], [null, {}, [`${template}: the analyzer answered NotPathOfUriResult`, `${template}: the analyzer answered NotPathOfUriResult`]]);
    });

    it('then the other still resolves.', () => {
      assert.deepEqual(facts[1]?.declarations.map((declaration) => declaration.name), ['Plain']);
    });
  });
});

describe('Given independent callbacks whose parameters feed nested functions, ', { skip }, () => {
  const source = `void run(void Function(int) body) => body(1);

void main() {
  run((left) {
    void firstUse() {
      print(left);
    }

    void secondUse() {
      print(left);
    }

    firstUse();
    secondUse();
  });

  run((right) {
    void thirdUse() {
      print(right);
    }

    void fourthUse() {
      print(right);
    }

    thirdUse();
    fourthUse();
  });
}
`;
  let review: BuiltReview;
  let chains: any[];

  describe('when each callback renames its own parameter, ', () => {
    before(async () => {
      review = await buildDartReview({
        base: { 'lib/example.dart': source },
        head: { 'lib/example.dart': source.replaceAll('left', 'alpha').replaceAll('right', 'beta') },
      });
      chains = review.data.model.compares.base.chains;
    });

    after(() => review?.remove());

    it('then the independent parameter changes keep separate chains.', () => {
      assert.equal(chains.length, 2);
      assert.ok(chains.every((chain) => chain.blocks.length === 3));
      assert.ok(chains[0].blocks.every((block: string) => !chains[1].blocks.includes(block)));
    });
  });
});

describe('Given new classes containing null-aware collection elements, ', { skip }, () => {
  let review: BuiltReview;
  let model: any;

  describe('when the review is built through the production pipeline, ', () => {
    before(async () => {
      review = await buildDartReview({
        base: {
          'pubspec.yaml': 'name: sample\nenvironment:\n  sdk: ">=3.8.0 <4.0.0"\n',
          'lib/existing.dart': 'void main() {}\n',
        },
        head: {
          'lib/labels.dart': `class Labels {
  String describe(String? optional) => ['base', ?optional].join(', ');
}

class Following {
  final int value = 1;
}
`,
        },
      });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then the original atomic change contains both complete classes in one declaration bundle.', () => {
      const file = model.files.find((file: any) => file.p === 'lib/labels.dart');
      const units = model.units.filter((unit: any) => unit.file === file.p);

      assert.deepEqual(units.map((unit: any) => [unit.name, unit.start, unit.end]), [['Labels, Following', 1, 7]]);
      assert.equal(file.blocks.length, 1);
      assert.equal(file.blocks[0].id, 'lib/labels.dart#0');
      assert.ok(file.blocks.every((block: any) => units.some((unit: any) => unit.id === block.unit && unit.blocks.includes(block.id))));
      assert.deepEqual(model.chains, []);
    });
  });
});

describe('Given a new class with leading comments after an existing declaration with a trailing comment, ', { skip }, () => {
  const existing = 'class Existing {} // This comment belongs to Existing.\n';
  const addition = `// This class owns these two lines.
// Its fields and constructor are read together.
class Added {
  Added(this.value);

  final int value;
}
`;
  let review: BuiltReview;
  let model: any;

  describe('when the review resolves the declaration boundaries, ', () => {
    before(async () => {
      review = await buildDartReview({
        base: { 'lib/example.dart': existing },
        head: { 'lib/example.dart': existing + addition },
      });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then the complete new class includes its leading comments without taking the existing comment.', () => {
      const unit = model.units.find((unit: any) => unit.name === 'Added');
      const changes = model.files[0].blocks.filter((block: any) => block.edits.length);

      assert.ok(unit);
      assert.deepEqual([unit.start, unit.end], [2, 8]);
      assert.ok(changes.every((block: any) => block.unit === unit.id));
      assert.deepEqual(model.chains, []);
    });
  });
});

describe('Given a change to a template file whose folder has a # in its name, beside a plain one, ', { skip }, () => {
  const template = 'lib/src/{{#auth}}auth{{!auth}}/endpoint.dart';
  let review: BuiltReview;
  let model: any;

  describe('when the review is built through the production pipeline, ', () => {
    before(async () => {
      review = await buildDartReview({
        base: { [template]: 'class Endpoint {}\n', 'lib/plain.dart': 'class Plain {}\n' },
        head: { [template]: 'class Endpoint {\n  int answer() => 42;\n}\n', 'lib/plain.dart': 'class Plain {\n  int answer() => 42;\n}\n' },
      });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then it reviews both files, and says the analyzer can’t resolve the template alone.', () => {
      assert.deepEqual(model.files.map((file: any) => file.p).sort(), ['lib/plain.dart', template]);
      assert.deepEqual(review.notes.filter((note) => note.includes('analyzer')), [`the Dart analyzer can't resolve ${template}: no chains or go to definition in it`]);
    });
  });
});
