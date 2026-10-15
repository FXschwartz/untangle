// The review's files between two commits. The hunks come from the diff stage; each diff
// line becomes the row the history attributes (the sign, then the text).
import { exportDiff } from '../../dist/pipeline/diff.js';

export interface ReviewFile {
  p: string;
  s: string;
  hunks: Array<{ o: number; n: number; rows: Array<[string, string]> }> | null;
}

export function reviewFiles(repo: string, base: string, head: string): ReviewFile[] {
  const diff = exportDiff(repo, { base: { left: base, right: head, label: 'base' } }, []);
  return diff.compares.base.files.map((file) => ({
    p: file.p,
    s: file.s,
    hunks: file.hunks
      ? file.hunks.map((hunk) => ({
        o: hunk.o,
        n: hunk.n,
        rows: hunk.l.map((line) => [line[0] ?? ' ', line.slice(1)] as [string, string]),
      }))
      : null,
  }));
}
