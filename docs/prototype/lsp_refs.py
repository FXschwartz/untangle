"""Changed usages: for each declaration on an added line, ask the Dart language server
for its references and keep the ones that sit on added lines of the same comparison.
"""
import json, os, subprocess, sys, threading, time, urllib.parse

head = os.path.abspath(sys.argv[1])
diff = json.load(open(sys.argv[2]))
defs = json.load(open(sys.argv[3]))
out_path = sys.argv[4]

proc = subprocess.Popen(['dart', 'language-server', '--protocol=lsp', '--client-id', 'bcr-proto', '--client-version', '0.1'],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=head)
lock = threading.Lock()
responses, waiters, next_id = {}, {}, [0]

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
        elif 'id' in msg:
            responses[msg['id']] = msg
            ev = waiters.pop(msg['id'], None)
            if ev: ev.set()

threading.Thread(target=reader, daemon=True).start()

def call(method, params, timeout=600):
    next_id[0] += 1
    rid = next_id[0]
    ev = threading.Event()
    waiters[rid] = ev
    send({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
    if not ev.wait(timeout):
        raise TimeoutError(method)
    return responses.pop(rid).get('result')

uri = lambda p: 'file://' + urllib.parse.quote(p)
unuri = lambda u: urllib.parse.unquote(u[len('file://'):])

call('initialize', {'processId': os.getpid(), 'rootUri': uri(head), 'workspaceFolders': [{'uri': uri(head), 'name': 'head'}],
                    'capabilities': {'workspace': {'configuration': True, 'workspaceFolders': True}}})
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})

result = {}
t0 = time.time()
for name, cmp in diff['compares'].items():
    added, block_of = set(), {}
    for f in cmp['files']:
        for hi, h in enumerate(f.get('hunks', [])):
            n, block, prev_type = h['n'], 0, ' '
            for raw in h['l']:
                t = raw[0]
                if t != ' ' and prev_type == ' ':
                    block += 1
                if t == '+':
                    added.add((f['p'], n))
                    block_of[(f['p'], n)] = (hi, block)
                if t != '-':
                    n += 1
                prev_type = t
    decls = []
    for key, target in defs['raw'].items():
        p, line, col = key.rsplit(':', 2)
        line, col = int(line), int(col)
        if (p, line) not in added:
            continue
        tpath, tl, tc = target
        if tpath == os.path.join(head, p) and tl == line - 1 and tc == col:
            decls.append((p, line, col))
    usages = {}
    for p, line, col in decls:
        refs = call('textDocument/references', {'textDocument': {'uri': uri(os.path.join(head, p))}, 'position': {'line': line - 1, 'character': col},
                                                'context': {'includeDeclaration': False}}) or []
        hits = []
        for r in refs:
            rp = unuri(r['uri'])
            if not rp.startswith(head + '/'):
                continue
            rp = rp[len(head) + 1:]
            rl, rc = r['range']['start']['line'] + 1, r['range']['start']['character']
            if (rp, rl) in added and not (rp == p and block_of.get((rp, rl)) == block_of.get((p, line))):
                hits.append([rp, rl, rc])
        if hits:
            usages[f'{p}:{line}:{col}'] = sorted(hits)
    result[name] = usages
    print(name, 'declarations on added lines:', len(decls), 'with changed usages elsewhere:', len(usages), round(time.time() - t0), 's', flush=True)

json.dump(result, open(out_path, 'w'), separators=(',', ':'))
for name, usages in result.items():
    top = sorted(usages.items(), key=lambda kv: -len(kv[1]))[:12]
    for k, v in top:
        print(f'  {name} {len(v):4} {k}')
call('shutdown', None)
send({'jsonrpc': '2.0', 'method': 'exit'})
