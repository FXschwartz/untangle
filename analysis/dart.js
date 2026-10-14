// The Dart grammar for tree-sitter, loaded once per process.
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

let dart = null;

export async function dartParser() {
  if (!dart) {
    await Parser.init();
    dart = await Language.load(createRequire(import.meta.url).resolve('tree-sitter-wasms/out/tree-sitter-dart.wasm'));
  }
  const parser = new Parser();
  parser.setLanguage(dart);
  return parser;
}
