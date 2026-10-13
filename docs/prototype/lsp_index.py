"""Asks the Dart language server (the one VS Code uses) where each identifier is defined.

Input: positions.json (identifier positions on the head side of the diff).
Output: defs.json with, per position, the definition target, and a snippet per target.
"""
import json, os, subprocess, sys, threading, time, urllib.parse
from collections import OrderedDict

head = os.path.abspath(sys.argv[1])
positions = json.load(open(sys.argv[2]))
out_path = sys.argv[3]

proc = subprocess.Popen(['dart', 'language-server', '--protocol=lsp', '--client-id', 'bcr-proto', '--client-version', '0.1'],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=head)
lock = threading.Lock()
responses, waiters = {}, {}
next_id = [0]
status = {'analyzing': None}

def send(msg):
    body = json.dumps(msg).encode()
    with lock:
        proc.stdin.write(b'Content-Length: %d\r\n\r\n' % len(body) + body)
        proc.stdin.flush()

def reader():
    f = proc.stdout
    while True:
        length = None
        while True:
            line = f.readline()
            if not line:
                return
            line = line.strip()
            if not line:
                break
            if line.lower().startswith(b'content-length:'):
                length = int(line.split(b':')[1])
        msg = json.loads(f.read(length))
        if 'id' in msg and 'method' in msg:  # server -> client request
            result = None
            if msg['method'] == 'workspace/configuration':
                result = [{} for _ in msg['params']['items']]
            send({'jsonrpc': '2.0', 'id': msg['id'], 'result': result})
        elif 'id' in msg:
            ev = waiters.get(msg['id'])
            responses[msg['id']] = msg
            if ev: ev.set()
        elif msg.get('method') == '$/analyzerStatus':
            status['analyzing'] = msg['params']['isAnalyzing']

threading.Thread(target=reader, daemon=True).start()

def request(method, params):
    next_id[0] += 1
    rid = next_id[0]
    ev = threading.Event()
    waiters[rid] = ev
    send({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
    return rid, ev

def wait(rid, ev, timeout=120):
    if not ev.wait(timeout):
        raise TimeoutError(rid)
    waiters.pop(rid, None)
    return responses.pop(rid)

def uri(path):
    return 'file://' + urllib.parse.quote(path)

def unuri(u):
    return urllib.parse.unquote(u[len('file://'):])

rid, ev = request('initialize', {
    'processId': os.getpid(), 'rootUri': uri(head),
    'workspaceFolders': [{'uri': uri(head), 'name': 'head'}],
    'capabilities': {'workspace': {'configuration': True, 'workspaceFolders': True},
                     'textDocument': {'definition': {'linkSupport': False}}},
})
wait(rid, ev)
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
t0 = time.time()

# Warm up: the first request waits for analysis of that file.
items = [(p, int(line), col, ln) for p, lines in positions.items() for line, cols in lines.items() for col, ln in cols]
print('positions', len(items), flush=True)

results = {}
WINDOW = 64
pending = OrderedDict()
it = iter(items)
done = 0
def pump():
    while len(pending) < WINDOW:
        try:
            p, line, col, ln = next(it)
        except StopIteration:
            return False
        rid, ev = request('textDocument/definition', {'textDocument': {'uri': uri(os.path.join(head, p))}, 'position': {'line': line - 1, 'character': col}})
        pending[rid] = (ev, (p, line, col, ln))
    return True

more = pump()
while pending:
    rid, (ev, key) = next(iter(pending.items()))
    msg = wait(rid, ev, timeout=600)
    pending.pop(rid)
    res = msg.get('result')
    if isinstance(res, list):
        res = res[0] if res else None
    if res and 'targetUri' in res:
        res = {'uri': res['targetUri'], 'range': res.get('targetSelectionRange') or res['targetRange']}
    results[key] = res
    done += 1
    if done % 1000 == 0:
        print(done, 'done', round(time.time() - t0), 's', flush=True)
    if more:
        more = pump()

print('definitions done in', round(time.time() - t0), 's', flush=True)

# Targets and snippets
targets, target_index = [], {}
file_cache = {}
def read_lines(path):
    if path not in file_cache:
        try:
            file_cache[path] = open(path, encoding='utf-8').read().split('\n')
        except OSError:
            file_cache[path] = None
    return file_cache[path]

def short(path):
    if path.startswith(head + '/'):
        return path[len(head) + 1:], 'repo'
    if '/.pub-cache/' in path:
        rest = path.split('/.pub-cache/', 1)[1].split('/')
        return '/'.join(rest[2:]), 'package'  # hosted/pub.dev/<pkg-ver>/...
    if '/dart-sdk/lib/' in path:
        return 'dart:' + path.split('/dart-sdk/lib/', 1)[1], 'sdk'
    return os.path.basename(path), 'other'

defs = {}
for (p, line, col, ln), res in results.items():
    if not res:
        continue
    tpath = unuri(res['uri'])
    tl, tc = res['range']['start']['line'], res['range']['start']['character']
    tk = (tpath, tl, tc)
    if tk not in target_index:
        lines = read_lines(tpath) or []
        start = tl
        while start > 0 and start > tl - 6 and lines[start - 1].strip().startswith(('///', '@')):
            start -= 1
        end = min(len(lines), tl + 8)
        name, where = short(tpath)
        target_index[tk] = len(targets)
        targets.append({'p': name, 'w': where, 'l': tl + 1, 'c': tc, 's': start + 1, 'code': lines[start:end]})
    defs.setdefault(p, {}).setdefault(str(line), []).append([col, ln, target_index[tk]])

json.dump({'targets': targets, 'defs': defs, 'raw': {f'{p}:{line}:{col}': [unuri(r['uri']), r['range']['start']['line'], r['range']['start']['character']] for (p, line, col, ln), r in results.items() if r}},
          open(out_path, 'w'), separators=(',', ':'))
print('targets', len(targets), 'resolved', sum(1 for r in results.values() if r), 'of', len(results), flush=True)
send({'jsonrpc': '2.0', 'id': 99999999, 'method': 'shutdown'})
time.sleep(1)
send({'jsonrpc': '2.0', 'method': 'exit'})
