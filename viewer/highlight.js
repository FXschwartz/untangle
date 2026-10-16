// Syntax highlighting with Shiki: VS Code's TextMate grammars and its Dark+ theme, run in the
// page. `npm run build` bundles this file into dist/highlight.js; the page calls
// window.UntangleShiki.load() and then colors code with lines().
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import darkPlus from 'shiki/themes/dark-plus.mjs';
import css from 'shiki/langs/css.mjs';
import dart from 'shiki/langs/dart.mjs';
import diff from 'shiki/langs/diff.mjs';
import dockerfile from 'shiki/langs/dockerfile.mjs';
import groovy from 'shiki/langs/groovy.mjs';
import html from 'shiki/langs/html.mjs';
import ini from 'shiki/langs/ini.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import make from 'shiki/langs/make.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import proto from 'shiki/langs/proto.mjs';
import shellscript from 'shiki/langs/shellscript.mjs';
import sql from 'shiki/langs/sql.mjs';
import swift from 'shiki/langs/swift.mjs';
import toml from 'shiki/langs/toml.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';
// Serverpod's VS Code grammar; its BSD notice is retained in the grammar and bundle.
import serverpod from './syntaxes/serverpod.tmLanguage.json';

const THEME = 'dark-plus';
const BY_EXT = {
  dart: 'dart', yaml: 'yaml', yml: 'yaml', spy: 'yaml', json: 'json', arb: 'json', md: 'markdown', sql: 'sql',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript', html: 'html', htm: 'html', css: 'css', xml: 'xml', plist: 'xml',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', proto: 'proto', toml: 'toml', gradle: 'groovy', groovy: 'groovy',
  diff: 'diff', patch: 'diff', ini: 'ini', cfg: 'ini', properties: 'ini',
};
const BY_NAME = { Dockerfile: 'dockerfile', Makefile: 'make' };

let highlighter = null;
let loading = null;
// The theme's color for text no grammar rule colors.
let fg = '#D4D4D4';

/** Loads the grammars and the theme, once. */
function load() {
  loading ??= createHighlighterCore({
    themes: [darkPlus],
    langs: [css, dart, diff, dockerfile, groovy, html, ini, javascript, json, kotlin, make, markdown, proto, shellscript, sql, swift, toml, typescript, xml, yaml, serverpod],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((h) => {
    highlighter = h;
    fg = (h.getTheme(THEME).fg || fg).toUpperCase();
    return h;
  });
  return loading;
}

/** The grammar for a path, or null for plain text. */
function langFor(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (/\.spy(?:\.ya?ml)?$/i.test(name)) return 'serverpod';
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return BY_EXT[ext] || null;
}

/**
 * Colors of each line of a piece of code, highlighted as one document so that strings and
 * comments over several lines keep their state: per line, [column, color, italic] for each
 * token, in order. Null when highlighting isn't loaded or the language isn't known.
 */
function lines(code, lang) {
  if (!highlighter || !lang) return null;
  let tokens;
  try {
    tokens = highlighter.codeToTokens(code, { lang, theme: THEME, tokenizeMaxLineLength: 2000 }).tokens;
  } catch {
    return null;
  }
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return tokens.map((line, li) => line.map((t) => [t.offset - starts[li], t.color || null, !!(t.fontStyle && t.fontStyle & 1)]));
}

window.UntangleShiki = { load, langFor, lines, fg: () => fg };
