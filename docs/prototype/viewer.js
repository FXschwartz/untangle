// Prototype viewer v5: the chain map first, then chains, then code. It only renders the model built by
// analyze.js (git + tree-sitter + Dart language server) and keeps your review marks.
(function () {
  'use strict';
  const C = window.ReviewCore;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const MODEL = JSON.parse($('#d-model').textContent);
  const DEFS = JSON.parse($('#d-defs').textContent);
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
    rev: { base: new Set(), since: new Set() },
    blockDiff: new Set(), collapsed: new Set(), expanded: new Set(), graphOpen: new Set(), groupAll: new Set(),
    search: { q: '', scope: 'unreviewed' },
  };
  try {
    const saved = JSON.parse(localStorage.getItem('bcr-v7') || 'null');
    if (saved) {
      state.rev.base = new Set(saved.rev.base || []);
      state.rev.since = new Set(saved.rev.since || []);
      state.layout = saved.layout === 'split' ? 'split' : 'unified';
      state.showReviewedDiff = !!saved.showReviewedDiff;
    }
  } catch (e) { /* storage unavailable */ }
  function save() {
    try {
      localStorage.setItem('bcr-v7', JSON.stringify({ rev: { base: [...state.rev.base], since: [...state.rev.since] }, layout: state.layout, showReviewedDiff: state.showReviewedDiff }));
    } catch (e) { /* ignore */ }
  }

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
  const rev = () => state.rev[state.compare];
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
    if (n.group !== null && n.group !== undefined) {
      const g = M().groupById.get(n.group);
      return { l1: `same change · ${n.files} file${n.files > 1 ? 's' : ''}`, l2: g ? groupLabel(g) : '' };
    }
    const { owner, name } = memberParts(n.member);
    if (!n.member || n.member === 'main') return { l1: /(^|\/)test\//.test(n.file) ? 'test file' : 'top level', l2: fileName(n.file), owner: '' };
    return { l1: fileName(n.file), l2: name, owner };
  }
  const kindWord = { member: 'changed member', type: 'changed type', param: 'parameter ripple', local: 'variable ripple' };

  // ---------- code rendering
  function lineDefs(path, n) {
    const arr = n != null && DEFS.defs[path] && DEFS.defs[path][n];
    return arr ? new Map(arr.map(([c, , ti]) => [c, ti])) : null;
  }
  function oldLineDefs(path, o) {
    const d = DEFS_OLD[state.compare];
    const arr = o != null && d && d.defs[path] && d.defs[path][o];
    return arr ? new Map(arr.map(([c, , ti]) => [c, ti])) : null;
  }
  function codeHtml(f, text, ranges, opts) {
    const toks = C.tokenize(text, f.lang);
    const marks = ranges && opts.emphasis ? new Map(ranges.map(([s, , id]) => [s, id])) : null;
    const defs = !opts.refs ? null : opts.n != null ? lineDefs(f.p, opts.n) : opts.o != null ? oldLineDefs(f.p, opts.o) : null;
    const nextCode = (i) => { for (let j = i + 1; j < toks.length; j++) if (toks[j].k !== 'ws') return toks[j]; return null; };
    return toks.map((tk, i) => {
      if (tk.k === 'ws') return esc(tk.t);
      let cls = 't-' + tk.k, attrs = '';
      if (tk.k === 'id') { const nx = nextCode(i); if (nx && (nx.t === '(' || nx.t === '<')) cls = 't-fn'; }
      if (marks && marks.has(tk.c)) cls += rev().has(marks.get(tk.c)) ? ' rv' : ' ch';
      if (defs && (tk.k === 'id' || tk.k === 'ty' || tk.k === 'ann')) {
        const col = tk.k === 'ann' ? tk.c + 1 : tk.c;
        const ti = defs.get(col);
        if (ti !== undefined) { cls += ' ref'; attrs = opts.n != null ? ` data-ti="${ti}" data-col="${col}" data-path="${esc(f.p)}" data-n="${opts.n}" title="Peek definition"` : ` data-ti="${ti}" data-col="${col}" data-path="${esc(f.p)}" data-o="${opts.o}" title="Peek definition (old side)"`; }
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
    return `<div class="ln ${o.cls}"${n != null ? ` data-n="${n}"` : ''}><span class="g">${o.tick || ''}</span><span class="no">${o.hideOld ? '' : meta.o != null ? meta.o : ''}</span><span class="no">${n != null ? n : ''}</span><span class="sg">${sign}</span><span class="tx">${codeHtml(f, text, ranges, { emphasis: o.emphasis, n, o: oldNo, refs: o.refs })}</span><span class="bdgs">${o.badges || ''}${o.toggle || ''}</span></div>` + (n != null ? peekAfter(f, n) : oldNo != null ? peekAfterOld(f, oldNo) : '');
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
      const b = meta.block;
      if (!b || !b.edits.length) { out += uRow(f, meta, text, null, { cls: 'ctx', refs: !ctx.noRefs }); continue; }
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
        out += uRow(f, meta, text, null, { cls: 'ctx rvd-quiet' + other, sign: '', hideOld: true, tick: first ? tickHtml(b) : '', toggle: first ? diffToggle(b) : '', refs: !ctx.noRefs });
        continue;
      }
      const first = !placed.has(b.id);
      placed.add(b.id);
      out += uRow(f, meta, text, ranges, {
        cls: (t === '+' ? 'add' : 'del') + (d ? ' rvd' : '') + other, emphasis, refs: !ctx.noRefs,
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
    return `<span class="half ${side} ${o.cls || ''}"><span class="no">${num != null ? num : ''}</span><span class="sg">${sign}</span><span class="tx">${codeHtml(f, text, ranges, { emphasis: o.emphasis, n, o: oldNo, refs: (side === 'r' && o.refs) || (oldNo != null && o.refs !== false) })}</span>${side === 'r' ? `<span class="bdgs">${o.badges || ''}${o.toggle || ''}</span>` : ''}</span>`;
  }
  function splitRowsHtml(f, hi, start, end, ctx) {
    ctx = ctx || {};
    const h = f.hunks[hi];
    let out = '';
    let ri = start;
    while (ri < end) {
      const meta = h.meta[ri];
      const b = meta.block;
      if (!b || !b.edits.length) {
        const [, text] = h.rows[ri];
        out += `<div class="sl" data-n="${meta.n != null ? meta.n : ''}"><span class="g"></span>${sCell(f, meta, text, null, 'l', { cls: 'ctx' })}${sCell(f, meta, text, null, 'r', { cls: 'ctx', refs: !ctx.noRefs })}</div>` + (meta.n != null ? peekAfter(f, meta.n) : '');
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
          out += `<div class="sl rvd-quiet${other}" data-n="${m2.n}"><span class="g">${k === 0 ? tickHtml(b) : ''}</span>${sCell(f, m2, h.rows[i][1], null, 'l', { cls: 'ctx', sign: '' }).replace(/<span class="no">\d*<\/span>/, '<span class="no"></span>')}${sCell(f, m2, h.rows[i][1], null, 'r', { cls: 'ctx', sign: '', refs: !ctx.noRefs, toggle: k === 0 ? diffToggle(b) : '' })}</div>` + peekAfter(f, m2.n);
        });
      } else {
        const rows = Math.max(dels.length, adds.length);
        for (let k = 0; k < rows; k++) {
          const li = dels[k], ai = adds[k];
          const lm = li != null ? h.meta[li] : null, am = ai != null ? h.meta[ai] : null;
          out += `<div class="sl${d ? ' rvd' : ''}${other}" data-n="${am ? am.n : ''}"><span class="g">${k === 0 ? tickHtml(b) : ''}</span>`
            + sCell(f, lm, lm ? h.rows[li][1] : '', lm ? h.rows[li][2] : null, 'l', { cls: 'del', emphasis })
            + sCell(f, am, am ? h.rows[ai][1] : '', am ? h.rows[ai][2] : null, 'r', { cls: 'add', emphasis, refs: !ctx.noRefs, badges: am && !ctx.noBadges ? badgesHtml(f, b, ai, am.n) : '', toggle: k === 0 && d ? diffToggle(b) : '' })
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
  const plainHtml = (path, text) => codeHtml({ p: path, lang: C.langOf(path) }, text, null, {});
  function usageContextHtml(hl) {
    const h = hl.f.hunks[hl.hi];
    const rows = [];
    for (let i = 0; i < h.rows.length; i++) if (h.meta[i].n != null) rows.push(i);
    const at = rows.indexOf(hl.ri);
    return rows.slice(Math.max(0, at - 4), at + 5).map((i) => {
      const r = h.meta[i];
      return `<div class="pk-ln${i === hl.ri ? ' hit' : ''}${r.t === '+' ? ' add' : ''}"><span class="no">${r.n}</span><span class="sg">${r.t === '+' ? '+' : ''}</span><span class="tx">${codeHtml(hl.f, h.rows[i][1], null, {})}</span></div>`;
    }).join('');
  }
  function peekHtml(p) {
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
      const t = p.old ? DEFS_OLD[state.compare].targets[p.ti] : DEFS.targets[p.ti];
      const where = (p.old ? `old side · ${M().raw.left} · ` : '') + (t.w === 'repo' ? 'this repo' : t.w === 'sdk' ? 'Dart SDK' : 'package');
      h += `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(t.p)}:${t.l}</span><span class="pk-src">${where}</span><span class="sp"></span><button type="button" class="pk-x" data-act="close-peek">Close</button></div>
        <div class="pk-code">${t.code.map((line, i) => {
          const ln = t.s + i;
          return `<div class="pk-ln${ln === t.l ? ' hit' : ''}"><span class="no">${ln}</span><span class="tx">${plainHtml(t.p, line)}</span></div>`;
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
      svg += `<path class="g-edge${dim ? ' dim' : ''}${long ? ' long' : ''}" d="${d}" marker-end="url(#gar-${spec.id})"/>`;
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
    return layeredSvg({
      id: 'map' + fam.id, w: 236, cap: 9, faintLong: true, label: `Map of ${fam.chains.length} linked chains; arrows point from a chain to the chains its root member uses.`,
      edges,
      nodes: fam.chains.map((c) => {
        const s = stats(blocksOf(c.blocks));
        const cls = /^(_?[A-Z][\w$]*)\.(.+)$/.exec(c.name);
        return { key: 'k' + c.id, layer: c.depth, l1: cls ? cls[1] : c.kind === 'group' && !c.rootKind ? 'same change' : '', l2: cls ? cls[2] : c.name, cnt: s.open ? s.open + '/' + s.total : '✓ ' + s.total, ok: !s.open, root: c === fam.top,
          attr: `data-chain="${c.id}"`, tip: c.name };
      }),
    });
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
      `<button type="button" class="btn sm${s.open ? ' primary' : ''}" data-act="mark-chain" data-chain-id="${c.id}">${s.open ? 'Mark chain reviewed' : 'Mark chain unreviewed'}</button>`, sub);
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
      } else h += subHunksHtml(blocks, { chain: c, key: 'c' + c.id + 'n' + n.idx });
      h += '</section>';
    });
    return h;
  }
  function renderMap(famId) {
    const m = M();
    const fam = m.families.find((f) => f.id === famId) || m.families[0];
    const linked = m.families.filter((f) => f.chains.length > 1);
    let h = headerHtml('<b>Chain map</b>', `<span>${fam.chains.length} linked chains</span><span>${fam.depth + 1} levels</span>`, '',
      `<div class="fv-sub">A chain uses another when its root member uses that chain’s function, method, field or type. Chains that nothing uses sit on the left.</div>${linked.length > 1 ? `<div class="fv-sub"><span class="links-k">Families</span>${linked.map((f) => `<button type="button" class="chip-btn${f === fam ? ' on' : ''}" data-map="${f.id}">${esc(f.top.name)} · ${f.chains.length}</button>`).join('')}</div>` : ''}`);
    h += `<div class="graph-box"><div class="graph-scroll tall">${mapSvg(fam)}</div>
      <div class="graph-legend"><span><i class="lg-open"></i>has changes to review</span><span><i class="lg-ok"></i>reviewed</span><span>Faint arrows skip levels.</span><span>Click a chain to open it.</span></div></div>`;
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
      `<button type="button" class="btn sm${s.open ? ' primary' : ''}" data-act="mark-file" data-file="${f.idx}">${s.open ? 'Mark file reviewed' : 'Mark file unreviewed'}</button>`,
      chains.length ? `<div class="fv-sub">In chains: ${chains.slice(0, 6).map((id) => `<button type="button" class="chip-btn" data-chain="${id}">${esc(m.chains[id].name)}</button>`).join('')}${chains.length > 6 ? ` +${chains.length - 6}` : ''}</div>` : '');
    if (state.compare === 'since') h += '<div class="since-note">Left: your reviewed snapshot (as if you had reviewed everything up to <code>0540639</code>). Right: the PR head <code>a45f9ae</code>.</div>';
    h += '<div class="code">';
    f.hunks.forEach((hk, hi) => { h += hunkHtml(f, hi, { key: 'file' }); });
    return h + '</div>';
  }
  function renderGenerated(path) {
    const f = M().generated.find((x) => x.p === path);
    const dir = f.p.slice(0, f.p.lastIndexOf('/') + 1);
    let h = headerHtml(`<span class="fv-dir">${esc(dir)}</span><b>${esc(fileName(f.p))}</b>`, `<span>generated (${esc(f.gen)})</span><span class="a">+${f.a}</span><span class="d">−${f.d}</span>`, '',
      '<div class="gen-note">Generated: not reviewed and not counted. Shown for reference only.</div>');
    if (!f.hunks) return h + `<div class="empty">This file has ${f.a + f.d} changed lines, too many to embed in the prototype. The tool opens it on demand.</div>`;
    h += '<div class="code">';
    f.hunks.forEach((hk) => {
      h += `<div class="hh"><span class="hh-tx">@@ −${hk.o} +${hk.n} @@ <span class="hh-ctx">${esc(hk.h)}</span></span></div>`;
      let o = hk.o, n = hk.n;
      hk.rows.forEach(([t, text]) => {
        const meta = { t, o: t !== '+' ? o : null, n: t !== '-' ? n : null };
        if (t !== '+') o++;
        if (t !== '-') n++;
        h += uRow({ p: f.p, lang: C.langOf(f.p) }, meta, text, null, { cls: (t === '+' ? 'add' : t === '-' ? 'del' : 'ctx') + ' gen', refs: false });
      });
    });
    return h + '</div>';
  }
  function renderGroup(id) {
    const g = M().groupById.get(Number(id));
    if (!g) return '<div class="empty">No such group in this comparison.</div>';
    const ok = g.edits.every((x) => rev().has(x));
    const e0 = M().edits[g.parts[0]];
    return headerHtml(`<b class="mono">${esc(groupLabel(g))}</b>`,
      `<span>same change in ${g.count} places · ${g.files} files</span><span>${e0.op === 'token' ? 'token replaced, as ' + esc(e0.where) : esc(e0.op) + ' of ' + esc(e0.where)}</span>${g.parts.length > 1 ? `<span>${g.parts.length} edits that always appear together</span>` : ''}`,
      `<button type="button" class="btn sm${ok ? '' : ' primary'}" data-act="mark-group" data-group-id="${g.id}">${ok ? 'Mark all unreviewed' : `Mark all ${g.count} reviewed`}</button>`)
      + instancesHtml(g, null, 'group' + g.id);
  }
  function renderSearch() {
    const q = state.search.q.trim().toLowerCase();
    const m = M();
    const res = [];
    m.files.forEach((f) => f.blocks.forEach((b) => {
      if (!b.edits.length || (state.search.scope === 'unreviewed' && done(b))) return;
      const h = f.hunks[b.hunk];
      for (let i = b.first; i < b.first + b.len; i++) if (h.rows[i][1].toLowerCase().includes(q)) res.push({ f, meta: h.meta[i], text: h.rows[i][1] });
    }));
    let h = headerHtml(`<b>Search changed lines for “${esc(state.search.q)}”</b>`, `<span>${res.length} result${res.length === 1 ? '' : 's'}</span>
      <span class="mini-seg" role="group" aria-label="Search scope"><button type="button" data-scope="unreviewed" aria-pressed="${state.search.scope === 'unreviewed'}">Not reviewed</button><button type="button" data-scope="all" aria-pressed="${state.search.scope === 'all'}">All changes</button></span>`);
    h += '<div class="code">';
    let last = null;
    res.slice(0, 400).forEach(({ f, meta, text }) => {
      if (f !== last) { h += `<div class="inst-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${esc(f.p)}</button></div>`; last = f; }
      const i = text.toLowerCase().indexOf(q);
      const line = meta.t !== '-' ? meta.n : meta.o;
      h += `<div class="ln ${meta.t === '+' ? 'add' : 'del'}"><span class="g"></span><span class="no wide"><button type="button" class="linkish" data-open="${esc(f.p)}" data-line="${meta.t !== '-' ? meta.n : ''}">${line}</button></span><span class="sg">${meta.t === '+' ? '+' : '−'}</span><span class="tx">${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}</span></div>`;
    });
    if (!res.length) h += '<div class="empty">No changed line matches. In the tool, the editor’s own search covers the whole repository.</div>';
    return h + '</div>';
  }

  // ---------- sidebar
  function renderSide() {
    const m = M();
    const all = m.files.flatMap((f) => f.blocks);
    const t = stats(all);
    const pct = t.all ? Math.round((1 - t.lines / t.all) * 100) : 100;
    const v = state.view;
    let h = `<div class="sb-prog"><div class="sb-big"><b>${t.open}</b> of ${t.total} changes to review</div>
      <div class="track" aria-hidden="true"><div class="fill" style="width:${pct}%"></div></div>
      <div class="sb-sub">${pct}% of changed lines reviewed · <button type="button" class="linkish" data-act="reset">Reset</button></div></div>
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
    main.innerHTML = v.kind === 'chain' ? renderChain(v.id) : v.kind === 'map' ? renderMap(v.family) : v.kind === 'standalone' ? renderStandalone() : v.kind === 'group' ? renderGroup(v.id) : v.kind === 'search' ? renderSearch() : renderFile(v.path);
    viewer.querySelectorAll('[data-compare]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.compare === state.compare)));
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
  const src = $('#analyze-src-view');
  if (src) src.textContent = $('#analyze-src').textContent.trim();
})();
