'use strict';
// Colour-code detector behind the swatches in diffs (renderer/colors.js).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/colors.js');
const values = (find, text, opts) => find(text, opts).map((c) => c.value);

test('finds hex codes of every valid length', async () => {
  const { findColors } = await load();
  assert.deepEqual(values(findColors, 'color: #fff; background: #ffffff80;'), ['#fff', '#ffffff80']);
  assert.deepEqual(values(findColors, 'a{border:1px solid #0a0b0c} b{color:#abcd}'), ['#0a0b0c', '#abcd']);
  assert.deepEqual(values(findColors, "accent: '#ff6a00',"), ['#ff6a00']);
  assert.deepEqual(values(findColors, '--muted: #333;'), ['#333']);
  assert.deepEqual(values(findColors, 'border: 1px solid #333;'), ['#333']);
  assert.deepEqual(values(findColors, 'background: linear-gradient(#fff, #000) }'), ['#fff', '#000']);
  assert.deepEqual(values(findColors, "{ fill: '#bad', stroke: #face !important }"), ['#bad', '#face']);
  assert.deepEqual(values(findColors, 'border: 1px solid #a1b'), ['#a1b']);
});

test('finds colour functions in comma and space syntax', async () => {
  const { findColors } = await load();
  const cases = ['rgb(255, 0, 0)', 'rgba(0,0,0,.5)', 'rgb(0 0 0 / 50%)', 'hsl(20 90% 50%)', 'hsla(20, 90%, 50%, 0.3)',
    'oklch(0.7 0.18 45)', 'oklab(0.6 0.1 0.1)', 'hwb(20 10% 10%)', 'lab(60% 40 50)', 'lch(60% 50 40)', 'color(display-p3 1 0.4 0)'];
  for (const c of cases) assert.deepEqual(values(findColors, `  color: ${c};`), [c], c);
});

test('reports positions so the line text can be split around swatches', async () => {
  const { findColors } = await load();
  const s = 'a: #fff, b: rgb(1 2 3)';
  for (const c of findColors(s)) assert.equal(s.slice(c.start, c.end), c.value);
  assert.deepEqual(findColors(s).map((c) => c.start), [3, 12]);
});

test('ignores hashes, issue refs, URL fragments and preprocessor lines', async () => {
  const { findColors } = await load();
  const none = [
    'commit 21a27fc1f0e9d0aa2b6c', 'Merge abc1234 into main', 'sha=deadbeefcafe', 'fixes #123 and #4567 in prose',
    'See (#123) for details', 'Closes #321: crash on start', 'https://example.com/docs#add', 'https://example.com/page#fade',
    'href="/#bad"', '#define FOO 1', '#ifdef DEBUG', '&#123; entity', '#deadbeef1', 'id #abcde', 'ref ##fff',
    'See [Usage](#add) and [docs](#fade)', '[x](#ffffff)', 'Notes (#fade) here', '// #bad idea, see #cafe or #face',
    'color: red;', 'my-rgb(1, 2, 3)', 'rgb(var(--x))', 'color(srgb 1 0 0)', '',
  ];
  for (const s of none) assert.deepEqual(values(findColors, s), [], s);
});

test('lets the validator reject values and caps swatches per line', async () => {
  const { findColors, MAX_PER_LINE } = await load();
  assert.deepEqual(values(findColors, 'a: rgb(1, 2), b: #fff', { isColor: (v) => v !== 'rgb(1, 2)' }), ['#fff']);
  const many = Array.from({ length: 50 }, () => '#fff;').join(' ');
  assert.equal(findColors(many).length, MAX_PER_LINE);
  assert.equal(findColors(many, { max: 3 }).length, 3);
});
