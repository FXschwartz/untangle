"""Exports the raw git diff of a PR as JSON, with no analysis.

For every changed file: path, status, +/- counts and whether .gitattributes marks it
linguist-generated. Files matching the review config's generated patterns get stats
only; every other file gets its unified-diff hunks (-U3), exactly as git produced them.
"""
import json, re, subprocess, sys

repo, out = sys.argv[1], sys.argv[2]
COMPARES = {  # name -> (left, right)
    'base': ('e0598c1577db2d55c9af7d0d165be6332256910d', 'a45f9aee30bcb170b863373840e63a0e42a0092b'),
    'since': ('0540639', 'a45f9aee30bcb170b863373840e63a0e42a0092b'),
}
CONFIG_GENERATED = ['**/migrations/**']  # same patterns the page shows as the review config

def git(*args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, check=True).stdout

def glob_re(pattern):
    rx = ''
    i = 0
    while i < len(pattern):
        if pattern.startswith('**/', i): rx += '(?:.*/)?'; i += 3
        elif pattern.startswith('**', i): rx += '.*'; i += 2
        elif pattern[i] == '*': rx += '[^/]*'; i += 1
        else: rx += re.escape(pattern[i]); i += 1
    return re.compile('^' + rx + '$')

CONFIG_RES = [glob_re(p) for p in CONFIG_GENERATED]

def parse_hunks(text):
    hunks, cur = [], None
    for line in text.split('\n'):
        m = re.match(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$', line)
        if m:
            cur = {'o': int(m.group(1)), 'n': int(m.group(3)), 'h': m.group(5).strip(), 'l': []}
            hunks.append(cur)
        elif cur is not None and line[:1] in (' ', '-', '+'):
            cur['l'].append(line)
        elif cur is not None and line.startswith('\\'):
            pass  # "\ No newline at end of file"
    return hunks

result = {'compares': {}}
for name, (left, right) in COMPARES.items():
    files = []
    status = {}
    for row in git('diff', '--no-renames', '--name-status', left, right).splitlines():
        st, path = row.split('\t', 1)
        status[path] = st
    numstat = {}
    for row in git('diff', '--no-renames', '--numstat', left, right).splitlines():
        a, d, path = row.split('\t', 2)
        numstat[path] = (int(a) if a != '-' else 0, int(d) if d != '-' else 0)
    attrs = {}
    paths = sorted(status)
    attr_out = subprocess.run(['git', '-C', repo, 'check-attr', '--stdin', 'linguist-generated'],
                              input='\n'.join(paths), capture_output=True, text=True, check=True).stdout
    for row in attr_out.splitlines():
        p, _, v = row.rsplit(': ', 2)
        attrs[p] = v
    for path in paths:
        a, d = numstat[path]
        f = {'p': path, 's': status[path], 'a': a, 'd': d, 'ga': attrs.get(path, 'unspecified')}
        by_config = any(rx.match(path) for rx in CONFIG_RES)
        if attrs.get(path) != 'true' and not by_config:
            f['hunks'] = parse_hunks(git('diff', '--no-renames', '-U3', left, right, '--', path))
        files.append(f)
    result['compares'][name] = {'left': left[:7], 'right': right[:7], 'files': files}

json.dump(result, open(out, 'w'), separators=(',', ':'))
for name, c in result['compares'].items():
    n = sum(len(h['l']) for f in c['files'] for h in f.get('hunks', []))
    print(name, len(c['files']), 'files;', sum(1 for f in c['files'] if 'hunks' in f), 'with hunks;', n, 'hunk lines')
