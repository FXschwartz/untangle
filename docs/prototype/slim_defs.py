"""Keeps what the page needs from defs.json: targets (snippets capped at 10 lines) and positions."""
import json, sys
d = json.load(open(sys.argv[1]))
slim = {'targets': [{'p': t['p'], 'w': t['w'], 'l': t['l'], 's': t['s'], 'code': [c[:160] for c in t['code'][:10]]} for t in d['targets']],
        'defs': d['defs']}
json.dump(slim, open(sys.argv[2], 'w'), separators=(',', ':'))
