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
  /** Static files the page loads (the highlighter, the fonts), by name. */
  asset(name: string): { type: string; body: Buffer } | null;
  /**
   * The page's API: api/<route>, with the query and the body (JSON) of the request, and the head
   * commit of the review the page shows (when it says).
   */
  call(route: string, method: string, query: URLSearchParams, body: unknown, head: string | null): Promise<{ status?: number; data: unknown }>;
}

/** The build's progress, and a way to wait for its next change. */
export interface Progressing {
  status: Status;
  next(fn: () => void): () => void;
}

export interface ServerOptions {
  host: string;
  port: number;
  /** Whether the port was asked for: if not, a busy port falls back to a free one. */
  portExplicit: boolean;
  basePath: string;
  /**
   * Called once the last page that said it opened has closed, no page opened again within
   * `after` ms (a reload), and no call is still being answered.
   */
  idle?: { after: number; then(): void };
}

const MAX_BODY = 32 << 20;
// How long the progress page's question waits for a change before it's answered anyway.
const STATUS_WAIT = 15_000;

export class ReviewServer {
  readonly token = crypto.randomBytes(18).toString('base64url');
  private server: http.Server | null = null;
  private cookie = '';
  // The pages open now, by the id each one made up, and the calls still being answered.
  private pages = new Set<string>();
  private calls = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: ServerOptions,
    private readonly progress: Progressing,
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  // A page says when it opens and when it closes (a reload does both).
  private presence(id: string, open: boolean) {
    if (open) {
      this.pages.add(id);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (!this.pages.delete(id) || this.pages.size || !this.opts.idle) return;
    const { after, then } = this.opts.idle;
    // A mark saved as the page went is still answered first.
    const wait = (ms: number) => {
      this.idleTimer = setTimeout(() => {
        if (this.pages.size) return;
        if (this.calls) return wait(250);
        this.idleTimer = null;
        then();
      }, ms);
    };
    wait(after);
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
    // The page asks for its metrics every few seconds, and for the build's progress at each change:
    // not worth a line each.
    if (route !== 'api/metrics' && route !== 'api/status') this.log(`${req.method} /${route}${url.search ? ' ?' + [...url.searchParams.keys()].join('&') : ''}`);
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
    if (route === 'api/status' && req.method === 'GET') {
      // Given the revision it shows, the progress page hears back at the next one.
      const seen = url.searchParams.get('rev');
      if (seen === null || Number(seen) !== this.progress.status.rev) return this.json(res, 200, this.progress.status);
      return new Promise<void>((resolve) => {
        let cancel = () => {};
        const answer = () => {
          clearTimeout(timer);
          cancel();
          if (!res.writableEnded && !res.destroyed) this.json(res, 200, this.progress.status);
          resolve();
        };
        const timer = setTimeout(answer, STATUS_WAIT);
        cancel = this.progress.next(answer);
        res.on('close', () => { clearTimeout(timer); cancel(); resolve(); });
      });
    }
    if (route.startsWith('assets/') && req.method === 'GET') {
      const a = this.api.asset(route.slice(7));
      if (!a) return this.send(res, 404, 'text/plain', 'Not found');
      // A versioned URL (?v=<hash>) never changes content, so it can be kept; any other, never.
      const caching = url.searchParams.has('v') ? 'private, max-age=31536000, immutable' : 'no-store';
      res.writeHead(200, { 'content-type': a.type, 'cache-control': caching, 'x-content-type-options': 'nosniff' });
      return res.end(a.body);
    }
    if (route.startsWith('api/')) {
      let body: unknown = null;
      if (req.method !== 'GET') {
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : null;
        } catch {
          return this.json(res, 400, { error: 'not JSON' });
        }
      }
      if (route === 'api/presence' && req.method === 'POST') {
        const said = body as { id?: unknown; open?: unknown } | null;
        if (!said || typeof said.id !== 'string' || typeof said.open !== 'boolean') return this.json(res, 400, { error: 'say which page (id) and whether it is open' });
        this.presence(said.id, said.open);
        return this.json(res, 200, { pages: this.pages.size });
      }
      this.calls++;
      try {
        const head = req.headers['x-untangle-head'];
        const out = await this.api.call(route.slice(4), req.method || 'GET', url.searchParams, body, typeof head === 'string' ? head : null);
        return this.json(res, out.status ?? 200, out.data);
      } catch (e) {
        return this.json(res, 500, { error: (e as Error).message });
      } finally {
        this.calls--;
      }
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
