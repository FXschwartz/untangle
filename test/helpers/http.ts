// Talks to a review the way the page does: the printed link's token, then the cookie.
export interface ReviewClient {
  readonly token: string;
  open(): Promise<{ status: number; location: string | null; cookie: string | null; text: string }>;
  /** The page, after the token has been traded for a cookie. */
  page(): Promise<{ status: number; text: string }>;
  call(route: string, init?: { method?: string; body?: unknown; head?: string; query?: Record<string, string> }): Promise<{ status: number; text: string; data: unknown }>;
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
