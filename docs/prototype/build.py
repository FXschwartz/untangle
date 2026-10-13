"""Assembles the prototype page: template + core.js + viewer.js + the exported data."""
import json, sys
d = sys.argv[1]
out = sys.argv[2]
read = lambda p: open(f'{d}/{p}', encoding='utf-8').read()
def js_json(p):
    return json.dumps(json.load(open(f'{d}/{p}')), separators=(',', ':'), ensure_ascii=False).replace('</', '<\\/')
page = read('template.html')
core, viewer = read('core.js'), read('viewer.js')
assert '</script' not in core and '</script' not in viewer
for key, val in (('/*CORE*/', core), ('/*VIEWER*/', viewer), ('/*DIFF*/', js_json('diff.json')), ('/*DEFS*/', js_json('defs_slim.json')), ('/*REFS*/', js_json('refs.json'))):
    assert page.count(key) == 1, key
    page = page.replace(key, val)
open(out, 'w', encoding='utf-8').write(page)
print(out, round(len(page.encode()) / 1024), 'KB')
