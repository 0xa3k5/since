# One-off during the migration: CommonJS to ES module syntax for one file (renamed to .ts),
# then (old, new) type replacements from a side file.
import re, sys, os, subprocess
src, reps = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)
dst = src[:-3] + '.ts'
subprocess.run(['git', 'mv', src, dst], check=True)
s = open(dst).read()
s = re.sub(r"^'use strict';\n", '', s)
def imp(m):
    names, mod = m.group(1), m.group(2)
    if mod.startswith('.') and not re.search(r'\.(ts|json)$', mod):
        bare = mod[:-3] if mod.endswith('.js') else mod
        base = os.path.normpath(os.path.join(os.path.dirname(dst), bare))
        if os.path.isdir(base) and os.path.exists(base + '/index.ts'): mod = bare + '/index.ts'
        elif os.path.exists(base + '.ts'): mod = bare + '.ts'
        elif not mod.endswith('.js'): mod = bare + '.js'
    if names.startswith('{'):
        names = re.sub(r'(\w+)\s*:\s*(\w+)', r'\1 as \2', names)
        return f"import {names} from '{mod}';"
    if mod.endswith('.json'): return f"import {names} from '{mod}' with {{ type: 'json' }};"
    return f"import {names} from '{mod}';" if not mod.startswith('.') else f"import * as {names} from '{mod}';"
s = re.sub(r"^const (\{[^}]+\}|\w+) = require\('([^']+)'\);", imp, s, flags=re.M)
m = re.search(r"^module\.exports = \{([^}]*)\};\n", s, flags=re.M | re.S)
if m:
    names = m.group(1)
    s = s[:m.start()] + s[m.end():]
    for name in [n.strip() for n in names.replace('\n', ' ').split(',') if n.strip()]:
        if ':' in name: print('aliased export, do by hand:', name); continue
        s, k = re.subn(rf"^(async function|function|const|let|class) {name}\b", rf"export \1 {name}", s, count=1, flags=re.M)
        if not k: print('not found:', name)
if reps:
    for a, b in eval(open(reps).read()):
        if a not in s: print('MISSING:', a[:70]); continue
        s = s.replace(a, b, 1)
open(dst, 'w').write(s)
