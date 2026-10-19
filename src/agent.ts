// The commands a coding agent runs to hold a review. `watch` starts the review when it isn't
// running (its page opens, in Orca's browser inside Orca), then waits for the notes and replies
// the agent hasn't read, prints them and exits: exiting is what wakes an agent that runs it in the
// background. `reply` answers in a note’s thread, `notes` prints the open notes, and `stop` closes
// the review.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrUrl } from './target.js';
import { openBrowser } from './open.js';
import { findRun, listRuns, prKey, removeRun, runDir, wantedDir, type RunInfo, type Wanted } from './runs.js';

// The server answers a wait at least this often, so no connection sits idle for long; the command
// asks again until its own time runs out.
const ROUND = 4 * 60_000;

/** The agent's name: given, or told by the agent's environment. */
export function agentName(given: string | null): string {
  const name = (given ?? process.env.UNTANGLE_AGENT ?? '').trim();
  if (name) return name.slice(0, 40);
  if (process.env.CLAUDECODE) return 'Claude Code';
  if (process.env.GEMINI_CLI) return 'Gemini CLI';
  return 'Agent';
}

const say = (line: string) => process.stdout.write(`untangle: ${line}\n`);
// Quoted for a shell, when it needs to be.
const sh = (s: string) => (/^[\w./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** What a command's -review (or watch's argument) stands for. */
function wanted(target: string): Wanted {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/(\d+)/.exec(target);
  if (isPrUrl(target) && m) return { pr: prKey(m[1], m[2], Number(m[3])), dir: null, repoKey: `github.com/${m[1]}/${m[2]}`, branch: null };
  if (!fs.existsSync(target)) throw new Error(`${target} does not exist`);
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const w = wantedDir(dir);
  if (!w) throw new Error(`${path.resolve(dir)} is not inside a git repository`);
  return w;
}

class Gone extends Error {}

/** A call to a running review, with its token. Rejects with Gone when the review isn't there. */
function call(run: RunInfo, method: string, route: string, opts: { query?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = new URL(run.url);
  const base = url.pathname.endsWith('/') ? url.pathname : url.pathname + '/';
  const query = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, method, path: `${base}api/${route}${query}`, signal: opts.signal,
      headers: { 'x-untangle-token': run.token, ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d: string) => { text += d; }).on('end', () => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text.trim() || `untangle answered ${res.statusCode}` };
        }
        resolve({ status: res.statusCode || 0, data });
      }).on('error', () => reject(new Gone()));
    });
    req.on('error', (e) => reject((e as Error).name === 'AbortError' ? e : new Gone()));
    req.end(body);
  });
}

const failed = (r: { status: number; data: Record<string, unknown> }) => (r.status >= 400 ? String(r.data.error || `untangle answered ${r.status}`) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => listRuns().some((r) => r.pid === pid);

/**
 * The review running for a target, when it answers: a run file left by a review that was killed
 * (whose process id another process now has) is removed.
 */
async function find(target: string): Promise<RunInfo | null> {
  const run = findRun(wanted(target));
  if (!run) return null;
  try {
    await call(run, 'GET', 'notes/hello');
    return run;
  } catch (e) {
    if (!(e instanceof Gone)) throw e;
    removeRun(run.pid);
    return null;
  }
}

/** The review a command is about, or an error that says how to start one. */
async function running(review: string | null): Promise<RunInfo> {
  const target = review ?? '.';
  const run = await find(target);
  if (!run) throw new Error(`no review of ${review ? target : 'this directory'} is running: untangle watch${review ? ' ' + sh(target) : ''} starts one`);
  return run;
}

/** The last lines a review that didn't start printed. */
const tail = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join('\n');
  } catch {
    return '';
  }
};

/** Starts a review in the background, as `untangle [flags] <target>` would, and finds its run file. */
async function start(target: string, flags: string[]): Promise<{ run: RunInfo; log: string }> {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  // Logs of reviews started a day ago or more are no longer read.
  for (const name of fs.readdirSync(runDir())) {
    const file = path.join(runDir(), name);
    if (/^start-.*\.log$/.test(name) && Date.now() - fs.statSync(file).mtimeMs > 86_400_000) fs.rmSync(file, { force: true });
  }
  const log = path.join(runDir(), `start-${Date.now()}-${process.pid}.log`);
  const fd = fs.openSync(log, 'a', 0o600);
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, ...flags, '--', target], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: process.cwd(), env: process.env });
  fs.closeSync(fd);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.unref();
  for (let i = 0; i < 600; i++) {
    const run = listRuns().find((r) => r.pid === child.pid);
    if (run) return { run, log };
    if (exited) break;
    await sleep(100);
  }
  throw new Error(`the review didn’t start${tail(log) ? ':\n' + tail(log) : ''}`);
}

/** Waits until the review is built: until then it answers 503. */
async function ready(run: RunInfo, agent: string, log: string | null): Promise<Record<string, unknown>> {
  for (;;) {
    let r;
    try {
      r = await call(run, 'GET', 'notes/hello', { query: { agent } });
    } catch (e) {
      if (!(e instanceof Gone) || !alive(run.pid)) throw new Error(`the review stopped before it was ready${log && tail(log) ? ':\n' + tail(log) : ''}`);
      r = { status: 503, data: {} };
    }
    if (r.status !== 503) {
      const err = failed(r);
      if (err) throw new Error(err);
      return r.data;
    }
    await sleep(400);
  }
}

export async function watch(o: { target: string; given: boolean; forward: string[]; agent: string | null; timeout: number }): Promise<number> {
  const agent = agentName(o.agent);
  let run = await find(o.target);
  let log: string | null = null;
  if (!run) {
    say(`starting the review of ${o.given ? o.target : 'this directory'}…`);
    ({ run, log } = await start(o.target, o.forward));
  }
  const hello = await ready(run, agent, log);
  // Already running, with no page open: one opens, so the person can write the notes.
  let opened = log ? (hello.opened as string | null) : null;
  if (!log && !hello.pages) opened = await openBrowser(run.url);
  if (log || !hello.pages) say(`${hello.title} is open ${opened === 'orca' ? 'in Orca’s browser' : opened === 'browser' ? 'in the browser' : `at ${run.url}`}.`);

  // The commands to answer with, as this agent should type them.
  const extra = [o.agent ? `-agent ${sh(o.agent)}` : '', o.given ? `-review ${sh(o.target)}` : ''].filter(Boolean).join(' ');
  const reply = `untangle reply${extra ? ' ' + extra : ''}`;
  const again = `untangle watch${o.agent ? ` -agent ${sh(o.agent)}` : ''}${o.given ? ' ' + sh(o.target) : ''}`;
  const deadline = o.timeout > 0 ? Date.now() + o.timeout : Infinity;
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  for (;;) {
    const wait = Math.min(ROUND, deadline - Date.now());
    let r;
    try {
      r = await call(run, 'GET', 'notes/watch', { query: { agent, wait: String(Math.max(0, Math.round(wait))) }, signal: stop.signal });
    } catch (e) {
      if (stop.signal.aborted) return 130;
      if (!(e instanceof Gone)) throw e;
      r = { status: 200, data: { closed: true } };
    }
    const err = failed(r);
    if (err) throw new Error(err);
    const a = r.data;
    if (a.closed) {
      say(`the review of ${hello.title} is closed (its page closed, or untangle stop ran): there’s nothing more to watch.`);
      return 0;
    }
    if (a.text) {
      process.stdout.write(String(a.text).replace(/\n*$/, '\n\n'));
      if (a.first) explain(String(hello.url || run.url), reply, again);
      else say(`answer a note with ${reply} <N> '<text>' (add -resolve once it’s done), and run ${again} again for what comes next.`);
      return 0;
    }
    if (Date.now() >= deadline) {
      say(`nothing new on ${hello.title} yet. Run ${again} again to keep waiting.`);
      if (a.first) explain(String(hello.url || run.url), reply, again);
      return 0;
    }
  }
}

/** The first watch says how the review works, so asking for a review is all the setup it needs. */
function explain(url: string, reply: string, again: string) {
  say(`you hold this code review. The person reviewing writes notes on the code in its page (${url}), and your answers show under them at once.`);
  say(`each ${again} waits for the notes and replies you haven’t read, prints them and exits: run it again after each answer, in the background if you can.`);
  say(`answer in a note’s thread with ${reply} N2 'your answer'; add -resolve once you’ve made the change. Commit as you go: the page shows your commits, and the notes follow their lines.`);
  say(`untangle notes prints the open notes again; untangle stop closes the review.`);
}

export async function reply(o: { review: string | null; agent: string | null; resolve: boolean; note: number; text: string | null }): Promise<number> {
  const run = await running(o.review);
  let text = o.text;
  if (text === '-') text = fs.readFileSync(0, 'utf8');
  const r = await call(run, 'POST', 'notes/agent', { body: { agent: agentName(o.agent), n: o.note, body: text, resolve: o.resolve } }).catch((e) => { throw e instanceof Gone ? new Error('the review stopped') : e; });
  const err = failed(r);
  if (err) throw new Error(err);
  say(text ? `answered N${o.note}${o.resolve ? ' and resolved it' : ''}.` : `resolved N${o.note}.`);
  return 0;
}

export async function notes(o: { review: string | null; all: boolean }): Promise<number> {
  const run = await running(o.review);
  const r = await call(run, 'GET', 'notes/export', { query: { scope: o.all ? 'all' : 'open' } }).catch((e) => { throw e instanceof Gone ? new Error('the review stopped') : e; });
  const err = failed(r);
  if (err) throw new Error(err);
  process.stdout.write(String(r.data.text));
  return 0;
}

export async function stop(o: { review: string | null }): Promise<number> {
  const run = await running(o.review);
  const r = await call(run, 'POST', 'stop').catch((e) => { throw e instanceof Gone ? new Error('the review stopped already') : e; });
  const err = failed(r);
  if (err) throw new Error(err);
  say(`closed the review${run.title ? ` of ${run.title}` : ''}.`);
  return 0;
}
