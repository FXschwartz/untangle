import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { buildDartReview, type BuiltReview } from '../helpers/review.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';

interface Edit { op: string; where: string; from: string; to: string; b: string; group?: number }
interface Chain { name: string; kind: string; depth: number; blocks: string[]; graph: { nodes: Array<{ layer: number; member: string | null }> } }
interface Model { compares: { base: { files: Array<{ p: string; blocks: Array<{ id: string; edits: number[] }> }>; generated: Array<{ p: string; s: string }>; edits: Edit[]; groups: Array<{ count: number; edits: number[] }>; chains: Chain[] } } }

function editsOf(review: BuiltReview): string {
  return (review.data.model as Model).compares.base.edits.map((edit) => `${edit.op} ${edit.where} ${edit.from} → ${edit.to}`).join('\n');
}

function groupsOf(review: BuiltReview): string {
  const base = (review.data.model as Model).compares.base;
  return base.groups.map((group) => {
    const edit = base.edits[group.edits[0]];
    return `x${group.count} ${edit.from} → ${edit.to}`;
  }).join('\n');
}

function chainsOf(review: BuiltReview): string {
  return (review.data.model as Model).compares.base.chains.map((chain) => `${chain.kind} ${chain.name}\n${chain.blocks.join('\n')}`).join('\n');
}

function levelsOf(review: BuiltReview): string {
  return (review.data.model as Model).compares.base.chains.map((chain) => chain.graph.nodes.map((node) => `L${node.layer} ${node.member}`).join('\n')).join('\n');
}

function aside(review: BuiltReview): string {
  const base = (review.data.model as Model).compares.base;
  return `files\n${base.files.map((item) => item.p).join('\n')}\ngenerated\n${base.generated.map((item) => item.p).join('\n')}`;
}

describe('Given a string changed in one function, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hello');\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the edit replaces that string.', () => {
      assert.equal(editsOf(review!), "replace string_literal 'hello' → 'hi'");
    });
  });
});

describe('Given the same string replaced in two functions, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void a() {\n  print('hello');\n}\n\nvoid b() {\n  print('hello');\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  print('hi');\n}\n\nvoid b() {\n  print('hi');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the two replacements are one same-change group.', () => {
      assert.equal(groupsOf(review!), "x2 'hello' → 'hi'");
    });
  });
});

describe('Given a function that gains a parameter and a call that passes it, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "void greet(String name) {\n  print(name);\n}\n\nvoid main() {\n  greet('ada');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the parameter and the call are one chain.', () => {
      assert.equal(chainsOf(review!), 'ripple greet(name)\nlib/a.dart#0\nlib/a.dart#1');
    });

    it('then the call sits one level out from the parameter.', () => {
      assert.equal(levelsOf(review!), 'L0 greet\nL1 main');
    });
  });
});

describe('Given a change to a library, its generated part and a file listed in .review.yaml, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'lib/a.dart': "void greet() {\n  print('hello');\n}\n",
      'lib/a.g.dart': 'const generated = 1;\n',
      '.review.yaml': 'generated:\n  - lib/extra.dart\n',
      'lib/extra.dart': 'const extra = 1;\n',
    },
    head: {
      'lib/a.dart': "void greet() {\n  print('hi');\n}\n",
      'lib/a.g.dart': 'const generated = 2;\n',
      '.review.yaml': 'generated:\n  - lib/extra.dart\n',
      'lib/extra.dart': 'const extra = 2;\n',
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the library is reviewed and the generated files are set aside.', () => {
      assert.equal(aside(review!), 'files\nlib/a.dart\ngenerated\nlib/a.g.dart\nlib/extra.dart');
    });
  });
});
