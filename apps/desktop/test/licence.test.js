'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const COPYRIGHT = 'Copyright (C) 2026 0xa3k5 and Since contributors';

test('the repo carries the GPLv3 text', () => {
  assert.match(read('LICENSE'), /^\s+GNU GENERAL PUBLIC LICENSE\n\s+Version 3, 29 June 2007/);
});

test('every package declares GPL-3.0-or-later', () => {
  for (const p of ['package.json', 'apps/desktop/package.json', 'apps/desktop/renderer/package.json', 'apps/web/package.json', 'packages/tokens/package.json']) {
    assert.strictEqual(JSON.parse(read(p)).license, 'GPL-3.0-or-later', p);
  }
});

test('the app bundle and the About panel carry the same copyright line', () => {
  assert.ok(read('apps/desktop/electron-builder.config.js').includes(`copyright: '${COPYRIGHT}'`));
  assert.ok(read('apps/desktop/main.js').includes(`copyright: '${COPYRIGHT}'`));
  assert.ok(read('apps/web/src/config.ts').includes(`COPYRIGHT = '${COPYRIGHT}'`));
});
