'use strict';
// The shared tokens must stay in step with the desktop app, which keeps its own copy in
// renderer/styles.css so the renderer stays buildless. Contrast and lane checks live in
// apps/desktop/test/theme.test.js and therefore cover these values too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { render, read } = require('../build.js');

const tokens = read();

test('tokens.css is generated from tokens.json', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'tokens.css'), 'utf8');
  assert.equal(css, render(tokens), 'run `pnpm --filter @gitlanes/tokens build`');
});

test('light and dark define the same tokens', () => {
  assert.deepEqual(Object.keys(tokens.dark).sort(), Object.keys(tokens.light).sort());
});

test('desktop styles.css uses the same values', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'apps', 'desktop', 'renderer', 'styles.css'), 'utf8');
  const block = (from) => {
    const start = css.indexOf('{', css.indexOf(from)) + 1;
    let depth = 1, i = start;
    while (depth) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; i++; }
    return Object.fromEntries([...css.slice(start, i - 1).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const light = block(':root');
  const dark = { ...light, ...block('@media (prefers-color-scheme: dark)') };
  for (const [k, v] of Object.entries({ ...tokens.shared, ...tokens.light })) assert.equal(light[k], v, `light --${k}`);
  for (const [k, v] of Object.entries({ ...tokens.shared, ...tokens.dark })) assert.equal(dark[k], v, `dark --${k}`);
});
