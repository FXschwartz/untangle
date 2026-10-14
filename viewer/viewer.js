// The review page: the chain map first, then chains, then code. It renders the model built by
// the analysis (git + tree-sitter + the Dart language server) and keeps your review marks: on the
// untangle server that serves it, or in this browser for a page saved on its own.
(function () {
  'use strict';
  const C = window.ReviewCore;
  const $ = (sel, el) => (el || document).querySelector(sel);
  // served: the server keeps marks and answers on demand. key: this review, for browser storage.
  const CONFIG = JSON.parse(($('#d-config') || { textContent: '{}' }).textContent || '{}');
  const MODEL = JSON.parse($('#d-model').textContent);
  const DEFS_ALL = JSON.parse($('#d-defs').textContent);
  const TEST_FILE = /(^|\/)(test|test_[a-z0-9_]+|integration_test)\/|_test\.dart$/;
  const defsNow = () => { if (DEFS_ALL.targets) return DEFS_ALL; const d = DEFS_ALL[state.compare]; return typeof d === 'string' ? DEFS_ALL[d] : d; };
  const REFS = JSON.parse($('#d-refs').textContent);
  const DEFS_OLD = JSON.parse($('#d-defs-old').textContent);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const fileName = (p) => p.slice(p.lastIndexOf('/') + 1);
  const wbr = (s) => esc(s).replace(/([.(])/g, '<wbr>$1');
  const fmt = (n) => n.toLocaleString('en-US');
  function diffstat(a, d) {
    const t = a + d, g = t ? Math.round((5 * a) / t) : 0;
    return `<span class="dstat"><span class="a">+${fmt(a)}</span><span class="d">−${fmt(d)}</span><span class="sq" aria-hidden="true">${'<i class="sa"></i>'.repeat(g)}${'<i class="sd"></i>'.repeat(5 - g)}</span></span>`;
  }

  const viewer = $('#viewer'), side = $('#vw-side'), main = $('#vw-main'), qInput = $('#vw-q');

  // ---------- state
  const state = {
    compare: 'base', tab: 'chains', layout: 'unified', showReviewedDiff: false,
    view: { kind: 'map', family: null }, prevView: null, peek: null, focus: null,
    rev: {},
    blockDiff: new Set(), moveOpen: new Set(), memberOpen: new Set(), collapsed: new Set(), expanded: new Set(), graphOpen: new Set(), groupAll: new Set(),
    search: { q: '', scope: 'unreviewed' },
  };
  const STORE = 'untangle:' + (CONFIG.key || 'review');
  try {
    const saved = CONFIG.served ? CONFIG.state : JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved) {
      Object.entries(saved.rev || {}).forEach(([k, v]) => { state.rev[k] = new Set(v); });
      state.layout = saved.layout === 'split' ? 'split' : 'unified';
      state.showReviewedDiff = !!saved.showReviewedDiff;
    }
  } catch (e) { /* storage unavailable */ }
  // Marks go to the server (a moment after the last change, or as the page goes away), or else
  // to this browser.
  let saveTimer = null, pendingSave = null;
  function flushSave() {
    if (pendingSave == null) return;
    const data = pendingSave;
    pendingSave = null;
    clearTimeout(saveTimer);
    fetch('api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: data, keepalive: true })
      .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then((j) => {
        viewer.classList.remove('unsaved');
        if (j.snapshot && (!CONFIG.snapshot || j.snapshot.commit !== CONFIG.snapshot.commit)) { CONFIG.snapshot = j.snapshot; renderSide(); }
      })
      .catch(() => viewer.classList.add('unsaved'));
  }
  function save() {
    const data = JSON.stringify({ rev: Object.fromEntries(Object.entries(state.rev).map(([k, v]) => [k, [...v]])), layout: state.layout, showReviewedDiff: state.showReviewedDiff });
    if (CONFIG.served) {
      clearTimeout(saveTimer);
      pendingSave = data;
      saveTimer = setTimeout(flushSave, 300);
      return;
    }
    try { localStorage.setItem(STORE, data); } catch (e) { /* storage unavailable */ }
  }
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

  // ---------- model
  const models = {};
  function M(name) {
    name = name || state.compare;
    if (models[name]) return models[name];
    const raw = MODEL.compares[name];
    const m = { name, raw, files: raw.files, edits: raw.edits, groups: raw.groups, chains: raw.chains, generated: raw.generated };
    m.blockById = new Map();
    m.head = new Map();
    m.files.forEach((f, fi) => {
      f.idx = fi;
      f.hunks.forEach((h) => {
        let o = h.o, n = h.n;
        h.meta = h.rows.map(([t]) => { const r = { t, o: t !== '+' ? o : null, n: t !== '-' ? n : null, block: null }; if (t !== '+') o++; if (t !== '-') n++; return r; });
      });
      f.blocks.forEach((b) => {
        b.file = f;
        m.blockById.set(b.id, b);
        const h = f.hunks[b.hunk];
        for (let i = b.first; i < b.first + b.len; i++) h.meta[i].block = b;
        b.firstRowOfEdit = new Map();
        for (let i = b.first; i < b.first + b.len; i++) (h.rows[i][2] || []).forEach(([, , id]) => { if (!b.firstRowOfEdit.has(id)) b.firstRowOfEdit.set(id, i); });
      });
      f.hunks.forEach((h, hi) => h.meta.forEach((r, ri) => { if (r.n != null) m.head.set(f.p + ':' + r.n, { f, hi, ri, r }); }));
    });
    m.groupById = new Map(m.groups.map((g) => [g.id, g]));
    m.chainsOf = new Map();
    m.chains.forEach((c) => {
      c.blockSet = new Set(c.blocks);
      c.blocks.forEach((id) => { if (!m.chainsOf.has(id)) m.chainsOf.set(id, []); m.chainsOf.get(id).push(c.id); });
      c.graph.nodes.forEach((n, i) => { n.idx = i; });
    });
    m.usedBy = new Map(m.chains.map((c) => [c.id, []]));
    m.chains.forEach((c) => c.uses.forEach((o) => m.usedBy.get(o).push(c.id)));
    const fams = new Map();
    m.chains.forEach((c) => { if (!fams.has(c.family)) fams.set(c.family, []); fams.get(c.family).push(c); });
    m.families = [...fams.entries()].map(([id, list]) => {
      list.sort((x, y) => x.depth - y.depth || y.blocks.length - x.blocks.length || (x.name < y.name ? -1 : 1));
      const top = list.slice().sort((x, y) => y.blocks.length - x.blocks.length || x.id - y.id)[0];
      return { id, chains: list, top, depth: Math.max(...list.map((c) => c.depth)) };
    }).sort((x, y) => y.chains.length - x.chains.length || x.id - y.id);
    m.byMember = new Map();
    m.files.forEach((f) => f.blocks.forEach((b) => { if (b.edits.length && b.mk && !/::\(top\)$/.test(b.mk)) { if (!m.byMember.has(b.mk)) m.byMember.set(b.mk, []); m.byMember.get(b.mk).push(b); } }));
    m.standalone = [];
    m.files.forEach((f) => f.blocks.forEach((b) => { if (b.edits.length && !m.chainsOf.has(b.id)) m.standalone.push(b); }));
    m.usageByLine = new Map();
    Object.entries(REFS[name] || {}).forEach(([key, list]) => {
      const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
      const k = key.slice(0, i1);
      if (!m.usageByLine.has(k)) m.usageByLine.set(k, []);
      m.usageByLine.get(k).push([key, list.length]);
    });
    models[name] = m;
    return m;
  }

  // ---------- review helpers
  const rev = () => state.rev[state.compare] || (state.rev[state.compare] = new Set());
  const done = (b) => b.edits.every((id) => rev().has(id));
  function setEdits(ids, on) { ids.forEach((id) => (on ? rev().add(id) : rev().delete(id))); save(); }
  function stats(blocks) {
    const s = { total: 0, open: 0, lines: 0, all: 0 };
    blocks.forEach((b) => { if (!b.edits.length) return; s.total++; s.all += b.adds + b.dels; if (!done(b)) { s.open++; s.lines += b.adds + b.dels; } });
    return s;
  }
  const blocksOf = (ids) => ids.map((id) => M().blockById.get(id));
  function toggleBlocks(blocks) {
    const anyOpen = blocks.some((b) => !done(b));
    setEdits(blocks.flatMap((b) => b.edits), anyOpen);
    blocks.forEach((b) => state.blockDiff.delete(b.id));
  }

  // ---------- labels
  function memberParts(member) {
    if (!member) return { owner: '', name: '' };
    const i = member.indexOf('.');
    return i < 0 ? { owner: '', name: member } : { owner: member.slice(0, i), name: member.slice(i + 1) };
  }
  function editText(id) {
    const e = M().edits[id];
    const side = (s) => trunc(s.replace(/\s+/g, ' '), 46);
    if (e.op === 'insert') return '+ ' + side(e.to);
    if (e.op === 'delete') return '− ' + side(e.from);
    return side(e.from) + ' → ' + side(e.to);
  }
  function groupLabel(g) { return g.parts.map(editText).join(' … '); }
  function nodeLabels(n) {
    if (n.tests != null) return { l1: 'tests', l2: `${fileName(n.file)} · ${n.tests} test${n.tests === 1 ? '' : 's'}`, owner: '' };
    if (n.group !== null && n.group !== undefined) {
      const g = M().groupById.get(n.group);
      return { l1: `same change · ${n.files} file${n.files > 1 ? 's' : ''}`, l2: g ? groupLabel(g) : '' };
    }
    const { owner, name } = memberParts(n.member);
    if (!n.member || n.member === 'main') return { l1: TEST_FILE.test(n.file) ? 'test file' : 'top level', l2: fileName(n.file), owner: '' };
    return { l1: fileName(n.file), l2: name, owner };
  }
  const kindWord = { member: 'changed member', type: 'changed type', param: 'parameter ripple', local: 'variable ripple' };

  // ---------- syntax colors: Shiki once it has loaded (VS Code's grammars and Dark+), the
  // tokenizer's classes until then. A run of rows is highlighted as two pieces of code, its new
  // side (context and added lines) and its old side (context and removed lines), so strings and
  // comments over several lines keep their colors.
  const SHIKI = window.UntangleShiki || null;
  let shikiOn = false;
  const rowsColorCache = new WeakMap();
  function rowsColors(rows, path) {
    if (!shikiOn) return null;
    if (rowsColorCache.has(rows)) return rowsColorCache.get(rows);
    const lang = SHIKI.langFor(path);
    let out = null;
    if (lang) {
      const neu = [], old = [];
      rows.forEach((r, i) => { if (r[0] !== '-') neu.push(i); if (r[0] !== '+') old.push(i); });
      const nl = SHIKI.lines(neu.map((i) => rows[i][1]).join('\n'), lang), ol = SHIKI.lines(old.map((i) => rows[i][1]).join('\n'), lang);
      out = { neu: [], old: [] };
      if (nl) neu.forEach((ri, k) => { out.neu[ri] = nl[k]; });
      if (ol) old.forEach((ri, k) => { out.old[ri] = ol[k]; });
    }
    rowsColorCache.set(rows, out);
    return out;
  }
  const rowColors = (rows, path, i) => { const c = rowsColors(rows, path); return c ? (rows[i][0] === '-' ? c.old[i] : c.neu[i]) || null : null; };
  const textColorCache = new Map();
  // Colors of each line of a text (a whole file, a snippet), cached by its content.
  function textColors(text, path) {
    if (!shikiOn) return null;
    const lang = SHIKI.langFor(path);
    if (!lang) return null;
    const k = lang + '\0' + text;
    if (!textColorCache.has(k)) { if (textColorCache.size > 400) textColorCache.clear(); textColorCache.set(k, SHIKI.lines(text, lang)); }
    return textColorCache.get(k);
  }
  const lineColors = (text, path) => { const c = textColors(text, path); return c ? c[0] : null; };
  function colorAt(colors, col) {
    let lo = 0, hi = colors.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (colors[mid][0] <= col) { best = colors[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }

  // ---------- code rendering
  function lineDefs(path, n) {
    const D = defsNow();
    const arr = n != null && D.defs[path] && D.defs[path][n];
    return arr ? new Map(arr.map(([c, , ti]) => [c, ti])) : null;
  }
  function oldLineDefs(path, o) {
    const d = DEFS_OLD[state.compare];
    const arr = o != null && d && d.defs[path] && d.defs[path][o];
    return arr ? new Map(arr.map(([c, , ti]) => [c, ti])) : null;
  }
  // A line of code as tokens. opts: emphasis (mark changed tokens), refs with n or o (definitions
  // answered ahead of time on that line), colors (the line's Shiki colors, else the line alone is
  // highlighted), live ({ side, p, ext, line }: any other name asks the server where it's defined).
  function codeHtml(f, text, ranges, opts) {
    const toks = C.tokenize(text, f.lang);
    const marks = ranges && opts.emphasis ? new Map(ranges.map(([s, , id]) => [s, id])) : null;
    const defs = !opts.refs ? null : opts.n != null ? lineDefs(f.p, opts.n) : opts.o != null ? oldLineDefs(f.p, opts.o) : null;
    const colors = opts.colors || lineColors(text, f.p);
    const live = CONFIG.served ? opts.live || (opts.refs && opts.n != null ? { side: 'head', p: f.p, line: opts.n } : opts.refs && opts.o != null ? { side: 'base', p: f.p, line: opts.o } : null) : null;
    const nextCode = (i) => { for (let j = i + 1; j < toks.length; j++) if (toks[j].k !== 'ws') return toks[j]; return null; };
    return toks.map((tk, i) => {
      if (tk.k === 'ws') return esc(tk.t);
      let cls = 't-' + tk.k, attrs = '';
      if (tk.k === 'id') { const nx = nextCode(i); if (nx && (nx.t === '(' || nx.t === '<')) cls = 't-fn'; }
      if (marks && marks.has(tk.c)) cls += rev().has(marks.get(tk.c)) ? ' rv' : ' ch';
      if (colors) {
        const c = colorAt(colors, tk.c);
        // Grammars leave plain names (variables, properties, parameters) in the default color;
        // VS Code colors them from the language server. The tokenizer's classes stand in there.
        const plain = !c || !c[1] || (c[1].toUpperCase() === SHIKI.fg() && (tk.k === 'id' || tk.k === 'ty'));
        if (!plain) attrs += ` style="color:${c[1]};font-style:${c[2] ? 'italic' : 'normal'}"`;
      }
      if (tk.k === 'id' || tk.k === 'ty' || tk.k === 'ann') {
        const col = tk.k === 'ann' ? tk.c + 1 : tk.c;
        const ti = defs ? defs.get(col) : undefined;
        if (ti !== undefined) { cls += ' ref'; attrs += opts.n != null ? ` data-ti="${ti}" data-col="${col}" data-path="${esc(f.p)}" data-n="${opts.n}" title="Peek definition"` : ` data-ti="${ti}" data-col="${col}" data-path="${esc(f.p)}" data-o="${opts.o}" title="Peek definition (old side)"`; }
        else if (live) { cls += ' ref live'; attrs += ` data-ls="${live.side || ''}" data-lp="${esc(live.p || '')}" data-lx="${live.ext != null ? live.ext : ''}" data-ll="${live.line}" data-lc="${col}" title="Go to definition"`; }
      }
      return `<span class="${cls}"${attrs}>${esc(tk.t)}</span>`;
    }).join('');
  }
  function badgesHtml(f, b, ri, n) {
    let h = '';
    if (b) {
      const seen = new Set();
      b.edits.forEach((id) => {
        const e = M().edits[id];
        if (e.group === undefined || e.group === null || b.firstRowOfEdit.get(id) !== ri || seen.has(e.group)) return;
        seen.add(e.group);
        const g = M().groupById.get(e.group);
        const ok = g.edits.every((x) => rev().has(x));
        h += `<button type="button" class="bdg grp${ok ? ' ok' : ''}" data-group="${g.id}" title="The same change in ${g.count} places">same change ×${g.count}</button>`;
      });
    }
    if (n != null) (M().usageByLine.get(f.p + ':' + n) || []).forEach(([key, cnt]) => {
      h += `<button type="button" class="bdg use" data-usage="${esc(key)}" title="Usages inside other changes, from the language server">${cnt} changed usage${cnt > 1 ? 's' : ''}</button>`;
    });
    return h;
  }
  function tickHtml(b) {
    const d = done(b);
    return `<button type="button" class="tick${d ? ' on' : ''}" data-act="toggle-block" data-block="${esc(b.id)}" title="${d ? 'Mark unreviewed' : 'Mark this change reviewed'}" aria-label="${d ? 'Mark unreviewed' : 'Mark this change reviewed'}">✓</button>`;
  }
  function diffToggle(b) {
    const shown = state.blockDiff.has(b.id) || state.showReviewedDiff;
    return state.showReviewedDiff ? '' : `<button type="button" class="dt" data-act="toggle-diff" data-block="${esc(b.id)}">${shown ? 'Hide diff' : 'Show diff'}</button>`;
  }
  function peekAfter(f, n) {
    return state.peek && !state.peek.old && state.peek.path === f.p && state.peek.n === n ? peekHtml(state.peek) : '';
  }
  function peekAfterOld(f, o) {
    return state.peek && state.peek.old && state.peek.path === f.p && state.peek.o === o ? peekHtml(state.peek) : '';
  }
  // One unified row.
  function uRow(f, meta, text, ranges, o) {
    const sign = o.sign != null ? o.sign : meta.t === '+' ? '+' : meta.t === '-' ? '−' : '';
    const n = meta.t !== '-' ? meta.n : null;
    const oldNo = meta.t === '-' ? meta.o : null;
    return `<div class="ln ${o.cls}"${n != null ? ` data-n="${n}"` : ''}><span class="g">${o.tick || ''}</span><span class="no">${o.hideOld ? '' : meta.o != null ? meta.o : ''}</span><span class="no">${n != null ? n : ''}</span><span class="sg">${sign}</span><span class="tx">${codeHtml(f, text, ranges, { emphasis: o.emphasis, n, o: oldNo, refs: o.refs, colors: o.colors })}</span><span class="bdgs">${o.badges || ''}${o.toggle || ''}</span></div>` + (n != null ? peekAfter(f, n) : oldNo != null ? peekAfterOld(f, oldNo) : '');
  }
  // A moved declaration. The removed copy is one line pointing at the new place. The added
  // copy shows the diff between the two bodies: unchanged lines are moved code, and long runs
  // of them fold.
  function movedAwayHtml(b) {
    const to = M().files[b.movedTo.f];
    const what = b.movedTo.changes ? `with ${b.movedTo.changes} change${b.movedTo.changes > 1 ? 's' : ''}` : 'unchanged';
    return `<div class="ln mv-away"><span class="g"></span><span class="no"></span><span class="no"></span><span class="sg">↦</span><span class="tx">${b.len} line${b.len > 1 ? 's' : ''} moved to <button type="button" class="linkish" data-open="${esc(to.p)}" data-line="${b.movedTo.n}">${esc(fileName(to.p))}:${b.movedTo.n}</button>, ${what}</span><span class="bdgs"></span></div>`;
  }
  function movedHtml(f, b, ctx) {
    const from = M().files[b.move.f];
    const fromBlock = M().blockById.get(b.move.b);
    const fromLine = fromBlock ? from.hunks[fromBlock.hunk].meta[fromBlock.first].o : '';
    const rows = b.move.rows;
    const changed = rows.filter((r) => r[0] !== ' ').length;
    const d = done(b);
    const open = state.moveOpen.has(b.id);
    const groups = new Set(b.edits.map((id) => M().edits[id].group).filter((g) => g != null));
    let h = `<div class="ln mv-head${d && b.edits.length ? ' rvd' : ''}"><span class="g">${b.edits.length ? tickHtml(b) : ''}</span><span class="no"></span><span class="no"></span><span class="sg">↤</span><span class="tx">Moved from <button type="button" class="linkish" data-open="${esc(from.p)}">${esc(fileName(from.p))}:${fromLine}</button> · ${b.edits.length ? `${b.edits.length} change${b.edits.length > 1 ? 's' : ''}` : 'no changes'}</span><span class="bdgs">`
      + [...groups].map((g) => { const gr = M().groupById.get(g); return `<button type="button" class="bdg grp" data-group="${g}">same change ×${gr.count}</button>`; }).join('')
      + `<button type="button" class="dt" data-act="toggle-move" data-block="${esc(b.id)}">${open ? 'Fold moved lines' : 'Show moved lines'}</button></span></div>`;
    // Keep each change with 3 lines of context; fold the rest unless opened.
    const keep = new Set();
    rows.forEach((r, i) => { if (r[0] !== ' ') for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) keep.add(k); });
    const fromFile = { p: from.p, lang: f.lang };
    let skipped = 0;
    const flush = () => { if (skipped) h += `<div class="ln skip mv"><span class="g"></span><span class="no"></span><span class="no"></span><span class="sg"></span><span class="tx">⋯ ${skipped} moved line${skipped > 1 ? 's' : ''}, unchanged</span></div>`; skipped = 0; };
    rows.forEach(([t, text, o, n, ranges], i) => {
      if (!open && !keep.has(i)) { skipped++; return; }
      flush();
      const meta = { t: t === ' ' ? ' ' : t, o: t === '+' ? null : o, n: t === '-' ? null : n };
      const colors = rowColors(rows, f.p, i);
      if (t === ' ') h += uRow(f, { t: ' ', o, n }, text, null, { cls: 'mv' + (d ? ' rvd' : ''), sign: '', refs: !ctx.noRefs, colors });
      else if (t === '-') h += uRow(fromFile, meta, text, ranges, { cls: 'del' + (d ? ' rvd' : ''), emphasis: true, refs: !ctx.noRefs, colors });
      else h += uRow(f, meta, text, ranges, { cls: 'add' + (d ? ' rvd' : ''), emphasis: true, refs: !ctx.noRefs, colors });
    });
    flush();
    return h;
  }
  // Rows [start, end) of a hunk. Reviewed changes stay visible: by default their diff is
  // hidden and the new code reads as muted context.
  function rowsHtml(f, hi, start, end, ctx) {
    ctx = ctx || {};
    const h = f.hunks[hi];
    let out = '';
    const placed = new Set();
    for (let ri = start; ri < end; ri++) {
      const meta = h.meta[ri];
      const [t, text, ranges] = h.rows[ri];
      const colors = rowColors(h.rows, f.p, ri);
      const b = meta.block;
      if (b && (b.move || b.movedTo)) {
        if (!placed.has(b.id)) { placed.add(b.id); out += b.move ? movedHtml(f, b, ctx) : movedAwayHtml(b); }
        continue;
      }
      if (!b || !b.edits.length) { out += uRow(f, meta, text, null, { cls: 'ctx', refs: !ctx.noRefs, colors }); continue; }
      const d = done(b);
      const showDiff = !d || state.showReviewedDiff || state.blockDiff.has(b.id);
      const other = ctx.chain && !ctx.chain.blockSet.has(b.id) ? ' other' : '';
      const emphasis = b.adds > 0 && b.dels > 0;
      if (!showDiff) {
        if (t === '-') {
          if (b.adds === 0 && !placed.has(b.id)) {
            placed.add(b.id);
            out += `<div class="ln gone"><span class="g">${tickHtml(b)}</span><span class="no"></span><span class="no"></span><span class="sg"></span><span class="tx">${b.dels} removed line${b.dels > 1 ? 's' : ''}, reviewed</span><span class="bdgs">${diffToggle(b)}</span></div>`;
          }
          continue;
        }
        const first = !placed.has(b.id);
        placed.add(b.id);
        out += uRow(f, meta, text, null, { cls: 'ctx rvd-quiet' + other, sign: '', hideOld: true, tick: first ? tickHtml(b) : '', toggle: first ? diffToggle(b) : '', refs: !ctx.noRefs, colors });
        continue;
      }
      const first = !placed.has(b.id);
      placed.add(b.id);
      out += uRow(f, meta, text, ranges, {
        cls: (t === '+' ? 'add' : 'del') + (d ? ' rvd' : '') + other, emphasis, refs: !ctx.noRefs, colors,
        tick: first ? tickHtml(b) : '', toggle: first && d ? diffToggle(b) : '',
        badges: ctx.noBadges ? '' : badgesHtml(f, b, ri, t !== '-' ? meta.n : null),
      });
    }
    return out;
  }
  // Split layout: removed lines on the left, added lines on the right, paired per change.
  function sCell(f, meta, text, ranges, side, o) {
    if (!meta) return `<span class="half ${side} empty"></span>`;
    const n = side === 'r' ? meta.n : null;
    const num = side === 'l' ? meta.o : meta.n;
    const sign = o.sign != null ? o.sign : side === 'l' && meta.t === '-' ? '−' : side === 'r' && meta.t === '+' ? '+' : '';
    const oldNo = side === 'l' && meta.t === '-' ? meta.o : null;
    return `<span class="half ${side} ${o.cls || ''}"><span class="no">${num != null ? num : ''}</span><span class="sg">${sign}</span><span class="tx">${codeHtml(f, text, ranges, { emphasis: o.emphasis, n, o: oldNo, refs: (side === 'r' && o.refs) || (oldNo != null && o.refs !== false), colors: o.colors })}</span>${side === 'r' ? `<span class="bdgs">${o.badges || ''}${o.toggle || ''}</span>` : ''}</span>`;
  }
  function splitRowsHtml(f, hi, start, end, ctx) {
    ctx = ctx || {};
    const h = f.hunks[hi];
    let out = '';
    let ri = start;
    while (ri < end) {
      const meta = h.meta[ri];
      const b = meta.block;
      if (b && (b.move || b.movedTo)) {
        out += b.move ? movedHtml(f, b, ctx) : movedAwayHtml(b);
        while (ri < end && h.meta[ri].block === b) ri++;
        continue;
      }
      if (!b || !b.edits.length) {
        const [, text] = h.rows[ri];
        const colors = rowColors(h.rows, f.p, ri);
        out += `<div class="sl" data-n="${meta.n != null ? meta.n : ''}"><span class="g"></span>${sCell(f, meta, text, null, 'l', { cls: 'ctx', colors })}${sCell(f, meta, text, null, 'r', { cls: 'ctx', refs: !ctx.noRefs, colors })}</div>` + (meta.n != null ? peekAfter(f, meta.n) : '');
        ri++;
        continue;
      }
      let bEnd = ri;
      while (bEnd < end && h.meta[bEnd].block === b) bEnd++;
      const dels = [], adds = [];
      for (let i = ri; i < bEnd; i++) (h.meta[i].t === '-' ? dels : adds).push(i);
      const d = done(b);
      const showDiff = !d || state.showReviewedDiff || state.blockDiff.has(b.id);
      const other = ctx.chain && !ctx.chain.blockSet.has(b.id) ? ' other' : '';
      const emphasis = b.adds > 0 && b.dels > 0;
      if (!showDiff) {
        if (!adds.length) {
          out += `<div class="sl gone"><span class="g">${tickHtml(b)}</span><span class="half l"><span class="tx">${b.dels} removed line${b.dels > 1 ? 's' : ''}, reviewed</span></span><span class="half r"><span class="bdgs">${diffToggle(b)}</span></span></div>`;
        }
        adds.forEach((i, k) => {
          const m2 = h.meta[i];
          const colors = rowColors(h.rows, f.p, i);
          out += `<div class="sl rvd-quiet${other}" data-n="${m2.n}"><span class="g">${k === 0 ? tickHtml(b) : ''}</span>${sCell(f, m2, h.rows[i][1], null, 'l', { cls: 'ctx', sign: '', colors }).replace(/<span class="no">\d*<\/span>/, '<span class="no"></span>')}${sCell(f, m2, h.rows[i][1], null, 'r', { cls: 'ctx', sign: '', refs: !ctx.noRefs, toggle: k === 0 ? diffToggle(b) : '', colors })}</div>` + peekAfter(f, m2.n);
        });
      } else {
        const rows = Math.max(dels.length, adds.length);
        for (let k = 0; k < rows; k++) {
          const li = dels[k], ai = adds[k];
          const lm = li != null ? h.meta[li] : null, am = ai != null ? h.meta[ai] : null;
          out += `<div class="sl${d ? ' rvd' : ''}${other}" data-n="${am ? am.n : ''}"><span class="g">${k === 0 ? tickHtml(b) : ''}</span>`
            + sCell(f, lm, lm ? h.rows[li][1] : '', lm ? h.rows[li][2] : null, 'l', { cls: 'del', emphasis, colors: li != null ? rowColors(h.rows, f.p, li) : null })
            + sCell(f, am, am ? h.rows[ai][1] : '', am ? h.rows[ai][2] : null, 'r', { cls: 'add', emphasis, refs: !ctx.noRefs, badges: am && !ctx.noBadges ? badgesHtml(f, b, ai, am.n) : '', toggle: k === 0 && d ? diffToggle(b) : '', colors: ai != null ? rowColors(h.rows, f.p, ai) : null })
            + '</div>' + (am ? peekAfter(f, am.n) : '') + (lm ? peekAfterOld(f, lm.o) : '');
        }
      }
      ri = bEnd;
    }
    return out;
  }
  const anyRowsHtml = (f, hi, s, e, ctx) => (state.layout === 'split' ? splitRowsHtml(f, hi, s, e, ctx) : rowsHtml(f, hi, s, e, ctx));
  const BIG = 150;
  function hunkView(f, hi, s0, e0, ctx) {
    ctx = ctx || {};
    const h = f.hunks[hi];
    const key = (ctx.key || 'file') + '|' + f.p + '#' + hi + ':' + s0;
    const blocks = f.blocks.filter((b) => b.hunk === hi && b.edits.length && b.first < e0 && b.first + b.len > s0);
    const open = blocks.filter((b) => !done(b)).length;
    const allDone = blocks.length > 0 && open === 0;
    const big = !!ctx.chain && e0 - s0 > BIG;
    const collapsed = state.collapsed.has(key) || ((allDone || big) && !state.expanded.has(key));
    let o = null, n = null;
    for (let i = s0; i < e0; i++) { if (o == null && h.meta[i].o != null) o = h.meta[i].o; if (n == null && h.meta[i].n != null) n = h.meta[i].n; }
    let out = `<div class="hh${allDone ? ' hh-done' : ''}"><button type="button" class="chev" data-act="toggle-hunk" data-key="${esc(key)}" aria-expanded="${!collapsed}" title="${collapsed ? 'Expand hunk' : 'Collapse hunk'}">${collapsed ? '▸' : '▾'}</button><span class="hh-tx">@@ −${o != null ? o : h.o} +${n != null ? n : h.n} @@ <span class="hh-ctx">${s0 === 0 ? esc(h.h) : ''}</span></span>`;
    if (blocks.length) out += `<button type="button" class="btn xs" data-act="mark-blocks" data-blocks="${esc(blocks.map((b) => b.id).join(' '))}">${open ? '✓ Mark hunk reviewed' : 'Mark hunk unreviewed'}</button>`;
    if (collapsed) {
      out += `<span class="hh-note">${e0 - s0} lines${allDone ? ' · all reviewed' : ''}</span>`;
      const focus = ctx.chain && ctx.chain.focus ? blocks.flatMap((b) => ctx.chain.focus[b.id] || []) : [];
      if (focus.length && !allDone) out += `<span class="hh-note">in this chain:</span>${[...new Set(focus)].slice(0, 8).map((ln) => `<button type="button" class="chip-btn" data-act="expand-to" data-key="${esc(key)}" data-line="${ln}">line ${ln}</button>`).join('')}`;
    }
    out += '</div>';
    if (!collapsed) out += anyRowsHtml(f, hi, s0, e0, ctx);
    return out;
  }
  const hunkHtml = (f, hi, ctx) => hunkView(f, hi, 0, f.hunks[hi].rows.length, ctx);
  // The hunks a set of changes needs: each change with 3 lines of context, merged when they touch.
  function subHunksHtml(blocks, ctx) {
    const byFile = new Map();
    blocks.forEach((b) => { if (!byFile.has(b.file)) byFile.set(b.file, []); byFile.get(b.file).push(b); });
    let h = '';
    [...byFile.keys()].sort((x, y) => x.idx - y.idx).forEach((f) => {
      h += `<div class="sec-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${esc(f.p)}</button></div><div class="code">`;
      const byHunk = new Map();
      byFile.get(f).forEach((b) => { if (!byHunk.has(b.hunk)) byHunk.set(b.hunk, []); byHunk.get(b.hunk).push(b); });
      [...byHunk.keys()].sort((x, y) => x - y).forEach((hi) => {
        const rows = f.hunks[hi].rows.length;
        const ranges = byHunk.get(hi).map((b) => [Math.max(0, b.first - 3), Math.min(rows, b.first + b.len + 3)]).sort((x, y) => x[0] - y[0]);
        const merged = [];
        ranges.forEach((r) => { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice()); });
        merged.forEach(([s0, e0]) => { h += hunkView(f, hi, s0, e0, ctx); });
      });
      h += '</div>';
    });
    return h;
  }

  // ---------- peek
  // The top panel shows the definition, or the changed usage picked in the list below it.
  // Clicking a usage once shows it here; clicking it again (or "Go to it") opens it.
  function usageContextHtml(hl) {
    const h = hl.f.hunks[hl.hi];
    const rows = [];
    for (let i = 0; i < h.rows.length; i++) if (h.meta[i].n != null) rows.push(i);
    const at = rows.indexOf(hl.ri);
    return rows.slice(Math.max(0, at - 4), at + 5).map((i) => {
      const r = h.meta[i];
      return `<div class="pk-ln${i === hl.ri ? ' hit' : ''}${r.t === '+' ? ' add' : ''}"><span class="no">${r.n}</span><span class="sg">${r.t === '+' ? '+' : ''}</span><span class="tx">${codeHtml(hl.f, h.rows[i][1], null, { colors: rowColors(h.rows, hl.f.p, i), live: CONFIG.served ? { side: 'head', p: hl.f.p, line: r.n } : null })}</span></div>`;
    }).join('');
  }
  // A definition asked live: where it is, its snippet (names in it can be asked in turn), and
  // ways to open it.
  function livePeekHtml(p) {
    const L = p.live;
    const back = p.back && p.back.length ? '<button type="button" class="btn xs" data-act="peek-back">Back</button>' : '';
    const close = '<button type="button" class="pk-x" data-act="close-peek">Close</button>';
    if (L.status === 'loading') return `<div class="pk-h"><b>Definition</b><span class="pk-src">looking it up…</span><span class="sp"></span>${back}${close}</div>`;
    if (L.status !== 'ok') return `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(L.error || 'The language server knows no definition for this name.')}</span><span class="sp"></span>${back}${close}</div>`;
    const t = L.target;
    const where = t.side === 'base' ? `old side · ${(CONFIG.base || '').slice(0, 7)}` : t.side === 'head' ? 'this repo' : t.w === 'sdk' ? 'Dart SDK' : t.w === 'package' ? 'package' : 'outside the repo';
    const file = { p: t.p, lang: C.langOf(t.p) };
    const colors = textColors(t.code.join('\n'), t.p);
    let h = `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(t.p)}:${t.l}</span><span class="pk-src">${where}</span><span class="sp"></span>${back}`
      + sourceButton({ side: t.side, p: t.side ? t.p : null, ext: t.ext, line: t.l, label: t.w !== 'repo' ? t.p : null, where }, 'Open file', 'btn xs')
      + editorHtml({ side: t.side, p: t.p, abs: t.abs, line: t.l, col: t.c }) + close + '</div>'
      + `<div class="pk-code">${t.code.map((line, i) => {
        const ln = t.s + i;
        return `<div class="pk-ln${ln === t.l ? ' hit' : ''}"><span class="no">${ln}</span><span class="tx">${codeHtml(file, line, null, { colors: colors && colors[i], live: { side: t.side, p: t.side ? t.p : null, ext: t.ext, line: ln } })}</span></div>`;
      }).join('')}</div>`;
    if (t.side === 'head' && M().head.has(t.p + ':' + t.l)) h += `<div class="pk-foot"><button type="button" class="linkish" data-open="${esc(t.p)}" data-line="${t.l}">Go to it in this diff</button></div>`;
    return h;
  }
  function peekHtml(p) {
    if (p.live) return '<div class="peek" role="region" aria-label="Peek">' + livePeekHtml(p) + '</div>';
    let h = '<div class="peek" role="region" aria-label="Peek">';
    const hasDef = p.ti !== undefined && p.ti !== null && !Number.isNaN(p.ti);
    const list = p.usageKey ? REFS[state.compare][p.usageKey] || [] : [];
    const isOpen = ([up, ul]) => { const hl = M().head.get(up + ':' + ul); return hl && hl.r.block && !done(hl.r.block); };
    const sel = p.sel != null && list[p.sel] ? list[p.sel] : null;
    const selHl = sel && M().head.get(sel[0] + ':' + sel[1]);
    if (sel && selHl) {
      h += `<div class="pk-h"><b>Usage ${p.sel + 1} of ${list.length}</b><span class="pk-loc">${esc(sel[0])}:${sel[1]}</span><span class="pk-src">${isOpen(sel) ? 'not reviewed' : 'reviewed'}</span><span class="sp"></span>`
        + (hasDef ? '<button type="button" class="btn xs" data-act="peek-def">Back to definition</button>' : '')
        + `<button type="button" class="btn xs primary" data-act="peek-go">Go to it</button><button type="button" class="pk-x" data-act="close-peek">Close</button></div>`
        + `<div class="pk-code">${usageContextHtml(selHl)}</div>`;
    } else if (hasDef) {
      const t = p.old ? DEFS_OLD[state.compare].targets[p.ti] : defsNow().targets[p.ti];
      const where = (p.old ? `old side · ${M().raw.left} · ` : '') + (t.w === 'repo' ? 'this repo' : t.w === 'sdk' ? 'Dart SDK' : 'package');
      const side = t.w === 'repo' ? (p.old ? 'base' : 'head') : null;
      const colors = textColors(t.code.join('\n'), t.p);
      h += `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(t.p)}:${t.l}</span><span class="pk-src">${where}</span><span class="sp"></span>`
        + (side ? sourceButton({ side, p: t.p, line: t.l }, 'Open file', 'btn xs') + editorHtml({ side, p: t.p, line: t.l }) : CONFIG.served ? '<button type="button" class="btn xs" data-act="open-def">Open file</button>' : '')
        + `<button type="button" class="pk-x" data-act="close-peek">Close</button></div>
        <div class="pk-code">${t.code.map((line, i) => {
          const ln = t.s + i;
          return `<div class="pk-ln${ln === t.l ? ' hit' : ''}"><span class="no">${ln}</span><span class="tx">${codeHtml({ p: t.p, lang: C.langOf(t.p) }, line, null, { colors: colors && colors[i], live: side ? { side, p: t.p, line: ln } : null })}</span></div>`;
        }).join('')}</div>`;
      if (!p.old && t.w === 'repo' && M().head.has(t.p + ':' + t.l) && !(t.p === p.path && t.l === p.n)) {
        h += `<div class="pk-foot"><button type="button" class="linkish" data-open="${esc(t.p)}" data-line="${t.l}">Go to it in this diff</button></div>`;
      }
    }
    if (p.usageKey) {
      const open = list.filter(isOpen).length;
      h += `<div class="pk-h pk-h2"><b>${list.length} changed usage${list.length === 1 ? '' : 's'}</b><span class="pk-src">${open} not reviewed</span><span class="pk-hint">Click one to show it above, again to go to it</span><span class="sp"></span>
        <button type="button" class="btn xs" data-act="mark-usages" data-usage="${esc(p.usageKey)}">${open ? 'Mark them reviewed' : 'Mark them unreviewed'}</button></div><div class="pk-list">`;
      list.forEach((u, i) => {
        const [up, ul] = u;
        const hl = M().head.get(up + ':' + ul);
        const text = hl ? hl.f.hunks[hl.hi].rows[hl.ri][1].trim() : '';
        h += `<button type="button" class="pk-use${isOpen(u) ? '' : ' done'}" data-act="peek-use" data-i="${i}" aria-current="${p.sel === i}" title="${p.sel === i ? 'Go to it' : 'Show it above'}"><span class="pk-up">${esc(fileName(up))}:${ul}</span><code>${hl ? codeHtml(hl.f, text, null, {}) : ''}</code></button>`;
      });
      h += '</div>';
    }
    return h + '</div>';
  }
  // Re-render only the peek, keeping the page and the usage list where they were.
  function refreshPeek(from, focusSel) {
    const el = from.closest('.peek');
    if (!el) return render();
    const listTop = el.querySelector('.pk-list') ? el.querySelector('.pk-list').scrollTop : 0;
    const tmp = document.createElement('div');
    tmp.innerHTML = peekHtml(state.peek);
    const next = tmp.firstElementChild;
    el.replaceWith(next);
    const lst = next.querySelector('.pk-list');
    if (lst) lst.scrollTop = listTop;
    const f = next.querySelector(focusSel);
    if (f) f.focus();
  }

  // ---------- graphs
  const NW = 214, NH = 52, GX = 66, GY = 14, PAD = 16;
  // spec: { id, nodes: [{ key, layer, l1, l2, cnt, ok, root, grp, attr, tip, label }], edges: [{ from, to, labels }], focus, w }
  function layeredSvg(spec) {
    const W0 = spec.w || NW;
    const layers = new Map();
    spec.nodes.forEach((n) => { if (!layers.has(n.layer)) layers.set(n.layer, []); layers.get(n.layer).push(n); });
    const keys = [...layers.keys()].sort((a, b) => a - b);
    const posOf = new Map();
    const more = [];
    let maxRows = 1;
    keys.forEach((L, li) => {
      let list = layers.get(L);
      let hidden = 0;
      const cap = spec.cap || 7;
      if (list.length > cap && !state.graphOpen.has(spec.id + ':' + L)) { hidden = list.length - (cap - 1); list = list.slice(0, cap - 1); }
      list.forEach((n, ri) => posOf.set(n.key, { x: PAD + li * (W0 + GX), y: PAD + ri * (NH + GY), n }));
      if (hidden) more.push({ x: PAD + li * (W0 + GX), y: PAD + list.length * (NH + GY), hidden, L });
      maxRows = Math.max(maxRows, list.length + (hidden ? 1 : 0));
    });
    const W = PAD * 2 + keys.length * W0 + Math.max(0, keys.length - 1) * GX + 40;
    const H = PAD * 2 + maxRows * NH + (maxRows - 1) * GY;
    const near = new Set();
    if (spec.focus) { near.add(spec.focus); spec.edges.forEach((e) => { if (e.from === spec.focus) near.add(e.to); if (e.to === spec.focus) near.add(e.from); }); }
    let svg = `<svg class="graph" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(spec.label)}">
      <defs><marker id="gar-${spec.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>`;
    let labels = '';
    const ports = new Map();
    const port = (key, side, otherY) => { const k = key + side; if (!ports.has(k)) ports.set(k, []); ports.get(k).push(otherY); };
    const visible = spec.edges.filter((e) => posOf.get(e.from) && posOf.get(e.to));
    visible.forEach((e) => {
      const a = posOf.get(e.from), b = posOf.get(e.to);
      const fwd = a.x < b.x, same = a.x === b.x;
      port(e.from, same || fwd ? 'R' : 'L', b.y); port(e.to, same || !fwd ? 'R' : 'L', a.y);
    });
    ports.forEach((list) => list.sort((x, y) => x - y));
    const portY = (key, side, otherY, base) => {
      const list = ports.get(key + side);
      if (!list || list.length < 2) return base + NH / 2;
      return base + 10 + (list.indexOf(otherY) * (NH - 20)) / (list.length - 1);
    };
    const shown = new Set();
    visible.forEach((e) => {
      const a = posOf.get(e.from), b = posOf.get(e.to);
      const fwd0 = a.x < b.x, same0 = a.x === b.x;
      const y1 = portY(e.from, same0 || fwd0 ? 'R' : 'L', b.y, a.y), y2 = portY(e.to, same0 || !fwd0 ? 'R' : 'L', a.y, b.y);
      let d, lx, ly;
      if (a.x !== b.x) {
        const x1 = fwd0 ? a.x + W0 : a.x, x2 = fwd0 ? b.x - 3 : b.x + W0 + 3;
        const mx = (x1 + x2) / 2;
        d = `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
        lx = (x1 + x2) / 2; ly = (y1 + y2) / 2 - 5;
      } else {
        const x1 = a.x + W0, x2 = b.x + W0 + 3, bx = x1 + 30;
        d = `M${x1} ${y1} C ${bx} ${y1}, ${bx} ${y2}, ${x2} ${y2}`;
        lx = x1 + 26; ly = (y1 + y2) / 2;
      }
      const dim = spec.focus && !(e.from === spec.focus || e.to === spec.focus);
      const long = spec.faintLong && Math.abs(a.n.layer - b.n.layer) > 1;
      svg += `<path class="g-edge${dim ? ' dim' : ''}${long ? ' long' : ''}${e.share ? ' share' : ''}" d="${d}"${e.share ? '' : ` marker-end="url(#gar-${spec.id})"`}/>`;
      if (e.labels && e.labels.length) {
        const text = trunc(e.labels[0], 18) + (e.labels.length > 1 ? ' +' + (e.labels.length - 1) : '');
        if (!shown.has(e.to + '|' + text) && !dim) { shown.add(e.to + '|' + text); labels += `<text class="g-elabel" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(text)}</text>`; }
      }
    });
    posOf.forEach(({ x, y, n }) => {
      const cls = ['g-node', n.ok ? 'ok' : '', n.root ? 'root' : '', n.grp ? 'grp' : '', spec.focus ? (n.key === spec.focus ? 'focus' : near.has(n.key) ? '' : 'dim') : ''].filter(Boolean).join(' ');
      svg += `<g class="${cls}" ${n.attr} tabindex="0" role="button" aria-label="${esc(n.l2 + ', ' + n.l1)}"><title>${esc(n.tip)}</title>
        <rect class="g-box" x="${x}" y="${y}" width="${W0}" height="${NH}" rx="8"/>
        <rect class="g-bar" x="${x}" y="${y}" width="6" height="${NH}" rx="3"/>
        <text class="g-l1" x="${x + 15}" y="${y + 20}">${esc(trunc(n.l1, Math.floor((W0 - 70) / 6.4)))}</text>
        <text class="g-l2" x="${x + 15}" y="${y + 39}">${esc(trunc(n.l2, Math.floor((W0 - 24) / 7.7)))}</text>
        <text class="g-cnt" x="${x + W0 - 10}" y="${y + 20}" text-anchor="end">${esc(n.cnt)}</text>
      </g>`;
    });
    more.forEach(({ x, y, hidden, L }) => {
      svg += `<g class="g-more" data-graph-open="${spec.id}:${L}" tabindex="0" role="button" aria-label="Show ${hidden} more"><rect x="${x}" y="${y}" width="${W0}" height="${NH}" rx="8"/><text x="${x + W0 / 2}" y="${y + NH / 2 + 4}" text-anchor="middle">+ ${hidden} more</text></g>`;
    });
    return svg + labels + '</svg>';
  }
  function graphSvg(c) {
    const m = M();
    const focusKey = state.focus && state.focus.chain === c.id ? c.graph.nodes[state.focus.node].key : null;
    return layeredSvg({
      id: 'c' + c.id, label: `Graph of the ${c.graph.nodes.length} changed members in this chain; arrows point from a change to what it uses.`, focus: focusKey,
      edges: c.graph.edges,
      nodes: c.graph.nodes.map((n) => {
        const s = stats(n.blocks.map((id) => m.blockById.get(id)));
        const { l1, l2, owner } = nodeLabels(n);
        return { key: n.key, layer: n.layer, l1, l2, cnt: s.open ? s.open + '/' + s.total : '✓ ' + s.total, ok: !s.open, root: n.key === c.graph.root, grp: n.group !== null && n.group !== undefined,
          attr: `data-node="${n.idx}"`, tip: (owner ? owner + '.' : '') + l2 + ' · ' + n.file };
      }),
    });
  }
  function mapSvg(fam) {
    const ids = new Set(fam.chains.map((c) => c.id));
    // Only direct dependencies: an arrow already implied by a longer path is left out.
    const out = new Map(fam.chains.map((c) => [c.id, c.uses.filter((o) => ids.has(o) && o !== c.id)]));
    const reach = (from, to, skip) => {
      const seen = new Set([from]), stack = out.get(from).filter((x) => !(from === skip[0] && x === skip[1]));
      while (stack.length) { const x = stack.pop(); if (x === to) return true; if (seen.has(x)) continue; seen.add(x); stack.push(...out.get(x)); }
      return false;
    };
    const edges = [];
    fam.chains.forEach((c) => out.get(c.id).forEach((o) => { if (!reach(c.id, o, [c.id, o])) edges.push({ from: 'k' + c.id, to: 'k' + o, labels: [] }); }));
    // Chains that share changes are one family too. One dashed line joins each group of chains
    // that uses links to the chain it shares the most changes with.
    const group = new Map(fam.chains.map((c) => [c.id, c.id]));
    const find = (x) => { while (group.get(x) !== x) x = group.get(x); return x; };
    fam.chains.forEach((c) => out.get(c.id).forEach((o) => group.set(find(c.id), find(o))));
    const pairs = [];
    fam.chains.forEach((c) => (c.shares || []).forEach((o) => {
      if (o <= c.id || !ids.has(o)) return;
      const ob = new Set(M().chains[o].blocks);
      pairs.push({ a: c, b: M().chains[o], n: c.blocks.filter((x) => ob.has(x)).length });
    }));
    pairs.sort((x, y) => y.n - x.n || x.a.id - y.a.id || x.b.id - y.b.id);
    pairs.forEach(({ a, b }) => {
      if (find(a.id) === find(b.id)) return;
      group.set(find(a.id), find(b.id));
      const [from, to] = a.depth <= b.depth ? [a, b] : [b, a];
      edges.push({ from: 'k' + from.id, to: 'k' + to.id, labels: [], share: true });
    });
    return layeredSvg({
      id: 'map' + fam.id, w: 236, cap: 9, faintLong: true, label: `Map of ${fam.chains.length} linked chains; arrows point from a chain to the chains its root member uses, and dashed lines join chains that share changes.`,
      edges,
      nodes: fam.chains.map((c) => {
        const s = stats(blocksOf(c.blocks));
        const cls = /^(_?[A-Z][\w$]*)\.(.+)$/.exec(c.name);
        return { key: 'k' + c.id, layer: c.depth, l1: cls ? cls[1] : c.kind === 'group' && !c.rootKind ? 'same change' : '', l2: cls ? cls[2] : c.name, cnt: s.open ? s.open + '/' + s.total : '✓ ' + s.total, ok: !s.open, root: c === fam.top,
          attr: `data-chain="${c.id}"`, tip: c.name };
      }),
    });
  }

  // ---------- whole files and the editor
  // A button that opens a file whole: { side, p } in the repository, or { ext } outside it.
  function sourceButton(loc, label, cls) {
    if (!CONFIG.served || (!loc.p && loc.ext == null)) return '';
    return `<button type="button" class="${cls || 'btn sm'}" data-act="open-source" data-side="${loc.side || ''}" data-p="${esc(loc.p || '')}" data-ext="${loc.ext != null ? loc.ext : ''}" data-line="${loc.line || ''}" data-label="${esc(loc.label || '')}" data-where="${esc(loc.where || '')}">${label}</button>`;
  }
  let rootsAsked = false;
  // "Open in editor": a link from the editor's URL template, or a button when untangle runs a command.
  function editorHtml(loc) {
    if (!CONFIG.served || !CONFIG.editor) return '';
    const line = loc.line || 1, col = loc.col || 0;
    if (CONFIG.editor.mode === 'command') return `<button type="button" class="btn xs" data-act="open-editor" data-side="${loc.side || ''}" data-p="${esc(loc.p || '')}" data-ext="${loc.ext != null ? loc.ext : ''}" data-line="${line}" data-col="${col}">Open in editor</button>`;
    let abs = loc.abs || null;
    if (!abs && loc.side && loc.p) {
      if (!CONFIG.roots) {
        if (!rootsAsked) { rootsAsked = true; fetch('api/roots').then((r) => r.json()).then((j) => { if (j.head) { CONFIG.roots = j; render(); } }).catch(() => {}); }
        return '';
      }
      abs = CONFIG.roots[loc.side] + '/' + loc.p;
    }
    if (!abs) return '';
    const href = CONFIG.editor.template.replace('{file}', encodeURI(abs)).replace('{line}', line).replace('{col}', col + 1);
    return `<a class="btn xs" href="${esc(href)}" title="${esc(abs)}:${line}">Open in editor</a>`;
  }
  const sources = new Map();
  const srcKey = (v) => (v.ext != null ? 'ext:' + v.ext : v.side + ':' + v.path);
  function loadSource(v) {
    const key = srcKey(v);
    if (sources.has(key)) return sources.get(key);
    const s = { status: 'loading' };
    sources.set(key, s);
    const q = new URLSearchParams(v.ext != null ? { ext: String(v.ext) } : { side: v.side, p: v.path });
    fetch('api/file?' + q).then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then((j) => Object.assign(s, { status: 'ok', text: j.text, lines: j.text.split('\n'), abs: j.abs, generated: j.generated }))
      .catch((e) => Object.assign(s, { status: 'error', error: e.message }))
      .then(() => { if (state.view.kind === 'source' && srcKey(state.view) === key) render(state.view.line ? { line: state.view.line } : { top: true }); });
    return s;
  }
  // A whole file at one side, or outside the repository. Names in it ask the server where
  // they are defined; lines this review changes are marked.
  function renderSource(v) {
    const s = loadSource(v);
    const name = v.ext != null ? v.label || 'file' : v.path;
    const f = v.ext == null ? M().files.find((x) => x.p === v.path) : null;
    const g = v.ext == null ? M().generated.find((x) => x.p === v.path) : null;
    const sha = v.side === 'base' ? CONFIG.base : CONFIG.head;
    const changed = new Set();
    if (f) f.hunks.forEach((hk) => hk.meta.forEach((r) => { if (v.side === 'base' ? r.t === '-' : r.t === '+') changed.add(v.side === 'base' ? r.o : r.n); }));
    const dir = name.slice(0, name.lastIndexOf('/') + 1);
    const meta = `<span>${v.ext != null ? esc(v.where || 'outside the repository') : `${v.side} · ${esc((sha || '').slice(0, 7))}`}</span>${s.lines ? `<span>${fmt(s.lines.length)} lines</span>` : ''}${changed.size ? `<span class="${v.side === 'base' ? 'd' : 'a'}">${changed.size} line${changed.size > 1 ? 's' : ''} ${v.side === 'base' ? 'removed' : 'added'} by this review</span>` : ''}${s.generated || g ? '<span>generated</span>' : ''}`;
    const actions = (f || g ? `<button type="button" class="btn sm" data-open="${esc(v.path)}">Show changes</button>` : '')
      + (f && f.s === 'M' ? sourceButton({ side: v.side === 'base' ? 'head' : 'base', p: v.path }, v.side === 'base' ? 'Head side' : 'Base side') : '')
      + editorHtml({ side: v.side, p: v.path, ext: v.ext, abs: s.abs, line: v.line || 1 }).replace('btn xs', 'btn sm');
    let h = headerHtml(`<span class="fv-dir">${esc(dir)}</span><b>${esc(fileName(name))}</b>`, meta, actions);
    if (s.status === 'loading') return h + '<div class="empty">Loading the file…</div>';
    if (s.status === 'error') return h + `<div class="empty">${esc(s.error)}</div>`;
    const colors = textColors(s.text, name);
    const key = srcKey(v);
    const file = { p: name, lang: C.langOf(name) };
    h += '<div class="code src">';
    s.lines.forEach((text, i) => {
      const ln = i + 1, c = changed.has(ln);
      h += `<div class="ln ${c ? (v.side === 'base' ? 'del' : 'add') : 'ctx'}" data-n="${ln}"><span class="g"></span><span class="no">${ln}</span><span class="sg">${c ? (v.side === 'base' ? '−' : '+') : ''}</span><span class="tx">${codeHtml(file, text, null, { colors: colors && colors[i], live: { side: v.side, p: v.path, ext: v.ext, line: ln } })}</span></div>`;
      if (state.peek && state.peek.src && state.peek.src.key === key && state.peek.src.line === ln) h += peekHtml(state.peek);
    });
    return h + '</div>';
  }
  function openSource(d) {
    state.view = { kind: 'source', side: d.side || null, path: d.p || null, ext: d.ext !== '' && d.ext != null ? Number(d.ext) : null, line: d.line ? Number(d.line) : null, label: d.label || null, where: d.where || null };
    if (state.view.ext == null && !state.view.side) state.view.side = 'head';
    state.peek = null;
    render(state.view.line ? { line: state.view.line } : { top: true });
  }
  // A name clicked anywhere without an answer computed ahead: ask the server. The peek opens
  // under the line; clicked inside a peek, the peek moves to the new definition (Back returns).
  const anchorOf = (p) => ({ path: p.path, n: p.n, old: p.old, o: p.o, col: p.col, src: p.src });
  function liveLookup(el) {
    const d = el.dataset;
    const q = { side: d.ls || null, p: d.lp || null, ext: d.lx !== '' && d.lx != null ? Number(d.lx) : null, l: Number(d.ll), c: Number(d.lc) };
    const sameQ = (x) => x && x.side === q.side && x.p === q.p && x.ext === q.ext && x.l === q.l && x.c === q.c;
    let peek;
    if (el.closest('.peek') && state.peek) peek = { ...anchorOf(state.peek), live: { q, status: 'loading' }, back: [...(state.peek.back || []), state.peek] };
    else {
      if (state.peek && state.peek.live && sameQ(state.peek.live.q) && !(state.peek.back || []).length) { state.peek = null; return render(); }
      if (state.view.kind === 'source') peek = { src: { key: srcKey(state.view), line: q.l }, live: { q, status: 'loading' } };
      else if (q.side === 'base') peek = { old: true, path: q.p, o: q.l, col: q.c, live: { q, status: 'loading' } };
      else peek = { path: q.p, n: q.l, col: q.c, live: { q, status: 'loading' } };
    }
    state.peek = peek;
    render();
    const params = new URLSearchParams({ l: String(q.l), c: String(q.c) });
    if (q.side) params.set('side', q.side);
    if (q.p) params.set('p', q.p);
    if (q.ext != null) params.set('ext', String(q.ext));
    fetch('api/definition?' + params).then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
      .then((j) => { peek.live = j.target ? { q, status: 'ok', target: j.target } : { q, status: 'none' }; })
      .catch((e) => { peek.live = { q, status: 'error', error: e.message }; })
      .then(() => { if (state.peek === peek) render(); });
  }

  // ---------- views
  function headerHtml(title, metaHtml, actionHtml, sub) {
    return `<div class="fv-head"><div class="fv-title">${title}</div>${sub || ''}<div class="fv-meta">${metaHtml}<span class="sp"></span>${actionHtml || ''}</div></div>`;
  }
  function instancesHtml(g, blocks, key) {
    const list = blocks || g.edits.map((id) => M().blockById.get(M().edits[id].b)).filter((b, i, arr) => arr.indexOf(b) === i);
    const showAll = state.groupAll.has(key) || list.length <= 12;
    const shown = showAll ? list : list.slice(0, 10);
    let h = '<div class="code inst">';
    let lastFile = null;
    shown.forEach((b) => {
      const f = b.file;
      const hunk = f.hunks[b.hunk];
      if (f !== lastFile) { h += `<div class="inst-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${esc(f.p)}</button></div>`; lastFile = f; }
      // Each edit's rows, extended to its whole syntax nodes, with one line of context.
      // Small changes are shown whole.
      const keep = new Set();
      if (b.len <= 8) for (let i = b.first; i < b.first + b.len; i++) keep.add(i);
      g.edits.forEach((id) => {
        const ed = M().edits[id];
        if (ed.b !== b.id) return;
        hunk.meta.forEach((r, i) => {
          if ((ed.ns && r.n != null && r.t !== '-' && r.n >= ed.ns[0] && r.n <= ed.ns[1]) || (ed.os && r.o != null && r.t !== '+' && r.o >= ed.os[0] && r.o <= ed.os[1])) keep.add(i);
        });
      });
      const wide = new Set();
      keep.forEach((i) => { for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < hunk.rows.length) wide.add(k); });
      const idx = [...wide].sort((x, y) => x - y);
      let segStart = idx[0];
      for (let k = 1; k <= idx.length; k++) {
        if (k === idx.length || idx[k] !== idx[k - 1] + 1) {
          h += anyRowsHtml(f, b.hunk, segStart, idx[k - 1] + 1, { noBadges: true });
          if (k < idx.length) { h += `<div class="ln skip"><span class="g"></span><span class="tx">⋯ ${idx[k] - idx[k - 1] - 1} lines of the same change</span></div>`; segStart = idx[k]; }
        }
      }
      h += '<div class="inst-gap"></div>';
    });
    h += '</div>';
    if (!showAll) h += `<div class="more-row"><button type="button" class="btn sm" data-act="group-all" data-key="${esc(key)}">Show all ${list.length} places</button></div>`;
    return h;
  }
  // The order chains are reviewed in: families as the sidebar lists them (each by level), then
  // unlinked chains, then the changes outside chains.
  function chainOrder() {
    const m = M();
    const linked = m.families.filter((f) => f.chains.length > 1).flatMap((f) => f.chains);
    const lone = m.families.filter((f) => f.chains.length === 1).map((f) => f.chains[0]).sort((x, y) => y.blocks.length - x.blocks.length);
    return linked.concat(lone).map((c) => c.id);
  }
  function nextUnreviewed() {
    const m = M();
    const order = chainOrder();
    const at = state.view.kind === 'chain' ? order.indexOf(state.view.id) : -1;
    for (let k = 1; k <= order.length; k++) {
      const id = order[(at + k + order.length) % order.length];
      if (stats(blocksOf(m.chains[id].blocks)).open) return { kind: 'chain', id };
    }
    return stats(m.standalone).open ? { kind: 'standalone' } : null;
  }
  const nextBtn = () => (nextUnreviewed() ? '<button type="button" class="btn sm" data-act="next-open" title="Next chain with changes to review (key: n)">Next unreviewed ›</button>' : '<span class="muted">All reviewed</span>');
  // A chain made only of one test file's changes: its tests as a list, grouped by group(...).
  function testListHtml(c, blocks) {
    const byGroup = new Map();
    const helpers = [];
    blocks.forEach((b) => {
      if (!/::(test:.*|main|\(top\))$/.test(b.mk || '')) { helpers.push(b); return; }
      const g = b.grp || '(no group)';
      if (!byGroup.has(g)) byGroup.set(g, new Map());
      const t = b.test && b.test !== b.grp ? b.test : '(setup)';
      if (!byGroup.get(g).has(t)) byGroup.get(g).set(t, []);
      byGroup.get(g).get(t).push(b);
    });
    let h = '';
    byGroup.forEach((tests, g) => {
      h += `<section class="sec"><div class="sec-h"><div class="sec-t"><b>${esc(g)}</b> <span>group · ${tests.size} test${tests.size > 1 ? 's' : ''}</span></div></div>`;
      tests.forEach((list, t) => {
        const ns = stats(list);
        h += `<div class="sec-h sub"><div class="sec-t"><span>${esc(t)}</span></div><div class="sec-m"><span class="sp"></span><span>${ns.total - ns.open}/${ns.total} reviewed</span><button type="button" class="btn xs" data-act="mark-blocks" data-blocks="${esc(list.map((b) => b.id).join(' '))}">${ns.open ? '✓ Mark test reviewed' : 'Mark test unreviewed'}</button></div></div>`
          + subHunksHtml(list, { chain: c, key: 'tl' + c.id + ':' + g + ':' + t });
      });
      h += '</section>';
    });
    if (helpers.length) h += `<section class="sec"><div class="sec-h"><div class="sec-t"><b>Helpers</b> <span>${helpers.length} change${helpers.length > 1 ? 's' : ''}</span></div></div>${subHunksHtml(helpers, { chain: c, key: 'tlh' + c.id })}</section>`;
    return h;
  }
  function renderChain(id) {
    const m = M();
    const c = m.chains[id];
    if (!c) return '<div class="empty">This chain doesn’t exist in this comparison.</div>';
    const s = stats(blocksOf(c.blocks));
    const chip = (o) => `<button type="button" class="chip-btn" data-chain="${o}">${esc(m.chains[o].name)}</button>`;
    const usedBy = m.usedBy.get(c.id);
    let sub = c.also.length ? `<div class="fv-sub">Also carries ${c.also.map((x) => `<code>${esc(x)}</code>`).join(', ')}</div>` : '';
    if (usedBy.length || c.uses.length) {
      sub += `<div class="fv-sub hier">${usedBy.length ? `<span class="links-k">Used by</span>${usedBy.slice(0, 6).map(chip).join('')}${usedBy.length > 6 ? `<span class="muted">+${usedBy.length - 6}</span>` : ''}` : ''}${c.uses.length ? `<span class="links-k">Uses</span>${c.uses.slice(0, 6).map(chip).join('')}${c.uses.length > 6 ? `<span class="muted">+${c.uses.length - 6}</span>` : ''}` : ''}<button type="button" class="linkish map-link" data-map="${c.family}">Open the chain map</button></div>`;
    }
    let h = headerHtml(`<b>${wbr(c.name)}</b>`,
      `<span>${c.kind === 'group' && !c.rootKind ? 'same change' : kindWord[c.rootKind] || 'chain'}</span>${diffstat(c.adds, c.dels)}<span>${s.total} changes · ${c.files} file${c.files > 1 ? 's' : ''}</span><span>${s.total - s.open}/${s.total} reviewed</span>`,
      `<button type="button" class="btn sm${s.open ? ' primary' : ''}" data-act="mark-chain" data-chain-id="${c.id}">${s.open ? 'Mark chain reviewed' : 'Mark chain unreviewed'}</button>${nextBtn()}`, sub);
    const all = blocksOf(c.blocks);
    const oneTestFile = new Set(all.map((b) => b.file)).size === 1 && TEST_FILE.test(all[0].file.p);
    if (oneTestFile) return h + `<p class="sec-note">One test file: its tests, grouped by <code>group(…)</code>.</p>` + testListHtml(c, all);
    const focused = state.focus && state.focus.chain === c.id ? c.graph.nodes[state.focus.node] : null;
    h += `<div class="graph-box"><div class="graph-scroll">${graphSvg(c)}</div>
      <div class="graph-legend"><span><i class="lg-open"></i>has changes to review</span><span><i class="lg-ok"></i>reviewed</span><span>Arrows point from a change to what it uses. Click a node to show only its code.</span></div></div>`;
    if (focused) {
      const { l2 } = nodeLabels(focused);
      h += `<div class="focus-bar">Showing only <b>${esc(l2)}</b> · ${focused.blocks.length} change${focused.blocks.length > 1 ? 's' : ''}<span class="sp"></span><button type="button" class="btn xs" data-act="clear-focus">Show all ${c.graph.nodes.length} nodes</button></div>`;
    }
    c.graph.nodes.forEach((n) => {
      if (focused && n !== focused) return;
      const blocks = blocksOf(n.blocks);
      const ns = stats(blocks);
      const { l1, l2, owner } = nodeLabels(n);
      const uses = c.graph.edges.filter((e) => e.from === n.key).map((e) => `uses <code>${esc(e.labels.join(', '))}</code> of ${esc(nodeLabels(c.graph.nodes.find((x) => x.key === e.to)).l2)}`);
      const usedByN = c.graph.edges.filter((e) => e.to === n.key).length;
      const rel = uses.concat(usedByN ? [`used by ${usedByN} node${usedByN > 1 ? 's' : ''}`] : []).join(' · ');
      const adds = blocks.reduce((x, b) => x + b.adds, 0), dels = blocks.reduce((x, b) => x + b.dels, 0);
      h += `<section class="sec" id="sec-${n.idx}"><div class="sec-h"><div class="sec-t"><b>${esc(l2)}</b> <span>${esc(owner ? owner + ' · ' + l1 : l1)}</span>${n.key === c.graph.root ? '<span class="root-pill">root</span>' : ''}${diffstat(adds, dels)}</div>
        <div class="sec-m"><span>${rel}</span><span class="sp"></span><span>${ns.total - ns.open}/${ns.total} reviewed</span><button type="button" class="btn xs" data-act="mark-blocks" data-blocks="${esc(n.blocks.join(' '))}">${ns.open ? '✓ Mark node reviewed' : 'Mark node unreviewed'}</button></div></div>`;
      if (n.group !== null && n.group !== undefined) {
        const g = m.groupById.get(n.group);
        h += `<p class="sec-note">The same change in ${blocks.length} places. Each place shows the whole edit.</p>` + instancesHtml(g, blocks, 'chain' + c.id + ':' + n.idx);
      } else {
        h += subHunksHtml(blocks, { chain: c, key: 'c' + c.id + 'n' + n.idx });
        // The member's other changes belong to other chains: folded context here.
        const rest = n.member ? [...new Set(blocks.map((b) => b.mk))].flatMap((k) => m.byMember.get(k) || []).filter((b) => !c.blockSet.has(b.id)) : [];
        if (rest.length) {
          const key = c.id + ':' + n.idx, open = state.memberOpen.has(key);
          const others = [...new Set(rest.flatMap((b) => m.chainsOf.get(b.id) || []))];
          h += `<div class="more-row ctx-row"><button type="button" class="linkish" data-act="toggle-member" data-key="${esc(key)}">${open ? 'Hide' : 'Show'} ${rest.length} more change${rest.length > 1 ? 's' : ''} in this member</button><span class="muted">, in ${others.length ? others.slice(0, 2).map((o) => esc(m.chains[o].name)).join(', ') + (others.length > 2 ? ` +${others.length - 2}` : '') : 'no chain'}</span></div>`;
          if (open) h += subHunksHtml(rest, { chain: c, key: 'cm' + key });
        }
      }
      h += '</section>';
    });
    return h;
  }
  function renderMap(famId) {
    const m = M();
    const fam = m.families.find((f) => f.id === famId) || m.families[0];
    const linked = m.families.filter((f) => f.chains.length > 1);
    let h = headerHtml('<b>Chain map</b>', `<span>${fam.chains.length} linked chains</span><span>${fam.depth + 1} levels</span>`, nextBtn(),
      `<div class="fv-sub">A chain uses another when its root member uses that chain’s function, method, field or type. Chains that nothing uses sit on the left. A dashed line joins chains that share changes.</div>${linked.length > 1 ? `<div class="fv-sub"><span class="links-k">Families</span>${linked.map((f) => `<button type="button" class="chip-btn${f === fam ? ' on' : ''}" data-map="${f.id}">${esc(f.top.name)} · ${f.chains.length}</button>`).join('')}</div>` : ''}`);
    h += `<div class="graph-box"><div class="graph-scroll tall">${mapSvg(fam)}</div>
      <div class="graph-legend"><span><i class="lg-open"></i>has changes to review</span><span><i class="lg-ok"></i>reviewed</span><span>Faint arrows skip levels.</span><span><i class="lg-share"></i>shares changes</span><span>Click a chain to open it.</span></div></div>`;
    return h;
  }
  function renderStandalone() {
    const m = M();
    const s = stats(m.standalone);
    let h = headerHtml('<b>Not in a chain</b>', `<span>${s.total} changes</span><span>${s.total - s.open} reviewed</span>`,
      `<button type="button" class="btn sm${s.open ? ' primary' : ''}" data-act="mark-standalone">${s.open ? 'Mark all reviewed' : 'Mark all unreviewed'}</button>`,
      '<div class="fv-sub">Changes that don’t use, and aren’t used by, anything changed elsewhere. Grouped by file.</div>');
    return h + '<div class="sec">' + subHunksHtml(m.standalone, { key: 'standalone' }) + '</div>';
  }
  function renderFile(path) {
    const m = M();
    const f = m.files.find((x) => x.p === path);
    if (!f) {
      const g = m.generated.find((x) => x.p === path);
      return g ? renderGenerated(path) : `<div class="empty">${esc(path)} has no changes in this comparison.</div>`;
    }
    const s = stats(f.blocks);
    const dir = f.p.slice(0, f.p.lastIndexOf('/') + 1);
    const chains = [...new Set(f.blocks.flatMap((b) => m.chainsOf.get(b.id) || []))];
    let h = headerHtml(`<span class="fv-dir">${esc(dir)}</span><b>${esc(fileName(f.p))}</b>`,
      `<span>${{ A: 'added', M: 'modified', D: 'deleted' }[f.s] || f.s}</span><span>${s.open} of ${s.total} changes to review</span>${s.open ? `<span class="a">+${f.blocks.filter((b) => !done(b)).reduce((x, b) => x + b.adds, 0)}</span><span class="d">−${f.blocks.filter((b) => !done(b)).reduce((x, b) => x + b.dels, 0)}</span>` : ''}`,
      `${sourceButton({ side: f.s === 'D' ? 'base' : 'head', p: f.p }, 'Whole file')}${editorHtml({ side: f.s === 'D' ? 'base' : 'head', p: f.p, line: (f.blocks.find((b) => b.adds) && f.hunks[f.blocks.find((b) => b.adds).hunk].meta[f.blocks.find((b) => b.adds).first].n) || 1 }).replace('btn xs', 'btn sm')}<button type="button" class="btn sm${s.open ? ' primary' : ''}" data-act="mark-file" data-file="${f.idx}">${s.open ? 'Mark file reviewed' : 'Mark file unreviewed'}</button>`,
      chains.length ? `<div class="fv-sub">In chains: ${chains.slice(0, 6).map((id) => `<button type="button" class="chip-btn" data-chain="${id}">${esc(m.chains[id].name)}</button>`).join('')}${chains.length > 6 ? ` +${chains.length - 6}` : ''}</div>` : '');
    if (state.compare === 'since') h += `<div class="since-note">Left: your reviewed snapshot (as if you had reviewed everything up to <code>${esc(m.raw.left)}</code>). Right: the head <code>${esc(m.raw.right)}</code>.</div>`;
    h += '<div class="code">';
    f.hunks.forEach((hk, hi) => { h += hunkHtml(f, hi, { key: 'file' }); });
    return h + '</div>';
  }
  function renderGenerated(path) {
    const f = M().generated.find((x) => x.p === path);
    const dir = f.p.slice(0, f.p.lastIndexOf('/') + 1);
    let h = headerHtml(`<span class="fv-dir">${esc(dir)}</span><b>${esc(fileName(f.p))}</b>`, `<span>generated (${esc(f.gen)})</span><span class="a">+${f.a}</span><span class="d">−${f.d}</span>`, sourceButton({ side: f.s === 'D' ? 'base' : 'head', p: f.p }, 'Whole file'),
      '<div class="gen-note">Generated: not reviewed and not counted. Shown for reference only.</div>');
    if (!f.hunks) {
      if (!CONFIG.served) return h + `<div class="empty">This file’s ${fmt(f.a + f.d)} changed lines aren’t in this page.</div>`;
      if (f.loadError) return h + `<div class="empty">${esc(f.loadError)}</div>`;
      if (!f.loading) {
        f.loading = true;
        fetch('api/generated?p=' + encodeURIComponent(f.p))
          .then((r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || r.status); return j; }))
          .then((j) => { f.hunks = j.hunks; })
          .catch((e) => { f.loadError = `Couldn’t load this file’s diff: ${e.message}`; })
          .then(() => { if (state.view.kind === 'file' && state.view.path === f.p) render(); });
      }
      return h + `<div class="empty">Loading ${fmt(f.a + f.d)} changed lines…</div>`;
    }
    h += '<div class="code">';
    f.hunks.forEach((hk) => {
      h += `<div class="hh"><span class="hh-tx">@@ −${hk.o} +${hk.n} @@ <span class="hh-ctx">${esc(hk.h)}</span></span></div>`;
      let o = hk.o, n = hk.n;
      hk.rows.forEach(([t, text], i) => {
        const meta = { t, o: t !== '+' ? o : null, n: t !== '-' ? n : null };
        if (t !== '+') o++;
        if (t !== '-') n++;
        h += uRow({ p: f.p, lang: C.langOf(f.p) }, meta, text, null, { cls: (t === '+' ? 'add' : t === '-' ? 'del' : 'ctx') + ' gen', refs: false, colors: rowColors(hk.rows, f.p, i) });
      });
    });
    return h + '</div>';
  }
  function renderGroup(id) {
    const g = M().groupById.get(Number(id));
    if (!g) return '<div class="empty">No such group in this comparison.</div>';
    const ok = g.edits.every((x) => rev().has(x));
    const e0 = M().edits[g.parts[0]];
    // Places grouped by the declaration they resolve to, when there is more than one.
    const bySym = new Map();
    g.edits.forEach((id) => { const e = M().edits[id]; const k = e.sym ? e.sym[0] : ''; if (!bySym.has(k)) bySym.set(k, { label: e.sym ? e.sym[1] : '', edits: [] }); bySym.get(k).edits.push(id); });
    const syms = bySym.size > 1 ? [...bySym.values()] : null;
    let h = headerHtml(`<b class="mono">${esc(groupLabel(g))}</b>`,
      `<span>same change in ${g.count} places · ${g.files} files${syms ? ` · ${syms.length} declarations` : ''}</span><span>${e0.op === 'token' ? 'token replaced, as ' + esc(e0.where) : esc(e0.op) + ' of ' + esc(e0.where)}</span>${g.parts.length > 1 ? `<span>${g.parts.length} edits that always appear together</span>` : ''}`,
      `<button type="button" class="btn sm${ok ? '' : ' primary'}" data-act="mark-group" data-group-id="${g.id}">${ok ? 'Mark all unreviewed' : `Mark all ${g.count} reviewed`}</button>`);
    if (!syms) return h + instancesHtml(g, null, 'group' + g.id);
    syms.forEach((sy, i) => {
      const blocks = sy.edits.map((id) => M().blockById.get(M().edits[id].b)).filter((b, k, arr) => arr.indexOf(b) === k);
      const done2 = sy.edits.every((x) => rev().has(x));
      h += `<div class="sym-h"><b class="mono">${esc(sy.label || 'unresolved')}</b><span class="muted">${sy.edits.length} place${sy.edits.length > 1 ? 's' : ''}</span><span class="sp"></span><button type="button" class="btn xs" data-act="mark-edits" data-edits="${sy.edits.join(' ')}">${done2 ? (sy.edits.length > 1 ? 'Mark these unreviewed' : 'Mark it unreviewed') : sy.edits.length > 1 ? `Mark these ${sy.edits.length} reviewed` : 'Mark it reviewed'}</button></div>`
        + instancesHtml(g, blocks, 'group' + g.id + ':' + i);
    });
    return h;
  }
  const repoSearches = new Map();
  function repoSearch(side, q) {
    const key = side + '\0' + q;
    if (!repoSearches.has(key)) {
      const r = { status: 'loading' };
      repoSearches.set(key, r);
      fetch('api/search?' + new URLSearchParams({ side, q })).then((x) => x.json().then((j) => { if (!x.ok) throw new Error(j.error || x.status); return j; }))
        .then((j) => Object.assign(r, { status: 'ok', results: j.results, truncated: j.truncated }))
        .catch((e) => Object.assign(r, { status: 'error', error: e.message }))
        .then(() => { if (state.view.kind === 'search' && state.search.q.trim() === q) render(); });
    }
    return repoSearches.get(key);
  }
  function scopesHtml() {
    const b = (k, label) => `<button type="button" data-scope="${k}" aria-pressed="${state.search.scope === k}">${label}</button>`;
    return `<span class="mini-seg" role="group" aria-label="Search scope">${b('unreviewed', 'Not reviewed')}${b('all', 'All changes')}${CONFIG.served ? b('repo-head', 'Repository · head') + b('repo-base', 'Repository · base') : ''}</span>`;
  }
  // Marks every place the query appears in a line (case-insensitive when the query is lower case).
  function markAll(text, q) {
    const hay = q === q.toLowerCase() ? text.toLowerCase() : text;
    let out = '', at = 0, i;
    while (q && (i = hay.indexOf(q, at)) >= 0) { out += esc(text.slice(at, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>'; at = i + q.length; }
    return out + esc(text.slice(at));
  }
  function renderRepoSearch(side, q) {
    const r = repoSearch(side, q);
    let h = headerHtml(`<b>Search the repository for “${esc(q)}”</b>`, `<span>${side} · ${esc(((side === 'base' ? CONFIG.base : CONFIG.head) || '').slice(0, 7))}</span>${r.status === 'ok' ? `<span>${r.results.length}${r.truncated ? '+' : ''} result${r.results.length === 1 ? '' : 's'}</span>` : ''}${scopesHtml()}`);
    if (q.length < 2) return h + '<div class="empty">Type at least two characters.</div>';
    if (r.status === 'loading') return h + '<div class="empty">Searching…</div>';
    if (r.status === 'error') return h + `<div class="empty">${esc(r.error)}</div>`;
    if (!r.results.length) return h + '<div class="empty">No line in the repository matches.</div>';
    // Generated files last.
    const list = r.results.slice().sort((a, b) => (a.generated - b.generated) || 0);
    h += '<div class="code">';
    let last = null;
    list.forEach((x) => {
      if (x.p !== last) { h += `<div class="inst-file">${sourceButton({ side, p: x.p }, esc(x.p), 'linkish')}${x.generated ? ' <span class="gen-tag">generated</span>' : ''}</div>`; last = x.p; }
      h += `<div class="ln ctx"><span class="g"></span><span class="no wide">${sourceButton({ side, p: x.p, line: x.l }, String(x.l), 'linkish')}</span><span class="sg"></span><span class="tx">${markAll(x.text, q)}</span></div>`;
    });
    if (r.truncated) h += `<div class="empty">The first ${r.results.length} matches. Make the search more precise for the rest.</div>`;
    return h + '</div>';
  }
  function renderSearch() {
    if (state.search.scope.startsWith('repo-')) return renderRepoSearch(state.search.scope.slice(5), state.search.q.trim());
    const q = state.search.q.trim().toLowerCase();
    const m = M();
    const res = [];
    m.files.forEach((f) => f.blocks.forEach((b) => {
      if (!b.edits.length || (state.search.scope === 'unreviewed' && done(b))) return;
      const h = f.hunks[b.hunk];
      for (let i = b.first; i < b.first + b.len; i++) if (h.rows[i][1].toLowerCase().includes(q)) res.push({ f, meta: h.meta[i], text: h.rows[i][1] });
    }));
    let h = headerHtml(`<b>Search changed lines for “${esc(state.search.q)}”</b>`, `<span>${res.length} result${res.length === 1 ? '' : 's'}</span>${scopesHtml()}`);
    h += '<div class="code">';
    let last = null;
    res.slice(0, 400).forEach(({ f, meta, text }) => {
      if (f !== last) { h += `<div class="inst-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${esc(f.p)}</button></div>`; last = f; }
      const i = text.toLowerCase().indexOf(q);
      const line = meta.t !== '-' ? meta.n : meta.o;
      h += `<div class="ln ${meta.t === '+' ? 'add' : 'del'}"><span class="g"></span><span class="no wide"><button type="button" class="linkish" data-open="${esc(f.p)}" data-line="${meta.t !== '-' ? meta.n : ''}">${line}</button></span><span class="sg">${meta.t === '+' ? '+' : '−'}</span><span class="tx">${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}</span></div>`;
    });
    if (!res.length) h += `<div class="empty">No changed line matches.${CONFIG.served ? ' “Repository” searches every file.' : ''}</div>`;
    return h + '</div>';
  }

  // ---------- sidebar
  // Where marks are kept: the reviewed-snapshot branch, or this browser for a page on its own.
  function snapshotHtml() {
    if (!CONFIG.served) return '<div class="sb-snap">Marks are kept in this browser.</div>';
    const sn = CONFIG.snapshot;
    if (!sn) return '';
    return `<div class="sb-snap" title="git diff ${esc(sn.branch)} ${esc((CONFIG.head || '').slice(0, 12))} shows what’s left">Marks on <code>${esc(sn.branch)}</code>${sn.commit ? ` · ${esc(sn.commit.slice(0, 7))}` : ''}${sn.note ? `<br>${esc(sn.note)}` : ''}</div>`;
  }
  function renderSide() {
    const m = M();
    const all = m.files.flatMap((f) => f.blocks);
    const t = stats(all);
    const pct = t.all ? Math.round((1 - t.lines / t.all) * 100) : 100;
    const v = state.view;
    let h = `<div class="sb-prog"><div class="sb-big"><b>${t.open}</b> of ${t.total} changes to review</div>
      <div class="track" aria-hidden="true"><div class="fill" style="width:${pct}%"></div></div>
      <div class="sb-sub">${pct}% of changed lines reviewed · <button type="button" class="linkish" data-act="reset">Reset</button></div>${snapshotHtml()}</div>
      <div class="tabs" role="tablist"><button type="button" role="tab" data-tab="chains" aria-selected="${state.tab === 'chains'}">Chains <span>${m.chains.length}</span></button><button type="button" role="tab" data-tab="files" aria-selected="${state.tab === 'files'}">Files <span>${m.files.length}</span></button></div>`;
    if (state.tab === 'chains') {
      const row = (c, indent) => {
        const s = stats(blocksOf(c.blocks));
        const frac = s.total ? Math.round(((s.total - s.open) / s.total) * 100) : 100;
        const on = v.kind === 'chain' && v.id === c.id;
        return `<button type="button" class="sb-row chain${s.open ? '' : ' done'}" data-chain="${c.id}"${on ? ' aria-current="true"' : ''} style="padding-left:${8 + Math.min(indent, 6) * 12}px">
          <span class="st"></span><span class="nm">${wbr(c.name)}<span class="sub">${s.total} change${s.total > 1 ? 's' : ''} · ${c.files} file${c.files > 1 ? 's' : ''} · <span class="a">+${fmt(c.adds)}</span> <span class="d">−${fmt(c.dels)}</span></span><span class="mini-track"><span style="width:${frac}%"></span></span></span>
          <span class="cnt">${s.open ? s.open + ' left' : 'reviewed'}</span></button>`;
      };
      const linked = m.families.filter((f) => f.chains.length > 1);
      const lone = m.families.filter((f) => f.chains.length === 1).map((f) => f.chains[0]).sort((x, y) => y.blocks.length - x.blocks.length);
      h += `<button type="button" class="sb-row map${v.kind === 'map' ? '' : ''}" data-map="${linked.length ? linked[0].id : ''}"${v.kind === 'map' ? ' aria-current="true"' : ''}><span class="st"></span><span class="nm">Chain map<span class="sub">${linked.length} famil${linked.length === 1 ? 'y' : 'ies'} of linked chains, in levels</span></span><span class="cnt">›</span></button>`;
      linked.forEach((f) => {
        h += `<div class="sb-h"><span>Family · ${esc(trunc(f.top.name, 30))}</span><span class="sb-hn">${f.chains.length}</span></div>` + f.chains.map((c) => row(c, c.depth)).join('');
      });
      if (lone.length) h += `<div class="sb-h"><span>Unlinked chains</span><span class="sb-hn">${lone.length}</span></div>` + lone.map((c) => row(c, 0)).join('');
      const s = stats(m.standalone);
      h += `<div class="sb-h"><span>Outside chains</span></div><button type="button" class="sb-row chain${s.open ? '' : ' done'}" data-standalone="1"${v.kind === 'standalone' ? ' aria-current="true"' : ''}><span class="st"></span><span class="nm">Not in a chain<span class="sub">${s.total} changes · grouped by file</span></span><span class="cnt">${s.open ? s.open + ' left' : 'reviewed'}</span></button>`;
    } else {
      let lastDir = null;
      m.files.forEach((f) => {
        const dir = f.p.slice(0, f.p.lastIndexOf('/') + 1);
        if (dir !== lastDir) { h += `<div class="sb-dir" title="${esc(dir)}">${esc(dir)}</div>`; lastDir = dir; }
        const s = stats(f.blocks);
        const on = v.kind === 'file' && v.path === f.p;
        h += `<button type="button" class="sb-row${s.open ? '' : ' done'}" data-open="${esc(f.p)}"${on ? ' aria-current="true"' : ''}><span class="st"></span><span class="nm">${esc(fileName(f.p))}</span><span class="cnt">${s.open ? s.open + ' left' : 'reviewed'}</span></button>`;
      });
      h += `<div class="sb-h"><span>Generated · not reviewed</span><span class="sb-hn">${m.generated.length}</span></div>`;
      m.generated.forEach((f) => {
        const on = v.kind === 'file' && v.path === f.p;
        h += `<button type="button" class="sb-row gen" data-open="${esc(f.p)}"${on ? ' aria-current="true"' : ''}><span class="st"></span><span class="nm">${esc(fileName(f.p))}<span class="sub">${esc(f.p.slice(0, f.p.lastIndexOf('/')))}</span></span><span class="cnt"><span class="a">+${f.a}</span></span></button>`;
      });
    }
    side.innerHTML = h;
  }

  // ---------- render
  function render(opts) {
    opts = opts || {};
    const keep = main.scrollTop;
    renderSide();
    const v = state.view;
    main.innerHTML = v.kind === 'chain' ? renderChain(v.id) : v.kind === 'map' ? renderMap(v.family) : v.kind === 'standalone' ? renderStandalone() : v.kind === 'group' ? renderGroup(v.id) : v.kind === 'search' ? renderSearch() : v.kind === 'source' ? renderSource(v) : renderFile(v.path);
    viewer.querySelectorAll('[data-compare]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.compare === state.compare)));
    const title = $('#vw-title');
    if (title && M().raw.title && !title.childElementCount) {
      const [first, ...rest] = M().raw.title.split(' ');
      const name = `<b>${esc(first)}</b> ${esc(rest.join(' '))}`;
      title.innerHTML = (CONFIG.url ? `<a href="${esc(CONFIG.url)}" target="_blank" rel="noopener">${name}</a>` : `<span>${name}</span>`)
        + `<span class="vw-where">${esc(CONFIG.where || M().raw.label)}</span>`;
    }
    viewer.querySelectorAll('[data-layout]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layout === state.layout)));
    viewer.classList.toggle('split', state.layout === 'split');
    const rd = $('#vw-revdiff');
    if (rd) rd.checked = state.showReviewedDiff;
    const headH = () => { const hd = main.querySelector('.fv-head'); return hd ? hd.offsetHeight : 0; };
    if (opts.line) {
      const el = main.querySelector(`[data-n="${opts.line}"]`);
      if (el) { main.scrollTop = el.offsetTop - headH() - 60; el.classList.add('flash'); }
    } else if (opts.section != null) {
      const el = main.querySelector('#sec-' + opts.section);
      if (el) { main.scrollTop = el.offsetTop - headH() - 8; el.classList.add('flash-sec'); }
    } else if (opts.top) main.scrollTop = 0;
    else main.scrollTop = keep;
    const cur = side.querySelector('[aria-current="true"]');
    if (cur && opts.top) {
      if (cur.offsetTop < side.scrollTop || cur.offsetTop > side.scrollTop + side.clientHeight - 40) side.scrollTop = cur.offsetTop - side.clientHeight / 3;
    }
  }
  function openFile(path, line) {
    state.view = { kind: 'file', path };
    state.peek = null;
    if (line) {
      const hl = M().head.get(path + ':' + line);
      if (hl) { const k = 'file|' + path + '#' + hl.hi + ':0'; state.collapsed.delete(k); state.expanded.add(k); }
    }
    render(line ? { line: Number(line) } : { top: true });
  }

  // ---------- events
  viewer.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-open],[data-group],[data-chain],[data-standalone],[data-node],[data-graph-open],[data-map],[data-tab],[data-compare],[data-layout],[data-usage],[data-scope],.ref');
    if (t && t.tagName === 'A') return;
    if (!t || !viewer.contains(t)) return;
    const m = M();
    const d = t.dataset;
    if (d.compare) {
      if (state.compare === d.compare) return;
      state.compare = d.compare; state.peek = null;
      state.view = { kind: 'map', family: null }; state.focus = null;
      return render({ top: true });
    }
    if (d.layout) { state.layout = d.layout; save(); return render(); }
    if (d.tab) { state.tab = d.tab; return render(); }
    if (d.scope) { state.search.scope = d.scope; return render({ top: true }); }
    if (d.graphOpen) { state.graphOpen.add(d.graphOpen); return render(); }
    if (d.node !== undefined && !d.act) {
      const node = Number(d.node);
      const same = state.focus && state.focus.chain === state.view.id && state.focus.node === node;
      state.focus = same ? null : { chain: state.view.id, node };
      return render(same ? {} : { section: node });
    }
    if (d.map !== undefined && !d.act) { state.view = { kind: 'map', family: d.map === '' ? null : Number(d.map) }; state.peek = null; state.focus = null; return render({ top: true }); }
    if (t.classList.contains('live')) return liveLookup(t);
    if (t.classList.contains('ref') && d.o !== undefined) {
      const path = d.path, o = Number(d.o), col = Number(d.col);
      const same = state.peek && state.peek.old && state.peek.path === path && state.peek.o === o && state.peek.col === col;
      state.peek = same ? null : { old: true, path, o, col, ti: Number(d.ti) };
      return render();
    }
    if (t.classList.contains('ref')) {
      const path = d.path, n = Number(d.n), col = Number(d.col);
      const key = `${path}:${n}:${col}`;
      const same = state.peek && state.peek.path === path && state.peek.n === n && state.peek.col === col;
      state.peek = same ? null : { path, n, col, ti: Number(d.ti), usageKey: REFS[state.compare][key] ? key : null };
      return render();
    }
    if (d.usage && !d.act) {
      const i1 = d.usage.lastIndexOf(':'), i0 = d.usage.lastIndexOf(':', i1 - 1);
      const path = d.usage.slice(0, i0), n = Number(d.usage.slice(i0 + 1, i1)), col = Number(d.usage.slice(i1 + 1));
      const defs = lineDefs(path, n);
      const same = state.peek && state.peek.usageKey === d.usage;
      state.peek = same ? null : { path, n, col, ti: defs ? defs.get(col) : undefined, usageKey: d.usage };
      return render();
    }
    if (d.chain !== undefined && !d.act) { state.view = { kind: 'chain', id: Number(d.chain) }; state.peek = null; state.focus = null; state.tab = 'chains'; return render({ top: true }); }
    if (d.standalone) { state.view = { kind: 'standalone' }; state.peek = null; return render({ top: true }); }
    if (d.open !== undefined && !d.act) return openFile(d.open, d.line);
    if (d.group !== undefined && !d.act) { state.view = { kind: 'group', id: Number(d.group) }; state.peek = null; return render({ top: true }); }
    const act = d.act;
    if (act === 'reset') { state.rev[state.compare] = new Set(); state.blockDiff.clear(); save(); return render(); }
    if (act === 'close-peek') { state.peek = null; return render(); }
    if (act === 'peek-back') { const prev = state.peek.back.slice(-1)[0]; state.peek = prev; return render(); }
    if (act === 'open-source') return openSource(d);
    if (act === 'open-def') {
      // Ask the server where the peeked name is defined, then open that file whole.
      const p0 = state.peek;
      const params = new URLSearchParams({ side: p0.old ? 'base' : 'head', p: p0.path, l: String(p0.old ? p0.o : p0.n), c: String(p0.col) });
      t.textContent = 'Opening…';
      fetch('api/definition?' + params).then((r) => r.json()).then((j) => {
        const x = j.target;
        if (!x) { t.textContent = 'Not found'; return; }
        openSource({ side: x.side || '', p: x.side ? x.p : '', ext: x.ext != null ? x.ext : '', line: x.l, label: x.side ? '' : x.p, where: x.w === 'sdk' ? 'Dart SDK' : x.w === 'package' ? 'package' : '' });
      }).catch(() => { t.textContent = 'Not found'; });
      return;
    }
    if (act === 'open-editor') {
      fetch('api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ side: d.side || undefined, p: d.p || undefined, ext: d.ext !== '' ? Number(d.ext) : undefined, l: Number(d.line) || 1, c: Number(d.col) || 0 }) })
        .then((r) => r.json()).then((j) => { if (j.error) alert(j.error); }).catch(() => {});
      return;
    }
    if (act === 'peek-use' || act === 'peek-go') {
      const list = (state.peek && REFS[state.compare][state.peek.usageKey]) || [];
      const i = act === 'peek-go' ? state.peek.sel : Number(d.i);
      if (!list[i]) return;
      if (act === 'peek-go' || state.peek.sel === i) return openFile(list[i][0], list[i][1]);
      state.peek.sel = i;
      return refreshPeek(t, `[data-act="peek-use"][data-i="${i}"]`);
    }
    if (act === 'peek-def') { state.peek.sel = null; return refreshPeek(t, '[data-act="peek-use"]'); }
    if (act === 'clear-focus') { state.focus = null; return render(); }
    if (act === 'toggle-block') { const b = m.blockById.get(d.block); toggleBlocks([b]); return render(); }
    if (act === 'toggle-move') { state.moveOpen.has(d.block) ? state.moveOpen.delete(d.block) : state.moveOpen.add(d.block); return render(); }
    if (act === 'toggle-diff') { state.blockDiff.has(d.block) ? state.blockDiff.delete(d.block) : state.blockDiff.add(d.block); return render(); }
    if (act === 'toggle-hunk') {
      const btn = t.getAttribute('aria-expanded') === 'true';
      if (btn) { state.collapsed.add(d.key); state.expanded.delete(d.key); } else { state.collapsed.delete(d.key); state.expanded.add(d.key); }
      return render();
    }
    if (act === 'expand-to') { state.collapsed.delete(d.key); state.expanded.add(d.key); return render({ line: Number(d.line) }); }
    if (act === 'mark-file') { toggleBlocks(m.files[Number(d.file)].blocks.filter((b) => b.edits.length)); return render(); }
    if (act === 'mark-blocks') { toggleBlocks(blocksOf(d.blocks.split(' '))); return render(); }
    if (act === 'mark-chain') { toggleBlocks(blocksOf(m.chains[Number(d.chainId)].blocks)); return render(); }
    if (act === 'mark-standalone') { toggleBlocks(m.standalone); return render(); }
    if (act === 'mark-edits') { const ids = d.edits.split(' ').map(Number); setEdits(ids, !ids.every((x) => rev().has(x))); return render(); }
    if (act === 'toggle-member') { state.memberOpen.has(d.key) ? state.memberOpen.delete(d.key) : state.memberOpen.add(d.key); return render(); }
    if (act === 'next-open') { const nx = nextUnreviewed(); if (nx) { state.view = nx; state.peek = null; state.focus = null; state.tab = 'chains'; return render({ top: true }); } return; }
    if (act === 'mark-group') { const g = m.groupById.get(Number(d.groupId)); setEdits(g.edits, !g.edits.every((x) => rev().has(x))); return render(); }
    if (act === 'group-all') { state.groupAll.add(d.key); return render(); }
    if (act === 'mark-usages') {
      const list = REFS[state.compare][d.usage] || [];
      const hits = list.map(([up, ul]) => m.head.get(up + ':' + ul)).filter((hl) => hl && hl.r.block);
      const anyOpen = hits.some((hl) => !done(hl.r.block));
      hits.forEach((hl) => {
        const ranges = hl.f.hunks[hl.hi].rows[hl.ri][2] || [];
        const ids = ranges.length ? [...new Set(ranges.map((x) => x[2]))] : hl.r.block.edits;
        setEdits(ids, anyOpen);
      });
      return render();
    }
  });
  // "n" walks to the next chain with changes to review, while the viewer is on screen.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.peek && !e.defaultPrevented) { state.peek = null; render(); return; }
    if (e.key !== 'n' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const r = viewer.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const nx = nextUnreviewed();
    if (!nx) return;
    e.preventDefault();
    state.view = nx; state.peek = null; state.focus = null; state.tab = 'chains';
    render({ top: true });
  });
  viewer.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('g[data-node],g[data-graph-open],g[data-chain]')) { e.preventDefault(); e.target.closest('g[data-node],g[data-graph-open],g[data-chain]').dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  });
  viewer.addEventListener('change', (e) => {
    if (e.target.id === 'vw-revdiff') { state.showReviewedDiff = e.target.checked; save(); render(); }
  });
  let qTimer = null;
  qInput.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.search.q = qInput.value;
      if (qInput.value.trim()) { if (state.view.kind !== 'search') state.prevView = state.view; state.view = { kind: 'search' }; }
      else if (state.view.kind === 'search') state.view = state.prevView || { kind: 'map', family: null };
      render({ top: true });
    }, 150);
  });

  render({ top: true });
  if (SHIKI) SHIKI.load().then(() => { shikiOn = true; render(); }).catch(() => {});
})();
