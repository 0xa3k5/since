// Usage: node capture.mjs <distDir> <outDir> <label> [paths...]
// Serves a static Astro build and saves full-page light + dark captures. Never opens them.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/Users/ak/Documents/Repos/gitlanes/package.json');
const { chromium } = require('playwright');

const [dist, out, label, ...paths] = process.argv.slice(2);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'text/xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const cands = [p, p + '.html', path.join(p, 'index.html')];
  for (const c of cands) {
    const f = path.join(dist, c);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
      return fs.createReadStream(f).pipe(res);
    }
  }
  res.writeHead(404); res.end();
}).listen(0);
const port = server.address().port;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: theme, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  for (const p of paths) {
    await page.goto(`http://localhost:${port}${p}`, { waitUntil: 'networkidle' });
    const name = (p === '/' ? 'home' : p.slice(1).replace(/\//g, '-'));
    await page.screenshot({ path: path.join(out, `${label}-${name}-${theme}.png`), fullPage: true });
  }
  await ctx.close();
}
await browser.close();
server.close();
console.log('captured', paths.length * 2);
