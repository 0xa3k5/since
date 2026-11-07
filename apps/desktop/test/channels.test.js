'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GIT, APP_PREFIX, PUSH } = require('../src/shared/channels');

const src = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');
const mainFiles = fs.readdirSync(path.join(src, 'main'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => `main/${f}`);

test('the preload lets through exactly the shared push channels', () => {
  const preload = read('preload/preload.js');
  const allowed = preload.match(/const allowed = \[([^\]]*)\]/);
  assert.ok(allowed, 'preload.js lists its allowed channels');
  assert.deepEqual([...allowed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), [...PUSH]);
  assert.ok(preload.includes(`ipcRenderer.invoke('${GIT}', method`));
  assert.ok(preload.includes(`ipcRenderer.invoke(\`${APP_PREFIX}\${channel}\``));
});

test('every channel the main process pushes is a shared push channel', () => {
  const used = new Set();
  for (const f of mainFiles) for (const m of read(f).matchAll(/(?:\.send|\bbroadcast)\('([^']+)'/g)) used.add(m[1]);
  assert.ok(used.size >= 5);
  for (const c of used) assert.ok(PUSH.includes(c), `${c} is pushed but not in src/shared/channels.js`);
});

test('every invoke channel the main process handles is git or app:', () => {
  const handled = [...require('./main-source').mainSource().matchAll(/\bhandle\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(handled.length > 20);
  for (const c of handled) assert.ok(c === GIT || c.startsWith(APP_PREFIX), c);
});
