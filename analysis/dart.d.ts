import type { Parser } from 'web-tree-sitter';
/** A tree-sitter parser for Dart. */
export declare function dartParser(): Promise<Parser>;
/** What each line of Dart source starts inside (a string over lines, an interpolation, a block comment), as the text that opens it; '' is code. Line n is at [n - 1]. */
export declare function dartOpenings(text: string): string[];
