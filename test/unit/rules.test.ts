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

describe('Given two top-level functions whose strings change, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  print('hello');\n}\n\nvoid wave() {\n  print('hello');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the hunk is two changes.', () => {
      assert.equal(blocksOf(review!), 'lib/a.dart#0 greet +1 -1 standalone\nlib/a.dart#1 wave +1 -1 standalone');
    });
  });
});

describe('Given two fields written on consecutive lines that both gain a value, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': 'class Box {\n  int a;\n  int b;\n}\n' },
    head: { 'lib/a.dart': 'class Box {\n  int a = 1;\n  int b = 2;\n}\n' },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then they stay one change.', () => {
      assert.equal(blocksOf(review!), 'lib/a.dart#0 Box.a +2 -2 standalone');
    });
  });
});

describe('Given a doc comment and the declaration under it both change, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "/// Old.\nvoid greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "/// New.\nvoid hello() {\n  print('hi');\n}\n\nvoid main() {\n  hello();\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the comment and the declaration are one change.', () => {
      assert.equal(blocksOf(review!), 'lib/a.dart#0 hello +2 -2\nlib/a.dart#1 main +1 -1');
    });
  });
});

describe('Given only a function\'s doc comment changes, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "/// Says hi.\nvoid greet() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "/// Says hello.\nvoid greet() {\n  print('hi');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the comment belongs to that function.', () => {
      assert.equal(blocksOf(review!), 'lib/a.dart#0 greet +1 -1 documents, standalone');
    });
  });
});

describe('Given an annotation between two methods, and both methods change, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "class Box {\n  void greet() { print(1); }\n\n  @Deprecated('old')\n  void wave() { print(2); }\n}\n" },
    head: { 'lib/a.dart': "class Box {\n  void greet() { print(3); }\n\n  @Deprecated('new')\n  void wave() { print(4); }\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the annotation changes with the method after it.', () => {
      assert.equal(blocksOf(review!), 'lib/a.dart#0 Box.greet +1 -1 standalone\nlib/a.dart#1 Box +2 -2 standalone');
    });
  });
});

describe('Given a test file whose group name and test body change, ', { skip: skipDart }, () => {
  const files = {
    base: { 'test/a_test.dart': "void main() {\n  group('outer', () {\n    test('one', () {\n      print(1);\n    });\n  });\n}\n" },
    head: { 'test/a_test.dart': "void main() {\n  group('inner', () {\n    test('one', () {\n      print(2);\n    });\n  });\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the group call and the test call are two changes.', () => {
      assert.equal(blocksOf(review!), 'test/a_test.dart#0 main +1 -1 test inner, standalone\ntest/a_test.dart#1 main +1 -1 test one, standalone');
    });
  });
});

describe('Given a function moved to another file and its body changed, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "void main() {\n  greet();\n}\n", 'lib/b.dart': "void greet() {\n  print('hello');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the review is the body\'s diff and the old copy points at the new one.', () => {
      assert.equal(((review) => `${blocksOf(review)}\n${editsOf(review)}`)(review!), 'lib/a.dart#0 greet +0 -0 points at line 1 with 1 to review, standalone\nlib/b.dart#0 greet +1 -2 standalone\nreplace string_literal \'hi\' → \'hello\'');
    });
  });
});

describe('Given a function moved to another file with its body unchanged, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "void main() {\n  greet();\n}\n", 'lib/b.dart': "void greet() {\n  print('hi');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the move has nothing to review.', () => {
      assert.equal(editsOf(review!), 'none');
    });
  });
});

describe('Given a function renamed and its call updated, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "void hello() {\n  print('hi');\n}\n\nvoid main() {\n  hello();\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the old and new usages are one chain.', () => {
      assert.equal(chainsOf(review!), 'member hello +2 -2 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 hello, L1 main\nmain → hello [hello]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a function removed and its call removed, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid main() {\n  greet();\n  print(1);\n}\n" },
    head: { 'lib/a.dart': "void main() {\n  print(1);\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the chain is named with a minus.', () => {
      assert.equal(chainsOf(review!), 'member − greet +0 -5 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 greet, L1 main\nmain → greet [greet]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a return type changed on its own line and the call\'s argument changed, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void\ngreet(String name) {\n  print(name);\n}\n\nvoid main() {\n  greet('a');\n}\n" },
    head: { 'lib/a.dart': "String\ngreet(String name) {\n  print(name);\n}\n\nvoid main() {\n  greet('b');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the call links to the function.', () => {
      assert.equal(chainsOf(review!), 'member greet +2 -2 depth 0\nlib/a.dart#1, lib/a.dart#2\nL0 greet, L1 main\nmain → greet [greet]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a parameter renamed and passed on by the caller, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet(String name) {\n  print(name);\n}\n\nvoid wave(String name) {\n  greet(name);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
    head: { 'lib/a.dart': "void greet(String title) {\n  print(title);\n}\n\nvoid wave(String title) {\n  greet(title);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the parameter and the caller are one chain.', () => {
      assert.equal(chainsOf(review!), 'ripple wave(title) +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 wave, L1 greet\nwave → greet [title]\nuses none, shares none, family 0');
    });
  });
});

describe('Given that same parameter passed on by its caller, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet(String name) {\n  print(name);\n}\n\nvoid wave(String name) {\n  greet(name);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
    head: { 'lib/a.dart': "void greet(String title) {\n  print(title);\n}\n\nvoid wave(String title) {\n  greet(title);\n}\n\nvoid main() {\n  wave('ada');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the chain is named for the parameter the value enters at.', () => {
      assert.equal(((review) => baseOf(review).chains.map((chain) => chain.name).join('\n'))(review!), 'wave(title)');
    });
  });
});

describe('Given a local renamed in one function and a same-named local changed in another, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  var name = 'a';\n  print(name);\n" + '  print(0);\n'.repeat(20) + "  print(name);\n}\n\nvoid main() {\n  var name = 'a';\n  print(name);\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  var title = 'a';\n  print(title);\n" + '  print(0);\n'.repeat(20) + "  print(title);\n}\n\nvoid main() {\n  var name = 'c';\n  print(name);\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the hunks stay standalone.', () => {
      assert.equal(blocksOf(review!), 'lib/a.dart#0 greet +2 -2 standalone\nlib/a.dart#1 greet +1 -1 standalone\nlib/a.dart#2 main +1 -1 standalone');
    });
  });
});

describe('Given a new function whose parameter is passed at the call, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void main() {\n  print(1);\n}\n" },
    head: { 'lib/a.dart': "import 'b.dart';\n\nvoid main() {\n  greet('ada');\n}\n", 'lib/b.dart': "void greet(String name) {\n  print(name);\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the chain is named for the function, not the parameter.', () => {
      assert.equal(chainsOf(review!), 'member greet +6 -1 depth 0\nlib/a.dart#0, lib/a.dart#1, lib/b.dart#0\nL0 greet, L1 main, L2 (top)\nmain → greet [greet name]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a field renamed, including the constructor parameter that sets it, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "class Box {\n  String name;\n  Box(this.name);\n  void show() {\n    print(name);\n  }\n}\n" },
    head: { 'lib/a.dart': "class Box {\n  String title;\n  Box(this.title);\n  void show() {\n    print(title);\n  }\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the field and the constructor are one chain.', () => {
      assert.equal(chainsOf(review!), 'member Box() +3 -3 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 Box.title, L1 Box.show\nBox.show → Box.title [title]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a test that starts calling a function which reaches a changed function, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('waves', () {\n    print(1);\n  });\n}\n",
    },
    head: {
      'lib/a.dart': "void greet() {\n  print('hello');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('waves', () {\n    wave();\n  });\n}\n",
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the test joins the changed function.', () => {
      assert.equal(chainsOf(review!), 'member greet +2 -2 depth 0\nlib/a.dart#0, test/a_test.dart#0\nL0 greet, L1 tests\ntests → greet [greet]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a file named a_test.dart whose test starts calling a function which reaches a changed function, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'lib/a.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'lib/a_test.dart': "import 'a.dart';\n\nvoid main() {\n  test('waves', () {\n    print(1);\n  });\n}\n",
    },
    head: {
      'lib/a.dart': "void greet() {\n  print('hello');\n}\n\nvoid wave() {\n  greet();\n}\n",
      'lib/a_test.dart': "import 'a.dart';\n\nvoid main() {\n  test('waves', () {\n    wave();\n  });\n}\n",
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the test file joins the changed function.', () => {
      assert.equal(chainsOf(review!), 'member greet +2 -2 depth 0\nlib/a.dart#0, lib/a_test.dart#0\nL0 greet, L1 tests\ntests → greet [greet]\nuses none, shares none, family 0');
    });
  });
});

describe('Given the same local renamed in two functions, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void a() {\n  var name = 1;\n}\n\nvoid b() {\n  var name = 1;\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  var title = 1;\n}\n\nvoid b() {\n  var title = 1;\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the rename is a chain.', () => {
      assert.equal(chainsOf(review!), 'group name → title +2 -2 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 a, L1 b\nnone\nuses none, shares none, family 0');
    });
  });
});

describe('Given a parameter renamed and another string in the same function changed, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet(String name) {\n  print(name);\n" + '  print(0);\n'.repeat(20) + "  print('hi');\n}\n\nvoid main() {\n  greet('a');\n}\n" },
    head: { 'lib/a.dart': "void greet(String title) {\n  print(title);\n" + '  print(0);\n'.repeat(20) + "  print('hello');\n}\n\nvoid main() {\n  greet('b');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the string change joins the function\'s chain.', () => {
      assert.equal(chainsOf(review!), 'ripple greet(title) +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1, lib/a.dart#2\nL0 greet, L1 main\nmain → greet [title]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a new file that declares a type whose methods call each other, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': 'void main() {}\n' },
    head: { 'lib/a.dart': 'void main() {}\n', 'lib/box.dart': "class Box {\n  void open() {\n    print(1);\n  }\n\n  void show() {\n    open();\n  }\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the file is one chain named for the type.', () => {
      assert.equal(chainsOf(review!), 'member Box +9 -0 depth 0\nlib/box.dart#0, lib/box.dart#1, lib/box.dart#2\nL0 Box.open, L1 Box.show, L2 Box\nBox.show → Box.open [open]\nuses none, shares none, family 0');
    });
  });
});

describe('Given two overrides of one unchanged method that each gain a parameter, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "class A {\n  void greet() {\n    print('a');\n  }\n}\n\nclass B extends A {\n  void greet() {\n    print('b');\n  }\n}\n\nclass C extends A {\n  void greet() {\n    print('c');\n  }\n}\n" },
    head: { 'lib/a.dart': "class A {\n  void greet() {\n    print('a');\n  }\n}\n\nclass B extends A {\n  void greet(String name) {\n    print(name);\n  }\n}\n\nclass C extends A {\n  void greet(String name) {\n    print(name);\n  }\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the overrides are one chain.', () => {
      assert.equal(chainsOf(review!), 'member overrides A.greet +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 C.greet, L1 B.greet\nB.greet → C.greet [greet]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a method and its override that each gain a parameter, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "class A {\n  void greet() {\n    print('a');\n  }\n}\n\nclass B extends A {\n  void greet() {\n    print('b');\n  }\n}\n" },
    head: { 'lib/a.dart': "class A {\n  void greet(String name) {\n    print(name);\n  }\n}\n\nclass B extends A {\n  void greet(String name) {\n    print(name);\n  }\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the override links to the method.', () => {
      assert.equal(chainsOf(review!), 'member A.greet +4 -4 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 A.greet, L1 B.greet\nB.greet → A.greet [greet]\nuses none, shares none, family 0');
    });
  });
});

describe('Given two toString methods whose results change, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "class A {\n  String toString() => 'a';\n}\n\nclass B {\n  String toString() => 'b';\n}\n" },
    head: { 'lib/a.dart': "class A {\n  String toString() => 'A';\n}\n\nclass B {\n  String toString() => 'B';\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then they are not one chain.', () => {
      assert.equal(chainsOf(review!), 'none');
    });
  });
});

describe('Given a function renamed in the file a new import starts using, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n", 'lib/b.dart': "void main() {\n  print(1);\n}\n" },
    head: { 'lib/a.dart': "void hello() {\n  print('hi');\n}\n", 'lib/b.dart': "import 'a.dart';\n\nvoid main() {\n  hello();\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the import joins that chain.', () => {
      assert.equal(chainsOf(review!), 'member hello +4 -2 depth 0\nlib/a.dart#0, lib/b.dart#0, lib/b.dart#1\nL0 hello, L1 main, L2 (top)\nmain → hello [hello]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a part directive added while the part renames a function its caller uses, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void main() {\n  print(1);\n}\n", 'lib/bit.dart': "void greet() {\n  print('hi');\n}\n\nvoid wave() {\n  greet();\n}\n" },
    head: { 'lib/a.dart': "part 'bit.dart';\n\nvoid main() {\n  print(1);\n}\n", 'lib/bit.dart': "part of 'a.dart';\n\nvoid hello() {\n  print('hi');\n}\n\nvoid wave() {\n  hello();\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the part directive joins the part\'s chain.', () => {
      assert.equal(chainsOf(review!), 'member hello +6 -2 depth 0\nlib/a.dart#0, lib/bit.dart#0, lib/bit.dart#1\nL0 (top), L1 wave, L2 (top)\nwave → (top) [hello]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a declaration\'s signature changed and a string that names it, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greetUser() {\n  print(1);\n}\n\nvoid main() {\n  print('old');\n}\n" },
    head: { 'lib/a.dart': "void greetUser(String name) {\n  print(1);\n}\n\nvoid main() {\n  print('greetUser');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the string links to the declaration.', () => {
      assert.equal(chainsOf(review!), 'member greetUser +2 -2 depth 0\nlib/a.dart#0, lib/a.dart#1\nL0 greetUser, L1 main\nmain → greetUser [greetUser]\nuses none, shares none, family 0');
    });
  });
});

describe('Given a new string introduced by a print and by a constant, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void main() {\n  print('old');\n}\n", 'lib/b.dart': 'void run() {}\n' },
    head: { 'lib/a.dart': "void main() {\n  print('tail_runner_logs');\n}\n", 'lib/b.dart': "void run() {\n  const name = 'tail_runner_logs';\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the two changes are a chain named for the string.', () => {
      assert.equal(chainsOf(review!), 'member “tail_runner_logs” +4 -2 depth 0\nlib/a.dart#0, lib/b.dart#0\nL0 main, L1 run\nrun → main [tail_runner_logs]\nuses none, shares none, family 0');
    });
  });
});

describe('Given the same interpolated string changed in two functions, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void a(String name) {\n  print('hi $name');\n}\n\nvoid b(String name) {\n  print('hi $name');\n}\n" },
    head: { 'lib/a.dart': "void a(String name) {\n  print('hello $name');\n}\n\nvoid b(String name) {\n  print('hello $name');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the string does not become a chain.', () => {
      assert.equal(chainsOf(review!), 'none');
    });
  });
});

describe('Given a Serverpod model that gains a field a generated table reads, ', { skip: skipDart }, () => {
  const files = {
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
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the use links to the model field and the generated file is set aside.', () => {
      assert.equal(((review) => `${chainsOf(review)}\n${generatedOf(review)}`)(review!), 'member User.title +3 -1 depth 0\nlib/app.dart#0, lib/user.spy.yaml#0\nL0 (top), L1 main\nmain → (top) [title]\nuses none, shares none, family 0\nlib/generated/user.dart');
    });
  });
});

describe('Given one string changed in one function, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  print('hello');\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the change is listed on its own.', () => {
      assert.equal(blocksOf(review!), 'lib/a.dart#0 greet +1 -1 standalone');
    });
  });
});

describe('Given the same identifier renamed in three functions, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void a() {\n  var name = 1;\n}\n\nvoid b() {\n  var name = 1;\n}\n\nvoid c() {\n  var name = 1;\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  var title = 1;\n}\n\nvoid b() {\n  var title = 1;\n}\n\nvoid c() {\n  var title = 1;\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the graph is one node.', () => {
      assert.equal(chainsOf(review!), 'group name → title +3 -3 depth 0\nlib/a.dart#0, lib/a.dart#1, lib/a.dart#2\nL0 a\nnone\nuses none, shares none, family 0');
    });
  });
});

describe('Given two tests that both start calling one changed function, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void greet() {\n  print('hi');\n}\n", 'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('one', () {\n    print(1);\n  });\n  test('two', () {\n    print(2);\n  });\n}\n" },
    head: { 'lib/a.dart': "void greet() {\n  print('hello');\n}\n", 'test/a_test.dart': "import 'package:sample/a.dart';\n\nvoid main() {\n  test('one', () {\n    greet();\n  });\n  test('two', () {\n    greet();\n  });\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the tests are one node.', () => {
      assert.equal(chainsOf(review!), 'member greet +3 -3 depth 0\nlib/a.dart#0, test/a_test.dart#0, test/a_test.dart#1\nL0 greet, L1 tests\ntests → greet [greet]\nuses none, shares none, family 0');
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

    it('then the two replacements are one group.', () => {
      assert.equal(groupsOf(review!), "x2 'hello' → 'hi'");
    });
  });
});

describe('Given the same doc comment edited on two functions, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "/// Hello there friend.\nvoid a() {}\n\n/// Hello there friend.\nvoid b() {}\n" },
    head: { 'lib/a.dart': "/// Goodbye there friend.\nvoid a() {}\n\n/// Goodbye there friend.\nvoid b() {}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the repeated comment is one group.', () => {
      assert.equal(groupsOf(review!), 'x2 /// Hello there friend. → /// Goodbye there friend.');
    });
  });
});

describe('Given five words changed in one doc comment, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': '/// alpha one two three four five omega.\nvoid greet() {}\n' },
    head: { 'lib/a.dart': '/// alpha six seven eight nine ten omega.\nvoid greet() {}\n' },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the line is one edit.', () => {
      assert.equal(editsOf(review!), 'replace documentation_comment /// alpha one two three four five omega. → /// alpha six seven eight nine ten omega.');
    });
  });
});

describe('Given report gains a parameter while it starts mentioning price, and checkout starts passing price a new parameter, ', { skip: skipDart }, () => {
  const files = {
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
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then report uses price, price sits one level deeper, and they are one family.', () => {
      assert.equal(chainsOf(review!), [
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
  ].join('\n'));
    });
  });
});

describe('Given the same bang inserted in two calls, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "void a() {\n  print('hi');\n}\n\nvoid b() {\n  print('hi');\n}\n" },
    head: { 'lib/a.dart': "void a() {\n  print('hi')!;\n}\n\nvoid b() {\n  print('hi')!;\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the punctuation is not a group.', () => {
      assert.equal(groupsOf(review!), 'none');
    });
  });
});

describe('Given a call whose argument changes many lines below the function name, ', { skip: skipDart }, () => {
  const call = ['  greet(', "    'a',", "    'b',", "    'c',", "    'd',", "    'e',", "    'f',", "    'g',", "    'h',", "    'i',", "    'j',", "    'k',", '  );'].join('\n');
  const files = {
    base: { 'lib/a.dart': `void main() {\n${call}\n}\n\nvoid greet(String a, String b, String c, String d, String e, String f, String g, String h, String i, String j, String k) {}\n` },
    head: { 'lib/a.dart': `void main() {\n${call.replace("'k'", "'kept'")}\n}\n\nvoid greet(String a, String b, String c, String d, String e, String f, String g, String h, String i, String j, String kept) {}\n` },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the call joins the parameter it passes.', () => {
      assert.equal(chainsOf(review!), [
        'ripple greet(kept) +2 -2 depth 0',
        'lib/a.dart#0, lib/a.dart#1',
        'L0 greet, L1 main',
        'main → greet [kept]',
        'uses none, shares none, family 0',
      ].join('\n'));
    });
  });
});

describe('Given a constructor call whose positional argument changes, ', { skip: skipDart }, () => {
  const files = {
    base: { 'lib/a.dart': "class Box {\n  const Box(this.value);\n  final String value;\n}\n\nvoid main() {\n  const box = const Box('a');\n  print(box);\n}\n" },
    head: { 'lib/a.dart': "class Box {\n  const Box(this.title);\n  final String title;\n}\n\nvoid main() {\n  const box = const Box('b');\n  print(box);\n}\n" },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the call joins the constructor parameter.', () => {
      assert.equal(chainsOf(review!), [
        'ripple Box(title) +3 -3 depth 0',
        'lib/a.dart#0, lib/a.dart#1',
        'L0 Box.Box, L1 main',
        'main → Box.Box [title]',
        'uses none, shares none, family 0',
      ].join('\n'));
    });
  });
});

describe('Given a protobuf message, its generated getter and a use of that getter, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'proto/user.proto': 'syntax = "proto3";\nmessage User {\n  string display_name = 1;\n}\n',
      'lib/user.pb.dart': 'class User {\n  String get displayName => \'\';\n}\n',
      'lib/app.dart': "import 'user.pb.dart';\n\nvoid main() {\n  print(User().displayName);\n}\n",
    },
    head: {
      'proto/user.proto': 'syntax = "proto3";\nmessage User {\n  string display_name = 1;\n  string given_name = 2;\n}\n',
      'lib/user.pb.dart': 'class User {\n  String get displayName => \'\';\n  String get givenName => \'\';\n}\n',
      'lib/app.dart': "import 'user.pb.dart';\n\nvoid main() {\n  print(User().givenName);\n}\n",
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the getter maps to the protobuf field.', () => {
      assert.equal(chainsOf(review!), [
        'member User.given_name +2 -1 depth 0',
        'lib/app.dart#0, proto/user.proto#0',
        'L0 (top), L1 main',
        'main → (top) [given_name]',
        'uses none, shares none, family 0',
      ].join('\n'));
    });
  });
});

describe('Given a part file whose generated constructor changes with the library field, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'lib/user.dart': "class User {\n  User({this.name});\n  final String? name;\n  factory User.fromJson(Map json) => _$UserFromJson(json);\n}\npart 'user.g.dart';\n",
      'lib/user.g.dart': "part of 'user.dart';\n\nUser _$UserFromJson(Map json) => User(name: json['name'] as String);\n",
    },
    head: {
      'lib/user.dart': "class User {\n  User({this.name, this.title});\n  final String? name;\n  final String? title;\n  factory User.fromJson(Map json) => _$UserFromJson(json);\n}\npart 'user.g.dart';\n",
      'lib/user.g.dart': "part of 'user.dart';\n\nUser _$UserFromJson(Map json) => User(name: json['name'] as String, title: json['title'] as String);\n",
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the generated part is set aside and the field stays on the constructor.', () => {
      assert.equal(`${chainsOf(review!)}\n${generatedOf(review!)}`, [
        'member User() +2 -1 depth 0',
        'lib/user.dart#0, lib/user.dart#1',
        'L0 User.title, L1 User.User',
        'User.User → User.title [title]',
        'uses none, shares none, family 0',
        'lib/user.g.dart',
      ].join('\n'));
    });
  });
});

describe('Given a Serverpod model whose doc comment changes above a field, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'lib/user.spy.yaml': 'class: User\nfields:\n  name: String\n  title: String\n',
      'lib/generated/user.dart': 'class UserTable {\n  String name = \'\';\n  String title = \'\';\n}\n',
      'lib/app.dart': "import 'generated/user.dart';\n\nvoid main() {\n  print(1);\n}\n",
    },
    head: {
      'lib/user.spy.yaml': 'class: User\nfields:\n  name: String\n  ## The heading.\n  title: String\n',
      'lib/generated/user.dart': 'class UserTable {\n  String name = \'\';\n  String title = \'\';\n}\n',
      'lib/app.dart': "import 'generated/user.dart';\n\nvoid main() {\n  final table = UserTable();\n  print(table.title);\n}\n",
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the comment belongs to the field below it.', () => {
      assert.equal(chainsOf(review!), [
        'member User.title +3 -1 depth 0',
        'lib/app.dart#0, lib/user.spy.yaml#0',
        'L0 (top), L1 main',
        'main → (top) [title]',
        'uses none, shares none, family 0',
      ].join('\n'));
    });
  });
});

describe('Given a Markdown change that names a changed member in backticks, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'lib/a.dart': "void greet() {\n  print('hi');\n}\n",
      'README.md': 'See greet.\n',
    },
    head: {
      'lib/a.dart': "void greetName() {\n  print('hi');\n}\n",
      'README.md': 'See `greetName`.\n',
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the note joins that member\'s chain.', () => {
      assert.equal(`${chainsOf(review!)}\n${blocksOf(review!)}`, [
        'member greetName +2 -2 depth 0',
        'README.md#0, lib/a.dart#0',
        'L0 greetName, L1 (top)',
        '(top) → greetName [greetName]',
        'uses none, shares none, family 0',
        'README.md#0 (top) +1 -1',
        'lib/a.dart#0 greetName +1 -1',
      ].join('\n'));
    });
  });
});

describe('Given a generated part whose new field a caller reads, ', { skip: skipDart }, () => {
  const files = {
    base: {
      'lib/user.dart': "part 'user.g.dart';\n\nabstract class User with _\$User {\n  const factory User({required String name}) = _User;\n}\n",
      'lib/user.g.dart': "part of 'user.dart';\n\nmixin _\$User {\n  String get name;\n}\n\nclass _User implements User {\n  const _User({required this.name});\n  @override\n  final String name;\n}\n",
      'lib/main.dart': "import 'user.dart';\n\nconst user = User(name: 'a');\n\nvoid main() {\n  print(user.name);\n}\n",
    },
    head: {
      'lib/user.dart': "part 'user.g.dart';\n\nabstract class User with _\$User {\n  const factory User({required String name, String? title}) = _User;\n}\n",
      'lib/user.g.dart': "part of 'user.dart';\n\nmixin _\$User {\n  String get name;\n  String? get title;\n}\n\nclass _User implements User {\n  const _User({required this.name, this.title});\n  @override\n  final String name;\n  @override\n  final String? title;\n}\n",
      'lib/main.dart': "import 'user.dart';\n\nconst user = User(name: 'a');\n\nvoid main() {\n  print(user.title);\n}\n",
    },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the caller joins the factory parameter and the part is set aside.', () => {
      assert.equal(`${chainsOf(review!)}\n${generatedOf(review!)}`, [
        'ripple User(title) +2 -2 depth 0',
        'lib/main.dart#0, lib/user.dart#0',
        'L0 User.User, L1 main',
        'main → User.User [title]',
        'uses none, shares none, family 0',
        'lib/user.g.dart',
      ].join('\n'));
    });
  });
});

describe('Given a const constructor call whose second argument changes below the name, ', { skip: skipDart }, () => {
  const call = ['  const Point(', '    1,', '    2,', '  );'].join('\n');
  const changed = ['  const Point(', '    1,', '    3,', '  );'].join('\n');
  const files = {
    base: { 'lib/a.dart': `class Point {\n  const Point(this.x, this.y);\n  final int x;\n  final int y;\n}\n\nvoid main() {\n${call}\n}\n` },
    head: { 'lib/a.dart': `class Point {\n  const Point(this.x, this.title);\n  final int x;\n  final int title;\n}\n\nvoid main() {\n${changed}\n}\n` },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the call joins that parameter.', () => {
      assert.equal(chainsOf(review!), [
        'ripple Point() +3 -3 depth 0',
        'lib/a.dart#0, lib/a.dart#1, lib/a.dart#2',
        'L0 Point.Point, L1 Point.title, L1 main',
        'Point.Point → Point.title [title], main → Point.Point [title]',
        'uses none, shares none, family 0',
      ].join('\n'));
    });
  });
});

describe('Given a new class nothing uses, whose methods call each other in two pairs, ', { skip: skipDart }, () => {
  const box = 'class Box {\n  int width() => _w();\n\n  int _w() => 1;\n\n  int height() => _h();\n\n  int _h() => 2;\n}\n';
  const files = {
    base: { 'lib/a.dart': 'void main() {}\n' },
    head: { 'lib/a.dart': `void main() {}\n\n${box}` },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the class and its methods are one chain, named after it.', () => {
      assert.equal(chainsOf(review!), [
        'member Box +9 -0 depth 0',
        'lib/a.dart#1, lib/a.dart#2, lib/a.dart#3, lib/a.dart#4, lib/a.dart#5',
        'L0 Box._w, L1 Box.width, L2 Box, L2 Box._h, L2 Box.height',
        'Box.width → Box._w [_w], Box.height → Box._h [_h]',
        'uses none, shares none, family 0',
      ].join('\n'));
    });
  });
});

describe('Given a removed class whose methods called each other in two pairs, ', { skip: skipDart }, () => {
  const box = 'class Box {\n  int width() => _w();\n\n  int _w() => 1;\n\n  int height() => _h();\n\n  int _h() => 2;\n}\n';
  const files = {
    base: { 'lib/a.dart': `void main() {}\n\n${box}` },
    head: { 'lib/a.dart': 'void main() {}\n' },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the class and its methods are one chain, named after it with a minus.', () => {
      assert.equal(chainsOf(review!), [
        'member − Box +0 -9 depth 0',
        'lib/a.dart#1, lib/a.dart#2, lib/a.dart#3, lib/a.dart#4, lib/a.dart#5',
        'L0 Box._w, L1 Box.width, L2 Box, L2 Box._h, L2 Box.height',
        'Box.width → Box._w [_w], Box.height → Box._h [_h]',
        'uses none, shares none, family 0',
      ].join('\n'));
    });
  });
});
