// A headless Chromium through the DevTools protocol. No Puppeteer or Playwright.
// Snap Chromium cannot read the host's /tmp, so pages are opened over http only
// and its profile lives under the home directory.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export function findChrome(): string | null {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const name of ['chromium', 'google-chrome', 'chromium-browser']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (found) return found;
    } catch {
      // The next name.
    }
  }
  return null;
}

/** Why a browser test cannot run, or false when Chromium is available. */
export function browserSkip(): string | false {
  return findChrome() ? false : 'Chromium is not on PATH (CHROME_PATH, chromium, google-chrome, or chromium-browser)';
}

/** Why an end-to-end test cannot run, or false when Chromium and dart are available. */
export function e2eSkip(): string | false {
  const chrome = browserSkip();
  if (chrome) return chrome;
  try {
    execFileSync('which', ['dart'], { stdio: 'ignore' });
  } catch {
    return 'dart is not on PATH';
  }
  return false;
}

const KEYS: Record<string, { code: string; vk: number; text?: string; shift?: boolean }> = {
  Escape: { code: 'Escape', vk: 27 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Enter: { code: 'Enter', vk: 13 },
  Tab: { code: 'Tab', vk: 9 },
  ' ': { code: 'Space', vk: 32, text: ' ' },
  '?': { code: 'Slash', vk: 191, text: '?', shift: true },
};

export interface Browser {
  goto(url: string): Promise<void>;
  /** Polls a JS expression until it is truthy. Throws the expression if it never is. */
  until(expression: string, ms?: number): Promise<unknown>;
  eval(expression: string): Promise<unknown>;
  click(selector: string, opts?: { scroll?: boolean }): Promise<void>;
  /** Clicks the element whose own text is `name` and whose line contains `line`. */
  clickIn(selector: string, name: string, line: string): Promise<void>;
  shiftClick(selector: string): Promise<void>;
  doubleClick(selector: string): Promise<void>;
  /** Presses at the element's center, moves by `dx`/`dy`, and releases. */
  drag(selector: string, dx: number, dy: number): Promise<void>;
  /** Presses on `from` and releases on `onto`. */
  dragOnto(from: string, onto: string): Promise<void>;
  /** Clicks at a fraction of the element's box, 0 to 1 from the top left. */
  clickRatio(selector: string, xRatio: number, yRatio: number): Promise<void>;
  hover(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string, opts?: { shift?: boolean; ctrl?: boolean }): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  reducedMotion(on: boolean): Promise<void>;
  close(): Promise<void>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  result?: unknown;
  params?: { response?: { url?: string; status?: number } };
}

export async function launchBrowser(width = 1400, height = 900): Promise<Browser> {
  const bin = findChrome();
  if (!bin) throw new Error(String(browserSkip()));
  const profile = fs.mkdtempSync(path.join(os.homedir(), 'untangle-e2e-'));
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const browserUrl = await devtoolsUrl(child);
  const ws = new WebSocket(browserUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('the DevTools socket failed')));
  });
  let next = 0;
  let sessionId = '';
  const pending = new Map<number, (message: CdpMessage) => void>();
  const send = (method: string, params: Record<string, unknown> = {}, session?: string) => new Promise<CdpMessage>((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    ws.send(JSON.stringify({ id, method, params, sessionId: session }));
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    const message = JSON.parse(String(ev.data)) as CdpMessage;
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)!(message);
      pending.delete(message.id);
    }
    if (message.method === 'Page.javascriptDialogOpening' && sessionId) {
      void send('Page.handleJavaScriptDialog', { accept: true }, sessionId);
    }
  });
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const targetId = (created.result as { targetId: string }).targetId;
  const attached = await send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = (attached.result as { sessionId: string }).sessionId;
  const session = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
  await session('Page.enable');
  await session('Runtime.enable');
  await session('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression: string): Promise<unknown> => {
    const message = await session('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const result = message.result as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined;
    if (result?.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || expression);
    }
    return result?.result?.value;
  };

  const boxOf = async (selector: string, scroll: boolean) => {
    const box = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      if (${scroll ? 'true' : 'false'}) el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`) as { left: number; top: number; width: number; height: number } | null;
    if (!box) throw new Error(`no element matches ${selector}`);
    return box;
  };
  const at = async (x: number, y: number, type: string, modifiers: number, clickCount: number, buttons = 0) => {
    await session('Input.dispatchMouseEvent', { x, y, type, button: 'left', buttons, modifiers, clickCount, pointerType: 'mouse' });
  };
  const clickAt = async (x: number, y: number, modifiers: number, clickCount: number) => {
    await at(x, y, 'mouseMoved', modifiers, 0);
    await at(x, y, 'mousePressed', modifiers, clickCount);
    await at(x, y, 'mouseReleased', modifiers, clickCount);
  };
  const press = async (key: string, opts: { shift?: boolean; ctrl?: boolean }) => {
    const known = KEYS[key] ?? {
      code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key,
      vk: 0,
      text: key.length === 1 ? key : undefined,
    };
    const modifiers = ((opts.shift || known.shift) ? 8 : 0) + (opts.ctrl ? 2 : 0);
    const base = { key, code: known.code, windowsVirtualKeyCode: known.vk, modifiers };
    await session('Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
    if (known.text && !opts.ctrl) await session('Input.dispatchKeyEvent', { ...base, type: 'char', text: known.text });
    await session('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch { /* already closed */ }
    if (child.pid != null && child.exitCode == null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode != null || child.signalCode != null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (child.pid != null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
        }
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(profile, { recursive: true, force: true });
  };

  return {
    async goto(url: string) {
      await session('Page.navigate', { url });
      await poll(evaluate, 'document.readyState === "complete"', 20_000);
    },
    until(expression: string, ms = 20_000) {
      return poll(evaluate, expression, ms);
    },
    eval: evaluate,
    async click(selector: string, opts: { scroll?: boolean } = {}) {
      const box = await boxOf(selector, opts.scroll !== false);
      await clickAt(box.left + box.width / 2, box.top + box.height / 2, 0, 1);
    },
    async clickIn(selector: string, name: string, line: string) {
      const point = await evaluate(`(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => (node.textContent || '') === ${JSON.stringify(name)} && (node.closest('.ln, .sl, .pk-ln')?.textContent || '').includes(${JSON.stringify(line)}));
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`) as { x: number; y: number } | null;
      if (!point) throw new Error(`no ${selector} named ${name} on a line with ${line}`);
      await clickAt(point.x, point.y, 0, 1);
    },
    async shiftClick(selector: string) {
      const box = await boxOf(selector, true);
      await clickAt(box.left + box.width / 2, box.top + box.height / 2, 8, 1);
    },
    async doubleClick(selector: string) {
      const box = await boxOf(selector, true);
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      await clickAt(x, y, 0, 1);
      await clickAt(x, y, 0, 2);
    },
    async drag(selector: string, dx: number, dy: number) {
      const box = await boxOf(selector, true);
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      await at(x, y, 'mousePressed', 0, 1, 1);
      await at(x + dx, y + dy, 'mouseMoved', 0, 0, 1);
      await at(x + dx, y + dy, 'mouseReleased', 0, 1, 0);
    },
    async dragOnto(from: string, onto: string) {
      const points = await evaluate(`(() => {
        const start = document.querySelector(${JSON.stringify(from)});
        const end = document.querySelector(${JSON.stringify(onto)});
        if (!start || !end) return null;
        start.scrollIntoView({ block: 'center', inline: 'nearest' });
        const a = start.getBoundingClientRect();
        const b = end.getBoundingClientRect();
        return { x: a.left + a.width / 2, y: a.top + a.height / 2, x2: b.left + b.width / 2, y2: b.top + b.height / 2 };
      })()`) as { x: number; y: number; x2: number; y2: number } | null;
      if (!points) throw new Error(`cannot drag ${from} onto ${onto}`);
      await at(points.x, points.y, 'mousePressed', 0, 1, 1);
      await at(points.x2, points.y2, 'mouseMoved', 0, 0, 1);
      await at(points.x2, points.y2, 'mouseReleased', 0, 1, 0);
    },
    async clickRatio(selector: string, xRatio: number, yRatio: number) {
      const box = await boxOf(selector, true);
      await clickAt(box.left + box.width * xRatio, box.top + box.height * yRatio, 0, 1);
    },
    async hover(selector: string) {
      const box = await boxOf(selector, true);
      await at(box.left + box.width / 2, box.top + box.height / 2, 'mouseMoved', 0, 0);
    },
    async type(text: string) {
      for (const char of text) await press(char, {});
    },
    key(key: string, opts: { shift?: boolean; ctrl?: boolean } = {}) {
      return press(key, opts);
    },
    async setViewport(nextWidth: number, nextHeight: number) {
      await session('Emulation.setDeviceMetricsOverride', { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false });
    },
    async reducedMotion(on: boolean) {
      await session('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] });
    },
    close,
  };
}

async function poll(evaluate: (expression: string) => Promise<unknown>, expression: string, ms: number): Promise<unknown> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch {
      // The page is between loads.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${expression}`);
}

function devtoolsUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    let settled = false;
    const finish = (error: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url!);
    };
    const take = (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
      if (match) finish(null, match[1]);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => finish(new Error(`Chromium did not open a DevTools port\n${text}`)), 20_000);
    child.once('exit', (code) => finish(new Error(`Chromium exited ${code} before opening a DevTools port\n${text}`)));
  });
}

/** Serves a directory over http, for an exported page. Snap Chromium cannot open file://. */
export function staticServer(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = path.resolve(dir);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.resolve(root, name === '/' ? 'review.html' : `.${name}`);
      if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
