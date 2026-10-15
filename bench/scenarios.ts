import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const scratch = path.resolve(process.env.UNTANGLE_BENCH_SCRATCH || path.join(os.tmpdir(), 'untangle-perf'));
export interface Scenario { name: string; repo: string; base: string; head: string }

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 128 << 20 }).trim();
}

function write(root: string, file: string, text: string) {
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}

function fixture(repo: string): { base: string; head: string } {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=fixture');
  git(repo, 'config', 'user.email', 'benchmark@example.invalid');
  git(repo, 'config', 'user.name', 'Benchmark');
  write(repo, '.gitignore', '.dart_tool/\npubspec.lock\n');
  write(repo, 'workspace/pubspec.yaml', "name: perf_workspace\nenvironment:\n  sdk: '>=3.11.0 <4.0.0'\nworkspace:\n  - packages/core\n  - packages/app\n");
  write(repo, 'workspace/packages/core/pubspec.yaml', "name: perf_core\nresolution: workspace\nenvironment:\n  sdk: '>=3.11.0 <4.0.0'\n");
  write(repo, 'workspace/packages/app/pubspec.yaml', "name: perf_app\nresolution: workspace\nenvironment:\n  sdk: '>=3.11.0 <4.0.0'\ndependencies:\n  perf_core: any\n");
  write(repo, 'separate/pubspec.yaml', "name: perf_separate\nenvironment:\n  sdk: '>=3.11.0 <4.0.0'\ndependencies:\n  perf_core:\n    path: ../workspace/packages/core\n");

  for (let i = 0; i < 25; i++) {
    write(repo, `workspace/packages/core/lib/value_${i}.dart`, `class Value${i} {\n  final String name;\n  const Value${i}(this.name);\n  int size() => name.length;\n}\n`);
  }
  write(repo, 'workspace/packages/core/lib/values.dart', Array.from({ length: 25 }, (_, i) => `export 'value_${i}.dart';`).join('\n') + '\n');
  write(repo, 'workspace/packages/core/lib/parent.dart', 'class Parent {\n  int calculate(int value) => value;\n}\n');
  write(repo, 'workspace/packages/app/lib/helper.dart', "import 'app.dart';\nint throughHelper() => App().calculate(2);\n");

  function revision(head: boolean) {
    write(repo, 'workspace/packages/core/lib/service.dart', `import 'values.dart';\n\nint service() {\n${Array.from({ length: 25 }, (_, i) => `  final item${i} = Value${i}('${head ? 'new' : 'old'}');`).join('\n')}\n  return ${Array.from({ length: 25 }, (_, i) => `item${i}.size()`).join(' + ')}${head ? ' + 1' : ''};\n}\n`);
    write(repo, 'workspace/packages/app/lib/app.dart', `import 'package:perf_core/parent.dart';\nimport 'package:perf_core/service.dart';\n\nclass App extends Parent {\n  @override\n  int calculate(int value) => service() + value${head ? ' + 2' : ''};\n}\n`);
    write(repo, 'workspace/packages/app/test/app_test.dart', `import '../lib/helper.dart';\nvoid main() {\n  assert(throughHelper() > ${head ? '2' : '0'});\n}\n`);
    write(repo, 'separate/lib/separate.dart', `import 'package:perf_core/service.dart';\nimport 'package:perf_core/values.dart';\n\nString separate() {\n${Array.from({ length: 15 }, (_, i) => `  final value${i} = Value${i}('${head ? 'after' : 'before'}');`).join('\n')}\n  return '${head ? 'head' : 'base'} ' + service().toString() + value0.name;\n}\n`);
  }

  const commit = (message: string, date: string) => {
    git(repo, 'add', '.');
    execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', message], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return git(repo, 'rev-parse', 'HEAD');
  };
  revision(false);
  const base = commit('Base fixture', '2026-01-01T00:00:00Z');
  revision(true);
  const head = commit('Head fixture', '2026-01-02T00:00:00Z');
  return { base, head };
}

export function prepare(name: string): Scenario {
  if (!['fixture', 'S', 'M', 'L'].includes(name)) throw new Error(`Unknown scenario: ${name}`);
  const largeRepo = process.env.UNTANGLE_BENCH_L_REPO;
  if (name === 'L' && !largeRepo) throw new Error('Set UNTANGLE_BENCH_L_REPO to the source repository for L.');

  const largeBase = process.env.UNTANGLE_BENCH_L_BASE;
  const largeHead = process.env.UNTANGLE_BENCH_L_HEAD;
  if (name === 'L' && (!largeBase || !largeHead)) {
    throw new Error('Set UNTANGLE_BENCH_L_BASE and UNTANGLE_BENCH_L_HEAD to the commits for L.');
  }

  const dir = path.join(scratch, 'scenarios', name);
  const manifest = path.join(dir, 'scenario.json');
  if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8')) as Scenario;
  fs.mkdirSync(dir, { recursive: true });
  const repo = path.join(dir, 'repo');
  let commits: { base: string; head: string };

  if (name === 'fixture') commits = fixture(repo);
  else {
    const source = name === 'L' ? path.resolve(largeRepo!) : path.join(scratch, 'serverpod-source');
    if (!fs.existsSync(source)) {
      if (name === 'L') throw new Error(`L source repository does not exist: ${source}`);
      execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/serverpod/serverpod', source], { stdio: 'inherit' });
    }
    if (name !== 'L') {
      git(source, 'fetch', 'origin', `refs/pull/${name === 'S' ? '5864' : '5866'}/head:refs/bench/${name}`);
    }
    execFileSync('git', ['clone', '--no-hardlinks', '--no-checkout', source, repo], { stdio: 'inherit' });
    if (name !== 'L') {
      // A local clone copies promised packs, but not their remote configuration.
      git(repo, 'remote', 'set-url', 'origin', 'https://github.com/serverpod/serverpod');
      git(repo, 'config', 'remote.origin.promisor', 'true');
      git(repo, 'config', 'remote.origin.partialclonefilter', 'blob:none');
    }
    const [base, head] = name === 'S' ? ['d65d22e0ede6', 'ac5ee4834410']
      : name === 'M' ? ['7645c5b5d9fc', 'b70d2354aa2a'] : [largeBase!, largeHead!];
    commits = { base: git(repo, 'rev-parse', `${base}^{commit}`), head: git(repo, 'rev-parse', `${head}^{commit}`) };
  }

  git(repo, 'checkout', '--detach', commits.head);
  const scenario = { name, repo, ...commits };
  fs.writeFileSync(manifest, JSON.stringify(scenario, null, 2) + '\n');
  return scenario;
}
