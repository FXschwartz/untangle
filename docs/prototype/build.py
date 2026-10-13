"""Assembles the v3 page: template + core.js + analyze.js (shown as text) + viewer3.js + data."""
import json, sys
d, out = sys.argv[1], sys.argv[2]
read = lambda p: open(f'{d}/{p}', encoding='utf-8').read()
def js_json(p):
    return json.dumps(json.load(open(f'{d}/{p}')), separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/')
page = read('template.html')
core, viewer, analyze = read('core.js'), read('viewer.js'), read('analyze.js')
for src in (core, viewer, analyze):
    assert '</script' not in src
parts = (('/*CORE*/', core), ('/*ANALYZE*/', analyze.replace('&', '&amp;').replace('<', '&lt;')), ('/*VIEWER*/', viewer),
         ('/*MODEL*/', js_json('model.json')), ('/*DEFS*/', js_json('defs_slim.json')), ('/*REFS*/', js_json('refs.json')), ('/*DEFSOLD*/', js_json('defs_old_slim.json')))
for key, val in parts:
    assert page.count(key) == 1, key
    page = page.replace(key, val)
open(out, 'w', encoding='utf-8').write(page)
print(out, round(len(page.encode()) / 1024), 'KB')
