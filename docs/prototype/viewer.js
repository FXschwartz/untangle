// Prototype viewer. Every count, group and hidden line comes from ReviewCore run on the
// raw diff, plus the definition and reference results of the Dart language server.
(function () {
  'use strict';
  const C = window.ReviewCore;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const RAW = JSON.parse($('#d-diff').textContent);
  const DEFS = JSON.parse($('#d-defs').textContent);
  const REFS = JSON.parse($('#d-refs').textContent);
  const CONFIG = {
    generated: ['**/migrations/**'],
    reviewedWith: [['**/migrations/**', '**/*.spy.yaml']],
  };
  const GEN_RES = CONFIG.generated.map(C.globToRegExp);
  const RW = CONFIG.reviewedWith.map(([g, s]) => ({ g: C.globToRegExp(g), s: C.globToRegExp(s), gs: g, ss: s }));
  const START_FILE = 'packages/serverpod_offline_sync/lib/src/database/database.dart';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => n.toLocaleString('en-US');

  const viewer = $('#viewer');
  const side = $('#vw-side');
  const main = $('#vw-main');
  const qInput = $('#vw-q');

  // ---------- state (reviewed atoms are remembered in this browser only)
  const state = {
    compare: 'base', keyMode: 'tokens', hideComments: false,
    view: { kind: 'file', path: START_FILE }, prevView: null, peek: null,
    showBlocks: new Set(), search: { q: '', scope: 'unreviewed' },
    rev: { base: new Set(), since: new Set() },
  };
  try {
    const saved = JSON.parse(localStorage.getItem('bcr-v2') || 'null');
    if (saved) {
      state.rev.base = new Set(saved.rev.base || []);
      state.rev.since = new Set(saved.rev.since || []);
      state.keyMode = saved.keyMode === 'next' ? 'next' : 'tokens';
      state.hideComments = !!saved.hideComments;
    }
  } catch (e) { /* storage unavailable: start fresh */ }
  function save() {
    try {
      localStorage.setItem('bcr-v2', JSON.stringify({ rev: { base: [...state.rev.base], since: [...state.rev.since] }, keyMode: state.keyMode, hideComments: state.hideComments }));
    } catch (e) { /* ignore */ }
  }

  // ---------- model per comparison
  const models = {};
  function genFolder(p) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === 'generated') return parts.slice(0, i + 1).join('/') + '/';
      if (parts[i] === 'migrations') return parts.slice(0, i + (i + 2 < parts.length ? 2 : 1)).join('/') + '/';
    }
    return parts.slice(0, -1).join('/') + '/';
  }
  function model(name) {
    if (models[name]) return models[name];
    const cmp = RAW.compares[name];
    const files = [], generated = [];
    cmp.files.forEach((f0) => {
      const f = Object.assign({}, f0);
      const byAttr = f.ga === 'true';
      const byConfig = GEN_RES.some((rx) => rx.test(f.p));
      if (byAttr || byConfig) { f.genSource = byAttr ? '.gitattributes' : '.review.yaml'; generated.push(f); return; }
      C.analyzeFile(f);
      files.push(f);
    });
    const head = new Map(), atoms = new Map(), blocks = new Map();
    files.forEach((f) => {
      f.blocks.forEach((b) => { blocks.set(b.id, b); b.rows.forEach((r) => { r.block = b; }); b.atoms.forEach((a) => atoms.set(a.id, a)); });
      f.hunks.forEach((h) => h.rows.forEach((r) => { if (r.type !== '-') head.set(f.p + ':' + r.n, { f, row: r }); }));
    });
    const usageByLine = new Map();
    Object.entries(REFS[name] || {}).forEach(([key, list]) => {
      const [p, line] = key.split(':');
      const k = p + ':' + line;
      if (!usageByLine.has(k)) usageByLine.set(k, []);
      usageByLine.get(k).push([key, list.length]);
    });
    const folders = new Map();
    generated.forEach((f) => { const d = genFolder(f.p); if (!folders.has(d)) folders.set(d, []); folders.get(d).push(f); });
    models[name] = { name, cmp, files, generated, folders, head, atoms, blocks, usageByLine, groups: {} };
    return models[name];
  }
  function groupsOf(m, mode) {
    if (!m.groups[mode]) {
      const list = C.groupAtoms(m.files, mode);
      const byAtom = new Map(), byId = new Map();
      list.forEach((g, i) => {
        g.id = mode + ':' + i;
        g.fileCount = new Set(g.atoms.map((a) => a.block.file.p)).size;
        g.atoms.forEach((a) => byAtom.set(a.id, g));
        byId.set(g.id, g);
      });
      m.groups[mode] = { list, byAtom, byId };
    }
    return m.groups[mode];
  }

  // ---------- review state helpers
  const M = () => model(state.compare);
  const rev = () => state.rev[state.compare];
  const blockDone = (b) => b.atoms.every((a) => rev().has(a.id));
  const blockCommentHidden = (b) => state.hideComments && !blockDone(b) && b.atoms.filter((a) => !rev().has(a.id)).every((a) => a.commentOnly);
  const blockOpen = (b) => !blockDone(b) && !blockCommentHidden(b);
  function setAtoms(list, on) { list.forEach((a) => (on ? rev().add(a.id) : rev().delete(a.id))); save(); }
  function fileStats(f) {
    const s = { open: 0, a: 0, d: 0, total: 0 };
    f.blocks.forEach((b) => {
      if (!b.atoms.length) return;
      s.total++;
      if (blockOpen(b)) { s.open++; s.a += b.adds; s.d += b.dels; }
    });
    return s;
  }
  function totals(m) {
    const t = { open: 0, lines: 0, files: 0, all: 0, allLines: 0, comment: 0, layout: 0 };
    m.files.forEach((f) => {
      const s = fileStats(f);
      t.open += s.open; t.lines += s.a + s.d; if (s.open) t.files++;
      f.blocks.forEach((b) => {
        if (!b.atoms.length) { t.layout++; return; }
        t.all++; t.allLines += b.adds + b.dels;
        if (blockCommentHidden(b)) t.comment++;
      });
    });
    return t;
  }
  function genStatus(m, f) {
    const rule = RW.find((r) => r.g.test(f.p));
    if (!rule) return { kind: 'auto' };
    const srcs = m.files.filter((x) => rule.s.test(x.p));
    const done = srcs.filter((x) => x.blocks.every(blockDone)).length;
    return { kind: 'with', rule, total: srcs.length, done, ok: done === srcs.length };
  }
  function shortDir(dir) {
    const parts = dir.replace(/\/$/, '').split('/');
    return (parts.length > 4 ? parts.slice(0, 2).concat('…', parts.slice(-2)) : parts).join('/') + '/';
  }
  function editSide(tokens) {
    const s = tokens.join(' ').replace(/ ([.,;:)\]]) ?/g, '$1').replace(/([(\[.]) /g, '$1').replace(/ \?\. /g, '?.');
    return s.length > 42 ? s.slice(0, 41) + '…' : s;
  }
  function editLabel(g) {
    const more = g.parts.length > 2 ? ` <span class="e-arr">+ ${g.parts.length - 2} more edits</span>` : '';
    return g.parts.slice(0, 2).map((p) => {
      const a = p.atoms[0];
      const del = editSide(a.text.del), ins = editSide(a.text.ins);
      if (!del) return `<span class="e-ins">+ ${esc(ins)}</span>`;
      if (!ins) return `<span class="e-del">− ${esc(del)}</span>`;
      return `<span class="e-del">${esc(del)}</span> <span class="e-arr">→</span> <span class="e-ins">${esc(ins)}</span>`;
    }).join(' <span class="e-arr">…</span> ') + more;
  }

  // ---------- sidebar
  function renderSide() {
    const m = M();
    const t = totals(m);
    const pct = t.allLines ? Math.round((1 - t.lines / t.allLines) * 100) : 100;
    const cur = state.view;
    let h = `<div class="sb-prog">
      <div class="sb-big"><b>${fmt(t.open)}</b> changes to review</div>
      <div class="sb-sub">${fmt(t.lines)} lines in ${t.files} files</div>
      <div class="track" aria-hidden="true"><div class="fill" style="width:${pct}%"></div></div>
      <div class="sb-sub">${pct}% of changed lines reviewed · <button class="linkish" data-act="reset">Reset</button></div>
    </div>`;

    h += `<div class="sb-h"><span>Files</span><span class="sb-hn">${m.files.length}</span></div>`;
    let lastDir = null;
    m.files.forEach((f) => {
      const dir = f.p.slice(0, f.p.lastIndexOf('/') + 1);
      if (dir !== lastDir) { h += `<div class="sb-dir" title="${esc(dir)}">${esc(shortDir(dir))}</div>`; lastDir = dir; }
      const s = fileStats(f);
      const on = cur.kind === 'file' && cur.path === f.p;
      h += `<button class="sb-row${s.open ? '' : ' done'}" data-open="${esc(f.p)}"${on ? ' aria-current="true"' : ''}>
        <span class="st"></span><span class="nm">${esc(f.p.slice(dir.length))}</span>
        <span class="cnt">${s.open ? `<span class="a">+${s.a}</span> <span class="d">−${s.d}</span>` : 'reviewed'}</span></button>`;
    });

    const G = groupsOf(m, state.keyMode);
    h += `<div class="sb-h"><span>Repeated edits</span><span class="sb-hn">${G.list.length}</span></div>
      <div class="mini-seg" role="group" aria-label="What counts as the same edit">
        <button type="button" data-mode="tokens" aria-pressed="${state.keyMode === 'tokens'}">Same tokens</button>
        <button type="button" data-mode="next" aria-pressed="${state.keyMode === 'next'}">+ next token</button>
      </div>`;
    G.list.forEach((g) => {
      const done = g.atoms.every((a) => rev().has(a.id));
      const on = cur.kind === 'group' && cur.id === g.id;
      h += `<button class="sb-row grp${done ? ' done' : ''}" data-group="${g.id}"${on ? ' aria-current="true"' : ''} title="${esc(g.count + ' places in ' + g.fileCount + ' files')}">
        <span class="st"></span><span class="nm edit">${editLabel(g)}</span><span class="cnt">×${g.count}</span></button>`;
    });

    const genLines = m.generated.reduce((s, f) => s + f.a + f.d, 0);
    h += `<div class="sb-h"><span>Generated · not diffed</span><span class="sb-hn">${m.generated.length} files · ${fmt(genLines)} lines</span></div>`;
    m.folders.forEach((fs, dir) => {
      const st = genStatus(m, fs[0]);
      const src = [...new Set(fs.map((f) => f.genSource))].join(', ');
      const waiting = st.kind === 'with' && !st.ok;
      const on = cur.kind === 'gen' && cur.dir === dir;
      h += `<button class="sb-row gen${waiting ? ' waiting' : ' done'}" data-gen="${esc(dir)}"${on ? ' aria-current="true"' : ''}>
        <span class="st"></span><span class="nm">${esc(shortDir(dir))}<span class="sub">${fs.length} file${fs.length > 1 ? 's' : ''} · ${esc(src)}${st.kind === 'with' ? ` · ${st.ok ? 'reviewed with' : 'waits on'} ${esc(st.rule.ss)} (${st.done}/${st.total})` : ''}</span></span>
        <span class="cnt"><span class="a">+${fmt(fs.reduce((s, f) => s + f.a, 0))}</span></span></button>`;
    });

    h += `<div class="sb-h"><span>Filters</span></div>
      <label class="sb-check"><input type="checkbox" id="vw-comments"${state.hideComments ? ' checked' : ''}> Hide changes that only touch comments${state.hideComments ? ` <span class="sb-hn">${t.comment} hidden</span>` : ''}</label>
      <p class="sb-note">Changes that only move whitespace or line breaks are always hidden. This diff has ${t.layout}.</p>`;
    side.innerHTML = h;
  }

  // ---------- code rendering
  function lineDefs(path, n) {
    const arr = n != null && DEFS.defs[path] && DEFS.defs[path][n];
    return arr ? new Map(arr.map(([c, , ti]) => [c, ti])) : null;
  }
  function tokHtml(tk, defs) {
    if (tk.k === 'ws') return esc(tk.t);
    let cls = 't-' + tk.k;
    let attrs = '';
    // Token emphasis only where a line mixes changed and unchanged tokens; a block that
    // only adds or only removes lines is already marked by its line color.
    if (tk.atom && tk.atom.block.adds && tk.atom.block.dels) cls += rev().has(tk.atom.id) ? ' rv' : ' ch';
    if (defs && (tk.k === 'id' || tk.k === 'ty' || tk.k === 'ann')) {
      const col = tk.k === 'ann' ? tk.c + 1 : tk.c;
      const ti = defs.get(col);
      if (ti !== undefined) { cls += ' ref'; attrs = ` data-ti="${ti}" data-col="${col}" title="Peek definition"`; }
    }
    return `<span class="${cls}"${attrs}>${esc(tk.t)}</span>`;
  }
  function codeHtml(f, row, noRefs) {
    const toks = row.toks || C.tokenize(row.text, f.lang);
    const defs = row.type !== '-' && !noRefs ? lineDefs(f.p, row.n) : null;
    return toks.map((tk) => tokHtml(tk, defs)).join('');
  }
  function badgesHtml(f, row) {
    let h = '';
    if (row.block) {
      const G = groupsOf(M(), state.keyMode);
      const seen = new Set();
      row.block.atoms.forEach((a) => {
        const first = (a.ins[0] || a.del[0]).row;
        const g = G.byAtom.get(a.id);
        if (first !== row || !g || seen.has(g.id)) return;
        seen.add(g.id);
        const ok = g.atoms.every((x) => rev().has(x.id));
        h += `<button class="bdg grp${ok ? ' ok' : ''}" data-group="${g.id}" title="The same edit is in ${g.count} places">same edit ×${g.count}</button>`;
      });
    }
    if (row.type !== '-') {
      (M().usageByLine.get(f.p + ':' + row.n) || []).forEach(([key, n]) => {
        h += `<button class="bdg use" data-usage="${esc(key)}" title="Usages inside other changes, from the language server">${n} changed usage${n > 1 ? 's' : ''}</button>`;
      });
    }
    return h;
  }
  function rowHtml(f, row, extraCls, tick) {
    const sign = row.type === '+' ? '+' : row.type === '-' ? '−' : '';
    const cls = row.type === '+' ? 'add' : row.type === '-' ? 'del' : 'ctx';
    const n = row.type !== '-' ? row.n : '';
    return `<div class="ln ${cls}${extraCls || ''}"${n ? ` data-n="${n}"` : ''}>
      <span class="g">${tick || ''}</span><span class="no">${row.o != null ? row.o : ''}</span><span class="no">${n}</span><span class="sg">${sign}</span><span class="tx">${codeHtml(f, row)}</span><span class="bdgs">${badgesHtml(f, row)}</span></div>`
      + (state.peek && state.peek.path === f.p && row.type !== '-' && state.peek.n === row.n ? peekHtml(state.peek) : '');
  }
  function peekHtml(p) {
    let h = '<div class="peek" role="region" aria-label="Peek">';
    if (p.ti !== undefined) {
      const t = DEFS.targets[p.ti];
      const where = t.w === 'repo' ? 'this repo' : t.w === 'sdk' ? 'Dart SDK' : 'package';
      h += `<div class="pk-h"><b>Definition</b><span class="pk-loc">${esc(t.p)}:${t.l}</span><span class="pk-src">${where}</span><span class="sp"></span><button type="button" class="pk-x" data-act="close-peek">Close</button></div>
        <div class="pk-code">${t.code.map((line, i) => {
          const ln = t.s + i;
          const toks = C.tokenize(line, 'dart');
          return `<div class="pk-ln${ln === t.l ? ' hit' : ''}"><span class="no">${ln}</span><span class="tx">${toks.map((tk) => (tk.k === 'ws' ? esc(tk.t) : `<span class="t-${tk.k}">${esc(tk.t)}</span>`)).join('')}</span></div>`;
        }).join('')}</div>`;
      if (t.w === 'repo' && M().head.has(t.p + ':' + t.l) && !(t.p === p.path && t.l === p.n)) {
        h += `<div class="pk-foot"><button type="button" class="linkish" data-open="${esc(t.p)}" data-line="${t.l}">Go to it in this diff</button></div>`;
      }
    }
    if (p.usageKey) {
      const list = REFS[state.compare][p.usageKey] || [];
      const open = list.filter(([up, ul]) => { const hl = M().head.get(up + ':' + ul); return hl && hl.row.block && blockOpen(hl.row.block); }).length;
      h += `<div class="pk-h pk-h2"><b>${list.length} changed usages</b><span class="pk-src">${open} not reviewed</span><span class="sp"></span>
        <button type="button" class="btn sm" data-act="mark-usages" data-usage="${esc(p.usageKey)}">${open ? 'Mark their changes reviewed' : 'Mark them unreviewed'}</button></div><div class="pk-list">`;
      list.forEach(([up, ul]) => {
        const hl = M().head.get(up + ':' + ul);
        const done = hl && hl.row.block && !blockOpen(hl.row.block);
        h += `<button type="button" class="pk-use${done ? ' done' : ''}" data-open="${esc(up)}" data-line="${ul}"><span class="pk-up">${esc(up.split('/').pop())}:${ul}</span><code>${esc(hl ? hl.row.text.trim().slice(0, 110) : '')}</code></button>`;
      });
      h += '</div>';
    }
    return h + '</div>';
  }

  // ---------- main views
  function renderFile(path) {
    const m = M();
    const f = m.files.find((x) => x.p === path);
    if (!f) {
      const g = m.generated.find((x) => x.p === path);
      return `<div class="empty">${g ? `${esc(path)} is generated, so it isn't diffed.` : `${esc(path)} has no changes in this comparison.`} Pick a file on the left.</div>`;
    }
    const s = fileStats(f);
    const dir = f.p.slice(0, f.p.lastIndexOf('/') + 1);
    const status = { A: 'added', M: 'modified', D: 'deleted' }[f.s] || f.s;
    let h = `<div class="fv-head"><div class="fv-path"><span>${esc(dir)}</span><b>${esc(f.p.slice(dir.length))}</b></div>
      <div class="fv-meta"><span>${status}</span><span>${s.open} of ${s.total} changes to review</span>${s.open ? `<span class="a">+${s.a}</span><span class="d">−${s.d}</span>` : ''}
      <span class="sp"></span><button type="button" class="btn sm${s.open ? ' primary' : ''}" data-act="mark-file">${s.open ? 'Mark file reviewed' : 'Mark file unreviewed'}</button></div></div>`;
    if (state.compare === 'since') {
      h += `<div class="since-note">Left side: your reviewed snapshot, as if you had reviewed everything up to <code>0540639</code>. Right side: the PR head <code>a45f9ae</code>. Only what changed after you reviewed shows up.</div>`;
    }
    h += '<div class="code">';
    f.hunks.forEach((hk, hi) => {
      const hb = f.blocks.filter((b) => b.hunk === hi && b.atoms.length);
      const shown = hb.filter((b) => blockOpen(b) || state.showBlocks.has(b.id));
      if (hb.length && !shown.length) {
        const done = hb.every(blockDone);
        h += `<div class="ln fold"><span class="g"></span><span class="fold-tx">${done ? '✓ Reviewed' : 'Only comments changed'} · @@ −${hk.o} +${hk.n} @@ ${esc(hk.h)}</span>
          <button type="button" class="linkish" data-act="show-hunk" data-hunk="${hi}">Show</button></div>`;
        return;
      }
      if (!hb.length) return; // layout-only hunk
      h += `<div class="hh"><span class="hh-tx">@@ −${hk.o} +${hk.n} @@ <span class="hh-ctx">${esc(hk.h)}</span></span>
        <button type="button" class="btn xs" data-act="mark-hunk" data-hunk="${hi}">✓ Mark hunk reviewed</button></div>`;
      const rendered = new Set();
      hk.rows.forEach((row) => {
        const b = row.block;
        if (!b) { h += rowHtml(f, row); return; }
        if (!blockOpen(b) && !state.showBlocks.has(b.id)) {
          if (!rendered.has(b.id)) {
            rendered.add(b.id);
            const label = !b.atoms.length ? 'Whitespace-only change' : blockDone(b) ? '✓ Reviewed' : 'Comment-only change';
            h += `<div class="ln fold"><span class="g"></span><span class="fold-tx">${label} · ${b.rows.length} line${b.rows.length > 1 ? 's' : ''}</span>
              <button type="button" class="linkish" data-act="show-block" data-block="${esc(b.id)}">Show</button></div>`;
          }
          return;
        }
        let tick = '';
        if (!rendered.has(b.id)) {
          rendered.add(b.id);
          const done = blockDone(b);
          tick = `<button type="button" class="tick${done ? ' on' : ''}" data-act="toggle-block" data-block="${esc(b.id)}" title="${done ? 'Mark unreviewed' : 'Mark this change reviewed'}" aria-label="${done ? 'Mark unreviewed' : 'Mark this change reviewed'}">✓</button>`;
        }
        h += rowHtml(f, row, blockDone(b) ? ' rvd' : '', tick);
      });
    });
    return h + '</div>';
  }

  function renderGroup(id) {
    const m = M();
    const g = groupsOf(m, state.keyMode).byId.get(id);
    if (!g) return '<div class="empty">This group doesn’t exist with the current matching rule.</div>';
    const done = g.atoms.every((a) => rev().has(a.id));
    const byBlock = new Map();
    g.atoms.forEach((a) => { if (!byBlock.has(a.block)) byBlock.set(a.block, []); byBlock.get(a.block).push(a); });
    let h = `<div class="fv-head"><div class="gv-edit">${editLabel(g)}</div>
      <div class="fv-meta"><span>Same edit in ${g.count} places · ${g.fileCount} files</span>${g.parts.length > 1 ? `<span>${g.parts.length} edits that always appear together</span>` : ''}
      <span class="sp"></span><button type="button" class="btn sm${done ? '' : ' primary'}" data-act="mark-group" data-group-id="${g.id}">${done ? 'Mark all unreviewed' : `Mark all ${g.count} reviewed`}</button></div></div><div class="code gv">`;
    let lastFile = null;
    byBlock.forEach((list, b) => {
      const f = b.file;
      if (f !== lastFile) { h += `<div class="gv-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${esc(f.p)}</button></div>`; lastFile = f; }
      const first = list[0];
      const row = (first.ins[0] || first.del[0]).row;
      const isDone = list.every((a) => rev().has(a.id));
      const line = row.type !== '-' ? row.n : row.o;
      h += `<div class="ln ${row.type === '+' ? 'add' : 'del'}${isDone ? ' rvd' : ''}">
        <span class="g"><button type="button" class="tick${isDone ? ' on' : ''}" data-act="toggle-atoms" data-atoms="${esc(list.map((a) => a.id).join(' '))}" aria-label="Mark this place reviewed">✓</button></span>
        <span class="no wide"><button type="button" class="linkish" data-open="${esc(f.p)}" data-line="${row.type !== '-' ? row.n : ''}" title="Open in the file">${line}</button></span>
        <span class="sg">${row.type === '+' ? '+' : '−'}</span><span class="tx">${codeHtml(f, row, true)}</span></div>`;
    });
    return h + '</div>';
  }

  function renderGen(dir) {
    const m = M();
    const fs = m.folders.get(dir) || [];
    const st = fs.length ? genStatus(m, fs[0]) : { kind: 'auto' };
    let h = `<div class="fv-head"><div class="fv-path"><b>${esc(dir)}</b></div>
      <div class="fv-meta"><span>${fs.length} generated files</span><span>${esc([...new Set(fs.map((f) => f.genSource))].join(', '))}</span></div></div><div class="gen-body">`;
    h += st.kind === 'with'
      ? `<p>Rule <code>reviewedWith: ${esc(st.rule.gs)} → ${esc(st.rule.ss)}</code>: these files count as reviewed once every changed <code>${esc(st.rule.ss)}</code> file is reviewed. Right now ${st.done} of ${st.total} are.</p>`
      : '<p>Generated files are listed with their size and never enter the review queue or the line counts.</p>';
    h += '<table class="gen-t"><thead><tr><th>File</th><th>Status</th><th class="r">+</th><th class="r">−</th></tr></thead><tbody>';
    fs.forEach((f) => { h += `<tr><td>${esc(f.p.slice(dir.length) || f.p)}</td><td>${{ A: 'added', M: 'modified', D: 'deleted' }[f.s] || f.s}</td><td class="r a">${fmt(f.a)}</td><td class="r d">${fmt(f.d)}</td></tr>`; });
    h += '</tbody></table><p class="muted">In the tool, opening one of these files shows its diff on demand. The prototype doesn’t embed their content.</p></div>';
    return h;
  }

  function renderSearch() {
    const q = state.search.q.trim().toLowerCase();
    const m = M();
    const res = [];
    m.files.forEach((f) => f.blocks.forEach((b) => {
      if (!b.atoms.length) return;
      if (state.search.scope === 'unreviewed' && !blockOpen(b)) return;
      b.rows.forEach((r) => { if (r.text.toLowerCase().includes(q)) res.push({ f, r }); });
    }));
    let h = `<div class="fv-head"><div class="fv-path"><b>Search changed lines for “${esc(state.search.q)}”</b></div>
      <div class="fv-meta"><span>${res.length} result${res.length === 1 ? '' : 's'}</span>
      <div class="mini-seg inline" role="group" aria-label="Search scope">
        <button type="button" data-scope="unreviewed" aria-pressed="${state.search.scope === 'unreviewed'}">Not reviewed</button>
        <button type="button" data-scope="all" aria-pressed="${state.search.scope === 'all'}">All changes</button>
      </div></div></div><div class="code gv">`;
    let lastFile = null;
    res.slice(0, 400).forEach(({ f, r }) => {
      if (f !== lastFile) { h += `<div class="gv-file"><button type="button" class="linkish" data-open="${esc(f.p)}">${esc(f.p)}</button></div>`; lastFile = f; }
      const text = r.text;
      const i = text.toLowerCase().indexOf(q);
      const line = r.type !== '-' ? r.n : r.o;
      h += `<div class="ln ${r.type === '+' ? 'add' : 'del'}"><span class="g"></span>
        <span class="no wide"><button type="button" class="linkish" data-open="${esc(f.p)}" data-line="${r.type !== '-' ? r.n : ''}">${line}</button></span><span class="sg">${r.type === '+' ? '+' : '−'}</span>
        <span class="tx">${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}</span></div>`;
    });
    if (res.length > 400) h += `<div class="empty">Showing the first 400 of ${res.length}.</div>`;
    if (!res.length) h += '<div class="empty">No changed line matches. In the tool, the editor’s own search still covers the whole repository.</div>';
    return h + '</div>';
  }

  function render(scrollLine) {
    const keep = main.scrollTop;
    renderSide();
    const v = state.view;
    main.innerHTML = v.kind === 'group' ? renderGroup(v.id) : v.kind === 'gen' ? renderGen(v.dir) : v.kind === 'search' ? renderSearch() : renderFile(v.path);
    viewer.querySelectorAll('[data-compare]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.compare === state.compare)));
    if (scrollLine) {
      const el = main.querySelector(`.ln[data-n="${scrollLine}"]`);
      if (el) {
        main.scrollTop = el.offsetTop - main.clientHeight / 3;
        el.classList.add('flash');
      }
    } else if (scrollLine === false) {
      main.scrollTop = 0;
    } else {
      main.scrollTop = keep;
    }
    const cur = side.querySelector('[aria-current="true"]');
    if (cur && scrollLine !== undefined) {
      const top = cur.offsetTop - side.clientHeight / 3;
      if (cur.offsetTop < side.scrollTop || cur.offsetTop > side.scrollTop + side.clientHeight - 30) side.scrollTop = top;
    }
  }

  function openFile(path, line) {
    state.view = { kind: 'file', path };
    state.peek = null;
    if (line) {
      const hl = M().head.get(path + ':' + line);
      if (hl && hl.row.block && !blockOpen(hl.row.block)) state.showBlocks.add(hl.row.block.id);
    }
    render(line ? Number(line) : false);
  }

  // ---------- events
  viewer.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-open],[data-group],[data-gen],[data-mode],[data-compare],[data-usage],[data-scope],.ref');
    if (!t || !viewer.contains(t)) return;
    const m = M();
    if (t.dataset.compare) {
      if (state.compare === t.dataset.compare) return;
      state.compare = t.dataset.compare;
      state.peek = null;
      if (state.view.kind !== 'file' || !model(state.compare).files.some((f) => f.p === state.view.path)) state.view = { kind: 'file', path: START_FILE };
      return render(false);
    }
    if (t.dataset.mode) { state.keyMode = t.dataset.mode; save(); if (state.view.kind === 'group') state.view = { kind: 'file', path: START_FILE }; return render(); }
    if (t.dataset.scope) { state.search.scope = t.dataset.scope; return render(false); }
    if (t.classList.contains('ref')) {
      if (state.view.kind !== 'file') return;
      const ln = t.closest('.ln');
      const n = Number(ln.dataset.n);
      const col = Number(t.dataset.col);
      const path = state.view.path;
      const key = `${path}:${n}:${col}`;
      const same = state.peek && state.peek.path === path && state.peek.n === n && state.peek.col === col;
      state.peek = same ? null : { path, n, col, ti: Number(t.dataset.ti), usageKey: REFS[state.compare][key] ? key : null };
      return render();
    }
    if (t.dataset.usage && !t.dataset.act) {
      const [path, n, col] = t.dataset.usage.split(':');
      const defs = lineDefs(path, Number(n));
      const ti = defs ? defs.get(Number(col)) : undefined;
      const same = state.peek && state.peek.usageKey === t.dataset.usage;
      state.peek = same ? null : { path, n: Number(n), col: Number(col), ti, usageKey: t.dataset.usage };
      return render();
    }
    if (t.dataset.open !== undefined && !t.dataset.act) return openFile(t.dataset.open, t.dataset.line);
    if (t.dataset.group && !t.dataset.act) { state.view = { kind: 'group', id: t.dataset.group }; state.peek = null; return render(false); }
    if (t.dataset.gen) { state.view = { kind: 'gen', dir: t.dataset.gen }; return render(false); }
    const act = t.dataset.act;
    const f = state.view.kind === 'file' ? m.files.find((x) => x.p === state.view.path) : null;
    if (act === 'reset') { state.rev[state.compare] = new Set(); state.showBlocks.clear(); save(); return render(); }
    if (act === 'close-peek') { state.peek = null; return render(); }
    if (act === 'toggle-block') { const b = m.blocks.get(t.dataset.block); setAtoms(b.atoms, !blockDone(b)); state.showBlocks.delete(b.id); return render(); }
    if (act === 'show-block') { state.showBlocks.add(t.dataset.block); return render(); }
    if (act === 'show-hunk' && f) { f.blocks.filter((b) => b.hunk === Number(t.dataset.hunk)).forEach((b) => state.showBlocks.add(b.id)); return render(); }
    if (act === 'mark-hunk' && f) {
      const bs = f.blocks.filter((b) => b.hunk === Number(t.dataset.hunk));
      setAtoms(bs.flatMap((b) => b.atoms), true);
      bs.forEach((b) => state.showBlocks.delete(b.id));
      return render();
    }
    if (act === 'mark-file' && f) {
      const on = fileStats(f).open > 0;
      setAtoms(f.blocks.flatMap((b) => b.atoms), on);
      f.blocks.forEach((b) => state.showBlocks.delete(b.id));
      return render();
    }
    if (act === 'mark-group') { const g = groupsOf(m, state.keyMode).byId.get(t.dataset.groupId); setAtoms(g.atoms, !g.atoms.every((a) => rev().has(a.id))); return render(); }
    if (act === 'toggle-atoms') { const list = t.dataset.atoms.split(' ').map((id) => m.atoms.get(id)); setAtoms(list, !list.every((a) => rev().has(a.id))); return render(); }
    if (act === 'mark-usages') {
      const list = REFS[state.compare][t.dataset.usage] || [];
      const blocks = list.map(([up, ul]) => m.head.get(up + ':' + ul)).filter((hl) => hl && hl.row.block).map((hl) => ({ hl, b: hl.row.block }));
      const anyOpen = blocks.some(({ b }) => blockOpen(b));
      blocks.forEach(({ hl, b }) => setAtoms(b.atoms.filter((a) => a.ins.some((d) => d.row === hl.row)), anyOpen));
      return render();
    }
  });
  viewer.addEventListener('change', (e) => {
    if (e.target.id === 'vw-comments') { state.hideComments = e.target.checked; save(); render(); }
  });
  let qTimer = null;
  qInput.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.search.q = qInput.value;
      if (qInput.value.trim()) { if (state.view.kind !== 'search') state.prevView = state.view; state.view = { kind: 'search' }; }
      else if (state.view.kind === 'search') state.view = state.prevView || { kind: 'file', path: START_FILE };
      render(false);
    }, 150);
  });

  render(false);
  const src = $('#core-src');
  if (src) src.textContent = $('#core-script').textContent.trim();
})();
