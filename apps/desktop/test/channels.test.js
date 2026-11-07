'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GIT, APP_PREFIX, PUSH } = require('../src/shared/channels.ts');

const src = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');
const mainFiles = fs.readdirSync(path.join(src, 'main'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => `main/${f}`);

test('the preload lets through exactly the shared push channels', () => {
  const preload = read('preload/preload.ts');
  const allowed = preload.match(/const allowed[^=]*= \[([^\]]*)\]/);
  assert.ok(allowed, 'preload.ts lists its allowed channels');
  assert.deepEqual([...allowed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]), [...PUSH]);
  assert.ok(preload.includes(`ipcRenderer.invoke('${GIT}', method`));
  assert.ok(preload.includes(`ipcRenderer.invoke(\`${APP_PREFIX}\${channel}\``));
});

test('every channel the main process pushes is a shared push channel', () => {
  const used = new Set();
  for (const f of mainFiles) for (const m of read(f).matchAll(/(?:\.send|\bbroadcast)\('([^']+)'/g)) used.add(m[1]);
  assert.ok(used.size >= 5);
  for (const c of used) assert.ok(PUSH.includes(c), `${c} is pushed but not in src/shared/channels.ts`);
});

test('every invoke channel the main process handles is git or app:', () => {
  const handled = [...require('./main-source').mainSource().matchAll(/\bhandle\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(handled.length > 20);
  for (const c of handled) assert.ok(c === GIT || c.startsWith(APP_PREFIX), c);
});

test('the git methods in the contract are exactly the ones ipc.js checks', () => {
  const { GIT_METHODS } = require('../src/shared/channels.ts');
  const { gitSchemas } = require('../src/main/ipc.ts');
  assert.deepEqual([...GIT_METHODS].sort(), Object.keys(gitSchemas).sort());
});

test('the app channels in the contract are exactly the ones the main process handles', () => {
  const { APP_CHANNELS } = require('../src/shared/channels.ts');
  const handled = new Set([...require('./main-source').mainSource().matchAll(/\bhandle\('app:([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...APP_CHANNELS].sort(), [...handled].sort());
});

test('every app call and git call in the renderer is in the contract', () => {
  const { APP_CHANNELS, GIT_METHODS } = require('../src/shared/channels.ts');
  const renderer = fs.readdirSync(path.join(src, 'renderer'), { recursive: true }).filter((f) => /\.(js|ts)$/.test(f)).map((f) => read(`renderer/${f}`)).join('\n');
  const apps = [...renderer.matchAll(/\bapi\.app\('([^']+)'/g)].map((m) => m[1]);
  const gits = [...renderer.matchAll(/\bapi\.git\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(apps.length > 100);
  for (const c of apps) assert.ok(APP_CHANNELS.includes(c), `api.app('${c}') is not in src/shared/channels.ts`);
  for (const m of gits) assert.ok(GIT_METHODS.includes(m), `api.git('${m}') is not in src/shared/channels.ts`);
});

test('handle() refuses a channel that is not in the contract', () => {
  const source = read('main/handlers/handle.ts');
  assert.match(source, /APP_CHANNELS as readonly string\[\]\)\.includes\(channel\.slice\(APP_PREFIX\.length\)\)/);
  assert.match(source, /if \(!known\) throw/);
});
