// The local web server: the review page, its progress while it's built, and the page's API.
// Every request needs the token from the printed URL (kept in a cookie after the first visit).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Status } from './narrate.js';

export interface Api {
  /** The review page, once it's built. */
  page(): string | null;
  /** A generated file's diff: { hunks } or { error }. */
  generated(path: string): { hunks?: unknown; error?: string };
  /** Saves the page's marks and layout. */
  saveState(json: string): void;
}

export interface ServerOptions {
  host: string;
  port: number;
  /** Whether the port was asked for: if not, a busy port falls back to a free one. */
  portExplicit: boolean;
  basePath: string;
}

const MAX_BODY = 32 << 20;

export class ReviewServer {
  readonly token = crypto.randomBytes(18).toString('base64url');
  private server: http.Server | null = null;
  private cookie = '';

  constructor(
    private readonly opts: ServerOptions,
    private readonly status: Status,
    private readonly api: Api,
    private readonly progressPage: string,
    private readonly log: (line: string) => void,
  ) {}

  /** Listens, and returns the URL to open (with the token). */
  async listen(): Promise<string> {
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.send(res, 500, 'text/plain', String(e && e.message))));
    this.server = server;
    const tryPort = (port: number) => new Promise<number>((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve((server.address() as AddressInfo).port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.opts.host);
    });
    let port: number;
    try {
      port = await tryPort(this.opts.port);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.opts.portExplicit) throw new Error(`cannot listen on ${this.opts.host}:${this.opts.port}: ${(e as Error).message}`);
      port = await tryPort(0);
    }
    this.cookie = `untangle-${port}`;
    const shown = this.opts.host === '0.0.0.0' || this.opts.host === '::' ? '127.0.0.1' : this.opts.host.includes(':') ? `[${this.opts.host}]` : this.opts.host;
    return `http://${shown}:${port}${this.opts.basePath}?token=${this.token}`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private send(res: http.ServerResponse, code: number, type: string, body: string, headers: Record<string, string> = {}) {
    res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
    res.end(body);
  }

  private json(res: http.ServerResponse, code: number, data: unknown) {
    this.send(res, code, 'application/json', JSON.stringify(data));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const jar = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2));
    const got = Buffer.from(String(jar[this.cookie] || ''));
    const want = Buffer.from(this.token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://localhost');
    const base = this.opts.basePath;
    if (!url.pathname.startsWith(base)) {
      if (url.pathname === base.slice(0, -1)) return this.send(res, 302, 'text/plain', '', { location: base + url.search });
      return this.send(res, 404, 'text/plain', 'Not found');
    }
    const route = url.pathname.slice(base.length);
    this.log(`${req.method} /${route}${url.search ? ' ?' + [...url.searchParams.keys()].join('&') : ''}`);
    if (route === 'favicon.ico') return this.send(res, 204, 'text/plain', '');

    // The token from the printed URL becomes a cookie, and the address bar loses it.
    const token = url.searchParams.get('token');
    if (route === '' && token !== null) {
      if (token !== this.token) return this.send(res, 403, 'text/plain', 'This link’s token is not the one untangle printed. Open the link from the terminal.');
      return this.send(res, 302, 'text/plain', '', { location: base, 'set-cookie': `${this.cookie}=${this.token}; Path=${base}; HttpOnly; SameSite=Strict` });
    }
    if (!this.authorized(req)) return this.send(res, 403, 'text/plain', 'Open the link untangle printed in the terminal: it carries the token that lets this browser in.');

    if (route === '' && req.method === 'GET') {
      const page = this.api.page();
      return this.send(res, 200, 'text/html', page ?? this.progressPage);
    }
    if (route === 'api/status' && req.method === 'GET') return this.json(res, 200, this.status);
    if (route === 'api/generated' && req.method === 'GET') {
      const p = url.searchParams.get('p');
      if (!p) return this.json(res, 400, { error: 'which file? (p=)' });
      const out = this.api.generated(p);
      return this.json(res, out.error ? 404 : 200, out);
    }
    if (route === 'api/state' && req.method === 'PUT') {
      const body = await readBody(req);
      try {
        JSON.parse(body);
      } catch {
        return this.json(res, 400, { error: 'not JSON' });
      }
      this.api.saveState(body);
      return this.json(res, 200, { saved: true });
    }
    return this.send(res, 404, 'text/plain', 'Not found');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Writes a file through a temporary one, so a crash never leaves half of it. */
export function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
