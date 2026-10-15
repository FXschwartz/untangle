#!/usr/bin/env node
import { ResponseError, createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';

const conn = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const events = [];
let hold = null;
let release = null;
let answers = [];
let probeErrors = 0;

conn.onNotification((method, params) => {
  events.push({ method, params });
  if (method === 'exit') process.exit(0);
});

conn.onRequest(async (method, params) => {
  if (method.startsWith('test/')) {
    if (method === 'test/events') return events;
    if (method === 'test/hold') hold = params.method;
    if (method === 'test/release') release?.();
    if (method === 'test/definitions') answers = params.answers;
    if (method === 'test/probe' && params.behavior === 'error once') probeErrors = 1;
    if (method === 'test/probe' && params.behavior === 'error twice') probeErrors = 2;
    return null;
  }

  events.push({ method, params });
  if (method === hold) {
    hold = null;
    await new Promise((resolve) => {
      release = resolve;
      conn.sendNotification('window/logMessage', { message: 'held' });
    });
  }

  if (method === 'initialize') return { capabilities: {} };
  if (method === 'textDocument/documentSymbol' && probeErrors > 0) {
    probeErrors--;
    throw new ResponseError(-32003, 'file cannot be resolved');
  }
  if (method === 'textDocument/definition') {
    const answer = answers.shift() ?? 'empty';
    if (answer === 'error') throw new ResponseError(-32801, 'contexts changed');
    if (answer === 'location') {
      return [{ uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }];
    }
  }
  return [];
});
conn.listen();
