// Types for core.js, which runs in the page and in the analysis alike.
export {};

export interface Token {
  /** Text. */
  t: string;
  /** Kind: ws, id, ty, kw, num, ann, key, str, com, op, md. */
  k: string;
  /** Column. */
  c: number;
}

declare global {
  var ReviewCore: {
    tokenize(line: string, lang: string): Token[];
    langOf(path: string): string;
    globToRegExp(pattern: string): RegExp;
  };
}
