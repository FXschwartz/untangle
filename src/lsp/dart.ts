// One Dart analysis server (the one VS Code uses), with every checkout of the review as a
// workspace folder, so both sides of a diff resolve through the same process.
//
// Like an editor, it only analyzes the packages of files that are open, and each request opens
// its file first. A review touches a few packages of a repository, so this is many times faster
// than analyzing both checkouts whole, with the same answers. Opening a file of another package
// makes the server rebuild its contexts, and a request that lands meanwhile answers nothing:
// callers open a batch's files before asking (openAll) and ask again for empty answers (askAll).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node.js';

export interface Location {
  /** Absolute path. */
  path: string;
  line: number;
  col: number;
}

export interface CallHierarchyItem {
  name: string;
  uri: string;
  selectionRange: { start: { line: number; character: number } };
  [key: string]: unknown;
}

interface LspRange { start: { line: number; character: number } }
type LspLocation = { uri: string; range: LspRange } | { targetUri: string; targetRange: LspRange; targetSelectionRange?: LspRange };

const REQUEST_TIMEOUT_MS = 600_000;

// `dart` is often a wrapper (Flutter's bin/dart) and the analysis server a process of its own
// under it, so each server starts in its own process group and stops as a group. Servers still
// running when untangle exits (Ctrl+C during a build, say) go with it.
const GROUPS = process.platform !== 'win32';
const running = new Set<ChildProcess>();
function killTree(child: ChildProcess) {
  try {
    if (GROUPS && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {
    // Gone already.
  }
}
process.on('exit', () => running.forEach(killTree));

export const fileUri = (p: string) => pathToFileURL(p).href;
export const uriPath = (u: string) => fileURLToPath(u);

export class DartServer {
  private exited: Error | null = null;
  private readonly opened = new Set<string>();
  // Settles (as a rejection) when the server process goes away; every request races it.
  private readonly gone: Promise<never>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: MessageConnection,
  ) {
    this.gone = new Promise<never>((_, reject) => {
      child.once('exit', (code) => reject((this.exited ??= new Error(`the Dart analysis server exited (code ${code})`))));
      child.once('error', (e) => reject((this.exited ??= new Error(`could not start the Dart analysis server: ${e.message}`))));
    });
    this.gone.catch(() => {});
  }

  static async start(folders: Array<{ name: string; dir: string }>, opts: { clientVersion: string; log?: (line: string) => void }): Promise<DartServer> {
    const child = spawn('dart', ['language-server', '--protocol=lsp', '--client-id', 'untangle', '--client-version', opts.clientVersion], {
      cwd: folders[0].dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: GROUPS,
    });
    running.add(child);
    child.on('exit', () => running.delete(child));
    const conn = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
    const server = new DartServer(child, conn);
    child.stderr!.setEncoding('utf8').on('data', (d: string) => opts.log?.(d.trimEnd()));
    child.on('error', () => conn.dispose());
    // Requests from the server: configuration gets empty sections, everything else no answer.
    conn.onRequest((method: string, params: unknown) => {
      if (method === 'workspace/configuration') return ((params as { items?: unknown[] }).items || []).map(() => ({}));
      return null;
    });
    conn.onNotification((method: string, params: unknown) => {
      if (method === 'window/logMessage' || method === 'window/showMessage') opts.log?.(String((params as { message?: string }).message ?? ''));
    });
    conn.listen();
    await server.request('initialize', {
      processId: process.pid,
      rootUri: fileUri(folders[0].dir),
      workspaceFolders: folders.map((f) => ({ uri: fileUri(f.dir), name: f.name })),
      initializationOptions: { onlyAnalyzeProjectsWithOpenFiles: true },
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { definition: { linkSupport: false }, callHierarchy: {} },
      },
    });
    conn.sendNotification('initialized', {});
    return server;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(this.exited);
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.conn.sendRequest(method, params) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${method} timed out`)), REQUEST_TIMEOUT_MS);
      }),
      this.gone,
    ]).finally(() => clearTimeout(timer));
  }

  /** Where the identifier at a position is defined. */
  async definition(file: string, line: number, col: number): Promise<Location | null> {
    this.open(file);
    const answer = await this.request<LspLocation | LspLocation[] | null>('textDocument/definition', { textDocument: { uri: fileUri(file) }, position: { line, character: col } });
    const res = Array.isArray(answer) ? answer[0] : answer;
    if (!res) return null;
    const uri = 'targetUri' in res ? res.targetUri : res.uri;
    const range = 'targetUri' in res ? res.targetSelectionRange || res.targetRange : res.range;
    if (!uri.startsWith('file:')) return null;
    return { path: uriPath(uri), line: range.start.line, col: range.start.character };
  }

  /** The declaration that the one at a position overrides (dart/textDocument/super). */
  async superOf(file: string, line: number, col: number): Promise<Location | null> {
    this.open(file);
    const res = await this.request<{ uri: string; range: LspRange } | null>('dart/textDocument/super', { textDocument: { uri: fileUri(file) }, position: { line, character: col } });
    if (!res || !res.uri.startsWith('file:')) return null;
    return { path: uriPath(res.uri), line: res.range.start.line, col: res.range.start.character };
  }

  async prepareCallHierarchy(file: string, line: number, col: number): Promise<CallHierarchyItem[]> {
    this.open(file);
    return (await this.request<CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', { textDocument: { uri: fileUri(file) }, position: { line, character: col } })) || [];
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyItem[]> {
    if (item.uri.startsWith('file:')) this.open(uriPath(item.uri));
    const res = await this.request<Array<{ to: CallHierarchyItem }> | null>('callHierarchy/outgoingCalls', { item });
    return (res || []).map((c) => c.to);
  }

  /** Asks the server to shut down, and ends its process group when it doesn't in time. */
  async stop(): Promise<void> {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (!this.exited) {
      const exit = new Promise((resolve) => this.child.once('exit', resolve));
      try {
        await Promise.race([this.conn.sendRequest('shutdown'), wait(10_000)]);
        this.conn.sendNotification('exit');
      } catch {
        // Gone already.
      }
      await Promise.race([exit, wait(5_000)]);
    }
    this.conn.dispose();
    killTree(this.child);
    running.delete(this.child);
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream?.destroy();
  }

  openAll(files: Iterable<string>) {
    for (const f of files) this.open(f);
  }

  /** Opens a file as it is on disk, once, so that its package gets analyzed. */
  open(file: string) {
    if (this.opened.has(file)) return;
    this.opened.add(file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    this.conn.sendNotification('textDocument/didOpen', { textDocument: { uri: fileUri(file), languageId: 'dart', version: 1, text } });
  }

  /** Adds a checkout to the workspace. */
  addFolder(name: string, dir: string) {
    this.conn.sendNotification('workspace/didChangeWorkspaceFolders', { event: { added: [{ uri: fileUri(dir), name }], removed: [] } });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * pool(), then the items whose answer is empty are asked again once the batch is done, until a
 * round changes nothing (at most three rounds). An answer that is truly empty costs one more
 * request; one that came during a context rebuild gets its real answer.
 */
export async function askAll<T, R>(items: T[], width: number, fn: (item: T) => Promise<R>, empty: (r: R) => boolean, onDone?: (done: number) => void): Promise<R[]> {
  const results = await pool(items, width, fn, onDone);
  for (let round = 1; round <= 3; round++) {
    const again = results.flatMap((r, i) => (empty(r) ? [i] : []));
    if (!again.length) break;
    await sleep(300 * round);
    const answers = await pool(again, width, (i) => fn(items[i]));
    let changed = 0;
    answers.forEach((r, k) => { if (!empty(r)) { results[again[k]] = r; changed++; } });
    if (!changed) break;
  }
  return results;
}

/** Runs fn over items with at most `width` in flight, keeping the results in item order. */
export async function pool<T, R>(items: T[], width: number, fn: (item: T, i: number) => Promise<R>, onDone?: (done: number) => void): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}
