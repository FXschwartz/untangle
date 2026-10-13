// Review core, build-time pass. Deterministic: the same commits, grammar and language
// server always produce the same model.
//
//   node analyze.js <repo> <head-worktree> <diff.json> <defs.json> <out.json>
//
// 1. Edits: tokens of each change block are diffed (core.js); each run of changed tokens
//    is an edit. For Dart, tree-sitter names the edit: one token replaced by another
//    ("spaceId → userId in label"), or whole syntax nodes inserted, removed or replaced.
// 2. Same change: edits with the same tree-sitter description form a group.
// 3. Chains: changes linked by the language server (a changed line uses something declared
//    on another changed line). Parameters and locals carry a chain across changes;
//    functions, methods, fields and types start their own chain.
'use strict';
require('./core.js');
const C = globalThis.ReviewCore;
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [REPO, HEADDIR, DIFF, DEFS, OUT] = process.argv.slice(2);
const HEAD = path.resolve(HEADDIR) + '/';
const DEPS = process.env.BCR_DEPS || path.join(__dirname, 'node_modules');
const { Parser, Language } = require(DEPS + '/web-tree-sitter/tree-sitter.cjs');
const COMPARES = {
  base: { left: 'e0598c1577db2d55c9af7d0d165be6332256910d', right: 'a45f9aee30bcb170b863373840e63a0e42a0092b', label: 'main · e0598c1' },
  since: { left: '0540639', right: 'a45f9aee30bcb170b863373840e63a0e42a0092b', label: 'Reviewed at 0540639' },
};
const CONFIG = { generated: ['**/migrations/**'], peekMaxLines: 2000 };
const GEN_RES = CONFIG.generated.map(C.globToRegExp);

const gitShow = (rev, p) => { try { return execFileSync('git', ['-C', REPO, 'show', `${rev}:${p}`], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return null; } };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const CODE_KINDS = new Set(['id', 'ty', 'kw', 'num', 'ann', 'key']);
const SIGNATURES = new Set(['method_signature', 'function_signature', 'getter_signature', 'setter_signature', 'constructor_signature', 'factory_constructor_signature', 'operator_signature', 'redirecting_factory_constructor_signature', 'constant_constructor_signature']);
const TYPES = new Set(['class_definition', 'mixin_declaration', 'extension_declaration', 'enum_declaration', 'extension_type_declaration']);

(async () => {
  await Parser.init();
  const Dart = await Language.load(DEPS + '/tree-sitter-wasms/out/tree-sitter-dart.wasm');
  const parser = new Parser();
  parser.setLanguage(Dart);
  const parse = (src) => (src == null ? null : parser.parse(src));
  const diff = JSON.parse(fs.readFileSync(DIFF, 'utf8'));
  const defsRaw = JSON.parse(fs.readFileSync(DEFS, 'utf8')).raw;
  const out = { compares: {} };

  // ---------- tree-sitter helpers
  const pos = (line, col) => ({ row: line - 1, column: col });
  function spanNode(tree, a, b) { return tree.rootNode.descendantForPosition(a, b); }
  // The smallest run of complete sibling nodes that covers [a, b].
  const cmpPos = (p, q) => (p.row - q.row) || (p.column - q.column);
  function completeRegion(tree, src, a, b) {
    const lca = spanNode(tree, a, b);
    if (lca.childCount === 0 || (cmpPos(a, lca.startPosition) <= 0 && cmpPos(lca.endPosition, b) <= 0)) {
      return { parentType: lca.parent ? lca.parent.type : 'program', type: lca.type, start: lca.startPosition, end: lca.endPosition, text: src.slice(lca.startIndex, lca.endIndex) };
    }
    // Children of the common ancestor that overlap [a, b]: complete nodes only.
    const kids = [];
    for (let i = 0; i < lca.childCount; i++) {
      const k = lca.child(i);
      if (cmpPos(k.endPosition, a) > 0 && cmpPos(k.startPosition, b) < 0) kids.push(k);
    }
    if (!kids.length) return { parentType: lca.parent ? lca.parent.type : 'program', type: lca.type, start: lca.startPosition, end: lca.endPosition, text: src.slice(lca.startIndex, lca.endIndex) };
    return { parentType: lca.type, type: kids.map((k) => k.type).join('+'), start: kids[0].startPosition, end: kids[kids.length - 1].endPosition, text: src.slice(kids[0].startIndex, kids[kids.length - 1].endIndex) };
  }
  function nameOf(sig) {
    const byField = sig.childForFieldName && sig.childForFieldName('name');
    if (byField) return byField.text;
    for (let i = 0; i < sig.namedChildCount; i++) {
      const c = sig.namedChild(i);
      if (c.type === 'identifier') return c.text;
      if (SIGNATURES.has(c.type)) return nameOf(c);
    }
    const m = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(?:<[^>]*>)?\s*\(/.exec(sig.text);
    return m ? m[1] : sig.text.split('\n')[0].slice(0, 40);
  }
  function memberAt(tree, line, text) {
    if (!tree) return null;
    const col = Math.max(0, text.search(/\S/));
    let n = tree.rootNode.descendantForPosition(pos(line, col));
    let member = null, owner = null, test = null;
    for (let a = n; a; a = a.parent) {
      if (!member && a.type === 'function_body') {
        const s = a.previousNamedSibling;
        if (s && SIGNATURES.has(s.type)) member = nameOf(s);
      }
      if (!member && SIGNATURES.has(a.type)) member = nameOf(a);
      if (!member && (a.type === 'declaration' || a.type === 'static_final_declaration' || a.type === 'initialized_identifier') && a.parent && (a.parent.type === 'class_body' || a.parent.type === 'program' || a.parent.type === 'static_final_declaration_list' || a.parent.type === 'initialized_identifier_list')) {
        const id = a.descendantsOfType ? a.descendantsOfType('identifier')[0] : null;
        if (id) member = id.text;
      }
      if (!test && a.type === 'expression_statement') {
        const m = /^(test|group)\s*\(\s*(['"])((?:\\.|(?!\2).)*)\2/.exec(a.text);
        if (m) test = m[3];
      }
      if (!owner && TYPES.has(a.type)) { const nm = a.childForFieldName('name'); owner = nm ? nm.text : null; }
    }
    return { member: member ? (owner && !member.includes('.') ? owner + '.' + member : member) : owner || null, test };
  }
  // Role of a replaced token: a declaration name (the language server resolves it to
  // itself), a named-argument label, a type, or a reference.
  function roleOf(f, d) {
    const t = defsRaw[`${f.p}:${d.row.n}:${d.tk.c}`];
    if (t && t[0] === HEAD + f.p && t[1] === d.row.n - 1 && t[2] === d.tk.c) return 'declaration';
    const node = spanNode(f.newTree, pos(d.row.n, d.tk.c), pos(d.row.n, d.tk.c + d.tk.t.length));
    if (node.parent && node.parent.type === 'label') return 'named argument';
    if (d.tk.k === 'ty') return 'type';
    if (d.tk.k === 'kw') return 'keyword';
    return 'reference';
  }
  function declKind(tree, line, col) {
    if (!tree) return 'member';
    let n = tree.rootNode.descendantForPosition(pos(line, col));
    const types = [];
    for (let a = n; a; a = a.parent) types.push(a.type);
    for (const t of types) {
      if (t === 'formal_parameter' || t === 'formal_parameter_list' || t === 'optional_formal_parameters') return 'param';
      if (t === 'local_variable_declaration' || t === 'for_loop_parts' || t === 'pattern_variable_declaration' || t === 'catch_clause') return 'local';
      if (t === 'function_body' || t === 'class_body' || t === 'program') break;
    }
    if (types.some((t) => TYPES.has(t)) && !types.includes('class_body')) return 'type';
    return 'member';
  }

  for (const [name, cmp] of Object.entries(diff.compares)) {
    const meta = COMPARES[name];
    const files = [], generated = [];
    for (const f0 of cmp.files) {
      const f = JSON.parse(JSON.stringify(f0));
      const byAttr = f.ga === 'true';
      if (byAttr || GEN_RES.some((rx) => rx.test(f.p))) {
        f.gen = byAttr ? '.gitattributes' : '.review.yaml';
        if ((f.a + f.d) <= CONFIG.peekMaxLines) {
          const text = execFileSync('git', ['-C', REPO, 'diff', '--no-renames', '-U3', meta.left, meta.right, '--', f.p], { encoding: 'utf8', maxBuffer: 64 << 20 });
          f.hunks = [];
          let cur = null;
          for (const line of text.split('\n')) {
            const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
            if (m) { cur = { o: +m[1], n: +m[2], h: m[3].trim(), l: [] }; f.hunks.push(cur); } else if (cur && /^[ +-]/.test(line)) cur.l.push(line);
          }
        }
        generated.push(f);
        continue;
      }
      C.analyzeFile(f);
      f.oldSrc = f.s !== 'A' ? gitShow(meta.left, f.p) : null;
      f.newSrc = f.s !== 'D' ? gitShow(meta.right, f.p) : null;
      if (f.lang === 'dart') { f.oldTree = parse(f.oldSrc); f.newTree = parse(f.newSrc); }
      files.push(f);
    }

    // ---------- edits and their tree-sitter identity
    const edits = [];
    for (const f of files) {
      for (const b of f.blocks) {
        b.edits = [];
        for (const a of b.atoms) {
          const e = { id: edits.length, block: b, atom: a, commentOnly: a.commentOnly };
          const del = a.del, ins = a.ins;
          const first = (list, side) => pos(side === 'n' ? list[0].row.n : list[0].row.o, list[0].tk.c);
          const last = (list, side) => { const x = list[list.length - 1]; return pos(side === 'n' ? x.row.n : x.row.o, x.tk.c + x.tk.t.length); };
          let oldR = null, newR = null;
          if (f.lang === 'dart') {
            if (ins.length && f.newTree) newR = completeRegion(f.newTree, f.newSrc, first(ins, 'n'), last(ins, 'n'));
            if (del.length && f.oldTree) oldR = completeRegion(f.oldTree, f.oldSrc, first(del, 'o'), last(del, 'o'));
          }
          const oneToken = del.length === 1 && ins.length === 1 && CODE_KINDS.has(del[0].tk.k) && CODE_KINDS.has(ins[0].tk.k);
          if (f.lang === 'dart' && oneToken && newR) {
            e.op = 'token';
            e.where = roleOf(f, ins[0]);
            e.key = `dart|token|${e.where}|${del[0].tk.t}→${ins[0].tk.t}`;
            e.from = del[0].tk.t; e.to = ins[0].tk.t;
          } else if (f.lang === 'dart' && (newR || oldR)) {
            e.op = !del.length ? 'insert' : !ins.length ? 'delete' : 'replace';
            e.where = (newR || oldR).type;
            e.from = oldR ? norm(oldR.text) : ''; e.to = newR ? norm(newR.text) : '';
            e.key = `dart|${e.op}|${e.where}|${e.from}→${e.to}`;
          } else {
            e.op = !del.length ? 'insert' : !ins.length ? 'delete' : 'replace';
            e.where = 'tokens';
            e.from = a.text.del.join(' '); e.to = a.text.ins.join(' ');
            e.key = `${f.lang}|tokens|${a.keyText.del.join(' ')}→${a.keyText.ins.join(' ')}`;
          }
          // Lines the edit covers, extended to the whole syntax nodes when known.
          const lines = (list, side) => list.map((d) => (side === 'n' ? d.row.n : d.row.o));
          const nl = lines(ins, 'n'), ol = lines(del, 'o');
          e.newSpan = newR ? [newR.start.row + 1, newR.end.row + 1] : nl.length ? [Math.min(...nl), Math.max(...nl)] : null;
          e.oldSpan = oldR ? [oldR.start.row + 1, oldR.end.row + 1] : ol.length ? [Math.min(...ol), Math.max(...ol)] : null;
          b.edits.push(e);
          edits.push(e);
        }
      }
    }

    // ---------- same change: same key, at least two edits; edits that always occur in the
    // same blocks merge into one group.
    const byKey = new Map();
    edits.forEach((e) => { if (!byKey.has(e.key)) byKey.set(e.key, []); byKey.get(e.key).push(e); });
    const bySig = new Map();
    byKey.forEach((list, key) => {
      if (list.length < 2) return;
      const sig = list.map((e) => e.block.id).sort().join('|');
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push({ key, edits: list });
    });
    const groups = [];
    bySig.forEach((parts) => {
      parts.sort((x, y) => (x.edits[0].id - y.edits[0].id));
      groups.push({ parts, edits: parts.flatMap((p) => p.edits), count: parts[0].edits.length });
    });
    groups.sort((x, y) => y.count - x.count || (x.parts[0].key < y.parts[0].key ? -1 : 1));
    groups.forEach((g, i) => { g.id = i; g.edits.forEach((e) => { e.group = i; }); g.files = new Set(g.edits.map((e) => e.block.file.p)).size; });

    // ---------- members (enclosing declarations) for every block
    // A block belongs to the member that holds most of its code lines (comments don't count).
    const codeRow = (r) => r.toks && r.toks.some((tk) => tk.k !== 'ws' && tk.k !== 'com');
    for (const f of files) {
      for (const b of f.blocks) {
        let rows = b.rows.filter((r) => r.type === '+' && codeRow(r));
        let tree = f.newTree, line = (r) => r.n;
        if (!rows.length) { rows = b.rows.filter((r) => r.type === '-' && codeRow(r)); tree = f.oldTree; line = (r) => r.o; }
        if (!rows.length) rows = b.rows.filter((r) => r.type === '+').length ? b.rows.filter((r) => r.type === '+') : b.rows;
        const tally = new Map();
        let firstTest = null;
        rows.forEach((r) => {
          const at = memberAt(tree, line(r), r.text);
          const k = at && at.member ? at.member : null;
          tally.set(k, (tally.get(k) || 0) + 1);
          if (!firstTest && at && at.test) firstTest = at.test;
        });
        let best = null, bestN = -1;
        tally.forEach((n, k) => { if (n > bestN) { best = k; bestN = n; } });
        b.member = best;
        b.test = firstTest;
        const commentOnly = b.atoms.length && b.atoms.every((a) => a.commentOnly);
        if (commentOnly && tree) {
          const src = tree === f.newTree ? f.newSrc : f.oldSrc;
          const lines = src.split('\n');
          const after = Math.max(...b.rows.filter((r) => (tree === f.newTree ? r.type === '+' : r.type === '-')).map((r) => line(r)).concat([0]));
          for (let l = after + 1; l <= Math.min(lines.length, after + 20); l++) {
            const t = lines[l - 1].trim();
            if (!t || t.startsWith('//') || t.startsWith('@')) continue;
            const at = memberAt(tree, l, lines[l - 1]);
            if (at && at.member) { b.member = at.member; b.documents = true; }
            break;
          }
        }
        const isTest = /(^|\/)test\//.test(f.p) && (!b.member || b.member === 'main');
        b.memberKey = f.p + '::' + (isTest && b.test ? 'test:' + b.test : b.member || '(top)');
      }
    }

    // ---------- usage links from the language server
    const plusRow = new Map();
    files.forEach((f) => f.blocks.forEach((b) => b.rows.forEach((r) => { if (r.type === '+') plusRow.set(f.p + ':' + r.n, { f, b, r }); })));
    const changedCol = (r, col) => r.toks.some((tk) => tk.atom && (tk.c === col || tk.c + 1 === col));
    const decls = new Map();
    const usesOf = new Map();
    for (const [key, [tpath, tl, tc]] of Object.entries(defsRaw)) {
      const i1 = key.lastIndexOf(':'), i0 = key.lastIndexOf(':', i1 - 1);
      const p = key.slice(0, i0), line = +key.slice(i0 + 1, i1), col = +key.slice(i1 + 1);
      const u = plusRow.get(p + ':' + line);
      if (!u || !tpath.startsWith(HEAD) || !changedCol(u.r, col)) continue;
      const rel = tpath.slice(HEAD.length);
      const d = plusRow.get(rel + ':' + (tl + 1));
      if (!d || d.b === u.b) continue;
      const dk = `${rel}:${tl + 1}:${tc}`;
      if (!decls.has(dk)) {
        const tok = d.r.toks.find((t) => t.c === tc) || d.r.toks.find((t) => t.c + 1 === tc);
        const at = memberAt(d.f.newTree, tl + 1, ' '.repeat(tc) + 'x');
        decls.set(dk, { key: dk, name: tok ? tok.t.replace(/^@/, '') : '?', kind: declKind(d.f.newTree, tl + 1, tc), block: d.b, users: new Set(), member: at && at.member, test: at && at.test, line: tl + 1, file: rel });
      }
      decls.get(dk).users.add(u.b);
      if (!usesOf.has(u.b)) usesOf.set(u.b, new Map());
      usesOf.get(u.b).set(dk, true);
    }

    // ---------- chains
    const allBlocks = files.flatMap((f) => f.blocks).filter((b) => b.atoms.length);
    const parent = new Map(allBlocks.map((b) => [b, b]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (x, y) => { x = find(x); y = find(y); if (x !== y) parent.set(x, y); };
    decls.forEach((d) => { if (d.kind === 'param' || d.kind === 'local') d.users.forEach((u) => union(d.block, u)); });
    const comps = new Map();
    allBlocks.forEach((b) => { const r = find(b); if (!comps.has(r)) comps.set(r, new Set()); comps.get(r).add(b); });
    let chains = [...comps.values()].filter((s) => s.size > 1).map((blocks) => ({ blocks, kind: 'ripple' }));
    const chainOf = new Map();
    chains.forEach((c) => c.blocks.forEach((b) => chainOf.set(b, c)));
    decls.forEach((d) => {
      if ((d.kind !== 'member' && d.kind !== 'type') || !d.users.size) return;
      const blocks = new Set([d.block, ...d.users]);
      const owners = new Set([...blocks].map((b) => chainOf.get(b)));
      if (owners.size === 1 && [...owners][0]) return; // already inside one ripple chain
      chains.push({ blocks, kind: 'member', root: d });
    });
    const identToken = (d) => d.tk.k === 'id' || d.tk.k === 'ty' || d.tk.k === 'ann';
    groups.forEach((g) => {
      const named = g.edits.some((e) => !e.commentOnly && e.atom.del.concat(e.atom.ins).some(identToken));
      if (!named) return;
      const blocks = new Set(g.edits.map((e) => e.block));
      if (blocks.size < 2) return;
      const shared = chains.filter((c) => [...blocks].every((b) => c.blocks.has(b)));
      if (shared.length) return;
      chains.push({ blocks, kind: 'group', group: g });
    });
    const memberCount = (c) => new Set([...c.blocks].map((b) => b.memberKey)).size;
    chains = chains.filter((c) => (c.kind === 'group' ? c.blocks.size > 1 : memberCount(c) > 1));
    // Member cohesion: a chain takes every change of the members it touches (a test counts as
    // a member in test files; top-level code doesn't).
    const byMember = new Map();
    allBlocks.forEach((b) => { if (!b.memberKey.endsWith('::(top)')) { if (!byMember.has(b.memberKey)) byMember.set(b.memberKey, []); byMember.get(b.memberKey).push(b); } });
    chains.forEach((c) => { [...c.blocks].forEach((b) => (byMember.get(b.memberKey) || []).forEach((x) => c.blocks.add(x))); });
    chains.forEach((c) => {
      const inside = [...decls.values()].filter((d) => c.blocks.has(d.block)).map((d) => ({ d, n: [...d.users].filter((u) => c.blocks.has(u)).length })).filter((x) => x.n > 0);
      inside.sort((x, y) => y.n - x.n || (x.d.key < y.d.key ? -1 : 1));
      if (!c.root) c.root = inside.length ? inside[0].d : null;
      c.also = inside.filter((x) => x.d !== c.root && x.n >= 2 && x.d.kind !== 'local').slice(0, 3).map((x) => x.d);
    });
    const label = (d) => {
      if (!d) return '(changes)';
      let m = d.member;
      const ctor = m && /^([\w$]+)\.\1$/.exec(m);
      if (ctor) m = ctor[1];
      if (d.kind === 'param') return `${m || '?'}(${d.name})`;
      if (ctor && d.name === ctor[1]) return `${ctor[1]}()`;
      if (d.kind === 'local') return `${!m || m === 'main' ? path.basename(d.file) : m} · ${d.name}`;
      return m && m.endsWith(d.name) ? m : m ? `${m.split('.')[0]}.${d.name}` : d.name;
    };
    const editLabel = (e) => {
      const t = (x) => (x.length > 48 ? x.slice(0, 47) + '…' : x);
      return e.op === 'insert' ? '+ ' + t(e.to) : e.op === 'delete' ? '− ' + t(e.from) : t(e.from) + ' → ' + t(e.to);
    };
    // Chains with the same root name are one chain (a ripple and the star of its root).
    // A member's own chain and the ripple of one of its parameters are one chain too.
    const byName = new Map();
    const mergeKey = (c, nm) => (c.root && c.root.kind === 'param' && c.root.member ? label({ ...c.root, kind: 'member', name: c.root.member.split('.').pop() }) : nm);
    chains.forEach((c) => {
      const nm = c.kind === 'group' && !c.root ? editLabel(c.group.edits[0]) : label(c.root);
      const key = mergeKey(c, nm);
      c.name = nm;
      if (!byName.has(key)) { byName.set(key, c); return; }
      const keep = byName.get(key);
      if (keep.root && keep.root.kind === 'param' && c.root && c.root.kind !== 'param') { keep.name = c.name; }
      c.blocks.forEach((b) => keep.blocks.add(b));
      [c.root, ...c.also].forEach((d) => { if (d && !keep.also.includes(d) && d !== keep.root) keep.also.push(d); });
    });
    chains = [...byName.values()];
    const namesOf = (c) => {
      const out = new Set();
      c.blocks.forEach((b) => { if (b.member && b.member !== 'main') out.add(b.member.split('.').pop()); });
      decls.forEach((d) => { if (c.blocks.has(d.block) && (d.kind === 'member' || d.kind === 'type')) out.add(d.name); });
      return out;
    };
    const chainNames = chains.map((c) => [c, namesOf(c)]);
    allBlocks.filter((b) => b.lang === 'md').forEach((b) => {
      const mentioned = new Set();
      b.rows.forEach((r) => { if (r.type === '+' || r.type === '-') for (const m of r.text.matchAll(/`([A-Za-z_$][\w$.]*)(?:\(\))?`/g)) mentioned.add(m[1].split('.').pop()); });
      chainNames.forEach(([c, names]) => { if ([...mentioned].some((x) => names.has(x))) c.blocks.add(b); });
    });
    allBlocks.filter((b) => b.lang === 'dart').forEach((b) => {
      const imported = [];
      b.rows.forEach((r) => {
        const m = r.type === '+' && /^\s*import\s+['"]([^'"]+)['"]/.exec(r.text);
        if (m && !m[1].startsWith('package:') && !m[1].startsWith('dart:')) imported.push(path.normalize(path.join(path.dirname(b.file.p), m[1])));
      });
      if (!imported.length) return;
      chains.forEach((c) => {
        const uses = [...c.blocks].some((x) => x.file === b.file && [...(usesOf.get(x) || new Map()).keys()].some((dk) => imported.includes(decls.get(dk).file)));
        if (uses) c.blocks.add(b);
      });
    });
    chains.sort((x, y) => y.blocks.size - x.blocks.size || (x.name < y.name ? -1 : 1));
    chains.forEach((c, i) => { c.id = i; c.files = new Set([...c.blocks].map((b) => b.file.p)).size; });

    // Graph per chain: nodes are members; blocks whose edits are all one same-change group
    // that appears 3+ times in the chain collapse into one node.
    for (const c of chains) {
      const groupCount = new Map();
      c.blocks.forEach((b) => { const gs = new Set(b.edits.map((e) => e.group)); if (gs.size === 1 && [...gs][0] !== undefined) groupCount.set([...gs][0], (groupCount.get([...gs][0]) || 0) + 1); });
      const nodeOf = new Map();
      const nodes = new Map();
      [...c.blocks].sort((x, y) => (x.id < y.id ? -1 : 1)).forEach((b) => {
        const gs = new Set(b.edits.map((e) => e.group));
        const g = gs.size === 1 ? [...gs][0] : undefined;
        const key = g !== undefined && groupCount.get(g) >= 3 ? 'group:' + g : 'member:' + b.memberKey;
        if (!nodes.has(key)) nodes.set(key, { key, blocks: [], files: new Set(), group: key.startsWith('group:') ? g : null, member: b.member, file: b.file.p, test: b.test });
        const n = nodes.get(key);
        n.blocks.push(b); n.files.add(b.file.p);
        nodeOf.set(b, key);
      });
      const edges = new Map();
      c.blocks.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => {
          const d = decls.get(dk);
          if (!c.blocks.has(d.block)) return;
          const from = nodeOf.get(b), to = nodeOf.get(d.block);
          if (from === to) return;
          const k = from + '>' + to;
          if (!edges.has(k)) edges.set(k, { from, to, labels: new Set() });
          edges.get(k).labels.add(d.name);
        });
      });
      c.focus = {};
      decls.forEach((d) => {
        if (!c.blocks.has(d.block)) return;
        const inChainUsers = [...d.users].filter((u) => c.blocks.has(u));
        if (!inChainUsers.length && d !== c.root) return;
        (c.focus[d.block.id] = c.focus[d.block.id] || new Set()).add(d.line);
      });
      c.blocks.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => {
          const d = decls.get(dk);
          if (!c.blocks.has(d.block)) return;
          b.rows.forEach((r) => {
            if (r.type !== '+') return;
            if (r.toks.some((tk) => tk.atom && defsRaw[`${b.file.p}:${r.n}:${tk.c}`] && defsRaw[`${b.file.p}:${r.n}:${tk.c}`][0] === HEAD + d.file && defsRaw[`${b.file.p}:${r.n}:${tk.c}`][1] === d.line - 1)) (c.focus[b.id] = c.focus[b.id] || new Set()).add(r.n);
          });
        });
      });
      const rootKey = c.root ? nodeOf.get(c.root.block) : [...nodes.keys()][0];
      // Layers: distance from the root over links in either direction.
      const adj = new Map([...nodes.keys()].map((k) => [k, new Set()]));
      edges.forEach((e) => { adj.get(e.from).add(e.to); adj.get(e.to).add(e.from); });
      const layer = new Map([[rootKey, 0]]);
      const q = [rootKey];
      while (q.length) { const x = q.shift(); [...adj.get(x)].sort().forEach((y) => { if (!layer.has(y)) { layer.set(y, layer.get(x) + 1); q.push(y); } }); }
      const maxLayer = Math.max(0, ...layer.values());
      nodes.forEach((n, k) => { if (!layer.has(k)) layer.set(k, maxLayer + 1); });
      c.graph = {
        root: rootKey,
        nodes: [...nodes.values()].map((n) => ({ key: n.key, layer: layer.get(n.key), group: n.group, member: n.member, file: n.file, files: n.files.size, test: n.test, blocks: n.blocks.map((b) => b.id) }))
          .sort((x, y) => x.layer - y.layer || (x.file < y.file ? -1 : x.file > y.file ? 1 : (x.key < y.key ? -1 : 1))),
        edges: [...edges.values()].map((e) => ({ from: e.from, to: e.to, labels: [...e.labels].sort() })),
      };
    }
    // Linked chains: a block of one chain uses a member that roots another, or they share blocks.
    const rootChain = new Map(chains.filter((c) => c.root).map((c) => [c.root.key, c]));
    chains.forEach((c) => {
      const links = new Set();
      c.blocks.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => { const o = rootChain.get(dk); if (o && o !== c) links.add(o.id); });
        chains.forEach((o) => { if (o !== c && o.blocks.has(b)) links.add(o.id); });
      });
      c.links = [...links].sort((x, y) => x - y);
      c.shares = new Set();
      chains.forEach((o) => { if (o !== c && [...c.blocks].some((b) => o.blocks.has(b))) c.shares.add(o.id); });
    });
    // A chain's core is the changes of its root's member (all its changes when it has no root).
    // Chain A uses chain B when A's core uses a function, method, field or type of B's core.
    chains.forEach((c) => {
      const mk = c.root ? c.root.block.memberKey : null;
      c.core = new Set([...c.blocks].filter((b) => !mk || b.memberKey === mk));
    });
    chains.forEach((c) => {
      c.uses = new Set();
      c.core.forEach((b) => {
        (usesOf.get(b) || new Map()).forEach((_, dk) => {
          const d = decls.get(dk);
          if (d.kind !== 'member' && d.kind !== 'type' && !chains.some((o) => o.root === d)) return;
          chains.forEach((o) => { if (o !== c && o.core.has(d.block) && !c.core.has(d.block)) c.uses.add(o.id); });
        });
      });
    });
    // Depth: longest path from a chain nobody uses, ignoring back edges of cycles.
    const depth = new Map();
    const usedBy = new Map(chains.map((c) => [c.id, []]));
    chains.forEach((c) => c.uses.forEach((o) => usedBy.get(o).push(c.id)));
    const state = new Map();
    const order = [];
    const visit = (id) => { state.set(id, 1); [...chains[id].uses].sort((a, b) => a - b).forEach((o) => { if (!state.has(o)) visit(o); }); state.set(id, 2); order.push(id); };
    chains.forEach((c) => { if (!state.has(c.id)) visit(c.id); });
    order.reverse().forEach((id) => {
      const parents = usedBy.get(id).filter((p) => order.indexOf(p) < order.indexOf(id));
      depth.set(id, parents.length ? Math.max(...parents.map((p) => depth.get(p) + 1)) : 0);
    });
    // Families: chains connected by uses or shared changes.
    const fam = new Map();
    let famId = 0;
    chains.forEach((c) => {
      if (fam.has(c.id)) return;
      const stack = [c.id];
      fam.set(c.id, famId);
      while (stack.length) { const x = stack.pop(); const ch = chains[x]; [...ch.uses, ...usedBy.get(x)].forEach((y) => { if (!fam.has(y)) { fam.set(y, famId); stack.push(y); } }); }
      famId++;
    });
    chains.forEach((c) => { c.depth = depth.get(c.id); c.family = fam.get(c.id); });

    // ---------- serialize
    const fileIndex = new Map(files.map((f, i) => [f, i]));
    const ser = {
      label: meta.label, left: meta.left.slice(0, 7), right: meta.right.slice(0, 7),
      files: files.map((f) => ({
        p: f.p, s: f.s, a: f.a, d: f.d, lang: f.lang,
        hunks: f.hunks.map((h) => ({ o: h.o, n: h.n, h: h.h, rows: h.rows.map((r) => {
          const row = [r.type, r.text];
          if (r.toks) {
            const ranges = [];
            r.toks.forEach((tk) => { if (tk.atom) ranges.push([tk.c, tk.c + tk.t.length, tk.atom.block.edits[tk.atom.block.atoms.indexOf(tk.atom)].id]); });
            if (ranges.length) row.push(ranges);
          }
          return row;
        }) })),
        blocks: f.blocks.map((b) => ({ id: b.id, hunk: b.hunk, first: b.first, len: b.rows.length, adds: b.adds, dels: b.dels, member: b.member, test: b.test, documents: b.documents || undefined, edits: b.edits.map((e) => e.id) })),
      })),
      edits: edits.map((e) => ({ id: e.id, f: fileIndex.get(e.block.file), b: e.block.id, op: e.op, where: e.where, from: e.from.slice(0, 400), to: e.to.slice(0, 400), group: e.group, comment: e.commentOnly || undefined, os: e.oldSpan, ns: e.newSpan })),
      groups: groups.map((g) => ({ id: g.id, count: g.count, files: g.files, parts: g.parts.map((p) => p.edits[0].id), edits: g.edits.map((e) => e.id) })),
      chains: chains.map((c) => ({ id: c.id, name: c.name, kind: c.kind, rootKind: c.root ? c.root.kind : null, also: c.also.map(label).filter((x, i, a) => x !== c.name && a.indexOf(x) === i), blocks: [...c.blocks].map((b) => b.id).sort(), files: c.files, graph: c.graph, links: c.links, uses: [...c.uses].sort((a, b) => a - b), shares: [...c.shares].sort((a, b) => a - b), depth: c.depth, family: c.family, adds: [...c.blocks].reduce((x, b) => x + b.adds, 0), dels: [...c.blocks].reduce((x, b) => x + b.dels, 0), focus: Object.fromEntries(Object.entries(c.focus).map(([k, v]) => [k, [...v].sort((x, y) => x - y)])) })),
      generated: generated.map((f) => ({ p: f.p, s: f.s, a: f.a, d: f.d, gen: f.gen, hunks: f.hunks ? f.hunks.map((h) => ({ o: h.o, n: h.n, h: h.h, rows: h.l.map((l) => [l[0], l.slice(1)]) })) : null })),
    };
    out.compares[name] = ser;
    const inChain = new Set(chains.flatMap((c) => [...c.blocks]));
    console.log(`${name}: ${files.length} files, ${allBlocks.length} change blocks, ${edits.length} edits, ${groups.length} same-change groups (${groups.reduce((s, g) => s + g.edits.length, 0)} edits), ${chains.length} chains covering ${inChain.size} blocks, ${allBlocks.length - inChain.size} not in a chain, generated ${generated.length} (${generated.filter((g) => g.hunks).length} peekable)`);
    chains.slice(0, 14).forEach((c) => console.log(`   chain ${String(c.blocks.size).padStart(3)} blocks · ${String(c.files).padStart(2)} files · ${c.graph.nodes.length} nodes · ${c.name}${c.also.length ? '  also: ' + c.also.map(label).join(', ') : ''}  links: ${c.links.length}`));
    const names = chains.map((c) => c.name); console.log('   duplicate chain names:', names.filter((n, i) => names.indexOf(n) !== i).length);
    groups.slice(0, 8).forEach((g) => { const e = edits[g.parts[0].edits[0].id]; console.log(`   group ×${g.count} ${e.op} in ${e.where}: ${e.from.slice(0, 40)} → ${e.to.slice(0, 40)}`); });
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log('wrote', OUT, Math.round(fs.statSync(OUT).size / 1024), 'KB');
})();
