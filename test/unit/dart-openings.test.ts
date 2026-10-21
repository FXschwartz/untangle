import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dartOpenings } from '../../analysis/dart.js';

/** Each line with what it starts inside, as text: "3 '''" is line 3 inside a ''' string. */
const shown = (lines: string[]) => dartOpenings(lines.join('\n')).map((open, i) => `${i + 1} ${open || 'code'}`).join('\n');

describe('Given Dart source, ', () => {
  it(
    'when a string over several lines opens, raw or not, between triple quotes of either kind, '
    + 'then each line inside it starts inside it, up to the line it ends on.',
    () => {
      assert.equal(shown(["final a = '''", 'yaml: $x', "''';", 'final b = r"""raw ${not}', 'still', '"""; // it\'s done', 'code();']), [
        '1 code', "2 '''", "3 '''", '4 code', '5 r"""', '6 r"""', '7 code',
      ].join('\n'));
    },
  );

  it(
    'when an interpolation in one spans lines, and block comments nest, '
    + 'then the lines start inside both, and inside each level.',
    () => {
      assert.equal(shown(["final c = '''${foo(", "  'x', ['''inner''']) } after", "''';", '/* one /* two', '*/ still one */ code();']), [
        '1 code', "2 '''${", "3 '''", '4 code', '5 /*/*',
      ].join('\n'));
    },
  );

  it(
    'when a string between single quotes is left open at its line’s end, or quotes sit in a comment, '
    + 'then the next line starts as code.',
    () => {
      assert.equal(shown(["print('unclosed", "// it's \"quoted\" '''", "final d = 'it''s';", 'more();']), ['1 code', '2 code', '3 code', '4 code'].join('\n'));
    },
  );
});
