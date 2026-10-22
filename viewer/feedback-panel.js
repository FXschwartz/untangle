// The Feedback panel: a picture of the page as you see it, marked up, with your words and what
// untangle knows, filed as an issue on untangle's repository through gh, or finished on GitHub's
// own form. `npm run build` bundles this file with modern-screenshot into dist/feedback-panel.js. The
// review's page and the Reviews page load it, and open it with what only they know:
// window.UntangleFeedback.open(host).
import { domToCanvas } from 'modern-screenshot';

const REPO = 'marcelomendoncasoares/untangle';
// The marks: a red untangle never uses, so they read as yours.
const INK = '#FF6B5E';
// A hidden word: a bar of its length.
const BAR = '#34343C';
// GitHub answers a longer new-issue link with 414.
const WEB_MAX = 6000;

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICON = {
  arrow: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13L12.5 3.5M6.5 3.5h6v6"/></svg>',
  box: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/></svg>',
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 11.5c2-3 3.5-6.5 5.5-6.5s.5 6 2.5 6 2-3 3-4.5"/></svg>',
  hide: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="4.5" width="11" height="7" rx="1"/><path d="M5 11.5l4-7M8.5 11.5l4-7" stroke-width="1.2"/></svg>',
  undo: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5L2.5 6.5l3 3"/><path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7h-3"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
};
const TOOLS = [['arrow', 'Arrow'], ['box', 'Box'], ['pen', 'Pen'], ['hide', 'Hide']];

const STYLE = `
.fbk-scrim { position: fixed; inset: 0; z-index: 900; background: rgba(5, 5, 7, .62); }
.fbk { position: fixed; z-index: 901; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(1180px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: grid; grid-template-rows: auto minmax(0, 1fr); border-radius: 14px; background: var(--raised); box-shadow: 0 0 0 1px var(--hair-2), 0 24px 64px rgba(0, 0, 0, .7); color: var(--text); font: 400 13px/1.45 var(--ui); -webkit-font-smoothing: antialiased; }
.fbk[hidden], .fbk-scrim[hidden], .fbk-take[hidden] { display: none; }
.fbk-h { display: flex; align-items: center; gap: 14px; padding: 12px 12px 12px 20px; }
.fbk-h > b { font: 600 14px/1.2 var(--ui); }
.fbk-seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px; background: var(--sheet); }
.fbk-seg button { appearance: none; border: 0; background: none; color: var(--text-2); font: 600 12px/1 var(--ui); padding: 6px 11px; border-radius: 6px; cursor: pointer; }
.fbk-seg button[aria-pressed="true"] { background: var(--hover); color: var(--text); }
.fbk-sp { flex: 1; }
.fbk-x { appearance: none; border: 0; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border-radius: 7px; background: none; color: var(--text-2); cursor: pointer; }
.fbk-x:hover { background: var(--hover); color: var(--text); }
.fbk-x svg { width: 14px; height: 14px; }
.fbk-b { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 20px; padding: 0 20px 20px; min-height: 0; overflow: auto; }
.fbk-pic { display: grid; gap: 8px; align-content: start; min-width: 0; }
.fbk-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.fbk-tools button { appearance: none; border: 0; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 7px; background: none; color: var(--text-2); font: 600 12px/1 var(--ui); cursor: pointer; white-space: nowrap; }
.fbk-tools button:hover { background: var(--hover); color: var(--text); }
.fbk-tools button[aria-pressed="true"] { background: rgba(255, 107, 94, .14); color: #FF9C92; }
.fbk-tools button:disabled { opacity: .4; cursor: default; background: none; }
.fbk-tools svg { width: 14px; height: 14px; flex: none; }
.fbk-tools i { width: 1px; height: 18px; margin: 0 6px; background: var(--hair-2); }
.fbk-board { position: relative; width: 100%; border-radius: 8px; overflow: hidden; background: var(--ground); box-shadow: 0 0 0 1px var(--hair-2); }
.fbk-board canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }
.fbk-board canvas.ink { cursor: crosshair; touch-action: none; }
.fbk-board .fbk-wait { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-3); font-size: 12.5px; }
.fbk-board .fbk-wait[hidden] { display: none; }
.fbk-hint { font-size: 12px; color: var(--text-3); }
.fbk-form { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.fbk-lab { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font: 600 12.5px/1.3 var(--ui); }
.fbk-lab span { font-weight: 400; font-size: 11.5px; color: var(--text-3); }
.fbk-form textarea { flex: 0 1 176px; min-height: 96px; width: 100%; resize: vertical; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--sheet); box-shadow: inset 0 0 0 1px var(--hair-2); color: var(--text); font: 400 13px/1.5 var(--ui); outline: none; }
.fbk-form textarea:focus { box-shadow: inset 0 0 0 1px var(--text-3); }
.fbk-chk { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 2px 8px; align-items: start; font: 500 12.5px/1.35 var(--ui); cursor: pointer; }
.fbk-chk input { margin: 1px 0 0; width: 14px; height: 14px; accent-color: ${INK}; }
.fbk-chk small { grid-column: 2; font-size: 11.5px; font-weight: 400; line-height: 1.4; color: var(--text-3); }
.fbk-goes { padding: 9px 12px; border-radius: 8px; background: var(--sheet); }
.fbk-goes summary { cursor: pointer; font: 600 12.5px/1.3 var(--ui); }
.fbk-goes summary span { font-weight: 400; color: var(--text-3); }
.fbk-goes ul { margin: 9px 0 2px; padding: 0; list-style: none; display: grid; gap: 6px; max-height: 220px; overflow-y: auto; }
.fbk-goes label { display: grid; grid-template-columns: 14px 76px minmax(0, 1fr); gap: 8px; font: 400 11.5px/1.4 var(--ui); color: var(--text-2); cursor: pointer; }
.fbk-goes label b { font-weight: 600; color: var(--text); }
.fbk-goes label span { overflow-wrap: anywhere; }
.fbk-goes input { margin: 1px 0 0; width: 13px; height: 13px; accent-color: ${INK}; }
.fbk-log { margin: 4px 0 0 98px; }
.fbk-log summary { cursor: pointer; font-size: 11.5px; color: var(--text-3); }
.fbk-log pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 6px; background: var(--ground); color: var(--text-2); font: 400 11px/1.5 var(--code); white-space: pre; overflow-x: auto; }
.fbk-err { font-size: 12.5px; color: var(--del-ink); }
.fbk-err[hidden] { display: none; }
.fbk-dest { font-size: 11.5px; line-height: 1.45; color: var(--text-3); }
.fbk-dest b { color: var(--text-2); font-weight: 600; }
.fbk-acts { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 16px; }
.fbk-link { appearance: none; border: 0; background: none; padding: 0; color: var(--text-2); font: 500 12.5px/1 var(--ui); text-decoration: underline; text-decoration-color: var(--text-4); text-underline-offset: 3px; cursor: pointer; }
.fbk-link:hover, .fbk-link.on { color: var(--text); }
.fbk-send { appearance: none; border: 0; height: 32px; padding: 0 18px; border-radius: 8px; background: var(--text); color: var(--ground); font: 600 13px/1 var(--ui); cursor: pointer; }
.fbk-send:disabled { opacity: .45; cursor: default; }
.fbk-ok { display: grid; gap: 10px; padding: 12px 14px; border-radius: 10px; background: var(--sheet); box-shadow: inset 0 0 0 1px var(--hair-2); }
.fbk-ok[hidden], .fbk-acts[hidden], .fbk-dest[hidden] { display: none; }
.fbk-ok > b { font: 600 13px/1.3 var(--ui); }
.fbk-ok ul { margin: 0; padding: 0 0 0 18px; display: grid; gap: 6px; font-size: 12.5px; line-height: 1.45; color: var(--text-2); }
.fbk-ok li b { color: var(--text); font-weight: 600; }
.fbk-ok code { font: 500 11.5px/1 var(--code); color: var(--text); background: var(--hover); padding: .15em .35em; border-radius: 4px; }
.fbk-take { position: fixed; z-index: 901; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; height: 44px; padding: 0 8px 0 16px; border-radius: 999px; background: var(--raised); box-shadow: 0 0 0 1px var(--hair-2), 0 12px 32px rgba(0, 0, 0, .55); color: var(--text-2); font: 500 12.5px/1 var(--ui); white-space: nowrap; }
.fbk-take button { appearance: none; border: 0; height: 30px; padding: 0 12px; border-radius: 999px; background: var(--hover); color: var(--text); font: 600 12.5px/1 var(--ui); cursor: pointer; }
.fbk-take button.go { background: var(--text); color: var(--ground); }
.fbk-toast { position: fixed; z-index: 902; left: 50%; bottom: 24px; transform: translate(-50%, 8px); max-width: min(620px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 10px; background: var(--hover); box-shadow: 0 0 0 1px var(--hair-2), 0 12px 32px rgba(0, 0, 0, .55); color: var(--text); font: 500 12.5px/1.45 var(--ui); opacity: 0; transition: opacity 200ms ease, transform 200ms ease; pointer-events: none; }
.fbk-toast.on { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.fbk-toast a { color: var(--text); margin-left: 8px; }
@media (max-width: 960px) {
  .fbk-b { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 560px) {
  .fbk { left: 0; top: 0; transform: none; width: 100%; height: 100%; max-height: none; border-radius: 0; }
  .fbk-b { padding: 0 16px 16px; }
}
@media (prefers-reduced-motion: reduce) { .fbk-toast { transition: none; } }
`;

let styled = false;
const style = () => {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
};

// ---------- The picture

// Every word of `root` that matches `selector` becomes a bar of its length, in the copy the
// picture is drawn from: the page you see never changes. The map's labels are SVG text, whose
// characters become blocks; a field's value goes.
function hideText(root, selector) {
  const words = (el) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walk.nextNode()) texts.push(walk.currentNode);
    for (const t of texts) {
      const parent = t.parentNode;
      if (!parent || !/\S/.test(t.textContent)) continue;
      if (parent instanceof SVGElement) {
        t.textContent = t.textContent.replace(/\S/g, '█');
        parent.style.fill = BAR;
        continue;
      }
      const frag = document.createDocumentFragment();
      for (const part of t.textContent.split(/(\s+)/)) {
        if (!part) continue;
        if (!/\S/.test(part)) { frag.append(part); continue; }
        const bar = document.createElement('span');
        bar.textContent = part;
        bar.style.cssText = `color: transparent; -webkit-text-fill-color: transparent; background: ${BAR}; border-radius: 2px; text-shadow: none`;
        frag.append(bar);
      }
      parent.replaceChild(frag, t);
    }
  };
  const hits = root.matches && root.matches(selector) ? [root] : [];
  root.querySelectorAll(selector).forEach((el) => { if (!hits.some((h) => h.contains(el))) hits.push(el); });
  for (const el of hits) {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) { el.value = ''; el.textContent = ''; el.removeAttribute('placeholder'); continue; }
    if (el instanceof HTMLImageElement) { el.style.visibility = 'hidden'; continue; }
    words(el);
  }
}

// The page as it shows now, at the screen's resolution (2× at most), without the panel.
async function capture(selector) {
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const bg = getComputedStyle(document.body).backgroundColor;
  const canvas = await domToCanvas(document.documentElement, {
    width: window.innerWidth,
    height: window.innerHeight,
    scale,
    backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#0B0B0D',
    filter: (node) => !(node instanceof Element && node.hasAttribute('data-fbk')),
    features: { restoreScrollPosition: true },
    onCloneNode: selector ? (clone) => hideText(clone, selector) : null,
  });
  return { canvas, scale };
}

// ---------- The marks: shapes in fractions of the picture, drawn at its size

function drawShape(c, s, w, h, unit) {
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const P = (p) => [p.x * w, p.y * h];
  if (s.tool === 'pen') {
    c.strokeStyle = INK;
    c.lineWidth = 3.5 * unit;
    c.beginPath();
    s.pts.forEach((p, i) => (i ? c.lineTo(...P(p)) : c.moveTo(...P(p))));
    c.stroke();
    c.restore();
    return;
  }
  const [ax, ay] = P(s.a), [bx, by] = P(s.b);
  const x = Math.min(ax, bx), y = Math.min(ay, by), bw = Math.abs(bx - ax), bh = Math.abs(by - ay);
  if (s.tool === 'hide') {
    c.fillStyle = '#0B0B0D';
    c.fillRect(x, y, bw, bh);
    c.beginPath();
    c.rect(x, y, bw, bh);
    c.clip();
    c.strokeStyle = '#26262D';
    c.lineWidth = 2 * unit;
    for (let d = -bh; d < bw; d += 9 * unit) { c.beginPath(); c.moveTo(x + d, y + bh); c.lineTo(x + d + bh, y); c.stroke(); }
  } else if (s.tool === 'box') {
    c.strokeStyle = INK;
    c.lineWidth = 3.5 * unit;
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, bw, bh, 6 * unit); else c.rect(x, y, bw, bh);
    c.stroke();
  } else {
    const ang = Math.atan2(by - ay, bx - ax), L = 17 * unit;
    c.strokeStyle = INK;
    c.fillStyle = INK;
    c.lineWidth = 4 * unit;
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx - Math.cos(ang) * L * 0.7, by - Math.sin(ang) * L * 0.7);
    c.stroke();
    c.beginPath();
    c.moveTo(bx, by);
    c.lineTo(bx - L * Math.cos(ang - 0.42), by - L * Math.sin(ang - 0.42));
    c.lineTo(bx - L * Math.cos(ang + 0.42), by - L * Math.sin(ang + 0.42));
    c.closePath();
    c.fill();
  }
  c.restore();
}

// ---------- What goes with it

const cell = (t) => String(t).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const age = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

// The browser, as its user agent names it.
function browser() {
  const ua = navigator.userAgent;
  const named = [[/Edg\/(\d+)/, 'Edge'], [/OPR\/(\d+)/, 'Opera'], [/Firefox\/(\d+)/, 'Firefox'], [/Electron\/(\d+)/, 'Electron'], [/Chrome\/(\d+)/, /Chromium/.test(ua) ? 'Chromium' : 'Chrome'], [/Version\/(\d+)[\d.]* Safari/, 'Safari']];
  for (const [re, name] of named) { const m = re.exec(ua); if (m) return `${name} ${m[1]}`; }
  return 'an unknown browser';
}

// ---------- The panel

let kept = { text: '', kind: 'bug' };
let current = null, opening = false;
let toastTimer = 0;

function toast(html) {
  style();
  let el = document.querySelector('.fbk-toast');
  if (!el) { el = document.createElement('div'); el.className = 'fbk-toast'; el.setAttribute('role', 'status'); el.setAttribute('data-fbk', ''); document.body.appendChild(el); }
  el.innerHTML = html;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 7000);
}

/**
 * Opens the panel. `host`: { page: 'review' | 'reviews', api(path, init) → fetch Response,
 * facts() → [{ id, k, v, hidden? }] (what only the page knows; `hidden` is the value when the
 * repository's text is hidden, null to leave it out then), repoText: the selector of the
 * repository's text on this page, offline: true when untangle isn't answering, draft: a draft
 * from `untangle feedback` }.
 */
async function open(host) {
  if (current) { current.focus(); return; }
  if (opening) return;
  opening = true;
  style();
  const api = (path, init) => host.api(path, init);
  // What untangle knows, unless it isn't answering: a few seconds, then the panel opens without it.
  const asking = new AbortController(), cut = setTimeout(() => asking.abort(), 4000);
  const ctx = host.offline ? null : await api('api/feedback', { signal: asking.signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null).finally(() => { clearTimeout(cut); opening = false; });
  opening = false;
  const draft = host.draft || (ctx && ctx.draft) || null;
  const repo = (ctx && ctx.repo) || REPO;
  const login = ctx && ctx.gh && ctx.gh.login;
  const isPublic = !!(ctx && ctx.review && ctx.review.public === true);
  const st = {
    kind: draft && draft.kind === 'idea' ? 'idea' : kept.kind,
    tool: 'arrow',
    include: true,
    hidden: !isPublic,
    shapes: [],
    off: new Set(),
    pics: { shown: null, hidden: null },
    custom: null,
    sending: false,
  };

  const scrim = document.createElement('div');
  scrim.className = 'fbk-scrim';
  scrim.setAttribute('data-fbk', '');
  const el = document.createElement('div');
  el.className = 'fbk';
  el.setAttribute('data-fbk', '');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Feedback for untangle');
  const take = document.createElement('div');
  take.className = 'fbk-take';
  take.setAttribute('data-fbk', '');
  take.hidden = true;
  take.innerHTML = '<span>Go to what the picture should show</span><button type="button" data-fb="cancel-take">Cancel</button><button type="button" class="go" data-fb="take">Take it</button>';
  const reviewNote = !ctx ? 'untangle isn’t answering, so it can’t say whether this repository is public: it’s hidden.'
    : ctx.review && ctx.review.repo ? (isPublic ? `${esc(ctx.review.repo)} is public, so it starts off.` : `${esc(ctx.review.repo)} isn’t public, or untangle can’t tell, so it starts on.`)
    : ctx.review ? 'untangle can’t tell whether this repository is public, so it starts on.' : 'It starts on.';
  el.innerHTML = `<div class="fbk-h"><b>Feedback for untangle</b><div class="fbk-seg" role="group" aria-label="Kind"><button type="button" data-kind="bug">Bug</button><button type="button" data-kind="idea">Idea</button></div><span class="fbk-sp"></span><button type="button" class="fbk-x" data-fb="close" aria-label="Close" title="Close (Esc)">${ICON.close}</button></div>`
    + '<div class="fbk-b"><div class="fbk-pic">'
    + `<div class="fbk-tools" role="toolbar" aria-label="Marks">${TOOLS.map(([t, label]) => `<button type="button" data-tool="${t}">${ICON[t]}${label}</button>`).join('')}<i></i><button type="button" data-fb="undo">${ICON.undo}Undo</button><button type="button" data-fb="clear">Clear</button><span class="fbk-sp"></span><button type="button" data-fb="retake" title="Go to something else on the page, and take the picture again">Retake</button></div>`
    + '<div class="fbk-board"><canvas class="pic"></canvas><canvas class="ink" aria-label="Draw on the picture"></canvas><div class="fbk-wait">Taking the picture…</div></div>'
    + '<p class="fbk-hint">Drawing on it checks Include the picture. Paste or drop an image to send your own instead.</p>'
    + '</div><div class="fbk-form">'
    + '<label class="fbk-lab" for="fbk-text">What happened <span>The first line is the issue’s title</span></label>'
    + '<textarea id="fbk-text" spellcheck="true" placeholder="What you did, what you saw, and what you expected"></textarea>'
    + '<label class="fbk-chk"><input type="checkbox" data-fb="include"><span>Include the picture</span></label>'
    + `<label class="fbk-chk"><input type="checkbox" data-fb="hidden"><span>Hide the repository’s text</span><small>Every name, path, message and line of code becomes a bar, in the picture and in what untangle adds. ${reviewNote} Your words go as you write them.</small></label>`
    + '<details class="fbk-goes"><summary>Goes with it <span></span></summary><ul></ul></details>'
    + '<p class="fbk-err" role="alert" hidden></p>'
    + '<span class="fbk-sp"></span>'
    + `<p class="fbk-dest">An issue on <b>${esc(repo)}</b>, which is public, filed as you through gh${login ? ` (${esc(login)})` : ''}. Send shows what it uploads, and waits for your yes.</p>`
    + '<div class="fbk-ok" role="group" aria-label="What Send does" hidden></div>'
    + '<div class="fbk-acts"><button type="button" class="fbk-link" data-fb="web">Open on GitHub instead</button><button type="button" class="fbk-send" data-fb="send">Send</button></div>'
    + '</div></div>';
  document.body.append(scrim, el, take);

  const $ = (sel) => el.querySelector(sel);
  const text = $('textarea'), board = $('.fbk-board'), pic = $('canvas.pic'), ink = $('canvas.ink'), wait = $('.fbk-wait');
  const err = $('.fbk-err'), sendBtn = $('[data-fb="send"]'), webBtn = $('[data-fb="web"]'), goes = $('.fbk-goes');
  const ok = $('.fbk-ok'), acts = $('.fbk-acts'), dest = $('.fbk-dest');
  text.value = draft && draft.text ? draft.text : kept.text;
  if (draft) api('api/feedback/draft', { method: 'DELETE' }).catch(() => {});

  // The picture on the board: the page's, hidden or not, or your own.
  const showing = () => st.custom || (st.hidden ? st.pics.hidden : st.pics.shown);
  const unitOf = (p) => (p ? p.scale : 1);
  function paint() {
    const p = showing();
    wait.hidden = !!p;
    if (!p) return;
    const c = p.canvas;
    if (pic.width !== c.width || pic.height !== c.height) { pic.width = c.width; pic.height = c.height; ink.width = c.width; ink.height = c.height; }
    board.style.aspectRatio = `${c.width} / ${c.height}`;
    const pc = pic.getContext('2d');
    pc.clearRect(0, 0, pic.width, pic.height);
    pc.drawImage(c, 0, 0);
    const ic = ink.getContext('2d');
    ic.clearRect(0, 0, ink.width, ink.height);
    st.shapes.forEach((s) => drawShape(ic, s, ink.width, ink.height, unitOf(p)));
  }
  board.style.aspectRatio = `${window.innerWidth} / ${window.innerHeight}`;

  // Takes the picture the board needs, and the other one after, so the switch is instant.
  let taking = null;
  const takeBoth = () => (taking ??= (async () => {
    const first = st.hidden ? 'hidden' : 'shown';
    const order = [first, first === 'hidden' ? 'shown' : 'hidden'];
    for (const which of order) {
      if (!current || st.pics[which]) continue;
      try {
        st.pics[which] = await capture(which === 'hidden' ? host.repoText : null);
      } catch (e) {
        wait.textContent = 'untangle couldn’t take the picture: paste or drop one instead.';
        break;
      }
      paint();
    }
    taking = null;
  })());

  function goesItems() {
    const items = [];
    if (ctx) {
      items.push({ id: 'version', k: 'untangle', v: `${ctx.version}${ctx.commit ? `, at ${ctx.commit}` : ''}` });
      const s = ctx.system || {};
      items.push({ id: 'system', k: 'System', v: [`${s.platform}/${s.arch}${s.release ? ' ' + s.release : ''}`, s.node && `Node ${s.node}`, `git ${s.git || 'missing'}`, `gh ${s.gh || 'missing'}`].filter(Boolean).join(' · ') });
    }
    items.push({ id: 'browser', k: 'Browser', v: `${browser()} · a window of ${window.innerWidth}×${window.innerHeight}, at ${Math.round((window.devicePixelRatio || 1) * 100) / 100}×` });
    for (const f of host.facts()) {
      const v = st.hidden && f.hidden !== undefined ? f.hidden : f.v;
      if (v != null && v !== '') items.push({ id: f.id, k: f.k, v });
    }
    if (draft && draft.details) draft.details.forEach((d, i) => items.push({ id: `draft${i}`, k: d.k, v: d.v }));
    if (draft && draft.running && draft.running.length) items.push({ id: 'running', k: 'Running', v: draft.running.map((r) => `${r.command} · pid ${r.pid} · ${age(r.seconds)}`).join('; ') });
    const log = logLines();
    if (log.length) items.push({ id: 'log', k: 'Its log', v: `the last ${log.length} lines, paths and tokens taken out` });
    return items;
  }
  // untangle's log. Hidden, only its own lines: each step, how it ended, and errors. A step's
  // details name the repository, its title and its files, so they stay out.
  function logLines() {
    const lines = (ctx && ctx.log) || [];
    if (!st.hidden) return lines;
    const named = ctx && ctx.review && ctx.review.repo;
    return lines.filter((l) => /^\s*(?:✓|✗|…|error:)/.test(l) && !(named && l.includes(named)));
  }
  function renderGoes() {
    const items = goesItems();
    // The log goes as it shows here, line by line.
    const log = logLines();
    $('.fbk-goes ul').innerHTML = items.map((g) => `<li><label><input type="checkbox" data-go="${esc(g.id)}"${st.off.has(g.id) ? '' : ' checked'}><b>${esc(g.k)}</b><span>${esc(g.v)}</span></label>${g.id === 'log' ? `<details class="fbk-log"><summary>Show them</summary><pre>${esc(log.join('\n'))}</pre></details>` : ''}</li>`).join('');
    $('.fbk-goes summary span').textContent = `· ${items.filter((g) => !st.off.has(g.id)).length} of ${items.length}`;
  }

  function sync() {
    el.querySelectorAll('[data-tool]').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.tool === st.tool)); });
    el.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === st.kind)));
    $('[data-fb="include"]').checked = st.include;
    const hid = $('[data-fb="hidden"]');
    hid.checked = st.hidden;
    hid.disabled = !!st.custom;
    $('[data-fb="undo"]').disabled = !st.shapes.length;
    $('[data-fb="clear"]').disabled = !st.shapes.length;
    const words = text.value.trim();
    sendBtn.disabled = st.sending || !words || !ctx || !(ctx.gh && ctx.gh.ready);
    sendBtn.textContent = st.sending ? 'Sending…' : 'Send';
    sendBtn.title = !ctx ? 'untangle isn’t answering: open it on GitHub instead' : !(ctx.gh && ctx.gh.ready) ? 'gh isn’t signed in: open it on GitHub instead' : !words ? 'Say what happened first' : 'File it as an issue, as you, through gh';
    webBtn.classList.toggle('on', !ctx || !(ctx.gh && ctx.gh.ready));
    renderGoes();
    paint();
  }

  // Drawing, in fractions of the board whatever its size.
  let live = null;
  const at = (e) => { const r = ink.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  ink.addEventListener('pointerdown', (e) => {
    if (e.button || !showing()) return;
    e.preventDefault();
    ink.setPointerCapture(e.pointerId);
    const p = at(e);
    live = st.tool === 'pen' ? { tool: 'pen', pts: [p] } : { tool: st.tool, a: p, b: p };
    st.shapes.push(live);
    paint();
  });
  ink.addEventListener('pointermove', (e) => {
    if (!live) return;
    const p = at(e);
    if (live.tool === 'pen') live.pts.push(p); else live.b = p;
    paint();
  });
  const end = () => {
    if (!live) return;
    const s = live;
    live = null;
    const r = ink.getBoundingClientRect();
    const span = s.tool === 'pen' ? s.pts.length : Math.hypot((s.b.x - s.a.x) * r.width, (s.b.y - s.a.y) * r.height);
    if (span < (s.tool === 'pen' ? 3 : 6)) st.shapes.pop(); else st.include = true;
    sync();
  };
  ink.addEventListener('pointerup', end);
  ink.addEventListener('pointercancel', end);

  // An image of your own, pasted or dropped, in place of the page's.
  const own = (file) => {
    if (!file || !/^image\//.test(file.type)) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      st.custom = { canvas: c, scale: Math.max(1, c.width / 1600) };
      st.shapes = [];
      st.include = true;
      sync();
    };
    img.src = url;
  };
  board.addEventListener('dragover', (e) => e.preventDefault());
  board.addEventListener('drop', (e) => { e.preventDefault(); own(e.dataTransfer && e.dataTransfer.files[0]); });
  el.addEventListener('paste', (e) => {
    const file = [...((e.clipboardData && e.clipboardData.files) || [])].find((f) => /^image\//.test(f.type));
    if (file) { e.preventDefault(); own(file); }
  });

  // The picture with its marks, as the issue shows it.
  function composite() {
    const p = showing();
    if (!p || !st.include) return null;
    const c = document.createElement('canvas');
    c.width = p.canvas.width;
    c.height = p.canvas.height;
    const x = c.getContext('2d');
    x.drawImage(p.canvas, 0, 0);
    st.shapes.forEach((s) => drawShape(x, s, c.width, c.height, unitOf(p)));
    return c;
  }
  const words = () => {
    const lines = text.value.replace(/\r/g, '').split('\n');
    const title = (lines.shift() || '').trim();
    return { title: title.slice(0, 256), rest: lines.join('\n').trim() };
  };
  // What untangle adds, as a table, and its log.
  function details(forWeb) {
    const items = goesItems().filter((g) => !st.off.has(g.id) && g.id !== 'log');
    const sum = items.filter((g) => ['version', 'system', 'browser', 'view'].includes(g.id)).map((g) => (g.id === 'version' ? `untangle ${g.v}` : g.id === 'system' ? g.v.split(' · ')[0] : g.v.split(' · ')[0])).join(' · ') || 'What untangle adds';
    const rows = items.map((g) => `| ${cell(g.k)} | ${cell(g.v)} |`).join('\n');
    const log = st.off.has('log') ? [] : logLines();
    const table = rows ? `| | |\n| --- | --- |\n${rows}` : '';
    const fence = log.length ? '```\n' + log.join('\n').replace(/```/g, "'''") + '\n```' : '';
    if (forWeb) return { table, fence };
    return `<details><summary>${esc(sum)}</summary>\n\n${table}${fence ? '\n\n' + fence : ''}\n\n</details>`;
  }
  function body() {
    const { rest } = words();
    return [rest, st.include && showing() ? '{{picture}}' : '', details(false)].filter(Boolean).join('\n\n');
  }
  // GitHub's form, filled in, within its length: the log goes first, then the table.
  function webUrl() {
    const { title, rest } = words();
    const d = details(true);
    const marker = `<!-- untangle-feedback kind=${st.kind} -->`;
    const make = (table, fence) => `https://github.com/${repo}/issues/new?` + new URLSearchParams({ template: `${st.kind}.yml`, title: title || 'Feedback from untangle', what: rest || title, details: [table, fence, marker].filter(Boolean).join('\n\n') }).toString();
    let url = make(d.table, d.fence);
    if (url.length > WEB_MAX) url = make(d.table, '');
    if (url.length > WEB_MAX) url = make('', '');
    return url.slice(0, WEB_MAX);
  }

  function close() {
    kept = { text: text.value, kind: st.kind };
    current = null;
    removeEventListener('keydown', onKey, true);
    scrim.remove();
    el.remove();
    take.remove();
    if (host.onClose) host.onClose();
  }
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    if (!take.hidden) { take.hidden = true; el.hidden = scrim.hidden = false; return; }
    close();
  };
  addEventListener('keydown', onKey, true);

  // Send says what will happen, and nothing leaves until you say yes: with a picture, a new secret
  // gist in your account, which anyone with its link can open, and the public issue that shows it.
  function ask() {
    if (!words().title || st.sending) return;
    const who = login ? `<b>${esc(login)}</b>` : 'your GitHub account';
    const pic = st.include && showing();
    ok.innerHTML = '<b>Before anything leaves this machine</b><ul>'
      + (pic ? `<li>untangle makes a <b>new secret gist</b> in ${login ? `your GitHub account, ${who}` : who}, with this picture. Secret means unlisted: anyone with its link can open it.</li>` : '')
      + `<li>It files a <b>public issue</b> on <b>${esc(repo)}</b>, as ${who}${pic ? ', that shows the picture' : ''}.</li>`
      + (pic ? '<li>The gist stays yours: <code>untangle feedback -list</code> lists them, and you can delete one any time. Its issue then shows a broken picture.</li>' : '')
      + `</ul><div class="fbk-acts"><button type="button" class="fbk-link" data-fb="back">Back</button><button type="button" class="fbk-send" data-fb="approve">${pic ? 'Upload the picture and file it' : 'File the issue'}</button></div>`;
    ok.hidden = false;
    acts.hidden = dest.hidden = true;
    ok.querySelector('[data-fb="approve"]').focus();
  }
  function back() {
    ok.hidden = true;
    ok.innerHTML = '';
    acts.hidden = dest.hidden = false;
  }
  async function send() {
    const { title } = words();
    if (!title || st.sending) return;
    st.sending = true;
    err.hidden = true;
    const yes = ok.querySelector('[data-fb="approve"]');
    if (yes) { yes.disabled = true; yes.textContent = 'Sending…'; }
    sync();
    const c = composite();
    try {
      const r = await api('api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: st.kind, title, body: body(), picture: c ? c.toDataURL('image/png') : null, approved: true }) });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `untangle answered ${r.status}.`);
      kept = { text: '', kind: 'bug' };
      text.value = '';
      close();
      toast(`Filed as #${esc(out.number)} on ${esc(repo)}<a href="${esc(out.url)}" target="_blank" rel="noopener noreferrer">Open the issue</a>${out.gist ? `<a href="${esc(out.gist)}" target="_blank" rel="noopener noreferrer">The picture’s gist</a>` : ''}`);
    } catch (e) {
      st.sending = false;
      back();
      err.textContent = `${e.message} You can still open it on GitHub instead.`;
      err.hidden = false;
      webBtn.classList.add('on');
      sync();
    }
  }

  // GitHub's own form: the words and what goes with it in the link, the picture on the clipboard.
  function web() {
    const c = composite();
    const url = webUrl();
    let note = 'GitHub’s form is open in a new tab, filled in. Submit it there.';
    if (c) {
      const blob = new Promise((resolve) => c.toBlob(resolve, 'image/png'));
      const copied = navigator.clipboard && window.ClipboardItem ? navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]) : Promise.reject(new Error('no clipboard'));
      note = 'GitHub’s form is open in a new tab, filled in, and the picture is on your clipboard: paste it into the form’s Picture box, then submit.';
      copied.catch(() => blob.then((b) => {
        // No clipboard here: the picture is saved instead, to drop into the form.
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'untangle-feedback.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        toast('GitHub’s form is open in a new tab, filled in. The picture is in your downloads, as untangle-feedback.png: drop it into the form’s Picture box, then submit.');
      }));
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    close();
    toast(note);
  }

  function retake() {
    el.hidden = scrim.hidden = true;
    take.hidden = false;
  }
  async function takeAgain() {
    take.hidden = true;
    st.pics = { shown: null, hidden: null };
    st.custom = null;
    st.shapes = [];
    // A frame for the page to settle without the panel's buttons.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    el.hidden = scrim.hidden = false;
    sync();
    takeBoth();
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) { st.tool = b.dataset.tool; return sync(); }
    if (b.dataset.kind) { st.kind = b.dataset.kind; return sync(); }
    const act = b.dataset.fb;
    if (act === 'close') close();
    else if (act === 'undo') { st.shapes.pop(); sync(); }
    else if (act === 'clear') { st.shapes = []; sync(); }
    else if (act === 'retake') retake();
    else if (act === 'send') ask();
    else if (act === 'approve') send();
    else if (act === 'back') back();
    else if (act === 'web') web();
  });
  take.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.fb === 'take') takeAgain();
    else { take.hidden = true; el.hidden = scrim.hidden = false; }
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    if (!ok.hidden) back();
    if (t.dataset.fb === 'include') st.include = t.checked;
    else if (t.dataset.fb === 'hidden') st.hidden = t.checked;
    else if (t.dataset.go) { if (t.checked) st.off.delete(t.dataset.go); else st.off.add(t.dataset.go); }
    sync();
  });
  text.addEventListener('input', () => { if (!ok.hidden) back(); sync(); });
  scrim.addEventListener('click', () => text.focus());

  current = { focus: () => text.focus() };
  sync();
  text.focus();
  takeBoth();
}

window.UntangleFeedback = { open };
