'use strict';
// The build transpiles each source on its own (scripts/build.js), and no unit test imports the
// entries, so a file the build can't transpile, or an entry pointing at a file that isn't there,
// would pass `pnpm test` and open a blank window (AK-250).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const src = path.join(__dirname, '..', 'src');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(src);
const rel = (f) => path.relative(src, f);

test('every TypeScript source transpiles on its own, with the options the build uses', () => {
  const failed = [];
  for (const file of files.filter((f) => f.endsWith('.ts'))) {
    const esm = rel(file).startsWith(`renderer${path.sep}`);
    try {
      esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: esm ? 'esm' : 'cjs', target: 'esnext', sourcefile: rel(file), tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } } });
    } catch (e) {
      failed.push(`${rel(file)}: ${e.message.split('\n')[0]}`);
    }
  }
  assert.deepEqual(failed, []);
});

test('src has no plain JavaScript left: sources are TypeScript', () => {
  assert.deepEqual(files.filter((f) => /\.[cm]?js$/.test(f)).map(rel), []);
});

test('every script a page loads, and the preload, has a TypeScript source', () => {
  for (const html of files.filter((f) => f.endsWith('.html'))) {
    for (const [, script] of fs.readFileSync(html, 'utf8').matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
      const source = path.join(path.dirname(html), script.replace(/\.js$/, '.ts'));
      assert.ok(fs.existsSync(source), `${rel(html)} loads ${script}, but ${rel(source)} is missing`);
    }
  }
  assert.ok(fs.existsSync(path.join(src, 'preload', 'preload.ts')), 'preload/preload.ts is missing');
});
