// Fails the build if any internal link or asset in dist/ points at a file that doesn't exist.
// External links are not fetched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const exists = (p) => fs.existsSync(p) && fs.statSync(p).isFile();

function resolves(url) {
  const clean = decodeURI(url.split(/[?#]/)[0]);
  if (clean === '' ) return true;
  const target = path.join(dist, clean);
  return exists(target) || exists(target + '.html') || exists(path.join(target, 'index.html'));
}

const broken = [];
const pages = walk(dist).filter((f) => f.endsWith('.html'));
for (const page of pages) {
  const html = fs.readFileSync(page, 'utf8');
  for (const [, url] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    if (!url.startsWith('/') || url.startsWith('//')) continue;
    if (!resolves(url)) broken.push(`${path.relative(dist, page)} → ${url}`);
  }
}

if (broken.length) {
  console.error(`Broken internal links (${broken.length}):\n  ${broken.join('\n  ')}`);
  process.exit(1);
}
console.log(`Link check: ${pages.length} pages, no broken internal links.`);
