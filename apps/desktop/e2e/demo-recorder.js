'use strict';
// Helpers for the launch videos (demo-video.capture.js): a frame recorder on Chromium's screencast,
// the captions, pressed keys and end card drawn inside the window (capture only, never shipped),
// and the ffmpeg encodes. ffmpeg here has no drawtext, so nothing is composited afterwards.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FFMPEG = process.env.FFMPEG || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((f) => fs.existsSync(f)) || 'ffmpeg';
const QUALITY = 92;
const MB = 1024 * 1024;

// Records the window as JPEG frames at the display's scale (the screencast sends one each time the
// page repaints). Starts paused. pause()/resume() cut waits a viewer shouldn't sit through (loading,
// GitHub round trips): the paused time is dropped and the video picks up wherever the screen is.
async function record(page, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let paused = true;
  let pausedAt = Date.now() / 1000;
  let offset = 0;
  let n = 0;
  const push = (data, t) => {
    const file = path.join(dir, `f${String(n++).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: t - offset });
  };
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const now = Date.now() / 1000;
    // The frame's own swap time when it's on the same clock, else when it arrived.
    if (!paused) push(data, Math.abs((metadata.timestamp || 0) - now) < 2 ? metadata.timestamp : now);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, everyNthFrame: 1 });
  return {
    async resume() {
      if (!paused) return;
      // The screencast only sends repaints: take the screen as it is now.
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY });
      const now = Date.now() / 1000;
      offset += now - pausedAt;
      paused = false;
      push(data, now);
    },
    pause() {
      if (paused) return;
      paused = true;
      pausedAt = Date.now() / 1000;
    },
    async stop() {
      const end = (paused ? pausedAt : Date.now() / 1000) - offset;
      paused = true;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
      frames.sort((a, b) => a.t - b.t);
      return { frames, seconds: end - frames[0].t, end };
    },
  };
}

// Draws the caption, the pressed keys and the end card on top of the app. CSSOM only: the app's
// CSP blocks inline style attributes.
function overlay(page) {
  return page.evaluate(() => {
    const el = (tag, style, text) => { const e = document.createElement(tag); Object.assign(e.style, style); if (text) e.textContent = text; return e; };
    const font = getComputedStyle(document.body).fontFamily;
    const pill = { background: 'rgba(18, 18, 20, 0.9)', color: '#f4f4f5', fontFamily: font, fontWeight: '500', boxShadow: '0 10px 32px rgba(0, 0, 0, 0.28)', border: '1px solid rgba(255, 255, 255, 0.1)' };
    const root = el('div', { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
    const keys = el('div', { position: 'absolute', left: '0', right: '0', bottom: '112px', display: 'flex', justifyContent: 'center', gap: '8px' });
    const caption = el('div', { ...pill, position: 'absolute', left: '50%', bottom: '44px', transform: 'translate(-50%, 8px)', opacity: '0', fontSize: '25px', letterSpacing: '-0.01em', padding: '13px 24px', borderRadius: '14px', whiteSpace: 'nowrap', transition: 'opacity 220ms ease, transform 220ms ease' });
    root.append(keys, caption);
    document.documentElement.append(root);
    window.__demo = {
      caption(text) {
        if (!text) { caption.style.opacity = '0'; caption.style.transform = 'translate(-50%, 8px)'; return; }
        caption.textContent = text;
        caption.style.opacity = '1';
        caption.style.transform = 'translate(-50%, 0)';
      },
      key(label) {
        const k = el('div', { ...pill, minWidth: '44px', height: '44px', padding: '0 14px', borderRadius: '11px', fontSize: '22px', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 260ms ease' }, label);
        keys.append(k);
        while (keys.children.length > 6) keys.firstChild.remove();
        setTimeout(() => { k.style.opacity = '0'; setTimeout(() => k.remove(), 300); }, 1500);
      },
      end({ svg, title, line }) {
        window.__demo.caption(null);
        keys.replaceChildren();
        const bg = [document.body, document.documentElement].map((e) => getComputedStyle(e).backgroundColor).find((c) => c && c !== 'rgba(0, 0, 0, 0)')
          || (matchMedia('(prefers-color-scheme: dark)').matches ? '#141414' : '#fafafa');
        const card = el('div', { position: 'absolute', inset: '0', background: bg, color: getComputedStyle(document.body).color, fontFamily: font, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '18px', opacity: '0', transition: 'opacity 450ms ease' });
        const logo = el('div', { width: '148px', height: '148px' });
        logo.innerHTML = svg;
        Object.assign(logo.firstElementChild.style, { width: '100%', height: '100%' });
        card.append(logo, el('div', { fontSize: '60px', fontWeight: '500', letterSpacing: '-0.02em', marginTop: '6px' }, title), el('div', { fontSize: '26px', opacity: '0.62' }, line));
        root.append(card);
        requestAnimationFrame(() => { card.style.opacity = '1'; });
      },
    };
  });
}

// Playwright key names → what the keys overlay shows.
const GLYPHS = { Meta: '⌘', Alt: '⌥', Shift: '⇧', Control: '⌃', Enter: '↵', Escape: 'esc', ArrowDown: '↓', ArrowUp: '↑', ArrowLeft: '←', ArrowRight: '→', Backspace: '⌫', PageDown: 'page down', PageUp: 'page up', End: 'end', Home: 'home', Space: 'space', Tab: '⇥' };
const glyph = (key) => key.split('+').map((k) => GLYPHS[k] || (/^Digit\d$/.test(k) ? k.slice(5) : k.toUpperCase())).join('');

// An ffconcat list that shows each frame until the next one (the last until `end`).
function frameList({ frames, end }, dir) {
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, (frames[i + 1]?.t ?? end) - f.t).toFixed(4)}`));
  lines.push(`file '${frames.at(-1).file}'`);
  const list = path.join(dir, 'frames.ffconcat');
  fs.writeFileSync(list, `${lines.join('\n')}\n`);
  return list;
}

// Encodes the recording: mp4 (H.264) and webm (VP9) at `width`, a GIF at `gifWidth` with a palette
// pass. Each steps its quality down until it fits its size cap. → { file: bytes }
function encode(rec, dir, { mp4, webm, gif, width = 1920, gifWidth = 900, maxVideo = 8 * MB, maxGif = 5 * MB }) {
  const list = frameList(rec, dir);
  const ff = (...args) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  const size = (f) => fs.statSync(f).size;
  const fit = (file, max, tries, run) => { for (const t of tries) { run(t); if (size(file) <= max) break; } return size(file); };
  const scale = `scale=${width}:-2:flags=lanczos`;
  const sizes = {};
  for (const f of [mp4, webm, gif].filter(Boolean)) fs.mkdirSync(path.dirname(f), { recursive: true });
  if (mp4) sizes[mp4] = fit(mp4, maxVideo, [18, 21, 24, 27, 30], (crf) => ff('-vf', `fps=30,${scale},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-movflags', '+faststart', '-an', mp4));
  if (webm) sizes[webm] = fit(webm, maxVideo, [30, 34, 38, 42], (crf) => ff('-vf', `fps=30,${scale},format=yuv420p`, '-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an', webm));
  if (gif) {
    sizes[gif] = fit(gif, maxGif, [[15, 256], [12, 256], [12, 128], [12, 64]], ([fps, colors]) => ff('-vf',
      `fps=${fps},scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=${colors}[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gif));
  }
  return sizes;
}

module.exports = { record, overlay, glyph, encode, MB };
