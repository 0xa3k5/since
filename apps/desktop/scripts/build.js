'use strict';
// Builds the app into out/, which is what Electron runs and electron-builder packages. esbuild
// transpiles each .ts file under src/ on its own: types are stripped and nothing is bundled.
// Every other file (plain .js, HTML, CSS, images) is copied. Relative imports that name a .ts
// file are rewritten to the .js file built next to it.
//
//   node scripts/build.js            clean build
//   node scripts/build.js --dev      clean build with inline source maps
//   node scripts/build.js --watch    clean build with source maps, then rebuild each file that changes
//   node scripts/build.js --out DIR  build into DIR instead of out/
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'out');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

// Type declarations and tsconfig files only matter to `tsc`; dotfiles (.DS_Store) to nobody.
const skipped = (rel) => rel.endsWith('.d.ts') || path.basename(rel).startsWith('.') || path.basename(rel).startsWith('tsconfig');
const target = (rel) => path.join(OUT, rel.replace(/\.ts$/, '.js'));

// `./x.ts` → `./x.js` in import, export … from, import() and require().
const TS_SPECIFIER = /(\b(?:from|import|require)\s*\(?\s*)(['"])(\.\.?\/[^'"\n]+?)\.ts\2/g;
const rewrite = (code) => code.replace(TS_SPECIFIER, '$1$2$3.js$2');

function buildFile(rel) {
  if (skipped(rel)) return;
  const from = path.join(SRC, rel);
  const to = target(rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (rel.endsWith('.js')) return fs.writeFileSync(to, rewrite(fs.readFileSync(from, 'utf8')));
  if (!rel.endsWith('.ts')) return fs.copyFileSync(from, to);
  // The renderer loads ES modules. The main process and the sandboxed preload run CommonJS,
  // where `import.meta.dirname` is `__dirname`.
  const esm = rel.startsWith(`renderer${path.sep}`);
  const { code } = esbuild.transformSync(fs.readFileSync(from, 'utf8'), {
    loader: 'ts',
    format: esm ? 'esm' : 'cjs',
    target: 'esnext',
    sourcefile: rel,
    sourcemap: dev ? 'inline' : false,
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    define: esm ? {} : { 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' },
  });
  fs.writeFileSync(to, rewrite(code));
}

function buildAll() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const files = fs.readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(SRC, path.join(e.parentPath, e.name)));
  for (const rel of files) buildFile(rel);
  return files.length;
}

const started = Date.now();
const count = buildAll();
console.log(`built ${count} files into ${path.relative(ROOT, OUT) || '.'} in ${Date.now() - started} ms`);

if (watch) {
  fs.watch(SRC, { recursive: true }, (_event, rel) => {
    if (!rel || skipped(rel)) return;
    try {
      const from = path.join(SRC, rel);
      if (!fs.existsSync(from)) fs.rmSync(target(rel), { recursive: true, force: true });
      else if (fs.statSync(from).isFile()) buildFile(rel);
      else return;
      console.log(`rebuilt ${rel}`);
    } catch (e) { console.error(e.message); }
  });
  console.log('watching src/ for changes');
}
