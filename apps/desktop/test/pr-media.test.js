'use strict';
// PR media loaded by the main process (pr-media.js, AK-519): ids instead of URLs, the token only
// for the GitHub host, bounded in-memory image cache, videos streamed and never kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMedia, allowedHost, MAX_BYTES } = require('../pr-media');

const fakeFetch = (routes) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization || null, range: init.headers.Range || null, redirect: init.redirect });
    const r = routes(url);
    return new Response(r.body ?? null, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { calls, fetchImpl };
};
const png = (n) => ({ body: Buffer.alloc(n, 1), headers: { 'content-type': 'image/png' } });

test('allowedHost: the GitHub host, its subdomains, githubusercontent.com; S3 only after a redirect', () => {
  assert.ok(allowedHost('github.com', 'github.com'));
  assert.ok(allowedHost('private-user-images.githubusercontent.com', 'github.com'));
  assert.ok(allowedHost('media.ghe.acme.com', 'ghe.acme.com'));
  assert.ok(!allowedHost('githubusercontent.com.evil.com', 'github.com'));
  assert.ok(!allowedHost('example.com', 'github.com'));
  assert.ok(!allowedHost('x.s3.amazonaws.com', 'github.com'));
  assert.ok(allowedHost('x.s3.amazonaws.com', 'github.com', true));
});

test('register drops other hosts; image() sends the token only to the GitHub host and caches in memory', async () => {
  const { calls, fetchImpl } = fakeFetch((url) => (url.startsWith('https://github.com/')
    ? { status: 302, headers: { location: 'https://private-user-images.githubusercontent.com/1/a.png?jwt=x' } }
    : png(10)));
  let asked = 0;
  const media = createMedia({ token: async () => { asked++; return 'gho_secret'; }, fetchImpl });
  const items = media.register([
    { url: 'https://github.com/user-attachments/assets/aaa', kind: 'image' },
    { url: 'https://example.com/tracker.png', kind: 'image' },
  ], 'github.com');
  assert.equal(items.length, 1);
  assert.match(items[0].id, /^[0-9a-f]{32}$/);
  const data = await media.image(items[0].id);
  assert.equal(data, `data:image/png;base64,${Buffer.alloc(10, 1).toString('base64')}`);
  assert.deepEqual(calls.map((c) => [new URL(c.url).hostname, c.auth, c.redirect]), [
    ['github.com', 'Bearer gho_secret', 'manual'],
    ['private-user-images.githubusercontent.com', null, 'manual'],
  ]);
  assert.equal(await media.image(items[0].id), data);
  assert.equal(calls.length, 2, 'served from memory');
  assert.equal(asked, 1);
  await assert.rejects(media.image('f'.repeat(32)), /Unknown image/);
});

test('image(): refuses redirects off GitHub, non-images and oversized files; memory stays bounded', async () => {
  const { fetchImpl } = fakeFetch((url) => {
    if (url.includes('/away')) return { status: 302, headers: { location: 'https://evil.example/x.png' } };
    if (url.includes('/html')) return { body: '<script>', headers: { 'content-type': 'text/html' } };
    if (url.includes('/huge')) return png(11 * 1024 * 1024);
    return png(9 * 1024 * 1024);
  });
  const media = createMedia({ token: async () => '', fetchImpl });
  const [away, html, huge] = media.register(['away', 'html', 'huge'].map((p) => ({ url: `https://github.com/${p}`, kind: 'image' })), 'github.com');
  await assert.rejects(media.image(away.id), /outside GitHub/);
  await assert.rejects(media.image(html.id), /Not an image/);
  await assert.rejects(media.image(huge.id), /too large/);
  const big = media.register(Array.from({ length: 6 }, (_, i) => ({ url: `https://github.com/big${i}`, kind: 'image' })), 'github.com');
  for (const b of big) await media.image(b.id);
  assert.ok(media.stats().bytes <= MAX_BYTES);
  assert.ok(media.stats().images < 6, 'oldest images dropped');
});

test('video(): streams with Range passed through, never cached; unknown ids are 404', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 206, body: 'abc', headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2/10', 'set-cookie': 'x=1' } }));
  const media = createMedia({ token: async () => 'gho_secret', fetchImpl });
  const [v] = media.register([{ url: 'https://github.com/user-attachments/assets/vid', kind: 'video' }], 'github.com');
  const req = new Request(`gitlanes-media://video/${v.id}`, { headers: { range: 'bytes=0-2' } });
  const res = await media.video(req);
  assert.equal(res.status, 206);
  assert.equal(await res.text(), 'abc');
  assert.equal(res.headers.get('content-range'), 'bytes 0-2/10');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual([calls[0].range, calls[0].auth], ['bytes=0-2', 'Bearer gho_secret']);
  await media.video(new Request(`gitlanes-media://video/${v.id}`));
  assert.equal(calls.length, 2, 'fetched again: nothing kept');
  assert.equal(media.stats().images, 0);
  assert.equal((await media.video(new Request(`gitlanes-media://video/${'0'.repeat(32)}`))).status, 404);
  await assert.rejects(media.image(v.id), /Unknown image/);
});
