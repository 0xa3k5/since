'use strict';
// Images and videos from a PR's description, comments and reviews (AK-519), loaded by the main
// process, because the sandboxed renderer has no network. The renderer never names a URL: the
// evidence call registers each media item here and hands the renderer an opaque id.
// - Images: `image(id)` fetches once and returns a data: URL. Kept in memory only (no disk cache),
//   at most MAX_BYTES in all, oldest out.
// - Videos: `gitlanes-media://video/<id>` streams from GitHub on demand (Range requests pass
//   through) and is never stored.
// The `gh` token goes only to the PR's own GitHub host, never to the hosts it redirects to.

const crypto = require('node:crypto');

const SCHEME = 'gitlanes-media';
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_REDIRECTS = 5;
const TIMEOUT = 30_000;

// Where media may come from: the GitHub host and its subdomains; for github.com also
// githubusercontent.com (user-images, private-user-images). Redirects may also land on Amazon S3,
// where GitHub keeps uploaded assets.
function allowedHost(hostname, host, redirect = false) {
  const h = hostname.toLowerCase();
  if (h === host || h.endsWith(`.${host}`)) return true;
  if (host === 'github.com' && (h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com'))) return true;
  return redirect && h.endsWith('.amazonaws.com');
}

function createMedia({ token, fetchImpl = (...a) => fetch(...a) } = {}) {
  const items = new Map(); // id -> { url, kind, host }
  const images = new Map(); // id -> data: URL, oldest first
  const tokens = new Map(); // host -> Promise<token | ''>
  let bytes = 0;

  // Adds an id to each media item of a PR on `host`; items from other hosts are dropped.
  function register(list, host) {
    const out = [];
    for (const m of list || []) {
      let u;
      try { u = new URL(m.url); } catch { continue; }
      if (u.protocol !== 'https:' || !allowedHost(u.hostname, host)) continue;
      const id = crypto.createHash('sha256').update(`${host}\n${m.url}`).digest('hex').slice(0, 32);
      items.delete(id);
      items.set(id, { url: m.url, kind: m.kind, host });
      out.push({ ...m, id });
    }
    while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    return out;
  }

  const authFor = (host) => {
    if (!tokens.has(host)) tokens.set(host, Promise.resolve().then(() => token(host)).catch(() => ''));
    return tokens.get(host);
  };

  // GET with redirects followed by hand, so the token is only sent to the GitHub host itself and
  // every hop is checked against allowedHost.
  async function get(item, headers = {}, signal) {
    let url = item.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !allowedHost(u.hostname, item.host, hop > 0)) throw new Error('Media link points outside GitHub.');
      const auth = u.hostname.toLowerCase() === item.host ? await authFor(item.host) : '';
      const res = await fetchImpl(url, {
        redirect: 'manual',
        signal: signal || AbortSignal.timeout(TIMEOUT),
        headers: { ...headers, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      });
      if (res.status < 300 || res.status >= 400) return res;
      const next = res.headers.get('location');
      if (!next) return res;
      url = new URL(next, url).href;
    }
    throw new Error('Too many redirects.');
  }

  // id → data: URL of the image. Throws for unknown ids, videos, non-images and oversized files.
  async function image(id) {
    const cached = images.get(id);
    if (cached) { images.delete(id); images.set(id, cached); return cached; }
    const item = items.get(id);
    if (!item || item.kind !== 'image') throw new Error('Unknown image.');
    const res = await get(item, { Accept: 'image/*' });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/[\w.+-]+$/.test(type)) throw new Error('Not an image.');
    if (Number(res.headers.get('content-length')) > MAX_IMAGE) throw new Error('Image is too large.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE) throw new Error('Image is too large.');
    const data = `data:${type};base64,${buf.toString('base64')}`;
    images.set(id, data);
    bytes += data.length;
    while (bytes > MAX_BYTES && images.size) {
      const [oldest, v] = images.entries().next().value;
      images.delete(oldest);
      bytes -= v.length;
    }
    return data;
  }

  // protocol.handle(SCHEME) handler: gitlanes-media://video/<id> → GitHub's response body, streamed.
  async function video(request) {
    const m = /^gitlanes-media:\/\/video\/([0-9a-f]{32})$/.exec(request.url);
    const item = m && items.get(m[1]);
    if (!item || item.kind !== 'video') return new Response(null, { status: 404 });
    const range = request.headers.get('range');
    try {
      const res = await get(item, range ? { Range: range } : {}, request.signal);
      const headers = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (res.headers.get(h)) headers[h] = res.headers.get(h);
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response(null, { status: 502 });
    }
  }

  const stats = () => ({ items: items.size, images: images.size, bytes });
  return { register, image, video, stats };
}

module.exports = { SCHEME, MAX_BYTES, MAX_IMAGE, allowedHost, createMedia };
