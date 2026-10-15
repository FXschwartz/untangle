import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkLive, makePlan, type Answers } from './live.ts';
import { git, prepare, scratch } from './scenarios.ts';
import { latestMessageMs, openedFiles, summarizeTraffic } from './traffic.ts';

const { values } = parseArgs({ options: {
  build: { type: 'string' }, scenario: { type: 'string' }, out: { type: 'string' },
  cache: { type: 'string', default: 'cold' }, 'no-shim': { type: 'boolean', default: false },
} });
if (!values.build || !values.scenario || !values.out || !['cold', 'warm'].includes(values.cache!)) {
  throw new Error('Usage: node bench/run.ts --build <dist/cli.js> --scenario <fixture|S|M|L> --out <scratch folder> --cache <cold|warm> [--no-shim]');
}

const cli = path.resolve(values.build);
const out = path.resolve(values.out);
if (!out.startsWith(scratch + path.sep)) throw new Error(`Output must be inside ${scratch}.`);
if (fs.existsSync(out)) throw new Error(`Output already exists: ${out}`);
fs.mkdirSync(scratch, { recursive: true });
const lockFile = path.join(scratch, 'run.lock');
const lock = fs.openSync(lockFile, 'wx');
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, out, startedAt: new Date().toISOString() }));
process.on('exit', () => { fs.closeSync(lock); fs.unlinkSync(lockFile); });

const scenario = prepare(values.scenario);
if (git(scenario.repo, 'rev-parse', 'HEAD') !== scenario.head) throw new Error('Scenario is not at its pinned head.');
if (git(scenario.repo, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Scenario has tracked changes.');

fs.mkdirSync(out, { recursive: true });
const scenarioDir = path.dirname(scenario.repo);
const cache = path.join(scenarioDir, 'untangle-cache');
const home = path.join(scenarioDir, 'home');
const analyzerCache = path.join(home, '.dartServer');
if (values.cache === 'warm' && !fs.existsSync(analyzerCache)) throw new Error('A warm run needs a preceding cold run.');
if (values.cache === 'cold') fs.rmSync(analyzerCache, { recursive: true, force: true });
fs.mkdirSync(analyzerCache, { recursive: true });

const flutter = path.join(scratch, 'toolchain/flutter');
const sdk = path.join(flutter, 'bin/cache/dart-sdk');
const realDart = path.join(sdk, 'bin/dart');
if (!fs.existsSync(realDart)) throw new Error(`Copy the Flutter SDK to ${flutter} before running.`);
const bin = path.join(out, 'bin');
fs.mkdirSync(bin);
const shim = fileURLToPath(new URL('./dart-shim.mjs', import.meta.url));
fs.chmodSync(shim, 0o755);
if (!values['no-shim']) fs.symlinkSync(shim, path.join(bin, 'dart'));

const env = { ...process.env };
for (const name of Object.keys(env)) if (name === 'BROWSER' || name.startsWith('ORCA_')) delete env[name];
Object.assign(env, {
  HOME: home, PUB_CACHE: path.join(scratch, 'pub-cache'), FLUTTER_ROOT: flutter,
  PATH: [bin, path.join(sdk, 'bin'), path.join(flutter, 'bin'), env.PATH].join(path.delimiter),
  UNTANGLE_CACHE: cache, BENCH_REAL_DART: realDart, BENCH_DART_CACHE: analyzerCache,
  BENCH_LSP_LOG: path.join(out, 'traffic.jsonl'), BENCH_DART_PID: path.join(out, 'dart-process.json'),
  CI: 'true', NO_COLOR: '1', DART_SUPPRESS_ANALYTICS: 'true', FLUTTER_SUPPRESS_ANALYTICS: 'true',
});

interface ProcessSample { pid: number; ppid: number; group: number; state: string; start: string; rss: number; hwm: number; command: string; executable: string }
function inspect(pid: number): ProcessSample | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    return { pid, ppid: Number(stat[1]), group: Number(stat[2]), state: stat[0], start: stat[19],
      rss: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024,
      hwm: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024,
      command: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(),
      executable: fs.readlinkSync(`/proc/${pid}/exe`) };
  } catch { return null; }
}

function descendants(pid: number): ProcessSample[] {
  const result: ProcessSample[] = [];
  try {
    const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    for (const child of children) {
      const sample = inspect(child);
      if (sample) result.push(sample, ...descendants(child));
    }
  } catch { /* The parent exited between samples. */ }
  return result;
}

const args = [cli, '-base', scenario.base, '-no-cache', '-no-open', '-port', '0', '-verbose'];
const startedAt = Date.now();
const available = Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1] ?? 0) * 1024;
const buildRoot = path.dirname(path.dirname(cli));
const commitFile = path.join(buildRoot, 'bench-commit.txt');
const buildCommit = fs.existsSync(commitFile) ? fs.readFileSync(commitFile, 'utf8').trim() : git(buildRoot, 'rev-parse', 'HEAD');
const result: Record<string, any> = {
  scenario, build: { cli, commit: buildCommit, sha256: crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex') },
  startedAt: new Date(startedAt).toISOString(), startEpochMs: startedAt, loadAverage: os.loadavg(),
  freeMemoryBytes: os.freemem(), availableMemoryBytes: available, analyzerCache: values.cache,
  analyzerCachePath: analyzerCache, untangleCache: cache, shim: !values['no-shim'], command: [process.execPath, ...args],
  dartVersion: execFileSync(realDart, ['--version'], { env, encoding: 'utf8' }).trim(),
  processes: [], memory: {}, live: [], cleanup: {},
};
fs.writeFileSync(path.join(out, 'started.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${scenario.name} ${values.cache}: starting at ${result.startedAt}; load ${result.loadAverage.join(', ')}; available ${(available / 2 ** 30).toFixed(1)} GiB`);

const stderr = fs.createWriteStream(path.join(out, 'stderr.log'));
const stdout = fs.createWriteStream(path.join(out, 'stdout.log'));
const rss = fs.createWriteStream(path.join(out, 'rss.csv'));
rss.write('epoch_ms,elapsed_ms,pid,vmrss_bytes,vmhwm_bytes,phase\n');
const child = spawn(process.execPath, args, { cwd: scenario.repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
result.cliPid = child.pid;
let text = '';
let pending = '';
let phase = 'build';
let buildFinishedAt = 0;
let servedAt = 0;
let dart: ProcessSample | null = null;
const owned = new Map<number, ProcessSample>();
let childExit: { code: number | null; signal: string | null } | null = null;
let readyResolve: (url: string) => void;
let readyReject: (error: Error) => void;
const ready = new Promise<string>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
let cancel: (error: Error) => void;
const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject; });
const exited = new Promise<void>((resolve) => child.on('exit', (code, signal) => {
  childExit = { code, signal };
  if (!servedAt) readyReject(new Error(`Untangle exited before serving (${code}, ${signal}).`));
  resolve();
}));
child.on('error', (error) => readyReject(error));
child.stdout.pipe(stdout);

function sample() {
  if (!dart) {
    const tree = descendants(child.pid!);
    if (tree.length) result.lastDiscovery = tree;
    dart = tree.find((p) => /analysis_server/.test(p.command))
      ?? tree.find((p) => p.executable === realDart && /(?:^| )language-server(?: |$)/.test(p.command)) ?? null;
    if (dart) {
      const group = tree.find((p) => p.pid === dart!.group);
      for (const process of [dart, ...(group ? [group] : [])]) owned.set(process.pid, process);
      result.processes.push(...[...owned.values()].map((p) => ({ pid: p.pid, group: p.group, start: p.start, command: p.command })));
      console.log(`Real analysis server PID ${dart.pid}, group ${dart.group}`);
    }
  }
  const current = dart && inspect(dart.pid);
  if (!current || current.start !== dart!.start || current.state === 'Z') return null;
  rss.write(`${Date.now()},${Date.now() - startedAt},${current.pid},${current.rss},${current.hwm},${phase}\n`);
  return { pid: current.pid, rssBytes: current.rss, hwmBytes: current.hwm, epochMs: Date.now() };
}

child.stderr.on('data', (chunk: Buffer) => {
  stderr.write(chunk);
  const part = chunk.toString('utf8');
  text += part;
  pending += part;
  let newline: number;
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (/✓ language server\s/.test(line)) {
      buildFinishedAt = Date.now();
      result.memory.buildEnd = sample();
      phase = 'analysis';
    }
    if (/^\s*[✓…✗]/.test(line)) console.log(line.trim());
    const url = /Review at (http:\/\/\S+)/.exec(line)?.[1];
    if (url) {
      servedAt = Date.now();
      result.memory.served = sample();
      phase = 'live';
      readyResolve(url);
    }
  }
});
const sampling = setInterval(sample, 500);
const deadline = setTimeout(() => readyReject(new Error('Build exceeded two hours.')), 2 * 60 * 60 * 1000);
const interrupt = () => cancel(new Error('Benchmark was interrupted.'));
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

function findAnswers(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? findAnswers(full) : entry.name === 'answers.json' ? [full] : [];
  });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stillOwned = () => [...owned.values()].filter((p) => {
  const now = inspect(p.pid);
  return now && now.start === p.start && now.state !== 'Z';
});

try {
  const url = await Promise.race([ready, cancelled]);
  clearTimeout(deadline);
  if (!dart) throw new Error('Could not identify the real analysis server process.');
  const answerFiles = findAnswers(path.join(cache, 'reviews')).filter((file) => file.includes(`${scenario.base.slice(0, 12)}-${scenario.head.slice(0, 12)}`));
  if (answerFiles.length !== 1) throw new Error(`Expected one answers.json, found ${answerFiles.length}.`);
  fs.copyFileSync(answerFiles[0], path.join(out, 'answers.json'));
  const answers = JSON.parse(fs.readFileSync(answerFiles[0], 'utf8')) as Answers;
  result.roots = { headDir: answers.headDir, baseDir: answers.baseDir };
  const planFile = path.join(scenarioDir, 'live-plan.json');
  const opened = await openedFiles(env.BENCH_LSP_LOG!, servedAt);
  if (!fs.existsSync(planFile)) {
    if (values['no-shim']) throw new Error('Make the live plan with a shim run first.');
    fs.writeFileSync(planFile, JSON.stringify(await makePlan(answers, opened, scenario.repo, scenario.base, scenario.head), null, 2) + '\n');
  }
  fs.copyFileSync(planFile, path.join(out, 'live-plan.json'));
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  result.trafficBoundaryMs = values['no-shim'] ? null : latestMessageMs(env.BENCH_LSP_LOG!);
  result.live = await Promise.race([checkLive(url, plan), cancelled]);
  result.memory.afterLive = sample();
  result.liveCounts = Object.fromEntries(['definition', 'onward', 'symbols'].map((kind) => [kind, result.live.filter((r: { kind: string }) => r.kind === kind).length]));
  result.liveMismatches = result.live.filter((r: { matches: boolean }) => !r.matches).map((r: { id: string }) => r.id);
  result.trafficEndMs = values['no-shim'] ? null : latestMessageMs(env.BENCH_LSP_LOG!);
  result.traffic = values['no-shim'] ? null : await summarizeTraffic(env.BENCH_LSP_LOG!, result.trafficBoundaryMs, answers, 0, true);
  result.liveTraffic = values['no-shim'] ? null : await summarizeTraffic(env.BENCH_LSP_LOG!, result.trafficEndMs, answers, result.trafficBoundaryMs, true);
  result.status = 'completed';
} catch (error) {
  result.status = 'failed';
  result.error = error instanceof Error ? error.stack : String(error);
  console.error(result.error);
} finally {
  clearTimeout(deadline);
  phase = 'stopping';
  result.cleanup.startedAt = new Date().toISOString();
  if (!childExit) child.kill('SIGINT');
  const until = Date.now() + 30_000;
  while (Date.now() < until && (!childExit || stillOwned().length)) await delay(100);
  result.cleanup.forcedGroups = [];
  if (!childExit || stillOwned().length) {
    const groups = new Set(stillOwned().map((p) => p.group));
    if (!childExit) groups.add(child.pid!);
    for (const group of groups) {
      try { process.kill(-group, 'SIGTERM'); result.cleanup.forcedGroups.push(group); } catch { /* Already gone. */ }
    }
    await Promise.race([exited, delay(5000)]);
    for (const p of stillOwned()) {
      try { process.kill(-p.group, 'SIGKILL'); } catch { /* Already gone. */ }
    }
    if (!childExit) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already gone. */ }
    }
    await Promise.race([exited, delay(5000)]);
  }
  clearInterval(sampling);
  result.cleanup.cliExit = childExit;
  result.cleanup.remaining = stillOwned().map((p) => p.pid);
  result.cleanup.completedAt = new Date().toISOString();
  if (!childExit || result.cleanup.remaining.length) result.status = 'failed';
  result.servedAt = servedAt || null;
  result.buildFinishedAt = buildFinishedAt || null;
  result.finishedAt = new Date().toISOString();
  result.elapsedMs = Date.now() - startedAt;
  result.steps = [...text.matchAll(/^\s*✓ (.+?)\s+(?:(\d+) min )?(\d+(?:\.\d+)?) (ms|s)\s*$/gm)].map((m) => ({
    label: m[1].trim(), durationMs: Number(m[2] ?? 0) * 60_000 + Number(m[3]) * (m[4] === 'ms' ? 1 : 1000), printed: m[0].trim(),
  }));
  const notes = /✓ language server[^\n]*\n([\s\S]*?)(?=^\s*[✓…✗]|$)/m.exec(text)?.[1] ?? '';
  result.languageServerNotes = notes.split('\n').map((line) => line.trim()).filter(Boolean);
  await Promise.all([stderr, stdout, rss].map((stream) => new Promise<void>((resolve) => stream.end(resolve))));
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`${result.status}: ${path.join(out, 'result.json')}`);
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}

if (result.status !== 'completed') process.exitCode = 1;
