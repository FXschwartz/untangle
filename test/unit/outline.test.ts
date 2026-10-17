import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { has } from '../../dist/exec.js';
import { buildDartReview, type BuiltReview } from '../helpers/review.ts';

const skipDart = has('dart') ? false : 'dart is not on PATH';

interface Call { k: string; t: string; p?: number; l?: number; st?: string; ot?: string; was?: string; own?: Array<[number, number, number]>; x?: number; su?: number }
interface Gone { k: string; t: string; p?: number; leaves: string[] }
interface Outline { nodes: Call[]; removed?: Gone[]; out?: number[] }
interface Hunk { o: number; n: number; rows: Array<[string, string]> }
interface Block { hunk: number; first: number; len: number }
interface Model { compares: { base: { files: Array<{ p: string; outline?: Outline; hunks: Hunk[]; blocks: Block[] }> } } }

const KIND: Record<string, string> = { g: 'group', t: 'test', w: 'wrapper' };

/** A file's outline, one call per line, nested: kind, title, status, a test's expect calls or a group's setUp, and what changed in its own lines. */
function outlineOf(review: BuiltReview, file: string): string {
  const outline = (review.data.model as Model).compares.base.files.find((f) => f.p === file)?.outline;
  if (!outline) return 'no outline';
  const depth = (call: Call): number => (call.p == null ? 0 : depth(outline.nodes[call.p]) + 1);
  const lines = outline.nodes.map((call) => {
    const own = (call.own || []).reduce((sum, [, adds, dels]) => [sum[0] + adds, sum[1] + dels], [0, 0]);
    const asserts = call.k === 't' ? `${call.x} expect${call.x === 1 ? '' : 's'}` : call.su ? 'setUp' : '';
    const notes = [call.l ? 'label' : '', call.st || '', asserts, call.ot ? `was “${call.ot}”` : '', call.was ? `read “${call.was}”` : '', own[0] || own[1] ? `own +${own[0]} −${own[1]}` : ''].filter(Boolean);
    return `${'  '.repeat(depth(call))}${KIND[call.k]} ${call.t} · ${notes.join(' · ')}`;
  });
  for (const gone of outline.removed || []) lines.push(`removed ${KIND[gone.k]} ${gone.t} · under ${gone.p == null ? 'the file' : outline.nodes[gone.p].t} · held “${gone.leaves.join('” “')}”`);
  return lines.join('\n');
}

/** A file's change blocks, one per line: each of its rows as its sign and line, a blank row marked. */
function blocksOf(review: BuiltReview, file: string): string {
  const found = (review.data.model as Model).compares.base.files.find((f) => f.p === file);
  if (!found) return 'no file';
  return found.blocks.map((block) => {
    const hunk = found.hunks[block.hunk];
    let old = hunk.o, now = hunk.n;
    const rows = hunk.rows.map(([sign, text]) => {
      const row = `${sign}${sign === '-' ? old : now}${text.trim() ? '' : ' (blank)'}`;
      if (sign !== '+') old++;
      if (sign !== '-') now++;
      return row;
    });
    return rows.slice(block.first, block.first + block.len).join(' ');
  }).join('\n');
}

const inbox = (thens: string) => `void main() {
  group('Given a signed-in user,', () {
    group('when they open the inbox,', () {
      test('then the unread count shows.', () {
        expect(1, 1);
      });
${thens}    });
  });
}
`;

describe('Given a test file whose Given and when groups gain a then, ', { skip: skipDart }, () => {
  const files = {
    base: { 'test/inbox_test.dart': inbox('') },
    head: { 'test/inbox_test.dart': inbox(`
      test('then the newest message is first.', () {
        expect(2, 2);
      });
`) },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the outline keeps the Given and the when as they were and marks the then new, with its body as its own lines.', () => {
      assert.equal(outlineOf(review!, 'test/inbox_test.dart'), [
        'group Given a signed-in user, · same',
        '  group when they open the inbox, · same',
        '    test then the unread count shows. · same · 1 expect',
        '    test then the newest message is first. · new · 1 expect · own +1 −0',
      ].join('\n'));
    });
  });
});

describe('Given two thens added under an existing when, each after a blank line, ', { skip: skipDart }, () => {
  const files = {
    base: { 'test/inbox_test.dart': inbox('') },
    head: { 'test/inbox_test.dart': inbox(`
      test('then the newest message is first.', () {
        expect(2, 2);
      });

      test('then the oldest message is last.', () {
        expect(3, 3);
      });
`) },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then each blank line goes with a then, and none is a change of its own.', () => {
      assert.equal(blocksOf(review!, 'test/inbox_test.dart'), [
        '+7 (blank) +8 +9 +10 +11 (blank)',
        '+12 +13 +14',
      ].join('\n'));
    });
  });
});

describe('Given a renamed Given over a test that did not change, ', { skip: skipDart }, () => {
  const file = (given: string) => `void main() {
  group('${given}', () {
    test('when they sign in, then a session starts.', () {
      expect(1, 1);
    });
  });
}
`;
  const files = {
    base: { 'test/session_test.dart': file('Given a visitor,') },
    head: { 'test/session_test.dart': file('Given a guest with an invitation,') },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the untouched test is reworded through its Given, with the sentence it read before.', () => {
      assert.equal(outlineOf(review!, 'test/session_test.dart'), [
        'group Given a guest with an invitation, · renamed · was “Given a visitor,”',
        '  test when they sign in, then a session starts. · reworded · 1 expect · read “Given a visitor, when they sign in, then a session starts.”',
      ].join('\n'));
    });
  });
});

describe('Given a group whose title held the when, split into a Given and a when, ', { skip: skipDart }, () => {
  const files = {
    base: { 'test/store_test.dart': `void main() {
  group('Given an empty store, when a row is inserted, ', () {
    test('then the row is stored.', () {
      expect(1, 1);
    });

    test('then the count is one.', () {
      expect(1, 1);
    });
  });
}
` },
    head: { 'test/store_test.dart': `void main() {
  group('Given an empty store,', () {
    group('when a row is inserted,', () {
      test('then the row is stored.', () {
        expect(1, 1);
      });

      test('then the count is one.', () {
        expect(1, 1);
      });
    });
  });
}
` },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then its tests read the same sentences in new groups, so they are regrouped rather than new.', () => {
      assert.equal(outlineOf(review!, 'test/store_test.dart'), [
        'group Given an empty store, · renamed · was “Given an empty store, when a row is inserted, ”',
        '  group when a row is inserted, · new',
        '    test then the row is stored. · regrouped · 1 expect · read “Given an empty store, when a row is inserted, then the row is stored.” · own +1 −1',
        '    test then the count is one. · regrouped · 1 expect · read “Given an empty store, when a row is inserted, then the count is one.” · own +1 −1',
      ].join('\n'));
    });
  });
});

describe('Given a Given removed with the test it held, ', { skip: skipDart }, () => {
  const kept = `  group('Given a clock,', () {
    test('when it ticks, then it advances.', () {
      expect(1, 1);
    });
  });
`;
  const files = {
    base: { 'test/clock_test.dart': `void main() {
${kept}
  group('Given a stopped clock,', () {
    test('when it ticks, then it stays.', () {
      expect(1, 1);
    });
  });
}
` },
    head: { 'test/clock_test.dart': `void main() {
${kept}}
` },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the outline lists it as removed, under the file, with the sentence it held.', () => {
      assert.equal(outlineOf(review!, 'test/clock_test.dart'), [
        'group Given a clock, · same',
        '  test when it ticks, then it advances. · same · 1 expect',
        'removed group Given a stopped clock, · under the file · held “Given a stopped clock, when it ticks, then it stays.”',
      ].join('\n'));
    });
  });
});

describe('Given a wrapper with a bracketed label around a Given whose test is renamed, ', { skip: skipDart }, () => {
  const file = (then: string) => `void main() {
  withServerpod('[Clocks]', (sessionBuilder, endpoints) {
    group('Given a server clock,', () {
      test('${then}', () {
        expect(1, 1);
      });
    });
  });
}
`;
  const files = {
    base: { 'test/server_clock_test.dart': file('when it ticks, then it advances.') },
    head: { 'test/server_clock_test.dart': file('when it ticks, then it advances by one.') },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the wrapper is a label that heads its tests and stays out of their sentences.', () => {
      assert.equal(outlineOf(review!, 'test/server_clock_test.dart'), [
        'wrapper [Clocks] · label · same',
        '  group Given a server clock, · same',
        '    test when it ticks, then it advances by one. · reworded · 1 expect · was “when it ticks, then it advances.” · read “Given a server clock, when it ticks, then it advances.”',
      ].join('\n'));
    });
  });
});

describe('Given a when whose setup changes and a helper changed outside every test, ', { skip: skipDart }, () => {
  const file = (count: number, helper: string) => `int total(int n) => ${helper};

void main() {
  group('Given a cart,', () {
    group('when an item is added,', () {
      late int count;

      setUp(() {
        count = ${count};
      });

      test('then the count grows.', () {
        expect(count, ${count});
      });
    });
  });
}
`;
  const files = {
    base: { 'test/cart_test.dart': file(1, 'n') },
    head: { 'test/cart_test.dart': file(2, 'n + 1') },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;
    let outside = '';

    before(async () => {
      review = await buildDartReview(files);
      const outline = (review.data.model as Model).compares.base.files.find((f) => f.p === 'test/cart_test.dart')?.outline;
      outside = JSON.stringify(outline?.out ?? []);
    });

    after(() => review?.remove());

    it('then the setup change is the when\'s own, the when sets up, and the test\'s own lines hold only its expectation.', () => {
      assert.equal(outlineOf(review!, 'test/cart_test.dart'), [
        'group Given a cart, · same',
        '  group when an item is added, · same · setUp · own +1 −1',
        '    test then the count grows. · same · 1 expect · own +1 −1',
      ].join('\n'));
    });

    it('then the helper\'s change is listed as outside the tests.', () => {
      assert.equal(outside, '[0]');
    });
  });
});

describe('Given a Given that sets up a ledger, gaining a when whose then asserts twice, ', { skip: skipDart }, () => {
  const file = (when: string) => `void main() {
  group('Given a ledger,', () {
    late List<int> rows;

    setUpAll(() {
      rows = [];
    });

    test('then it has no rows.', () {
      expect(rows, isEmpty);
    });
${when}  });
}
`;
  const files = {
    base: { 'test/ledger_test.dart': file('') },
    head: { 'test/ledger_test.dart': file(`
    group('when nothing is added,', () {
      test('then it stays empty and sums to zero.', () {
        expect(rows, isEmpty);
        // expect(rows.length, 1);
        expect(rows.fold(0, (a, b) => a + b), 0);
      });
    });
`) },
  };

  describe('when the review is built, ', () => {
    let review: BuiltReview | undefined;

    before(async () => {
      review = await buildDartReview(files);
    });

    after(() => review?.remove());

    it('then the Given sets up, the new when doesn\'t, and the then counts its two expect calls but not the commented one.', () => {
      assert.equal(outlineOf(review!, 'test/ledger_test.dart'), [
        'group Given a ledger, · same · setUp',
        '  test then it has no rows. · same · 1 expect',
        '  group when nothing is added, · new',
        '    test then it stays empty and sums to zero. · new · 2 expects · own +3 −0',
      ].join('\n'));
    });
  });
});
