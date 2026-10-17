'use strict';
// Guards the light/dark design tokens in renderer/styles.css: WCAG contrast, lane-colour
// separation (including simulated colour-vision deficiencies) and no stray hard-coded colours.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.join(__dirname, '..', 'renderer');
const css = fs.readFileSync(path.join(renderer, 'styles.css'), 'utf8');

function block(src, from) {
  const start = src.indexOf('{', src.indexOf(from)) + 1;
  let depth = 1, i = start;
  while (depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
  return { body: src.slice(start, i - 1), end: i };
}
function vars(body) {
  const out = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const lightBlock = block(css, ':root');
const darkMedia = block(css, '@media (prefers-color-scheme: dark)');
const light = vars(lightBlock.body);
const dark = { ...light, ...vars(darkMedia.body) };
const THEMES = { light, dark };

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// Machado et al. (2009) full-severity simulation matrices, applied in linear RGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
function oklab(h, kind) {
  let c = rgb(h).map(lin);
  if (CVD[kind]) c = CVD[kind].map((m) => Math.min(1, Math.max(0, m[0] * c[0] + m[1] * c[1] + m[2] * c[2])));
  const [r, g, b] = c;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const distance = (a, b, kind) => { const x = oklab(a, kind), y = oklab(b, kind); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
const lanes = (t) => Array.from({ length: 10 }, (_, i) => t[`lane-${i}`]);

for (const [name, t] of Object.entries(THEMES)) {
  const surfaces = ['bg', 'bg-content', 'bg-elevated'];
  const atLeast = (fg, min, on = surfaces) => {
    for (const bg of [].concat(on)) {
      const c = contrast(t[fg], t[bg]);
      assert.ok(c >= min, `${name}: --${fg} on --${bg} is ${c.toFixed(2)}:1, needs ${min}:1`);
    }
  };

  test(`${name} theme: text tokens meet WCAG AA`, () => {
    for (const k of ['text', 'text-2', 'text-3', 'accent-fg', 'green', 'merged', 'red', 'warn']) atLeast(k, 4.5);
    atLeast('text-4', 3); // hints, line numbers, placeholders
    atLeast('yellow', 3); // tag icon
  });

  test(`${name} theme: text on accent and danger fills meets WCAG AA`, () => {
    atLeast('accent-text', 4.5, ['accent', 'accent-hover']);
    atLeast('red-text', 4.5, 'red');
  });

  test(`${name} theme: focus ring and accent are visible on every surface`, () => {
    atLeast('focus-ring', 3);
    atLeast('accent', 3, ['bg-content', 'bg-elevated']);
  });

  test(`${name} theme: lanes are visible and distinguishable`, () => {
    const l = lanes(t);
    assert.equal(l[0], t.accent, 'lane 0 is the brand orange');
    for (let i = 0; i < l.length; i++) {
      for (const bg of surfaces) assert.ok(contrast(l[i], t[bg]) >= 3, `${name}: lane ${i} on --${bg}`);
      assert.ok(contrast(t['avatar-text'], l[i]) >= 3, `${name}: avatar initials on lane ${i}`);
    }
    for (let i = 0; i < l.length; i++) {
      for (let j = i + 1; j < l.length; j++) {
        assert.ok(distance(l[i], l[j]) >= 0.1, `${name}: lanes ${i} and ${j} too similar`);
        const neighbours = i === 0 || j === i + 1;
        if (!neighbours) continue;
        for (const kind of Object.keys(CVD)) {
          const min = i === 0 ? 0.09 : 0.06;
          assert.ok(distance(l[i], l[j], kind) >= min, `${name}/${kind}: lanes ${i} and ${j} too similar`);
        }
      }
    }
  });
}

test('both themes define the same tokens', () => {
  const darkOnly = Object.keys(vars(darkMedia.body)).filter((k) => !(k in light));
  assert.deepEqual(darkOnly, []);
});

test('colours outside the token blocks come from tokens', () => {
  const rest = css.slice(darkMedia.end);
  assert.deepEqual(rest.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) || [], []);
  for (const f of ['app.js', 'ui.js', 'graph.js', 'diff.js']) {
    const src = fs.readFileSync(path.join(renderer, f), 'utf8');
    assert.deepEqual(src.match(/['"`]#[0-9a-f]{3,8}['"`]/gi) || [], [], `${f} has hard-coded colours`);
  }
});

test('retired indigo accent is gone', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const files = ['README.md', 'apps/desktop/main.js', 'apps/desktop/README.md', 'apps/desktop/test/theme.test.js', ...fs.readdirSync(renderer).map((f) => `apps/desktop/renderer/${f}`)];
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    // Split so this file doesn't itself contain the retired values.
    const retired = new RegExp(['5e6a' + 'd2', '7170' + 'ff'].join('|'), 'i');
    assert.doesNotMatch(fs.readFileSync(p, 'utf8'), retired, f);
  }
});
