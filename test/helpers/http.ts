// Talks to a review the way the page does: the printed link's token, then the cookie.
import crypto from 'node:crypto';
import http from 'node:http';

/** The socket a page holds while it's open. */
export interface PresenceSocket {
  /** 101 once it's held, else the status of the refusal. */
  status: number;
  /** Drops the connection without a word, as a browser that destroys the page does. */
  drop(): void;
  /** Closes it as a browser does when the page goes: a close frame, answered in kind. */
  close(): Promise<void>;
  /** Settles once the connection has ended, whichever side ended it. */
  ended: Promise<void>;
}

export interface ReviewClient {
  readonly token: string;
  open(): Promise<{ status: number; location: string | null; cookie: string | null; text: string }>;
  /** The page, after the token has been traded for a cookie. */
  page(): Promise<{ status: number; text: string }>;
  call(route: string, init?: { method?: string; body?: unknown; head?: string; query?: Record<string, string> }): Promise<{ status: number; text: string; data: unknown }>;
  /** The presence socket of the page that made up this id. */
  socket(id: string): Promise<PresenceSocket>;
}

export function reviewClient(pageUrl: string): ReviewClient {
  const url = new URL(pageUrl);
  const token = url.searchParams.get('token') ?? '';
  const base = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  let cookie = '';

  async function request(pathname: string, search: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await fetch(`${url.origin}${pathname}${search}`, { ...init, headers, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0] ?? '';
    return res;
  }

  return {
    token,
    async open() {
      const res = await request(url.pathname, url.search);
      const text = await res.text();
      return { status: res.status, location: res.headers.get('location'), cookie: cookie || null, text };
    },
    async page() {
      const res = await request(base, '');
      return { status: res.status, text: await res.text() };
    },
    async call(route, init = {}) {
      const query = new URLSearchParams(init.query ?? {}).toString();
      const headers = new Headers();
      if (init.head) headers.set('x-untangle-head', init.head);
      if (init.body !== undefined) headers.set('content-type', 'application/json');
      const res = await request(`${base}api/${route}`, query ? `?${query}` : '', {
        method: init.method ?? 'GET',
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        // A refusal is plain text.
      }
      return { status: res.status, text, data };
    },
    socket(id) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          host: url.hostname,
          port: url.port,
          path: `${base}api/presence?id=${encodeURIComponent(id)}`,
          headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'), ...(cookie ? { cookie } : {}) },
        });
        req.on('upgrade', (res, socket) => {
          socket.on('error', () => {});
          // What the server sends (its pings, its close) is read and let go, so its end arrives.
          socket.resume();
          const ended = new Promise<void>((done) => socket.once('close', () => done()));
          resolve({
            status: res.statusCode ?? 101,
            drop: () => socket.destroy(),
            // A client's frames are masked: a close with an empty payload and a zero mask.
            close: () => { socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); return ended; },
            ended,
          });
        });
        req.on('response', (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, drop() {}, close: async () => {}, ended: Promise.resolve() });
        });
        req.on('error', reject);
        req.end();
      });
    },
  };
}

/** The review page, once the build has replaced the progress page. */
export async function waitForReview(client: ReviewClient): Promise<string> {
  const opened = await client.open();
  if (opened.status !== 302) throw new Error(`the printed link answered ${opened.status}: ${opened.text.slice(0, 200)}`);
  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    const page = await client.page();
    last = page.text;
    if (page.status === 200 && last.includes('id="d-model"')) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the review did not become ready\n${last.slice(0, 400)}`);
}

export function jsonScript(html: string, id: string): unknown {
  const marker = `id="${id}">`;
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`no ${id} in the page`);
  const start = at + marker.length;
  const end = html.indexOf('</script>', start);
  return JSON.parse(html.slice(start, end));
}
