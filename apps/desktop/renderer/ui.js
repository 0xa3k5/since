// Small DOM toolkit: hyperscript, icons, toasts, dialogs, menus, command palette, virtual list.
import * as keymap from './keymap.js';

export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

// --- Icons (16px, 1.5 stroke) ---------------------------------------------
const P = {
  map: '<circle cx="4" cy="4" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="7" r="1.6"/><path d="M4 5.6v4.8M4 7c0 0 0 0 0 0M10.4 7.4C7 8 5 8.2 4 10.4"/>',
  commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>',
  stash: '<path d="M2.5 5.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M1.8 3h12.4v2.5H1.8zM6.5 8.5h3"/>',
  history: '<path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8L2.5 5.9"/><path d="M2.5 2.8v3.1h3.1M8 5.2V8l2 1.4"/>',
  submodule: '<rect x="2" y="2" width="12" height="12" rx="2"/><rect x="5.5" y="5.5" width="5" height="5" rx="1"/>',
  reflog: '<path d="M3 3.5h10M3 8h10M3 12.5h6"/>',
  config: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 5v6M11.5 6.5c0 3-7 2.5-7 4.5"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>',
  cloud: '<path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7 1 2.5 2.5 0 0 1-.3 5z"/>',
  fetch: '<path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13.5h10"/>',
  pull: '<path d="M8 2.5v9M4.5 8 8 11.5 11.5 8"/>',
  push: '<path d="M8 13.5v-9M4.5 8 8 4.5 11.5 8"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  'check-circle': '<circle cx="8" cy="8" r="6.5"/><path d="m5.2 8.2 2 2 3.6-3.8"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  pending: '<circle cx="8" cy="8" r="4.5"/>',
  comment: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
  more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  chevronLeft: '<path d="m10 4-4 4 4 4"/>',
  chevronDown: '<path d="m4 6 4 4 4-4"/>',
  chevronUp: '<path d="m4 10 4-4 4 4"/>',
  undo: '<path d="M5.5 3.5 2.5 6.5l3 3"/><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7"/>',
  redo: '<path d="m10.5 3.5 3 3-3 3"/><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.8 6.2 2 1.8-2 1.8M8.5 10h2.7"/>',
  expand: '<path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.5"/>',
  edit: '<path d="M10.5 2.8 13.2 5.5 6 12.7l-3.2.5.5-3.2z"/>',
  merge: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="9" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 3 4 5.5 4"/>',
  rebase: '<circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><path d="M4.5 11V8.5a2 2 0 0 1 2-2h3a2 2 0 0 0 2-2V5"/>',
  cherry: '<circle cx="5" cy="11" r="2.5"/><circle cx="11" cy="11.5" r="2"/><path d="M5 8.5c.5-3 2.5-5 6-6M11 9.5c0-3-1-5-0-7"/>',
  revert: '<path d="M3.5 5.5h6.5a3 3 0 0 1 0 6H6"/><path d="m6 3-2.5 2.5L6 8"/>',
  squash: '<path d="M8 2v4M5.5 4 8 6.5 10.5 4M8 14v-4M5.5 12 8 9.5l2.5 2.5M3 8h10"/>',
  swap: '<path d="M5 2.5v11M2.5 11 5 13.5 7.5 11M11 13.5v-11M8.5 5 11 2.5 13.5 5"/>',
  checkout: '<path d="M3 8h7.5M7.5 4.5 11 8l-3.5 3.5M13.5 3v10"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  diff: '<path d="M4.5 2v6M1.5 5h6M8.5 11h6M11.5 2.5l-7 11"/>',
  sidebar: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>',
  panelRight: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/>',
  warning: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  file: '<path d="M4 1.8h5l3 3V14H4z"/><path d="M9 1.8v3h3"/>',
  restore: '<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1"/><path d="M2.5 2.5v3h3"/>',
  command: '<path d="M5.5 5.5h5v5h-5z"/><path d="M5.5 5.5H4a1.5 1.5 0 1 1 1.5-1.5zM10.5 5.5V4A1.5 1.5 0 1 1 12 5.5zM10.5 10.5H12a1.5 1.5 0 1 1-1.5 1.5zM5.5 10.5V12A1.5 1.5 0 1 1 4 10.5z"/>',
  split: '<path d="M8 2v12M3 5h3M3 8h3M10 8h3M10 11h3"/>',
  theme: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.8v1.4M8 12.8v1.4M14.2 8h-1.4M3.2 8H1.8M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1"/>',
  moon: '<path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z"/>',
  catchup: '<path d="M4.5 2.5v11"/><circle cx="4.5" cy="5" r="1.4"/><circle cx="4.5" cy="11" r="1.4"/><path d="M8 5h5.5M8 11h5.5"/>',
  lanes: '<path d="M2 4h12M2 8h12M2 12h12"/><circle cx="5" cy="4" r="1.3"/><circle cx="10" cy="8" r="1.3"/><circle cx="7" cy="12" r="1.3"/>',
  worktree: '<rect x="2" y="2.5" width="5.5" height="4" rx="1"/><rect x="8.5" y="9.5" width="5.5" height="4" rx="1"/><path d="M4.75 6.5v3.5a1.5 1.5 0 0 0 1.5 1.5H8.5"/>',
  update: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.6 2.4v2.9h-2.9M8 5.5v5M6 8.6l2 1.9 2-1.9"/>',
  sparkle: '<path d="M7 2.5 8.3 6.2 12 7.5 8.3 8.8 7 12.5 5.7 8.8 2 7.5 5.7 6.2z"/><path d="M12.5 10.5v3M11 12h3"/>',
  key: '<circle cx="5" cy="11" r="2.5"/><path d="m6.8 9.2 6-6M11 5l1.5 1.5"/>',
  checks: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.4M8 10.8v.1"/>',
  sendBack: '<path d="M6 9.5 2.5 6 6 2.5"/><path d="M2.5 6h7a4 4 0 0 1 0 8H7.5"/>',
  github: '<path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>',
};

export function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return span;
}

// --- Formatting --------------------------------------------------------------
const MIN = 60, HOUR = 3600, DAY = 86400;
export function timeAgo(t) {
  const d = Date.now() / 1000 - t;
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d`;
  const date = new Date(t * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
// "2h ago", but "just now" and "Oct 3" as they are.
export const ago = (t) => { const s = timeAgo(t); return /^\d+[mhd]$/.test(s) ? `${s} ago` : s; };
export const fullDate = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function hash(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return Math.abs(x); }
export function avatar(name, email, size = 18) {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return h('span.avatar', { title: `${name} <${email}>`, style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px', background: `var(--lane-${hash(email || name) % 10})` } }, initials);
}

// Overlapping avatars for [{ name, email }], at most `max`, then a +N chip. Who they are is in
// the group's tooltip, one per line (AK-533).
export function avatarStack(people, size = 18, max = 3) {
  const label = (p) => `${p.name} <${p.email}>`;
  const rest = people.slice(max);
  const quiet = (el) => { el.title = ''; return el; };
  return h('span.avatar-stack', { role: 'img', 'aria-label': people.map((p) => p.name).join(' and '), 'data-tip': people.map(label).join('\n') },
    people.slice(0, max).map((p) => quiet(avatar(p.name, p.email, size))),
    rest.length ? h('span.avatar.more', { 'aria-hidden': 'true', style: { height: size + 'px', minWidth: size + 'px', fontSize: Math.round(size * 0.42) + 'px' } }, `+${rest.length}`) : null);
}

// Quiet placeholder for slow loads (huge commits, big diffs). It fades in after a short delay,
// so fast loads never flash it.
export const loading = (label = 'Loading…') => h('div.loading-state', { role: 'status', 'aria-live': 'polite' }, h('span.spinner'), h('span', null, label));

export const kbd = (...keys) => h('span.kbd-group', null, keys.map((k) => h('kbd', null, k)));

// --- Toasts --------------------------------------------------------------------
// `action` is one inline text link (Undo). `actions` is a choice: a row of buttons under the text
// (the first, or any with `primary`, is the primary one) plus a dismiss button; the title stays on one line.
export function toast(message, { kind = 'info', action, actions = [], timeout = 4200, detail } = {}) {
  let root = $('#toasts');
  const run = (a) => () => { a.run(); close(); };
  const choice = actions.length > 0;
  const primary = actions.find((a) => a.primary) || actions[0];
  const el = h('div.toast.' + kind + (choice ? '.choice' : ''), null,
    kind === 'error' ? icon('warning') : kind === 'success' ? icon('check') : kind === 'busy' ? h('span.spinner') : null,
    h('div.toast-body', null, h('div.toast-title', null, message), detail ? h('div.toast-detail', null, detail) : null,
      choice ? h('div.toast-actions', null, actions.map((a) => h('button.btn.small.' + (a === primary ? 'primary' : 'subtle'), { onclick: run(a) }, a.label))) : null),
    action ? h('button.toast-action', { onclick: run(action) }, action.label) : null,
    choice ? h('button.icon-btn.tiny.toast-close', { 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => close() }, icon('x', 12)) : null,
  );
  root.append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  let timer;
  function close() { clearTimeout(timer); el.classList.remove('in'); setTimeout(() => el.remove(), 180); }
  if (timeout) timer = setTimeout(close, kind === 'error' ? timeout * 2 : timeout);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  return { close, update: (m) => { el.querySelector('.toast-title').textContent = m; } };
}

// --- Modal dialogs -------------------------------------------------------------
// `gate` names a checkbox field that must be ticked before submit is enabled ("merge anyway").
export function dialog({ title, description, fields = [], submit = 'Continue', destructive = false, wide = false, gate }) {
  return new Promise((resolve) => {
    const inputs = {};
    const prev = document.activeElement;
    const form = h('form.dialog' + (wide ? '.wide' : ''), {
      onsubmit: (e) => { e.preventDefault(); finish(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]))); },
    },
      h('div.dialog-head', null, h('div.dialog-title', null, title), description ? h('div.dialog-desc', null, description) : null),
      fields.length ? h('div.dialog-body', null, fields.map((f) => {
        if (f.type === 'checkbox') {
          inputs[f.name] = h('input', { type: 'checkbox', checked: !!f.value });
          return h('label.check', null, inputs[f.name], h('span', null, f.label));
        }
        // An extra action inside the sheet (e.g. "Draft with AI"); `run` gets the live inputs.
        if (f.type === 'button') {
          const btn = h('button.btn.ghost', { type: 'button', onclick: async () => { btn.disabled = true; try { await f.run(inputs); } finally { btn.disabled = false; } } }, f.icon ? icon(f.icon) : null, f.label);
          return h('div.field', null, btn);
        }
        if (f.type === 'select') {
          inputs[f.name] = h('select.input', null, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
          return h('label.field', null, f.label ? h('span.field-label', null, f.label) : null, inputs[f.name]);
        }
        inputs[f.name] = f.multiline
          ? h('textarea.input', { rows: f.rows || 6, placeholder: f.placeholder || '', value: f.value || '', spellcheck: false, readonly: f.readonly })
          : h('input.input', { type: 'text', placeholder: f.placeholder || '', value: f.value || '', spellcheck: false, autocomplete: 'off' });
        if (f.multiline) inputs[f.name].addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.submit') form.requestSubmit(); });
        return h('label.field', null, f.label ? h('span.field-label', null, f.label) : null, inputs[f.name]);
      })) : null,
      h('div.dialog-foot', null,
        h('button.btn.ghost', { type: 'button', onclick: () => finish(null) }, 'Cancel', kbd(...keymap.keys('dialog.cancel'))),
        h('button.btn.' + (destructive ? 'danger' : 'primary'), { type: 'submit' }, submit, kbd('↵')),
      ),
    );
    if (gate && inputs[gate]) {
      const btn = form.querySelector('button[type=submit]');
      const sync = () => { btn.disabled = !inputs[gate].checked; };
      inputs[gate].addEventListener('change', sync);
      sync();
    }
    const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) finish(null); } }, form);
    overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); finish(null); } });
    document.body.append(overlay);
    requestAnimationFrame(() => overlay.classList.add('in'));
    const first = Object.values(inputs).find((i) => i.type !== 'checkbox' && i.tagName !== 'SELECT');
    (first || form.querySelector('.btn.primary:not(:disabled), .btn.danger:not(:disabled)') || form.querySelector('.btn.ghost')).focus();
    if (first && first.select && first.tagName === 'INPUT') first.select();
    function finish(v) {
      overlay.classList.remove('in');
      setTimeout(() => overlay.remove(), 120);
      prev?.focus?.();
      resolve(v);
    }
  });
}

export const confirm = (title, description, { submit = 'Confirm', destructive = true } = {}) =>
  dialog({ title, description, submit, destructive }).then((v) => v !== null);

export const prompt = (title, { label, value, placeholder, submit = 'Create', description, multiline } = {}) =>
  dialog({ title, description, submit, fields: [{ name: 'v', label, value, placeholder, multiline }] }).then((v) => (v ? v.v.trim() : null));

// --- Context menu ---------------------------------------------------------------
let openMenu = null;
// `focus`: index of the actionable item highlighted on open, so Enter picks it (a popover's default).
export function contextMenu(x, y, items, { focus = -1 } = {}) {
  closeMenu();
  const flat = items.filter(Boolean);
  const menu = h('div.menu', { role: 'menu' });
  const actionable = [];
  flat.forEach((it) => {
    if (it === '-') return menu.append(h('div.menu-sep'));
    if (it.section) return menu.append(h('div.menu-section', null, it.section));
    const el = h('button.menu-item' + (it.danger ? '.danger' : ''), {
      disabled: it.disabled,
      onclick: () => { closeMenu(); it.run(); },
      onmouseenter: () => focusItem(actionable.indexOf(el)),
    }, it.icon ? icon(it.icon) : h('span.icon'), h('span.menu-label', null, it.label), it.kbd ? kbd(...[].concat(it.kbd)) : null);
    if (!it.disabled) actionable.push(el);
    menu.append(el);
  });
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  let idx = -1;
  function focusItem(i) { actionable.forEach((a) => a.classList.remove('active')); idx = i; if (actionable[i]) actionable[i].classList.add('active'); }
  if (focus >= 0) focusItem(focus);
  const onKey = (e) => {
    const id = keymap.match('dialog', e);
    if (id === 'dialog.cancel') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (id === 'menu.next') { e.preventDefault(); e.stopPropagation(); focusItem((idx + 1) % actionable.length); }
    else if (id === 'menu.prev') { e.preventDefault(); e.stopPropagation(); focusItem((idx - 1 + actionable.length) % actionable.length); }
    else if (id === 'menu.choose' && actionable[idx]) { e.preventDefault(); e.stopPropagation(); actionable[idx].click(); }
  };
  const onDown = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  window.addEventListener('keydown', onKey, true);
  setTimeout(() => window.addEventListener('mousedown', onDown, true));
  window.addEventListener('blur', closeMenu);
  openMenu = { el: menu, cleanup: () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown, true); window.removeEventListener('blur', closeMenu); } };
}
export function closeMenu() {
  if (!openMenu) return;
  openMenu.cleanup();
  openMenu.el.remove();
  openMenu = null;
}

// --- Tooltips ---------------------------------------------------------------
// Icon-only buttons carry their name and key in `data-tip` (see tipFor): shown on hover after a
// moment and at once on keyboard focus, kept inside the window. One tooltip at a time.
export const tipFor = (label, keyId) => [label, keyId ? keymap.keys(keyId).join('') : ''].filter(Boolean).join('  ');
let tipEl = null;
let tipTimer = 0;
let tipTarget = null;
function showTip(target) {
  const text = target.dataset.tip;
  if (!text || !target.isConnected) return;
  tipEl ||= h('div.tooltip', { role: 'tooltip' });
  tipEl.textContent = text;
  document.body.append(tipEl);
  const r = target.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  const below = r.bottom + 6 + t.height < innerHeight - 4;
  tipEl.style.left = Math.max(4, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 4)) + 'px';
  tipEl.style.top = (below ? r.bottom + 6 : r.top - 6 - t.height) + 'px';
  tipTarget = target;
}
function hideTip() { clearTimeout(tipTimer); tipEl?.remove(); tipTarget = null; }
if (typeof document !== 'undefined') {
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    if (!t.hasAttribute('title')) t.setAttribute('title', ''); // no native tooltip from a titled row around it
    tipTimer = setTimeout(() => showTip(t), 450);
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-tip]');
    hideTip();
    if (t && t.matches(':focus-visible')) showTip(t);
  });
  // Any key hides it (Tab shows the next one on focus).
  for (const ev of ['focusout', 'pointerdown', 'scroll', 'keydown']) document.addEventListener(ev, hideTip, true);
}

// --- Command palette ---------------------------------------------------------------
export function fuzzy(q, s) {
  if (!q) return 1;
  q = q.toLowerCase(); s = s.toLowerCase();
  const direct = s.indexOf(q);
  if (direct !== -1) return 1000 - direct - s.length * 0.01;
  let score = 0, j = 0, streak = 0;
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) { j++; streak++; score += streak * 2 + (i === 0 || s[i - 1] === ' ' || s[i - 1] === '/' ? 6 : 0); } else streak = 0;
  }
  return j === q.length ? score : 0;
}

export function palette(getItems, { placeholder = 'Type a command or search…', onDismiss } = {}) {
  if ($('.palette-overlay:not(.closing)')) return null;
  const prev = document.activeElement;
  const input = h('input.palette-input', { placeholder, spellcheck: false, autocomplete: 'off' });
  const list = h('div.palette-list');
  const box = h('div.palette', null, h('div.palette-head', null, icon('search'), input), list);
  const overlay = h('div.overlay.palette-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  let results = [], idx = 0;
  let all = getItems();
  function render() {
    const q = input.value.trim();
    results = all
      .map((it) => ({ it, s: fuzzy(q, (it.group || '') + ' ' + it.label + ' ' + (it.keywords || '')) * (fuzzy(q, it.label) ? 2 : 1) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .slice(0, 60)
      .map((r) => r.it);
    idx = Math.min(idx, Math.max(0, results.length - 1));
    list.replaceChildren();
    let group = null;
    results.forEach((it, i) => {
      if (!q && it.group !== group) { group = it.group; list.append(h('div.palette-group', null, group)); }
      const row = h('div.palette-item' + (i === idx ? '.active' : ''), {
        onmousemove: () => { if (idx !== i) { idx = i; mark(); } },
        onclick: () => choose(i),
      }, icon(it.icon || 'command'), h('span.palette-label', null, it.label), it.detail ? h('span.palette-detail', null, it.detail) : null, it.kbd ? kbd(...[].concat(it.kbd)) : null);
      list.append(row);
    });
    if (!results.length) list.append(h('div.palette-empty', null, 'No results'));
  }
  function mark() {
    list.querySelectorAll('.palette-item').forEach((el, i) => el.classList.toggle('active', i === idx));
    list.querySelectorAll('.palette-item')[idx]?.scrollIntoView({ block: 'nearest' });
  }
  function choose(i) { const it = results[i]; close(Boolean(it)); if (it) setTimeout(() => it.run(), 0); }
  function close(picked) { overlay.classList.remove('in'); overlay.classList.add('closing'); setTimeout(() => overlay.remove(), 100); prev?.focus?.(); if (!picked) onDismiss?.(); }
  input.addEventListener('input', () => { idx = 0; render(); });
  input.addEventListener('keydown', (e) => {
    const id = keymap.match('dialog', e);
    if (id === 'menu.next') { e.preventDefault(); idx = Math.min(idx + 1, results.length - 1); mark(); }
    else if (id === 'menu.prev') { e.preventDefault(); idx = Math.max(idx - 1, 0); mark(); }
    else if (id === 'menu.choose') { e.preventDefault(); choose(idx); }
    else if (id === 'dialog.cancel') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  document.body.append(overlay);
  render();
  requestAnimationFrame(() => overlay.classList.add('in'));
  input.focus();
  // refresh(): re-read the items (e.g. once async entries arrive) and keep the typed query.
  return { refresh: () => { if (overlay.isConnected && !overlay.classList.contains('closing')) { all = getItems(); render(); } } };
}

// --- Virtual list -----------------------------------------------------------------
// Browsers cannot lay out arbitrarily tall elements (Chromium tops out near 33.5M px, about a
// million 32px rows). Past MAX_SCROLL the scrollbar is scaled: scrollTop maps proportionally onto
// the list's virtual height, and rows are positioned relative to the viewport.
export const MAX_SCROLL = 1 << 24;

// Virtual offset (px into the full list) for a scrollTop, and back.
export function scrollMap(count, rowHeight, viewport) {
  const full = count * rowHeight;
  const spacer = Math.min(full, MAX_SCROLL);
  const scale = full > spacer && spacer > viewport ? (full - viewport) / (spacer - viewport) : 1;
  return { spacer, scale, toVirtual: (top) => top * scale, toScroll: (v) => v / scale };
}

// Renders only visible rows; recycles row elements by index.
export class VirtualList {
  constructor(container, { rowHeight, render, onScroll, overscan = 8 }) {
    this.el = container;
    this.rowHeight = rowHeight;
    this.render = render;
    this.onScroll = onScroll;
    this.overscan = overscan;
    this.count = 0;
    this.mapH = 0;
    this.map = scrollMap(0, rowHeight, 0);
    this.shift = 0;
    this.spacer = h('div.vl-spacer');
    this.layer = h('div.vl-layer');
    this.el.append(this.spacer, this.layer);
    this.rows = new Map();
    this.frame = 0;
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(this.el);
  }
  // `keep` leaves rendered rows alone (rows were only appended).
  setCount(n, { keep = false } = {}) {
    this.count = n;
    this.mapH = this.el.clientHeight;
    this.map = scrollMap(n, this.rowHeight, this.mapH);
    this.spacer.style.height = this.map.spacer + 'px';
    if (keep) this.schedule(); else this.invalidate();
  }
  invalidate() { for (const [, el] of this.rows) el.remove(); this.rows.clear(); this.schedule(); }
  schedule() { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); }); }
  range() {
    const hgt = this.el.clientHeight;
    const top = this.map.toVirtual(this.el.scrollTop);
    const first = Math.max(0, Math.floor(top / this.rowHeight) - this.overscan);
    const last = Math.min(this.count - 1, Math.ceil((top + hgt) / this.rowHeight) + this.overscan);
    return { first, last, top, height: hgt };
  }
  place(i, el) { el.style.transform = `translateY(${i * this.rowHeight - this.shift}px)`; }
  update() {
    if (this.el.clientHeight !== this.mapH) { this.mapH = this.el.clientHeight; this.map = scrollMap(this.count, this.rowHeight, this.mapH); }
    const { first, last, top, height } = this.range();
    const shift = top - this.el.scrollTop;
    for (const [i, el] of this.rows) if (i < first || i > last) { el.remove(); this.rows.delete(i); }
    if (shift !== this.shift) { this.shift = shift; for (const [i, el] of this.rows) this.place(i, el); }
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const el = this.render(i);
      this.place(i, el);
      el.style.height = this.rowHeight + 'px';
      this.rows.set(i, el);
      frag.append(el);
    }
    this.layer.append(frag);
    this.onScroll?.({ first, last, top, height });
  }
  refreshRow(i) { const el = this.rows.get(i); if (el) { el.remove(); this.rows.delete(i); this.schedule(); } }
  scrollToIndex(i, align = 'nearest') {
    const y = i * this.rowHeight, top = this.map.toVirtual(this.el.scrollTop), hgt = this.el.clientHeight;
    let v = null;
    if (align === 'center') v = y - hgt / 2 + this.rowHeight / 2;
    else if (y < top) v = y;
    else if (y + this.rowHeight > top + hgt) v = y + this.rowHeight - hgt;
    if (v !== null) this.el.scrollTop = this.map.toScroll(Math.max(0, v));
  }
  destroy() { this.ro.disconnect(); cancelAnimationFrame(this.frame); }
}
