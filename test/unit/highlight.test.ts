import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { before, describe, it } from 'node:test';

interface Highlight {
  load(): Promise<unknown>;
  langFor(file: string): string | null;
  lines(code: string, lang: string): Array<Array<[number, string, boolean]>>;
}

describe('Given the bundled highlighter and a Serverpod model with a field and a relation, ', () => {
  const window: { UntangleShiki?: Highlight } = {};
  const model = 'class: Invoice\nfields:\n  amount: int\n  parent: Invoice?, relation\n';
  let highlighter: Highlight;
  let colors: Array<Array<[number, string, boolean]>>;

  before(async () => {
    vm.runInNewContext(fs.readFileSync(new URL('../../dist/highlight.js', import.meta.url), 'utf8'), { window });
    highlighter = window.UntangleShiki!;
    await highlighter.load();
    colors = highlighter.lines(model, highlighter.langFor('invoice.spy.yaml')!);
  });

  it(
    'when a spy.yaml file is highlighted, '
    + 'then model names and field types use type colors.',
    () => {
      const colorAt = (line: number, col: number) => colors[line].filter(([start]) => start <= col).at(-1)?.[1];

      assert.equal(colorAt(0, 7), '#4EC9B0');
      assert.equal(colorAt(2, 10), '#4EC9B0');
      assert.equal(colorAt(3, 10), '#4EC9B0');
    },
  );

  it(
    'when spy.yml and legacy spy names are opened, '
    + 'then both use the Serverpod grammar.',
    () => {
      assert.equal(highlighter.langFor('invoice.spy.yml'), 'serverpod');
      assert.equal(highlighter.langFor('invoice.spy'), 'serverpod');
    },
  );

  it(
    'when an ordinary YAML file is opened, '
    + 'then it retains the YAML grammar.',
    () => {
      assert.equal(highlighter.langFor('pubspec.yaml'), 'yaml');
    },
  );
});
