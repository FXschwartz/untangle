"""Changed usages, without asking the language server again: every identifier on a changed line
already knows its declaration (defs.json), so inverting that map gives, for each declaration on
an added line, its usages on added lines of other changes (the "changed usages" badges).

    python3 refs_from_defs.py <head-worktree> <diff.json> <defs.json> <refs.json>
"""
import json, os, sys

head = os.path.abspath(sys.argv[1])
diff = json.load(open(sys.argv[2]))
defs = json.load(open(sys.argv[3]))['raw']
out_path = sys.argv[4]

result = {}
for name, cmp in diff['compares'].items():
    added, block_of = set(), {}
    for f in cmp['files']:
        for hi, h in enumerate(f.get('hunks') or []):
            n, block, prev = h['n'], 0, ' '
            for raw in h['l']:
                t = raw[0]
                if t != ' ' and prev == ' ':
                    block += 1
                if t == '+':
                    added.add((f['p'], n))
                    block_of[(f['p'], n)] = (hi, block)
                if t != '-':
                    n += 1
                prev = t
    decls = set()
    for key, (tpath, tl, tc) in defs.items():
        p, line, col = key.rsplit(':', 2)
        if (p, int(line)) in added and tpath == os.path.join(head, p) and tl == int(line) - 1 and tc == int(col):
            decls.add((p, int(line), int(col)))
    usages = {}
    for key, (tpath, tl, tc) in defs.items():
        p, line, col = key.rsplit(':', 2)
        line, col = int(line), int(col)
        if (p, line) not in added or not tpath.startswith(head + '/'):
            continue
        d = (tpath[len(head) + 1:], tl + 1, tc)
        if d not in decls or d == (p, line, col) or block_of.get((p, line)) == block_of.get((d[0], d[1])) and p == d[0]:
            continue
        usages.setdefault(f'{d[0]}:{d[1]}:{d[2]}', []).append([p, line, col])
    result[name] = {k: sorted(v) for k, v in usages.items()}
    print(name, 'declarations on added lines:', len(decls), 'with changed usages elsewhere:', len(usages), flush=True)
json.dump(result, open(out_path, 'w'), separators=(',', ':'))
