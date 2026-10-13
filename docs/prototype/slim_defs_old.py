"""Combines the old-side definitions of both comparisons into what the page embeds."""
import json, sys
out = {}
for arg in sys.argv[1:-1]:
    name, path = arg.split('=')
    d = json.load(open(path))
    out[name] = {'targets': [{'p': t['p'], 'w': t['w'], 'l': t['l'], 's': t['s'], 'code': [c[:160] for c in t['code'][:10]]} for t in d['targets']], 'defs': d['defs']}
json.dump(out, open(sys.argv[-1], 'w'), separators=(',', ':'))
