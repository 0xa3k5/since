import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const { chromium } = createRequire('/Users/ak/Documents/Repos/gitlanes/package.json')('playwright');
const [dist, ...paths] = process.argv.slice(2);
const server = http.createServer((req, res) => { const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  for (const c of [p, p + '.html', path.join(p, 'index.html')]) { const f = path.join(dist, c); if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res); } }
  res.writeHead(404); res.end(); }).listen(0);
const b = await chromium.launch({ channel: 'chrome' });
for (const w of [1280, 820, 390]) { const pg = await b.newPage({ viewport: { width: w, height: 800 } });
  for (const p of paths) { await pg.goto(`http://localhost:${server.address().port}${p}`); const r = await pg.evaluate(() => [document.documentElement.scrollWidth, innerWidth, [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('pre,.header-nav,table')).slice(0, 6).map((e) => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right)).join(' | ')]);
    if (r[0] > r[1] || r[2]) console.log(w, p, r.join(' '));
  } await pg.close(); }
await b.close(); server.close(); console.log('done');
