// One-off during the migration: point require('./x') at x.ts (or x/index.ts) once x.js is gone.
const fs = require('fs'), path = require('path');
let n = 0;
for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f, 'utf8');
  const t = s.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g, (all, q, rel) => {
    const base = path.resolve(path.dirname(f), rel);
    if (/\.(js|ts|json)$/.test(rel) && fs.existsSync(base)) return all;
    if (/\.js$/.test(rel) && fs.existsSync(base.slice(0, -3) + '.ts')) { n++; return `require(${q}${rel.slice(0, -3)}.ts${q})`; }
    if (fs.existsSync(base + '.js') || (fs.existsSync(base) && fs.existsSync(path.join(base, 'index.js')))) return all;
    if (fs.existsSync(base + '.ts')) { n++; return `require(${q}${rel}.ts${q})`; }
    if (fs.existsSync(path.join(base, 'index.ts'))) { n++; return `require(${q}${rel}/index.ts${q})`; }
    return all;
  });
  if (t !== s) fs.writeFileSync(f, t);
}
console.log(`fixed ${n} requires`);
