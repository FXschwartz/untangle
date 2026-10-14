/** "path:line:col" (1-based line) -> [absolute target file, 0-based line, column]. */
export type RawDefinitions = Record<string, [string, number, number]>;

export interface DiffFile {
  p: string;
  s: string;
  a: number;
  d: number;
  ga: string;
  hunks?: Array<{ o: number; n: number; h: string; l: string[] }>;
}

export interface Diff {
  compares: Record<string, { left: string; right: string; label: string; files: DiffFile[] }>;
}

export interface CallGraph {
  depth: number;
  seeds: string[];
  graph: Record<string, string[]>;
}

export interface Model {
  compares: Record<string, any>;
}

export declare function analyze(input: {
  repo: string;
  headDir: string;
  diff: Diff;
  defsRaw: RawDefinitions;
  old?: Record<string, { dir: string; raw: RawDefinitions }>;
  calls?: CallGraph | null;
  supers?: RawDefinitions | null;
  log?: (line: string) => void;
}): Promise<Model>;
