import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { buildDartReview, type BuiltReview } from '../helpers/review.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';

interface Edit { op: string; where: string; from: string; to: string }
interface Block { id: string; member: string | null; adds: number; dels: number; test?: string; documents?: boolean; movedTo?: { n: number; changes: number } }
interface Chain {
  name: string; kind: string; adds: number; dels: number; depth: number; family: number; blocks: string[]; uses: number[]; shares: number[];
  graph: { nodes: Array<{ key: string; layer: number; member: string | null }>; edges: Array<{ from: string; to: string; labels: string[] }> };
}
interface Model {
  compares: {
    base: {
      files: Array<{ blocks: Block[] }>;
      generated: Array<{ p: string }>;
      edits: Edit[];
      groups: Array<{ count: number; edits: number[] }>;
      chains: Chain[];
    };
  };
}

function baseOf(review: BuiltReview): Model['compares']['base'] {
  return (review.data.model as Model).compares.base;
}

function blocksOf(review: BuiltReview): string {
  const base = baseOf(review);
  const linked = new Set(base.chains.flatMap((chain) => chain.blocks));
  return base.files.flatMap((file) => file.blocks.map((block) => {
    const marks = [
      block.test ? `test ${block.test}` : '',
      block.documents ? 'documents' : '',
      block.movedTo ? `points at line ${block.movedTo.n} with ${block.movedTo.changes} to review` : '',
      linked.has(block.id) ? '' : 'standalone',
    ].filter(Boolean);
    return `${block.id} ${block.member ?? '(top)'} +${block.adds} -${block.dels}${marks.length ? ' ' + marks.join(', ') : ''}`;
  })).join('\n');
}

function editsOf(review: BuiltReview): string {
  const edits = baseOf(review).edits;
  return edits.length ? edits.map((edit) => `${edit.op} ${edit.where} ${edit.from} → ${edit.to}`).join('\n') : 'none';
}

function groupsOf(review: BuiltReview): string {
  const base = baseOf(review);
  return base.groups.length ? base.groups.map((group) => {
    const edit = base.edits[group.edits[0]];
    return `x${group.count} ${edit.from} → ${edit.to}`;
  }).join('\n') : 'none';
}

function chainsOf(review: BuiltReview): string {
  const chains = baseOf(review).chains;
  if (!chains.length) return 'none';
  return chains.map((chain) => {
    const nameOf = new Map(chain.graph.nodes.map((node) => [node.key, node.member ?? (node.key.startsWith('tests:') ? 'tests' : node.key.includes('(top)') ? '(top)' : 'group')]));
    const nodes = chain.graph.nodes.map((node) => `L${node.layer} ${nameOf.get(node.key)}`).join(', ');
    const edges = chain.graph.edges.map((edge) => `${nameOf.get(edge.from)} → ${nameOf.get(edge.to)} [${edge.labels.join(' ')}]`).join(', ') || 'none';
    const linked = [`uses ${chain.uses.join(' ') || 'none'}`, `shares ${chain.shares.join(' ') || 'none'}`, `family ${chain.family}`].join(', ');
    return `${chain.kind} ${chain.name} +${chain.adds} -${chain.dels} depth ${chain.depth}\n${chain.blocks.join(', ')}\n${nodes}\n${edges}\n${linked}`;
  }).join('\n');
}

function generatedOf(review: BuiltReview): string {
  const generated = baseOf(review).generated.map((file) => file.p);
  return generated.length ? generated.join('\n') : 'none';
}

function scenario(given: string, files: { base: Record<string, string>; head: Record<string, string> }, then: string, read: (review: BuiltReview) => string, expected: string, todo?: string): void {
  describe(given, { skip: skipDart }, () => {
    describe('when the review is built, ', () => {
      let review: BuiltReview | undefined;

      before(async () => {
        review = await buildDartReview(files);
      });

      after(() => review?.remove());

      it(then, todo ? { todo } : {}, () => {
        assert.equal(read(review!), expected);
      });
    });
  });
}

scenario(
  'Given two top-level functions whose strings change, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  print('hello');\n}\n\nvoid wave() {\n  print('hello');\n}\n" },
  },
  'then the hunk is two changes.',
  blocksOf,
  'lib/a.dart#0 greet +1 -1 standalone\nlib/a.dart#1 wave +1 -1 standalone',
);

scenario(
  'Given two fields written on consecutive lines that both gain a value, ',
  {
    base: { 'lib/a.dart': 'class Box {\n  int a;\n  int b;\n}\n' },
    head: { 'lib/a.dart': 'class Box {\n  int a = 1;\n  int b = 2;\n}\n' },
  },
  'then they stay one change.',
  blocksOf,
  'lib/a.dart#0 Box.a +2 -2 standalone',
);

scenario(
  'Given a doc comment and the declaration under it both change, ',
  {
    base: { 'lib/a.dart': "/// Old.\nvoid greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "/// New.\nvoid hello() {\n  print('hi');\n}\n\nvoid main() {\n  hello();\n}\n" },
  },
  'then the comment and the declaration are one change.',
  blocksOf,
  'lib/a.dart#0 hello +2 -2\nlib/a.dart#1 main +1 -1',
);

scenario(
  'Given only a function\'s doc comment changes, ',
  {
    base: { 'lib/a.dart': "/// Says hi.\nvoid greet() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "/// Says hello.\nvoid greet() {\n  print('hi');\n}\n" },
  },
  'then the comment belongs to that function.',
  blocksOf,
  'lib/a.dart#0 greet +1 -1 documents, standalone',
);

scenario(
  'Given an annotation between two methods, and both methods change, ',
  {
    base: { 'lib/a.dart': "class Box {\n  void greet() { print(1); }\n\n  @Deprecated('old')\n  void wave() { print(2); }\n}\n" },
    head: { 'lib/a.dart': "class Box {\n  void greet() { print(3); }\n\n  @Deprecated('new')\n  void wave() { print(4); }\n}\n" },
  },
  'then the annotation changes with the method after it.',
  blocksOf,
  'lib/a.dart#0 Box.greet +1 -1 standalone\nlib/a.dart#1 Box +2 -2 standalone',
);

scenario(
  'Given a test file whose group name and test body change, ',
  {
    base: { 'test/a_test.dart': "void main() {\n  group('outer', () {\n    test('one', () {\n      print(1);\n    });\n  });\n}\n" },
    head: { 'test/a_test.dart': "void main() {\n  group('inner', () {\n    test('one', () {\n      print(2);\n    });\n  });\n}\n" },
  },
  'then the group call and the test call are two changes.',
  blocksOf,
  'test/a_test.dart#0 main +1 -1 test inner, standalone\ntest/a_test.dart#1 main +1 -1 test one, standalone',
);

scenario(
  'Given a function moved to another file and its body changed, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "void main() {\n  greet();\n}\n", 'lib/b.dart': "void greet() {\n  print('hello');\n}\n" },
  },
  'then the review is the body\'s diff and the old copy points at the new one.',
  (review) => `${blocksOf(review)}\n${editsOf(review)}`,
  'lib/a.dart#0 greet +0 -0 points at line 1 with 1 to review, standalone\nlib/b.dart#0 greet +1 -2 standalone\nreplace string_literal \'hi\' → \'hello\'',
);

scenario(
  'Given a function moved to another file with its body unchanged, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "void main() {\n  greet();\n}\n", 'lib/b.dart': "void greet() {\n  print('hi');\n}\n" },
  },
  'then the move has nothing to review.',
  editsOf,
  'none',
);

scenario(
  'Given a function renamed and its call updated, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "void hello() {\n  print('hi');\n}\n\nvoid main() {\n  hello();\n}\n" },
  },
  'then the old and new usages are one chain.',
  chainsOf,
  'member hello +2 -2 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 hello, L1 main\nmain → hello [hello]\nuses none, shares none, family 0',
);

scenario(
  'Given a function removed and its call removed, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n  print(1);\n}\n" },
    head: { 'lib/a.dart': "void main() {\n  print(1);\n}\n" },
  },
  'then the chain is named with a minus.',
  chainsOf,
  'member − greet +0 -5 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 greet, L1 main\nmain → greet [greet]\nuses none, shares none, family 0',
);

scenario(
  'Given a return type changed on its own line and the call\'s argument changed, ',
  {
    base: { 'lib/a.dart': "void\ngreet(String name) {\n  print(name);\n}\n\nvoid main() {\n  greet('a');\n}\n" },
    head: { 'lib/a.dart': "String\ngreet(String name) {\n  print(name);\n}\n\nvoid main() {\n  greet('b');\n}\n" },
  },
  'then the call links to the function.',
  chainsOf,
  'member greet +2 -2 depth 0\nlib/a.dart#1, lib/a.dart#2\nL0 greet, L1 main\nmain → greet [greet]\nuses none, shares none, family 0',
);

scenario(
  'Given a parameter renamed and passed on by the caller, ',
  {
    base: { 'lib/a.dart': "void greet(String name) {\n  print(name);\n}\n\nvoid wave(String name) {\n  greet(name);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
    head: { 'lib/a.dart': "void greet(String title) {\n  print(title);\n}\n\nvoid wave(String title) {\n  greet(title);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
  },
  'then the parameter and the caller are one chain.',
  chainsOf,
  'ripple greet(title) +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 greet, L1 wave\nwave → greet [title]\nuses none, shares none, family 0',
);

scenario(
  'Given that same parameter passed on by its caller, ',
  {
    base: { 'lib/a.dart': "void greet(String name) {\n  print(name);\n}\n\nvoid wave(String name) {\n  greet(name);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
    head: { 'lib/a.dart': "void greet(String title) {\n  print(title);\n}\n\nvoid wave(String title) {\n  greet(title);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
  },
  'then the chain is named for the parameter the value enters at.',
  (review) => baseOf(review).chains.map((chain) => chain.name).join('\n'),
  'wave(title)',
  'bug: the ripple is named greet(title), the parameter the value is passed on to, rather than wave(title), where the value enters',
);

scenario(
  'Given a local renamed in one function and a same-named local changed in another, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  var name = 'a';\n  print(name);\n" + '  print(0);\n'.repeat(20) + "  print(name);\n}\n\nvoid main() {\n  var name = 'a';\n  print(name);\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  var title = 'a';\n  print(title);\n" + '  print(0);\n'.repeat(20) + "  print(title);\n}\n\nvoid main() {\n  var name = 'c';\n  print(name);\n}\n" },
  },
  'then the hunks stay standalone.',
  blocksOf,
  'lib/a.dart#0 greet +2 -2 standalone\nlib/a.dart#1 greet +1 -1 standalone\nlib/a.dart#2 main +1 -1 standalone',
);

scenario(
  'Given a new function whose parameter is passed at the call, ',
  {
    base: { 'lib/a.dart': "void main() {\n  print(1);\n}\n" },
    head: { 'lib/a.dart': "import 'b.dart';\n\nvoid main() {\n  greet('ada');\n}\n", 'lib/b.dart': "void greet(String name) {\n  print(name);\n}\n" },
  },
  'then the chain is named for the function, not the parameter.',
  chainsOf,
  'member greet +6 -1 depth 0\nlib/a.dart#0, lib/a.dart#1, lib/b.dart#0\nL0 greet, L1 main, L2 (top)\nmain → greet [greet name]\nuses none, shares none, family 0',
);

scenario(
  'Given a field renamed, including the constructor parameter that sets it, ',
  {
    base: { 'lib/a.dart': "class Box {\n  String name;\n  Box(this.name);\n  void show() {\n    print(name);\n  }\n}\n" },
    head: { 'lib/a.dart': "class Box {\n  String title;\n  Box(this.title);\n  void show() {\n    print(title);\n  }\n}\n" },
  },
  'then the field and the constructor are one chain.',
  chainsOf,
  'member Box() +3 -3 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 Box.title, L1 Box.show\nBox.show → Box.title [title]\nuses none, shares none, family 0',
);

scenario(
  'Given a test that starts calling a function which reaches a changed function, ',
  {
    base: {
      'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('waves', () {\n    print(1);\n  });\n}\n",
    },
    head: {
      'lib/a.dart': "void greet() {\n  print('hello');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('waves', () {\n    wave();\n  });\n}\n",
    },
  },
  'then the test joins the changed function.',
  chainsOf,
  'member greet +2 -2 depth 0\nlib/a.dart#0, test/a_test.dart#0\nL0 greet, L1 tests\ntests → greet [greet]\nuses none, shares none, family 0',
);

scenario(
  'Given a file named a_test.dart whose test starts calling a function which reaches a changed function, ',
  {
    base: {
      'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'lib/a_test.dart': "import 'a.dart';\n\nvoid main() {\n  test('waves', () {\n    print(1);\n  });\n}\n",
    },
    head: {
      'lib/a.dart': "void greet() {\n  print('hello');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'lib/a_test.dart': "import 'a.dart';\n\nvoid main() {\n  test('waves', () {\n    wave();\n  });\n}\n",
    },
  },
  'then the test file joins the changed function.',
  chainsOf,
  'member greet +2 -2 depth 0\nlib/a.dart#0, lib/a_test.dart#0\nL0 greet, L1 tests\ntests → greet [greet]\nuses none, shares none, family 0',
);

scenario(
  'Given the same local renamed in two functions, ',
  {
    base: { 'lib/a.dart': "void a() {\n  var name = 1;\n}\n\nvoid b() {\n  var name = 1;\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  var title = 1;\n}\n\nvoid b() {\n  var title = 1;\n}\n" },
  },
  'then the rename is a chain.',
  chainsOf,
  'group name → title +2 -2 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 a, L1 b\nnone\nuses none, shares none, family 0',
);

scenario(
  'Given a parameter renamed and another string in the same function changed, ',
  {
    base: { 'lib/a.dart': "void greet(String name) {\n  print(name);\n" + '  print(0);\n'.repeat(20) + "  print('hi');\n}\n\nvoid main() {\n  greet('a');\n}\n" },
    head: { 'lib/a.dart': "void greet(String title) {\n  print(title);\n" + '  print(0);\n'.repeat(20) + "  print('hello');\n}\n\nvoid main() {\n  greet('b');\n}\n" },
  },
  'then the string change joins the function\'s chain.',
  chainsOf,
  'ripple greet(title) +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1, lib/a.dart#2\nL0 greet, L1 main\nmain → greet [title]\nuses none, shares none, family 0',
);

scenario(
  'Given a new file that declares a type whose methods call each other, ',
  {
    base: { 'lib/a.dart': 'void main() {}\n' },
    head: { 'lib/a.dart': 'void main() {}\n', 'lib/box.dart': "class Box {\n  void open() {\n    print(1);\n  }\n\n  void show() {\n    open();\n  }\n}\n" },
  },
  'then the file is one chain named for the type.',
  chainsOf,
  'member Box +9 -0 depth 0\nlib/box.dart#0, lib/box.dart#1, lib/box.dart#2\nL0 Box.open, L1 Box.show, L2 Box\nBox.show → Box.open [open]\nuses none, shares none, family 0',
);

scenario(
  'Given two overrides of one unchanged method that each gain a parameter, ',
  {
    base: { 'lib/a.dart': "class A {\n  void greet() {\n    print('a');\n  }\n}\n\nclass B extends A {\n  void greet() {\n    print('b');\n  }\n}\n\nclass C extends A {\n  void greet() {\n    print('c');\n  }\n}\n" },
    head: { 'lib/a.dart': "class A {\n  void greet() {\n    print('a');\n  }\n}\n\nclass B extends A {\n  void greet(String name) {\n    print(name);\n  }\n}\n\nclass C extends A {\n  void greet(String name) {\n    print(name);\n  }\n}\n" },
  },
  'then the overrides are one chain.',
  chainsOf,
  'member overrides A.greet +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 C.greet, L1 B.greet\nB.greet → C.greet [greet]\nuses none, shares none, family 0',
);

scenario(
  'Given a method and its override that each gain a parameter, ',
  {
    base: { 'lib/a.dart': "class A {\n  void greet() {\n    print('a');\n  }\n}\n\nclass B extends A {\n  void greet() {\n    print('b');\n  }\n}\n" },
    head: { 'lib/a.dart': "class A {\n  void greet(String name) {\n    print(name);\n  }\n}\n\nclass B extends A {\n  void greet(String name) {\n    print(name);\n  }\n}\n" },
  },
  'then the override links to the method.',
  chainsOf,
  'member A.greet +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 A.greet, L1 B.greet\nB.greet → A.greet [greet]\nuses none, shares none, family 0',
);

scenario(
  'Given two toString methods whose results change, ',
  {
    base: { 'lib/a.dart': "class A {\n  String toString() => 'a';\n}\n\nclass B {\n  String toString() => 'b';\n}\n" },
    head: { 'lib/a.dart': "class A {\n  String toString() => 'A';\n}\n\nclass B {\n  String toString() => 'B';\n}\n" },
  },
  'then they are not one chain.',
  chainsOf,
  'none',
);

scenario(
  'Given a function renamed in the file a new import starts using, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n", 'lib/b.dart': "void main() {\n  print(1);\n}\n" },
    head: { 'lib/a.dart': "void hello() {\n  print('hi');\n}\n", 'lib/b.dart': "import 'a.dart';\n\nvoid main() {\n  hello();\n}\n" },
  },
  'then the import joins that chain.',
  chainsOf,
  'member hello +4 -2 depth 0\nlib/a.dart#0, lib/b.dart#0, lib/b.dart#1\nL0 hello, L1 main, L2 (top)\nmain → hello [hello]\nuses none, shares none, family 0',
);

scenario(
  'Given a part directive added while the part renames a function its caller uses, ',
  {
    base: { 'lib/a.dart': "void main() {\n  print(1);\n}\n", 'lib/bit.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "part 'bit.dart';\n\nvoid main() {\n  print(1);\n}\n", 'lib/bit.dart': "part of 'a.dart';\n\nvoid hello() {\n  print('hi');\n}\n\nvoid wave() {\n  hello();\n}\n" },
  },
  'then the part directive joins the part\'s chain.',
  chainsOf,
  'member hello +6 -2 depth 0\nlib/a.dart#0, lib/bit.dart#0, lib/bit.dart#1\nL0 (top), L1 wave, L2 (top)\nwave → (top) [hello]\nuses none, shares none, family 0',
);

scenario(
  'Given a declaration\'s signature changed and a string that names it, ',
  {
    base: { 'lib/a.dart': "void greetUser() {\n  print(1);\n}\n\nvoid main() {\n  print('old');\n}\n" },
    head: { 'lib/a.dart': "void greetUser(String name) {\n  print(1);\n}\n\nvoid main() {\n  print('greetUser');\n}\n" },
  },
  'then the string links to the declaration.',
  chainsOf,
  'member greetUser +2 -2 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 greetUser, L1 main\nmain → greetUser [greetUser]\nuses none, shares none, family 0',
);

scenario(
  'Given a new string introduced by a print and by a constant, ',
  {
    base: { 'lib/a.dart': "void main() {\n  print('old');\n}\n", 'lib/b.dart': 'void run() {}\n' },
    head: { 'lib/a.dart': "void main() {\n  print('tail_runner_logs');\n}\n", 'lib/b.dart': "void run() {\n  const name = 'tail_runner_logs';\n}\n" },
  },
  'then the two changes are a chain named for the string.',
  chainsOf,
  'member “tail_runner_logs” +4 -2 depth 0\nlib/a.dart#0, lib/b.dart#0\nL0 main, L1 run\nrun → main [tail_runner_logs]\nuses none, shares none, family 0',
);

scenario(
  'Given the same interpolated string changed in two functions, ',
  {
    base: { 'lib/a.dart': "void a(String name) {\n  print('hi $name');\n}\n\nvoid b(String name) {\n  print('hi $name');\n}\n" },
    head: { 'lib/a.dart': "void a(String name) {\n  print('hello $name');\n}\n\nvoid b(String name) {\n  print('hello $name');\n}\n" },
  },
  'then the string does not become a chain.',
  chainsOf,
  'none',
);

scenario(
  'Given a Serverpod model that gains a field a generated table reads, ',
  {
    base: {
      'lib/user.spy.yaml': 'class: User\nfields:\n  name: String\n',
      'lib/generated/user.dart': 'class UserTable {\n  String name = \'\';\n}\n',
      'lib/app.dart': "import 'generated/user.dart';\n\nvoid main() {\n  print(1);\n}\n",
    },
    head: {
      'lib/user.spy.yaml': 'class: User\nfields:\n  name: String\n  title: String\n',
      'lib/generated/user.dart': 'class UserTable {\n  String name = \'\';\n  String title = \'\';\n}\n',
      'lib/app.dart': "import 'generated/user.dart';\n\nvoid main() {\n  final table = UserTable();\n  print(table.title);\n}\n",
    },
  },
  'then the use links to the model field and the generated file is set aside.',
  (review) => `${chainsOf(review)}\n${generatedOf(review)}`,
  'member User.title +3 -1 depth 0\nlib/app.dart#0, lib/user.spy.yaml#0\nL0 (top), L1 main\nmain → (top) [title]\nuses none, shares none, family 0\nlib/generated/user.dart',
);

scenario(
  'Given one string changed in one function, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  print('hello');\n}\n" },
  },
  'then the change is listed on its own.',
  blocksOf,
  'lib/a.dart#0 greet +1 -1 standalone',
);

scenario(
  'Given the same identifier renamed in three functions, ',
  {
    base: { 'lib/a.dart': "void a() {\n  var name = 1;\n}\n\nvoid b() {\n  var name = 1;\n}\n\nvoid c() {\n  var name = 1;\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  var title = 1;\n}\n\nvoid b() {\n  var title = 1;\n}\n\nvoid c() {\n  var title = 1;\n}\n" },
  },
  'then the graph is one node.',
  chainsOf,
  'group name → title +3 -3 depth 0\nlib/a.dart#0, lib/a.dart#1, lib/a.dart#2\nL0 a\nnone\nuses none, shares none, family 0',
);

scenario(
  'Given two tests that both start calling one changed function, ',
  {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n", 'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('one', () {\n    print(1);\n  });\n  test('two', () {\n    print(2);\n  });\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  print('hello');\n}\n", 'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('one', () {\n    greet();\n  });\n  test('two', () {\n    greet();\n  });\n}\n" },
  },
  'then the tests are one node.',
  chainsOf,
  'member greet +3 -3 depth 0\nlib/a.dart#0, test/a_test.dart#0, test/a_test.dart#1\nL0 greet, L1 tests\ntests → greet [greet]\nuses none, shares none, family 0',
);

scenario(
  'Given the same string replaced in two functions, ',
  {
    base: { 'lib/a.dart': "void a() {\n  print('hello');\n}\n\nvoid b() {\n  print('hello');\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  print('hi');\n}\n\nvoid b() {\n  print('hi');\n}\n" },
  },
  'then the two replacements are one group.',
  groupsOf,
  "x2 'hello' → 'hi'",
);

scenario(
  'Given the same doc comment edited on two functions, ',
  {
    base: { 'lib/a.dart': "/// Hello there friend.\nvoid a() {}\n\n/// Hello there friend.\nvoid b() {}\n" },
    head: { 'lib/a.dart': "/// Goodbye there friend.\nvoid a() {}\n\n/// Goodbye there friend.\nvoid b() {}\n" },
  },
  'then the repeated comment is one group.',
  groupsOf,
  'x2 /// Hello there friend. → /// Goodbye there friend.',
);

scenario(
  'Given five words changed in one doc comment, ',
  {
    base: { 'lib/a.dart': '/// alpha one two three four five omega.\nvoid greet() {}\n' },
    head: { 'lib/a.dart': '/// alpha six seven eight nine ten omega.\nvoid greet() {}\n' },
  },
  'then the line is one edit.',
  editsOf,
  'replace documentation_comment /// alpha one two three four five omega. → /// alpha six seven eight nine ten omega.',
);

scenario(
  'Given report gains a parameter while it starts mentioning price, and checkout starts passing price a new parameter, ',
  {
    base: {
      'lib/a.dart': [
        'int price(int a) => a;',
        '',
        'int checkout() => price(2);',
        '',
        'void report() {',
        '  print(0);',
        '}',
        '',
        'void main() {',
        '  report();',
        '}',
        '',
      ].join('\n'),
    },
    head: {
      'lib/a.dart': [
        'int price(int a, {int tax = 0}) => a + tax;',
        '',
        'int checkout() => price(2, tax: 1);',
        '',
        'void report({bool short = false}) {',
        '  print(price);',
        '}',
        '',
        'void main() {',
        '  report(short: true);',
        '}',
        '',
      ].join('\n'),
    },
  },
  'then report uses price, price sits one level deeper, and they are one family.',
  chainsOf,
  [
    'ripple price +4 -4 depth 1',
    'lib/a.dart#0, lib/a.dart#1, lib/a.dart#2',
    'L0 price, L1 checkout, L1 report',
    'checkout → price [tax], report → price [price]',
    'uses none, shares 1, family 0',
    'ripple report(short) +3 -3 depth 0',
    'lib/a.dart#2, lib/a.dart#3',
    'L0 report, L1 main',
    'main → report [short]',
    'uses 0, shares 0, family 0',
  ].join('\n'),
);

scenario(
  'Given the same bang inserted in two calls, ',
  {
    base: { 'lib/a.dart': "void a() {\n  print('hi');\n}\n\nvoid b() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  print('hi')!;\n}\n\nvoid b() {\n  print('hi')!;\n}\n" },
  },
  'then the punctuation is not a group.',
  groupsOf,
  'none',
);
