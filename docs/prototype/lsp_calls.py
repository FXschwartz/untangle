"""Calls reachable from what changed tests call.

For each declaration that a changed test line uses (production code or an unchanged test
helper), follow the Dart language server's outgoing calls (call hierarchy) up to DEPTH levels,
inside the repository only. analyze.js then links the test to the first changed function on
each path.

    python3 lsp_calls.py <head-worktree> <diff.json> <defs.json> <calls.json>
"""
import collections, json, os, re, subprocess, sys, threading, time, urllib.parse

DEPTH = 3
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

def node_key(item):
    path = urllib.parse.unquote(item['uri'][len('file://'):])
    if not path.startswith(head + '/'):
        return None
    rel = path[len(head) + 1:]
    if '/generated/' in rel:
        return None
    start = item['selectionRange']['start']
    return f"{rel}:{start['line']}:{start['character']}"

request('initialize', {'processId': os.getpid(), 'rootUri': uri(head),
                       'workspaceFolders': [{'uri': uri(head), 'name': 'head'}],
                       'capabilities': {'workspace': {'configuration': True}, 'textDocument': {'callHierarchy': {}}}})
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
t0 = time.time()

# Added lines of test files, and the declarations they use that didn't change themselves.
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
is_test = lambda p: re.search(r'(^|/)(test|test_[a-z0-9_]+|integration_test)/|_test\.dart$', p)
seeds = set()
for key, (tpath, tl, tc) in defs.items():
    p, line, _ = key.rsplit(':', 2)
    if not is_test(p) or f'{p}:{line}' not in plus or not tpath.startswith(head + '/'):
        continue
    rel = tpath[len(head) + 1:]
    # Unchanged test helpers count too: a test often reaches changed code through one.
    if '/generated/' in rel or f'{rel}:{tl + 1}' in plus:
        continue
    seeds.add((rel, tl, tc))
print('seeds', len(seeds), flush=True)

graph, items, requests = {}, {}, 0
for rel, tl, tc in sorted(seeds):
    res = request('textDocument/prepareCallHierarchy', {'textDocument': {'uri': uri(os.path.join(head, rel))}, 'position': {'line': tl, 'character': tc}})
    requests += 1
    if res:
        k = node_key(res[0])
        if k:
            items[k] = (res[0], 0)
# Breadth first, so each function is expanded at its shortest distance from a seed.
frontier = collections.deque((k, item, d) for k, (item, d) in items.items())
seen = set()
while frontier:
    k, item, d = frontier.popleft()
    if k in seen:
        continue
    seen.add(k)
    if d >= DEPTH:
        continue
    callees = []
    for call in request('callHierarchy/outgoingCalls', {'item': item}) or []:
        ck = node_key(call['to'])
        if ck:
            callees.append(ck)
            frontier.append((ck, call['to'], d + 1))
    requests += 1
    graph[k] = sorted(set(callees))
json.dump({'depth': DEPTH, 'seeds': sorted(items), 'graph': graph}, open(out_path, 'w'), separators=(',', ':'))
print('call graph:', len(graph), 'functions,', sum(len(v) for v in graph.values()), 'calls,', requests, 'requests in', round(time.time() - t0), 's', flush=True)
proc.kill()
