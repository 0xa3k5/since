'use strict';
// Real avatars for PR authors. The renderer can't load remote images (its CSP allows only 'self'
// and data:), so the main process fetches each author's avatar once (github.avatarImage, through
// `gh`), keeps it on disk per login, and hands the renderer data: URLs. github.com only: bots and
// GitHub Enterprise logins get null, and the renderer keeps their initials.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // refetched after a week, so a changed avatar shows up
const POOL = 4; // `gh` calls at once
// A GitHub user login: letters, digits and single hyphens, at most 39 characters.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const avatarUrl = (host, login) => (host === 'github.com' && LOGIN.test(login || '') ? `https://avatars.githubusercontent.com/${login}?s=64` : null);

// The image type from its first bytes; null for anything that isn't a PNG, JPEG, GIF or WebP.
function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function dataUrl(buf) {
  const type = imageType(buf);
  return type && buf.length <= MAX_BYTES ? `data:${type};base64,${buf.toString('base64')}` : null;
}

// fetchImage(url) → Buffer. Returns get(host, logins) → { [login]: data URL | null }. Each login is
// asked about once per session (a failure stays null until the app restarts); a cached file younger
// than a week answers without the network, and an older one is still used when the refetch fails.
function createAvatars({ dir, fetchImage, maxAge = MAX_AGE, now = Date.now }) {
  const seen = new Map(); // login (lower case) → Promise<data URL | null>
  const file = (login) => path.join(dir, `${login.toLowerCase()}.img`);
  const cached = (login) => { try { return { buf: fs.readFileSync(file(login)), at: fs.statSync(file(login)).mtimeMs }; } catch { return null; } };

  async function one(host, login) {
    const url = avatarUrl(host, login);
    if (!url) return null;
    const hit = cached(login);
    if (hit && now() - hit.at < maxAge) return dataUrl(hit.buf);
    let buf;
    try { buf = await fetchImage(url); } catch { return hit ? dataUrl(hit.buf) : null; }
    const out = dataUrl(buf);
    if (!out) return hit ? dataUrl(hit.buf) : null;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(login), buf); } catch { /* shown this session anyway */ }
    return out;
  }

  return async function get(host, logins) {
    const todo = [...new Set(logins)];
    const out = {};
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const login = todo[next++];
        const key = `${host}/${login.toLowerCase()}`;
        if (!seen.has(key)) seen.set(key, one(host, login));
        out[login] = await seen.get(key);
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker));
    return out;
  };
}

module.exports = { createAvatars, avatarUrl, imageType, dataUrl, MAX_BYTES };
