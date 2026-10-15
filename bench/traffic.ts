import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { packageOf } from './live.ts';

export interface Message {
  ms: number;
  epochMs: number;
  direction: string;
  kind: string;
  method?: string;
  id?: number | string;
  uri?: string;
  position?: { line: number; character: number };
  requestMs?: number;
  durationMs?: number;
  empty?: boolean;
  size?: number;
  error?: unknown;
  params?: unknown;
  query?: string;
}

export function latestMessageMs(file: string): number {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 65536));
    fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const end = buffer.lastIndexOf(10);
    const start = buffer.lastIndexOf(10, end - 1) + 1;
    return (JSON.parse(buffer.subarray(start, end).toString('utf8')) as Message).ms;
  } finally { fs.closeSync(fd); }
}

export async function* messages(file: string): AsyncGenerator<Message> {
  if (!fs.existsSync(file)) return;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as Message;
}

export async function openedFiles(file: string, before: number): Promise<Set<string>> {
  const opened = new Set<string>();
  for await (const row of messages(file)) {
    if (row.epochMs > before) break;
    if (row.method === 'textDocument/didOpen' && row.uri) opened.add(fileURLToPath(row.uri));
  }
  return opened;
}

export async function summarizeTraffic(file: string, before: number, roots: { headDir: string; baseDir: string }, after = 0, monotonic = false) {
  const methods: Record<string, { requests: number; responses: number; empty: number; errors: number }> = {};
  const stages: Record<string, { startMs: number; endMs: number; durationMs: number; requests: number; empty: number }> = {};
  const opened = new Set<string>();
  const files = new Map<string, { requests: number; empty: number; totalMs: number; maxMs: number; positions: Set<string> }>();
  const analyzerStatus: Array<{ ms: number; params: unknown }> = [];
  let initialize: number | null = null;
  let firstAnswerMs: number | null = null;
  let didOpen = 0;
  let didClose = 0;

  for await (const row of messages(file)) {
    const at = monotonic ? row.ms : row.epochMs;
    if (at > before) break;
    if (at <= after) continue;
    const method = row.method;
    if (!method) continue;
    if (method === '$/analyzerStatus') analyzerStatus.push({ ms: row.ms, params: row.params ?? null });
    if (method === 'initialize' && row.direction === 'client') initialize = row.ms;
    if (method === 'textDocument/didOpen') {
      didOpen++;
      if (row.uri) opened.add(fileURLToPath(row.uri));
    }
    if (method === 'textDocument/didClose') didClose++;
    const request = row.direction === 'client' && row.kind === 'request';
    const response = row.direction === 'server' && row.kind === 'response';
    if (!request && !response) continue;
    const count = methods[method] ??= { requests: 0, responses: 0, empty: 0, errors: 0 };
    if (request) count.requests++;
    if (response) {
      count.responses++;
      if (row.empty) count.empty++;
      if (row.error) count.errors++;
      if (method === 'textDocument/definition' && !row.empty && firstAnswerMs === null) firstAnswerMs = row.ms - (initialize ?? 0);
    }

    const abs = row.uri?.startsWith('file:') ? fileURLToPath(row.uri) : null;
    const stage = method === 'textDocument/definition' ? abs?.startsWith(roots.baseDir + '/') ? 'baseDefinitions' : 'headDefinitions'
      : method === 'textDocument/prepareCallHierarchy' || method === 'callHierarchy/outgoingCalls' ? 'testCalls'
      : method === 'dart/textDocument/super' ? 'overrides' : null;
    if (stage && !after) {
      const start = row.requestMs ?? row.ms;
      const times = stages[stage] ??= { startMs: start, endMs: row.ms, durationMs: 0, requests: 0, empty: 0 };
      times.startMs = Math.min(times.startMs, start);
      times.endMs = Math.max(times.endMs, row.ms);
      times.durationMs = times.endMs - times.startMs;
      if (request) times.requests++;
      if (response && row.empty) times.empty++;
    }
    if (abs && method === 'textDocument/definition') {
      const item = files.get(abs) ?? { requests: 0, empty: 0, totalMs: 0, maxMs: 0, positions: new Set<string>() };
      if (request) {
        item.requests++;
        item.positions.add(JSON.stringify(row.position));
      } else {
        if (row.empty) item.empty++;
        item.totalMs += row.durationMs ?? 0;
        item.maxMs = Math.max(item.maxMs, row.durationMs ?? 0);
      }
      files.set(abs, item);
    }
  }
  const packages = [...new Set([...opened].map(packageOf).filter((p): p is string => p !== null))].sort();
  const byFile = [...files].map(([file, item]) => ({ file, requests: item.requests, empty: item.empty,
    distinctPositions: item.positions.size, repeatedPositions: item.requests - item.positions.size,
    meanMs: item.totalMs / item.requests, maxMs: item.maxMs })).sort((a, b) => b.meanMs - a.meanMs);
  return { didOpen, didClose, packages, packageCount: packages.length, distinctFiles: opened.size, methods, firstAnswerMs, stages, analyzerStatus, byFile };
}
