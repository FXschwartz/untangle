// A tiny Dart package reviewed through the real pipeline, offline, in its own cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReview, type Progress, type ReviewData } from '../../dist/build.js';
import { resolveDirectory, type Target } from '../../dist/target.js';
import { stubGh, type GhStub } from './gh.ts';
import { TempRepo, type Person } from './repo.ts';

export const pubspec = ['name: sample', 'environment:', '  sdk: ">=3.0.0 <4.0.0"', ''].join('\n');

const ada: Person = { name: 'Ada Review', email: 'ada@example.com', date: '2020-06-01T00:00:00Z' };
const quiet: Progress = { step() {}, detail() {}, note() {}, verbose() {} };

export interface BuiltReview {
  repo: TempRepo;
  cacheDir: string;
  gh: GhStub;
  target: Target;
  data: ReviewData;
  remove(): void;
}

/** `main` has `base`, `feature` has those files overwritten by `head`, compared with main. */
export async function buildDartReview(files: { base: Record<string, string>; head: Record<string, string> }): Promise<BuiltReview> {
  const repo = TempRepo.create();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untangle-cache-'));
  const gh = stubGh();
  const previous = { PATH: process.env.PATH, UNTANGLE_CACHE: process.env.UNTANGLE_CACHE };
  const restore = () => {
    if (previous.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = previous.PATH;
    if (previous.UNTANGLE_CACHE === undefined) delete process.env.UNTANGLE_CACHE;
    else process.env.UNTANGLE_CACHE = previous.UNTANGLE_CACHE;
  };
  const discard = () => {
    restore();
    repo.remove();
    gh.remove();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  };
  try {
    repo.write('pubspec.yaml', pubspec);
    for (const [file, content] of Object.entries(files.base)) repo.write(file, content);
    repo.commit({ subject: 'start', author: ada, committer: ada });
    repo.branch('feature');
    for (const [file, content] of Object.entries(files.head)) repo.write(file, content);
    const later = { ...ada, date: '2020-06-02T00:00:00Z' };
    repo.commit({ subject: 'change', author: later, committer: later });
    process.env.PATH = String(gh.env.PATH);
    process.env.UNTANGLE_CACHE = cacheDir;
    const target = await resolveDirectory(repo.dir, 'main', () => {});
    const built = await buildReview(target, { noCache: true, label: 'main', title: 'feature', keepServer: false }, quiet);
    restore();
    return { repo, cacheDir, gh, target, data: built.data, remove: discard };
  } catch (error) {
    discard();
    throw error;
  }
}
