"""Puts several analysed PRs into one page: each becomes a comparison of its own.

    python3 combine_runs.py <out-dir> <name>=<run-dir>[:<compare>]=<title> ...

Each run directory holds model.json, defs.json, refs.json and defs_old_slim.json from the
pipeline. A run with several comparisons (base and since) lists each one with its own name;
comparisons of the same run share its head-side definitions.
"""
import json, os, sys

out_dir = sys.argv[1]
model, defs, refs, defs_old = {'compares': {}}, {}, {}, {}
head_of = {}
for arg in sys.argv[2:]:
    name, rest = arg.split('=', 1)
    where, title = rest.split('=', 1)
    run, compare = (where.split(':') + ['base'])[:2]
    m = json.load(open(os.path.join(run, 'model.json')))['compares'][compare]
    m['title'] = title
    model['compares'][name] = m
    if run in head_of:
        defs[name] = head_of[run]
    else:
        d = json.load(open(os.path.join(run, 'defs.json')))
        defs[name] = {'targets': [{'p': t['p'], 'w': t['w'], 'l': t['l'], 's': t['s'], 'code': [c[:160] for c in t['code'][:10]]} for t in d['targets']], 'defs': d['defs']}
        head_of[run] = name
    refs[name] = json.load(open(os.path.join(run, 'refs.json'))).get(compare, {})
    defs_old[name] = json.load(open(os.path.join(run, 'defs_old_slim.json'))).get(compare, {'targets': [], 'defs': {}})
os.makedirs(out_dir, exist_ok=True)
for fname, data in (('model.json', model), ('defs_slim.json', defs), ('refs.json', refs), ('defs_old_slim.json', defs_old)):
    json.dump(data, open(os.path.join(out_dir, fname), 'w'), separators=(',', ':'), ensure_ascii=False)
print('comparisons:', ', '.join(model['compares']))
