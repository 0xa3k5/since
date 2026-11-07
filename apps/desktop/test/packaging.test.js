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
  assert.strictEqual(config.appId, 'com.gitsince.app');
  for (const file of [config.mac.icon, config.mac.entitlements, config.mac.entitlementsInherit, config.dmg.background]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
  }
  for (const t of config.mac.target) assert.deepStrictEqual(t.arch.sort(), ['arm64', 'x64'], t.target);
  assert.deepStrictEqual(config.mac.target.map((t) => t.target), ['dmg', 'zip']);
});

test('packaged files are only what the app loads at runtime', () => {
  assert.deepStrictEqual(config.files, ['out/**', 'package.json']);
  const pkg = require('../package.json');
  assert.deepStrictEqual(Object.keys(pkg.dependencies || {}), [], 'the app has no runtime dependencies');
});

test('packaging bakes no update channel and refuses an old beta build command', () => {
  const saved = process.env.SINCE_CHANNEL;
  const load = (v) => {
    if (v === undefined) delete process.env.SINCE_CHANNEL; else process.env.SINCE_CHANNEL = v;
    delete require.cache[require.resolve('../electron-builder.config.js')];
    return require('../electron-builder.config.js');
  };
  try {
    assert.deepStrictEqual(load(undefined).extraMetadata, {});
    assert.deepStrictEqual(load('release').extraMetadata, {});
    for (const name of ['beta', 'sandbox']) assert.throws(() => load(name), new RegExp(`SINCE_CHANNEL=${name} can't be packaged`));
  } finally {
    if (saved === undefined) delete process.env.SINCE_CHANNEL; else process.env.SINCE_CHANNEL = saved;
    delete require.cache[require.resolve('../electron-builder.config.js')];
  }
});

test('packaging bakes SINCE_VERSION and refuses anything that is not package.json\'s version or a pre-release of it', () => {
  const base = require('../package.json').version;
  const saved = process.env.SINCE_VERSION;
  const load = (v) => {
    if (v === undefined) delete process.env.SINCE_VERSION; else process.env.SINCE_VERSION = v;
    delete require.cache[require.resolve('../electron-builder.config.js')];
    return require('../electron-builder.config.js');
  };
  try {
    assert.strictEqual(load(undefined).extraMetadata.version, undefined, 'unset: package.json decides');
    assert.strictEqual(load('').extraMetadata.version, undefined, 'CI passes unset values as empty strings');
    assert.strictEqual(load(`${base}-beta.2`).extraMetadata.version, `${base}-beta.2`);
    assert.strictEqual(load(`${base}-rc.1`).extraMetadata.version, `${base}-rc.1`);
    assert.strictEqual(load(base).extraMetadata.version, base);
    assert.throws(() => load(`-- -c.extraMetadata.version=${base}-beta.2`), /SINCE_VERSION=.* is not a version/);
    assert.throws(() => load('beta.2'), /is not a version/);
    assert.throws(() => load(`v${base}-beta.2`), /is not a version/);
    assert.throws(() => load('9.9.9-beta.1'), /is not \d+\.\d+\.\d+ or a pre-release of it/);
    assert.throws(() => load(`${base}0-beta.1`), /is not .* or a pre-release of it/);
  } finally {
    if (saved === undefined) delete process.env.SINCE_VERSION; else process.env.SINCE_VERSION = saved;
    delete require.cache[require.resolve('../electron-builder.config.js')];
  }
});

test('every module the main process requires is packaged', () => {
  // Follow local require()s from main.js; a missing file only shows up as a crash in the DMG.
  // bench/ is dev-only (behind SINCE_BENCH) and never packaged.
  const seen = new Set();
  const resolve = (from, rel) => {
    const p = path.join(path.dirname(from), rel);
    if (fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isDirectory()) return path.join(p, 'index.js');
    return /\.(js|ts|json)$/.test(p) ? p : `${p}.js`;
  };
  const visit = (file) => {
    if (seen.has(file) || file.startsWith('bench/') || file.endsWith('.json')) return;
    seen.add(file);
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, rel] of src.matchAll(/(?:require\(|\bfrom |^import )'(\.\.?\/[^']+)'/gm)) visit(resolve(file, rel));
  };
  visit('src/main/main.js');
  visit('src/preload/preload.ts');
  // What runs is the build of src/ in out/ (scripts/build.js), with .ts files built to .js.
  const built = (file) => file.replace(/^src\//, 'out/').replace(/\.ts$/, '.js');
  const packaged = (file) => config.files.some((f) => f === built(file) || (f.endsWith('/**') && built(file).startsWith(f.slice(0, -2))));
  assert.ok(seen.has('src/main/ipc.js') && seen.has('src/main/updater.js') && seen.has('src/shared/channels.ts') && seen.has('src/main/git/run.ts'));
  assert.equal(require('../package.json').main, 'out/main/main.js');
  for (const file of seen) assert.ok(packaged(file), `${file} is required at runtime but not packaged`);
});

test('the main process opens no connections of its own, apart from updates', () => {
  // git and gh make their own requests; Since only spawns them. Only updater.js may request
  // anything, and it's listed in docs/security.md.
  const files = ['src/main', 'src/preload', 'src/shared'].flatMap((d) => fs.readdirSync(path.join(root, d), { recursive: true }).filter((f) => /\.(js|ts)$/.test(f)).map((f) => path.join(d, f)));
  assert.ok(files.includes('src/main/updater.js') && files.includes('src/main/git/run.ts'));
  const banned = /require\(['"](node:)?(http|https|http2|net|tls|dns|dgram)['"]\)|\bnet\b[^;]*require\(['"]electron['"]\)/;
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), banned, file);
  for (const file of [...files.filter((f) => f.startsWith('src/main/git/')), ...['ai.js', 'github.js', 'ipc.js', 'journal.js'].map((f) => `src/main/${f}`)]) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /\bfetch\(|XMLHttpRequest|WebSocket/, file);
  }
});

test('Electron fuses close the run-as-node and asar tampering paths', () => {
  assert.deepStrictEqual(config.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    enableCookieEncryption: true,
  });
  assert.strictEqual(config.asar, true);
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
  for (const file of ['build/icon.svg', 'build/icon-small.svg', 'build/background.svg']) {
    const svg = fs.readFileSync(path.join(root, file), 'utf8').toLowerCase();
    assert.ok(!svg.includes('#5e6ad2') && !svg.includes('#7170ff'), file);
  }
  for (const file of ['build/icon.svg', 'build/icon-small.svg']) assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /#ff6700/i);
});

test('the View menu leaves ⌘R free: no reload role on its default key (AK-362)', () => {
  const main = require('./main-source').mainSource();
  for (const m of main.matchAll(/\{ role: 'reload'[^}]*\}/g)) assert.match(m[0], /accelerator: '(?!CmdOrCtrl\+R')/, m[0]);
  assert.match(main, /app\.isPackaged \? \[\] : \[\{ role: 'reload'/);
});
