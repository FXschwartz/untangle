import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { buildDartReview, type BuiltReview } from '../helpers/review.ts';

const skip = has('dart') ? false : 'dart is not on PATH';

describe('Given a new reader with a dedicated decoder, recursive helpers, and a shared utility, ', { skip }, () => {
  const base = {
    'lib/existing.dart': 'void main() {}\n',
    'test/support.dart': 'void test(String name, void Function() body) {}\n',
  };
  const head = {
    'lib/reader.dart': `import 'decoder.dart';
import 'shared.dart';

class Reader {
  int read(String value) => Decoder().decode(value) + shared(value);
}
`,
    'lib/decoder.dart': `class Decoder {
  int decode(String value) => _first(value);
}

int _first(String value) => value.isEmpty ? 0 : _second(value);

int _second(String value) => value.length == 1 ? 1 : _first(value.substring(1));
`,
    'lib/shared.dart': 'int shared(String value) => value.length;\n',
    'lib/other.dart': `import 'shared.dart';

class Other {
  int read(String value) => shared(value);
}
`,
    'test/reader_test.dart': `import '../lib/reader.dart';
import 'support.dart';

void main() {
  test('A reader decodes text', () {
    print(Reader().read('abc'));
  });
}
`,
  };

  describe('when the connected implementation is reviewed, ', () => {
    let review: BuiltReview;
    let model: any;
    let chain: any;

    before(async () => {
      review = await buildDartReview({ base, head });
      model = review.data.model.compares.base;
      chain = model.chains.find((candidate: any) => candidate.name === 'Reader');
    });

    after(() => review?.remove());

    it('then the cross-file dependency and recursive helpers form one connected chain of whole units.', () => {
      assert.ok(chain);
      assert.deepEqual(new Set(chain.graph.nodes.map((node: any) => node.member)), new Set([
        'Reader', 'Decoder', '_first', '_second', 'A reader decodes text',
      ]));
      assert.equal(chain.files, 3);
      for (const node of chain.graph.nodes) {
        const unit = model.units.find((candidate: any) => candidate.id === node.unit);
        assert.deepEqual(new Set(node.blocks), new Set(unit.blocks));
        assert.ok(chain.graph.edges.some((edge: any) => edge.from === node.key || edge.to === node.key));
      }
    });

    it('then the shared utility does not pull the unrelated consumer into that chain.', () => {
      const outside = model.units.filter((unit: any) => unit.name === 'Other' || unit.name === 'shared');

      assert.equal(outside.length, 2);
      assert.ok(outside.every((unit: any) => unit.blocks.every((id: string) => !chain.blocks.includes(id))));
      assert.equal(model.chains.length, 1);
    });
  });
});

describe('Given connected new declarations contained in one file, ', { skip }, () => {
  describe('when the review is built, ', () => {
    let review: BuiltReview;
    let model: any;

    before(async () => {
      review = await buildDartReview({
        base: { 'lib/existing.dart': 'void main() {}\n' },
        head: {
          'lib/local.dart': `class Local {
  int value() => LocalHelper().value();
}

class LocalHelper {
  int value() => 1;
}
`,
        },
      });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then both declarations remain whole in the file review without a file-local chain.', () => {
      assert.deepEqual(model.units.map((unit: any) => unit.name), ['Local', 'LocalHelper']);
      assert.equal(model.chains.length, 0);
      const blocks = model.files.find((file: any) => file.p === 'lib/local.dart').blocks;
      assert.ok(blocks.every((block: any) => block.unit));
    });
  });
});

describe('Given two new scenarios that use the same new API, ', { skip }, () => {
  describe('when the review is built, ', () => {
    let review: BuiltReview;
    let model: any;

    before(async () => {
      review = await buildDartReview({
        base: { 'test/support.dart': 'void test(String name, void Function() body) {}\n' },
        head: {
          'lib/source.dart': 'class Source {\n  int read() => 1;\n}\n',
          'test/source_test.dart': `import '../lib/source.dart';
import 'support.dart';

void main() {
  test('Read once', () {
    print(Source().read());
  });

  test('Read again', () {
    print(Source().read());
  });
}
`,
        },
      });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then shared use of the new API does not manufacture a change-propagation chain.', () => {
      assert.equal(model.chains.length, 0);
      assert.deepEqual(model.units.filter((unit: any) => unit.kind === 'test').map((unit: any) => unit.name), ['Read once', 'Read again']);
      assert.ok(model.units.some((unit: any) => unit.name === 'Source'));
    });
  });
});

describe('Given two new classes using a shared helper and an existing class gaining a new sibling, ', { skip }, () => {
  const base = {
    'lib/existing.dart': 'class Existing {\n  int value() => 1;\n}\n',
  };
  const head = {
    'lib/existing.dart': `class Existing {
  int value() => 2;
}

/// A complete new declaration in an existing file.
class Draft {
  Draft(this.amount);

  final int amount;

  int total() => amount * 2;
}
`,
    'lib/shared.dart': 'int money(int value) => value * 100;\n',
    'lib/orders.dart': `import 'shared.dart';

class Order {
  Order(this.amount);

  final int amount;

  int total() => money(amount);
}

class Refund {
  Refund(this.amount);

  final int amount;

  int total() => money(-amount);
}
`,
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview;
    let model: any;

    before(async () => {
      review = await buildDartReview({ base, head });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then the new order is one complete reading unit without a singleton chain.', () => {
      const unit = model.units.find((u: any) => u.name === 'Order');
      const file = model.files.find((f: any) => f.p === 'lib/orders.dart');
      const members = file.blocks.filter((b: any) => b.unit === unit.id).map((b: any) => b.member);

      assert.deepEqual(members, ['Order', 'Order.Order', 'Order.amount', 'Order.total']);
      assert.equal(model.chains.some((chain: any) => chain.blocks.some((id: string) => unit.blocks.includes(id))), false);
    });

    it('then sharing a file and utility does not create a chain between independent consumers.', () => {
      const order = model.units.find((unit: any) => unit.name === 'Order');
      const refund = model.units.find((unit: any) => unit.name === 'Refund');
      const money = model.units.find((unit: any) => unit.name === 'money');

      assert.equal(order.blocks.some((id: string) => refund.blocks.includes(id)), false);
      assert.equal(order.blocks.some((id: string) => money.blocks.includes(id)), false);
      assert.equal(model.chains.length, 0);
    });

    it('then the draft stays whole without absorbing the existing class edit.', () => {
      const unit = model.units.find((u: any) => u.name === 'Draft');
      const file = model.files.find((f: any) => f.p === 'lib/existing.dart');
      const existing = file.blocks.find((b: any) => b.member === 'Existing.value');

      assert.equal(unit.start, 5);
      assert.equal(unit.blocks.length, 4);
      assert.equal(existing.unit, undefined);
    });
  });
});

describe('Given unrelated libraries whose existing private helpers have the same name, ', { skip }, () => {
  const base = {
    'lib/a.dart': 'int _money() => 1;\n\nint first() => _money();\n',
    'lib/b.dart': 'int _money() => 2;\n\nint second() => _money();\n',
  };
  const head = {
    'lib/a.dart': 'int _money(int amount) => amount;\n\nint first() => _money(10);\n',
    'lib/b.dart': 'int _money(String text) => int.parse(text);\n\nint second() => _money("20");\n',
  };

  describe('when both signatures and their callers change, ', () => {
    let review: BuiltReview;
    let chains: any[];

    before(async () => {
      review = await buildDartReview({ base, head });
      chains = review.data.model.compares.base.chains;
    });

    after(() => review?.remove());

    it('then neither helper chain contains changes from the other library.', () => {
      assert.equal(chains.length, 2);
      assert.deepEqual(chains.map((chain) => new Set(chain.blocks.map((id: string) => id.split('#')[0]))), [new Set(['lib/a.dart']), new Set(['lib/b.dart'])]);
    });
  });
});

describe('Given adjacent new classes and an existing function whose entire implementation is replaced, ', { skip }, () => {
  describe('when the review is built, ', () => {
    let review: BuiltReview;
    let model: any;

    before(async () => {
      review = await buildDartReview({
        base: { 'lib/compute.dart': 'int compute(int value) {\n  return value;\n}\n' },
        head: {
          'lib/compute.dart': 'String compute(String text) {\n  final result = text.trim();\n\n  return result.toUpperCase();\n}\n',
          'lib/pair.dart': 'class First {\n  int value() => 1;\n}\nclass Second {\n  int value() => 2;\n}\n',
          'lib/extensions.dart': 'extension<T> on T {\n  R let<R>(R Function(T value) transform) => transform(this);\n}\n\ntypedef Handler = void Function(int value);\n',
        },
      });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then the adjacent classes stay complete even when they share one atomic block.', () => {
      const units = model.units.filter((unit: any) => unit.file === 'lib/pair.dart');
      const blocks = model.files.find((file: any) => file.p === 'lib/pair.dart').blocks;

      assert.equal(units.length, 1);
      assert.equal(units[0].name, 'First, Second');
      assert.equal(units[0].start, 1);
      assert.equal(units[0].end, 6);
      assert.ok(blocks.every((block: any) => block.unit === units[0].id));
    });

    it('then rewriting the existing function does not classify it as an introduced declaration.', () => {
      assert.equal(model.units.some((unit: any) => unit.file === 'lib/compute.dart'), false);
    });

    it('then the unnamed extension includes its declaration and the type alias is independently reviewable.', () => {
      const units = model.units.filter((unit: any) => unit.file === 'lib/extensions.dart');
      const blocks = model.files.find((file: any) => file.p === 'lib/extensions.dart').blocks;

      assert.deepEqual(units.map((unit: any) => unit.name), ['extension<T> on T', 'Handler']);
      assert.ok(blocks.every((block: any) => units.some((unit: any) => unit.blocks.includes(block.id))));
    });
  });
});

describe('Given new widget scenarios with the same first title literal and a shared fixture, ', { skip }, () => {
  const base = { 'lib/value.dart': 'int value() => 1;\n' };
  const head = {
    'lib/value.dart': 'int value() => 2;\n',
    'test/value_test.dart': `import '../lib/value.dart';

void testWidgets(String name, void Function(Object) body) {}

void group(String name, void Function() body) {}

class Fixture {
  int read() => value();
}

void main() {
  final fixture = Fixture();

  group('Shared context', () {
    testWidgets('Given a value, ' 'when doubled, ' 'then it is four.', (tester) {
      print(fixture.read() * 2);
    });

    testWidgets('Given a value, ' 'when tripled, ' 'then it is six.', (tester) {
      print(fixture.read() * 3);
    });
  });
}
`,
  };

  describe('when the scenarios are analyzed, ', () => {
    let review: BuiltReview;
    let model: any;

    before(async () => {
      review = await buildDartReview({ base, head });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then both complete titles and distinct scenario identities survive.', () => {
      const tests = model.units.filter((u: any) => u.kind === 'test');
      assert.deepEqual(tests.map((u: any) => u.name), [
        'Given a value, when doubled, then it is four.',
        'Given a value, when tripled, then it is six.',
      ]);
      assert.notEqual(tests[0].id, tests[1].id);
    });

    it('then the shared fixture remains a reading unit instead of owning its consumers.', () => {
      const fixture = model.units.find((u: any) => u.name === 'Fixture');

      assert.ok(fixture);
      assert.equal(model.chains.some((chain: any) => chain.blocks.some((id: string) => fixture.blocks.includes(id))), false);
      assert.equal(model.chains.some((chain: any) => chain.name === 'value_test.dart'), false);
    });
  });
});

describe('Given a custom generator mapping and a new model with two fields, ', { skip }, () => {
  describe('when the model is added, ', () => {
    let review: BuiltReview;
    let model: any;

    before(async () => {
      review = await buildDartReview({
        base: {
          '.review.yaml': 'models:\n  - name: example\n    kind: yaml\n    source: [models/*.yaml]\n    generated: [lib/generated/*.dart]\n',
          'lib/existing.dart': 'void main() {}\n',
        },
        head: { 'models/invoice.yaml': 'class: Invoice\nfields:\n  amount: int\n\n  label: String\n' },
      });
      model = review.data.model.compares.base;
    });

    after(() => review?.remove());

    it('then the configured model is one complete reading unit.', () => {
      const unit = model.units.find((unit: any) => unit.name === 'Invoice');
      const blocks = model.files.find((file: any) => file.p === 'models/invoice.yaml').blocks;

      assert.equal(unit.kind, 'model');
      assert.deepEqual(new Set(unit.blocks), new Set(blocks.map((block: any) => block.id)));
    });
  });
});
