'use strict';
// The renderer is buildless: a call to another module's export that isn't imported only fails when
// it runs, as an unhandled rejection nobody sees (AK-577: Remove Worktree… did nothing after a
// restack dropped `menuAnchor` from app.js's import). Every such call must be imported or local.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'renderer');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exportsOf = (src) => [...src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/g)].map((m) => m[1]);

test('renderer modules import every sibling export they call', () => {
  const missing = [];
  for (const f of files) {
    const src = read(f);
    const code = src.replace(/\/\/.*$/gm, '');
    const known = new Set();
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => known.add(n));
    // Declared here: functions, variables, classes, destructured names and parameters.
    for (const m of src.matchAll(/(?:function\*?|const|let|var|class)\s+(\w+)/g)) known.add(m[1]);
    for (const m of src.matchAll(/[{(,]\s*(\w+)\s*(?:=[^,)}]*)?(?=[,)}])/g)) known.add(m[1]);
    for (const g of files) {
      if (g === f) continue;
      for (const n of exportsOf(read(g))) {
        if (!known.has(n) && new RegExp(`(^|[^.\\w$])${n}\\s*\\(`).test(code)) missing.push(`${f} calls ${n} (${g}) without importing it`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
