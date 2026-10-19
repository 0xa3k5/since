// Prototype (AK-574). Mirrors ui.js's h()/icon()/toast() so the file opens straight from disk
// (ES modules don't load over file://). Data is what the update feed gives us after an update.
const UPDATE = {
  version: '0.1.0-beta.2',
  from: '0.1.0-beta.1',
  headline: 'Preferences, remotes and a calmer sidebar.',
  highlights: ['Preferences on ⌘,', 'Remotes', 'Resizable Catch up list'],
  changelog: 'https://SITE_URL/changelog#beta-2',
};

const P = {
  sparkle: '<path d="M7 2.5 8.3 6.2 12 7.5 8.3 8.8 7 12.5 5.7 8.8 2 7.5 5.7 6.2z"/><path d="M12.5 10.5v3M11 12h3"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
};
function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
function icon(name, size = 16) {
  const s = h('span.icon');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${P[name]}</svg>`;
  return s;
}

// In the app: api.app('external', u.changelog), then close.
const openChangelog = (close) => () => { window.open(UPDATE.changelog, '_blank'); close(); };
const link = (close) => h('button.toast-link', { onclick: openChangelog(close) }, 'Changelog', icon('external', 12));
const dismiss = (close) => h('button.icon-btn.tiny.toast-close', { 'aria-label': 'Dismiss', title: 'Dismiss', onclick: close }, icon('x', 12));
const badge = (size) => h('span.toast-badge', null, icon('sparkle', size));
const title = () => h('div.toast-title', null, `Updated to GitLanes ${UPDATE.version}`);

const VARIANTS = {
  // A: one line. Title + inline link, no body. Auto-dismisses.
  a: (close) => h('div.toast.updated.compact', { role: 'status' },
    badge(13), h('div.toast-body', null, title()), link(close), dismiss(close)),
  // B: title, the release headline from the feed, the link under it. Stays until dismissed.
  b: (close) => h('div.toast.updated', { role: 'status' },
    badge(14),
    h('div.toast-body', null, title(), h('div.toast-detail', null, UPDATE.headline), link(close)),
    dismiss(close)),
  // C: title, up to three highlight titles, the link. Stays until dismissed.
  c: (close) => h('div.toast.updated', { role: 'status' },
    badge(14),
    h('div.toast-body', null, title(),
      h('ul.toast-notes', null, UPDATE.highlights.slice(0, 3).map((t) => h('li', null, t))),
      link(close)),
    dismiss(close)),
};
const TIMEOUT = { a: 8000, b: 0, c: 0 };

function play(v) {
  const root = document.getElementById('toasts');
  let timer;
  const close = () => { clearTimeout(timer); el.classList.remove('in'); setTimeout(() => el.remove(), 180); };
  const el = VARIANTS[v](close);
  root.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  if (TIMEOUT[v]) timer = setTimeout(close, TIMEOUT[v]);
}

for (const col of document.querySelectorAll('.proto-col')) {
  const v = col.dataset.variant;
  col.querySelector('.proto-slot').append(VARIANTS[v](() => {}));
}
for (const b of document.querySelectorAll('[data-play]')) b.addEventListener('click', () => play(b.dataset.play));
