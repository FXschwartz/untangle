#!/usr/bin/env node
// Observe the protocol without rewriting or delaying its bytes until a message is complete.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Transform } from 'node:stream';

const real = process.env.BENCH_REAL_DART;
if (!real) throw new Error('BENCH_REAL_DART must name the real Dart executable.');

const args = process.argv.slice(2);
const languageServer = args[0] === 'language-server';
if (languageServer && !process.env.BENCH_DART_CACHE) throw new Error('BENCH_DART_CACHE is required.');
if (languageServer) args.push(`--cache=${process.env.BENCH_DART_CACHE}`);

const startedAt = Date.now();
const started = performance.now();
const log = languageServer && process.env.BENCH_LSP_LOG
  ? fs.createWriteStream(process.env.BENCH_LSP_LOG, { flags: 'a' }) : null;
const requests = { client: new Map(), server: new Map() };

function observe(direction) {
  let buffer = Buffer.alloc(0);
  let length = null;

  return new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

      while (true) {
        if (length === null) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) break;
          const header = buffer.subarray(0, end).toString('ascii');
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) return callback(new Error('LSP frame has no Content-Length.'));
          length = Number(match[1]);
          buffer = buffer.subarray(end + 4);
        }
        if (buffer.length < length) break;

        const message = JSON.parse(buffer.subarray(0, length).toString('utf8'));
        const ms = performance.now() - started;
        const row = { ms, epochMs: Date.now(), monotonicMs: Number(process.hrtime.bigint()) / 1e6, direction, id: message.id };
        if (message.method) {
          row.method = message.method;
          row.kind = message.id === undefined ? 'notification' : 'request';
          row.uri = message.params?.textDocument?.uri ?? message.params?.item?.uri;
          row.position = message.params?.position ?? message.params?.item?.selectionRange?.start;
          if (message.method === 'workspace/symbol') row.query = message.params?.query;
          if (message.method === 'initialize') row.folders = message.params.workspaceFolders;
          if (['$/analyzerStatus', '$/progress', 'window/logMessage', 'window/showMessage'].includes(message.method)) row.params = message.params;
          if (message.id !== undefined) requests[direction].set(message.id, { method: message.method, uri: row.uri, ms });
        } else {
          const origin = direction === 'client' ? 'server' : 'client';
          const request = requests[origin].get(message.id);
          requests[origin].delete(message.id);
          row.kind = 'response';
          row.method = request?.method;
          row.uri = request?.uri;
          row.requestMs = request?.ms;
          row.durationMs = request ? ms - request.ms : null;
          row.empty = message.result == null || (Array.isArray(message.result) && message.result.length === 0);
          row.size = Array.isArray(message.result) ? message.result.length : message.result == null ? 0 : 1;
          row.bytes = Buffer.byteLength(JSON.stringify(message.result ?? null));
          if (['textDocument/definition', 'workspace/symbol'].includes(row.method)) row.result = message.result;
          if (message.error) row.error = message.error;
        }
        log?.write(JSON.stringify(row) + '\n');
        buffer = buffer.subarray(length);
        length = null;
      }
      callback();
    },
  });
}

// The child inherits the detached group untangle gave this shim.
const child = spawn(real, args, { stdio: languageServer && log ? ['pipe', 'pipe', 'inherit'] : 'inherit' });
if (languageServer && process.env.BENCH_DART_PID) {
  fs.writeFileSync(process.env.BENCH_DART_PID, JSON.stringify({ shim: process.pid, launcher: child.pid, startedAt, real, args }));
}
if (languageServer && log) {
  process.stdin.pipe(observe('client')).pipe(child.stdin);
  child.stdout.pipe(observe('server')).pipe(process.stdout);
  child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
}

const handlers = new Map();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  const handler = () => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  handlers.set(signal, handler);
  process.on(signal, handler);
}

child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  log?.end();
  process.exitCode = 127;
});
child.on('close', (code, signal) => {
  const finish = () => {
    if (signal) {
      for (const [name, handler] of handlers) process.off(name, handler);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  };
  if (log) log.end(finish);
  else finish();
});
