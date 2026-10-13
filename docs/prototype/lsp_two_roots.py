"""One Dart language server with both the head and the old checkout as workspace folders.
Resolves the same positions as the two separate runs, then reports peak memory."""
import json, os, subprocess, sys, threading, time, urllib.parse
head, old = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
pos_new, pos_old = json.load(open(sys.argv[3])), json.load(open(sys.argv[4]))
proc = subprocess.Popen(['dart', 'language-server', '--protocol=lsp', '--client-id', 'bcr-proto', '--client-version', '0.1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=head)
lock, responses, waiters, nid = threading.Lock(), {}, {}, [0]
def send(m):
    b = json.dumps(m).encode()
    with lock: proc.stdin.write(b'Content-Length: %d\r\n\r\n' % len(b) + b); proc.stdin.flush()
def reader():
    f = proc.stdout
    while True:
        n = None
        while True:
            l = f.readline()
            if not l: return
            l = l.strip()
            if not l: break
            if l.lower().startswith(b'content-length:'): n = int(l.split(b':')[1])
        m = json.loads(f.read(n))
        if 'id' in m and 'method' in m:
            send({'jsonrpc': '2.0', 'id': m['id'], 'result': [{} for _ in m['params']['items']] if m['method'] == 'workspace/configuration' else None})
        elif 'id' in m:
            responses[m['id']] = m; ev = waiters.pop(m['id'], None); ev and ev.set()
threading.Thread(target=reader, daemon=True).start()
def call(method, params):
    nid[0] += 1; i = nid[0]; ev = threading.Event(); waiters[i] = ev
    send({'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params}); ev.wait(600); return responses.pop(i).get('result')
uri = lambda p: 'file://' + urllib.parse.quote(p)
call('initialize', {'processId': os.getpid(), 'rootUri': uri(head), 'workspaceFolders': [{'uri': uri(head), 'name': 'head'}, {'uri': uri(old), 'name': 'old'}], 'capabilities': {'workspace': {'configuration': True, 'workspaceFolders': True}}})
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
peak = [0]
def sample():
    while proc.poll() is None:
        try:
            r = sum(int(l.split()[1]) for l in open(f'/proc/{proc.pid}/status') if l.startswith('VmRSS'))
            peak[0] = max(peak[0], r)
        except OSError: pass
        time.sleep(0.3)
threading.Thread(target=sample, daemon=True).start()
t0 = time.time(); n = 0
for root, pos in ((head, pos_new), (old, pos_old)):
    for p, lines in pos.items():
        for line, cols in lines.items():
            for col, _ in cols:
                call('textDocument/definition', {'textDocument': {'uri': uri(os.path.join(root, p))}, 'position': {'line': int(line) - 1, 'character': col}}); n += 1
print(f'one server, two roots: {n} lookups in {time.time() - t0:.0f} s, peak RSS {peak[0] // 1024} MB')
call('shutdown', None); send({'jsonrpc': '2.0', 'method': 'exit'})
