'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const config = require('../electron-builder.config.js');

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('packaging config points at files that exist', () => {
  assert.strictEqual(config.appId, 'app.gitlanes.desktop');
  for (const file of [config.mac.icon, config.mac.entitlements, config.mac.entitlementsInherit, config.dmg.background]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
  }
  assert.deepStrictEqual(config.mac.target[0].arch.sort(), ['arm64', 'x64']);
});

test('packaged files are only what the app loads at runtime', () => {
  assert.deepStrictEqual(config.files, ['main.js', 'git.js', 'journal.js', 'licence/**', 'preload.js', 'renderer/**', 'package.json']);
  // Every local module main.js requires must be packaged.
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  for (const [, mod] of main.matchAll(/require\('\.\/([\w-]+)/g)) {
    assert.ok(config.files.some((f) => f === `${mod}.js` || f === `${mod}/**`), `${mod} is required by main.js but not packaged`);
  }
  const pkg = require('../package.json');
  assert.deepStrictEqual(Object.keys(pkg.dependencies || {}), [], 'the app has no runtime dependencies');
});

test('packaging bakes production by default and refuses an unfilled or mock store', () => {
  delete require.cache[require.resolve('../electron-builder.config.js')];
  const saved = process.env.GITLANES_STORE;
  try {
    for (const [store, baked] of [[undefined, 'production'], ['sandbox', 'sandbox'], ['mock', 'mock']]) {
      if (store) process.env.GITLANES_STORE = store; else delete process.env.GITLANES_STORE;
      delete require.cache[require.resolve('../electron-builder.config.js')];
      const c = require('../electron-builder.config.js');
      assert.strictEqual(c.extraMetadata.gitlanes.store, baked);
      if (baked === 'sandbox') c.beforePack();
      else assert.throws(() => c.beforePack());
    }
  } finally {
    if (saved === undefined) delete process.env.GITLANES_STORE; else process.env.GITLANES_STORE = saved;
    delete require.cache[require.resolve('../electron-builder.config.js')];
  }
});

test('DMG background reads under both Finder label colours', () => {
  // Finder draws icon labels black in light mode and white in dark mode, on top of our background.
  const svg = fs.readFileSync(path.join(root, 'build/background.svg'), 'utf8');
  const gradient = svg.match(/<radialGradient id="bg"[\s\S]*?<\/radialGradient>/)[0];
  const stops = [...gradient.matchAll(/stop-color="(#[0-9a-f]{6})"/gi)].map((m) => m[1]);
  assert.ok(stops.length >= 2);
  for (const stop of stops) {
    assert.ok(contrast(stop, '#000000') >= 4, `${stop} vs black labels: ${contrast(stop, '#000000').toFixed(2)}`);
    assert.ok(contrast(stop, '#ffffff') >= 4, `${stop} vs white labels: ${contrast(stop, '#ffffff').toFixed(2)}`);
  }
});

test('brand assets use the orange brand, not the retired indigo', () => {
  for (const file of ['build/icon.svg', 'build/background.svg']) {
    const svg = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase();
    assert.ok(!svg.includes('#5e6ad2') && !svg.includes('#7170ff'), file);
  }
  assert.match(fs.readFileSync(path.join(root, 'build/icon.svg'), 'utf8'), /#ff6a1a/i);
});
