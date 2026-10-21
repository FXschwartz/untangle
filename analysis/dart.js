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

// What each line of Dart source starts inside, as the text that opens it: a string over several
// lines (''' or """, raw or not), an interpolation in one (${), a block comment (/*, once per
// level it's nested). A highlighter given that text first starts the line as the file does. '' is
// code. Line n is at [n - 1].
export function dartOpenings(text) {
  const out = [''];
  // What's open, outermost first: a string ({ q: its quote, raw }), an interpolation ({ braces }),
  // a block comment ({ depth }).
  const stack = [];
  const opening = () => stack.map((x) => (x.q ? (x.raw ? 'r' : '') + x.q : x.braces ? '${' : '/*'.repeat(x.depth))).join('');
  const n = text.length;
  for (let i = 0; i < n;) {
    const c = text[i], top = stack[stack.length - 1];
    if (c === '\n') {
      // A string between single quotes ends with its line.
      while (stack.length && stack[stack.length - 1].q && stack[stack.length - 1].q.length === 1) stack.pop();
      out.push(opening());
      i++;
    } else if (top && top.depth) {
      if (text.startsWith('*/', i)) { if (!--top.depth) stack.pop(); i += 2; }
      else if (text.startsWith('/*', i)) { top.depth++; i += 2; }
      else i++;
    } else if (top && top.q) {
      if (c === '\\' && !top.raw) i += text[i + 1] === '\n' ? 1 : 2;
      else if (text.startsWith(top.q, i)) { stack.pop(); i += top.q.length; }
      else if (c === '$' && text[i + 1] === '{' && !top.raw) { stack.push({ braces: 1 }); i += 2; }
      else i++;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end;
    } else if (text.startsWith('/*', i)) {
      stack.push({ depth: 1 });
      i += 2;
    } else if (top && top.braces && (c === '{' || c === '}')) {
      if (c === '{') top.braces++;
      else if (!--top.braces) stack.pop();
      i++;
    } else {
      // A string's quote, or r and the quote of a raw one (r alone, not a name's last letter).
      const raw = c === 'r' && (text[i + 1] === "'" || text[i + 1] === '"') && !/[\w$]/.test(text[i - 1] || '');
      const q = text[raw ? i + 1 : i];
      if (q === "'" || q === '"') {
        const triple = text.startsWith(q.repeat(3), raw ? i + 1 : i);
        stack.push({ q: triple ? q.repeat(3) : q, raw });
        i += (raw ? 1 : 0) + (triple ? 3 : 1);
      } else i++;
    }
  }
  return out;
}
