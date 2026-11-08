// Images and videos from a PR's description, comments and reviews (AK-519), loaded by the main
// process, because the sandboxed renderer has no network. The renderer never names a URL: the
// evidence call registers each media item here and hands the renderer an opaque id.
// - Images: `image(id)` fetches once and returns a data: URL. Kept in memory only (no disk cache),
//   at most MAX_BYTES in all, oldest out.
// - Videos: `since-media://video/<id>` streams from GitHub on demand (Range requests pass
//   through) and is never stored.
// The `gh` token goes only to the PR's own GitHub host, never to the hosts it redirects to.

import crypto from 'node:crypto';

interface MediaItem { url: string; kind: string; host: string }
/** Looks up the `gh` token for a GitHub host; '' when there is none. */
export type TokenFor = (host: string) => string | Promise<string>;

export const SCHEME = 'since-media';
export const MAX_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_ITEMS = 2000;
const MAX_REDIRECTS = 5;
const TIMEOUT = 30_000;

// Where media may come from: the GitHub host and its subdomains; for github.com also
// githubusercontent.com (user-images, private-user-images). Redirects may also land on Amazon S3,
// where GitHub keeps uploaded assets.
export function allowedHost(hostname: string, host: string, redirect = false): boolean {
  const h = hostname.toLowerCase();
  if (h === host || h.endsWith(`.${host}`)) return true;
  if (host === 'github.com' && (h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com'))) return true;
  return redirect && h.endsWith('.amazonaws.com');
}

export function createMedia({ token, fetchImpl = (input, init) => fetch(input, init) }: { token?: TokenFor; fetchImpl?: typeof fetch } = {}) {
  const items = new Map<string, MediaItem>(); // id -> { url, kind, host }
  const images = new Map<string, string>(); // id -> data: URL, oldest first
  const tokens = new Map<string, Promise<string>>(); // host -> Promise<token | ''>
  let bytes = 0;

  // Adds an id to each media item of a PR on `host`; items from other hosts are dropped.
  function register<M extends { url: string; kind: string }>(list: readonly M[] | null | undefined, host: string): (M & { id: string })[] {
    const out: (M & { id: string })[] = [];
    for (const m of list || []) {
      let u: URL;
      try { u = new URL(m.url); } catch { continue; }
      if (u.protocol !== 'https:' || !allowedHost(u.hostname, host)) continue;
      const id = crypto.createHash('sha256').update(`${host}\n${m.url}`).digest('hex').slice(0, 32);
      items.delete(id);
      items.set(id, { url: m.url, kind: m.kind, host });
      out.push({ ...m, id });
    }
    while (items.size > MAX_ITEMS) { const oldest = items.keys().next(); if (oldest.done) break; items.delete(oldest.value); }
    return out;
  }

  const authFor = (host: string): Promise<string> => {
    if (!tokens.has(host)) tokens.set(host, Promise.resolve().then(() => (token ? token(host) : '')).catch(() => ''));
    return tokens.get(host) ?? Promise.resolve('');
  };

  // GET with redirects followed by hand, so the token is only sent to the GitHub host itself and
  // every hop is checked against allowedHost.
  async function get(item: MediaItem, headers: Record<string, string> = {}, signal?: AbortSignal | null): Promise<Response> {
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
  async function image(id: string): Promise<string> {
    const cached = images.get(id);
    if (cached) { images.delete(id); images.set(id, cached); return cached; }
    const item = items.get(id);
    if (!item || item.kind !== 'image') throw new Error('Unknown image.');
    const res = await get(item, { Accept: 'image/*' });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const type = (String(res.headers.get('content-type') || '').split(';')[0] ?? '').trim().toLowerCase();
    if (!/^image\/[\w.+-]+$/.test(type)) throw new Error('Not an image.');
    if (Number(res.headers.get('content-length')) > MAX_IMAGE) throw new Error('Image is too large.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE) throw new Error('Image is too large.');
    const data = `data:${type};base64,${buf.toString('base64')}`;
    // Two loads of the same id can overlap; count the bytes of the one kept, not both.
    if (images.has(id)) bytes -= (images.get(id) ?? '').length;
    images.delete(id);
    images.set(id, data);
    bytes += data.length;
    while (bytes > MAX_BYTES && images.size) {
      const first = images.entries().next();
      if (first.done) break;
      const [oldest, v] = first.value;
      images.delete(oldest);
      bytes -= v.length;
    }
    return data;
  }

  // protocol.handle(SCHEME) handler: since-media://video/<id> → GitHub's response body, streamed.
  async function video(request: Request): Promise<Response> {
    const m = /^since-media:\/\/video\/([0-9a-f]{32})$/.exec(request.url);
    const item = m && items.get(m[1] ?? '');
    if (!item || item.kind !== 'video') return new Response(null, { status: 404 });
    const range = request.headers.get('range');
    try {
      const res = await get(item, range ? { Range: range } : {}, request.signal);
      const headers: Record<string, string> = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const val = res.headers.get(h); if (val) headers[h] = val; }
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response(null, { status: 502 });
    }
  }

  const stats = () => ({ items: items.size, images: images.size, bytes });
  return { register, image, video, stats };
}

