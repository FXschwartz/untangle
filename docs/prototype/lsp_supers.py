"""What each changed declaration overrides.

For every declaration on an added line (the language server resolves its name to itself),
ask the Dart language server for its super declaration (dart/textDocument/super). analyze.js
links changed overrides of the same method into one chain, and an override to its base when
the base changed too.

    python3 lsp_supers.py <head-worktree> <diff.json> <defs.json> <supers.json>
"""
import json, os, subprocess, sys, threading, time, urllib.parse

head = os.path.abspath(sys.argv[1])
diff = json.load(open(sys.argv[2]))
defs = json.load(open(sys.argv[3]))['raw']
out_path = sys.argv[4]

proc = subprocess.Popen(['dart', 'language-server', '--protocol=lsp', '--client-id', 'bcr-proto', '--client-version', '0.1'],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=head)
lock = threading.Lock()
responses, events, next_id = {}, {}, [0]

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
        if 'id' in msg and 'method' in msg:
            result = [{} for _ in msg['params']['items']] if msg['method'] == 'workspace/configuration' else None
            send({'jsonrpc': '2.0', 'id': msg['id'], 'result': result})
        elif 'id' in msg and msg['id'] in events:
            responses[msg['id']] = msg
            events[msg['id']].set()

threading.Thread(target=reader, daemon=True).start()

def request(method, params, timeout=600):
    next_id[0] += 1
    rid = next_id[0]
    events[rid] = threading.Event()
    send({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
    if not events[rid].wait(timeout):
        raise TimeoutError(method)
    events.pop(rid)
    return responses.pop(rid).get('result')

uri = lambda p: 'file://' + urllib.parse.quote(p)
request('initialize', {'processId': os.getpid(), 'rootUri': uri(head), 'workspaceFolders': [{'uri': uri(head), 'name': 'head'}],
                       'capabilities': {'workspace': {'configuration': True}}})
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
t0 = time.time()

plus = set()
for cmp in diff['compares'].values():
    for f in cmp['files']:
        for h in f.get('hunks') or []:
            n = h['n']
            for line in h['l']:
                if line[0] == '+':
                    plus.add(f"{f['p']}:{n}")
                if line[0] != '-':
                    n += 1
supers = {}
asked = 0
for key, (tpath, tl, tc) in sorted(defs.items()):
    p, line, col = key.rsplit(':', 2)
    if f'{p}:{line}' not in plus or tpath != os.path.join(head, p) or tl != int(line) - 1 or tc != int(col):
        continue
    res = request('dart/textDocument/super', {'textDocument': {'uri': uri(tpath)}, 'position': {'line': tl, 'character': tc}})
    asked += 1
    if res:
        start = res['range']['start']
        supers[key] = [urllib.parse.unquote(res['uri'][len('file://'):]), start['line'], start['character']]
json.dump(supers, open(out_path, 'w'), separators=(',', ':'))
print('declarations', asked, 'with a super declaration', len(supers), 'in', round(time.time() - t0), 's', flush=True)
proc.kill()
