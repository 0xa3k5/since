import { h, icon, contextMenu } from './ui.js';
import * as keymap from './keymap.js';
import { PREF_SECTIONS, prefSections, nextChoice } from './prefs.js';

// The Preferences window (⌘,, Since → Settings…, ⌘K). Rows come from prefs.js; every section is in one list,
// the sidebar jumps to a section. Type to search; ↑↓ move, ↵ toggles a switch or runs a button, ← → change a
// choice, ⌘↓ / ⌘↑ jump to the next or previous section, ⌘F returns to the
// search, Esc clears the search and then closes.
//
// `rows()` returns the current rows; `act(row, value)` applies a change (value: the new switch or choice value,
// or undefined for a button / config row; 'unset' and 'copy' for a config row's other actions) and may return a
// promise, after which the window redraws. Returns { close, find, refresh, show(section) }.

export function prefsWindow({ section, rows: getRows, act, onClose }) {
  const prev = document.activeElement;
  const input = h('input.palette-input.prefs-search', {
    placeholder: 'Search preferences…', spellcheck: false, autocomplete: 'off', 'aria-label': 'Search preferences', 'aria-controls': 'prefs-list',
  });
  const nav = h('nav.prefs-nav', { 'aria-label': 'Sections' });
  const list = h('div.prefs-list', { id: 'prefs-list', role: 'list' });
  const box = h('div.palette.prefs', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'prefs-title' },
    h('div.shortcuts-title', null, h('h2', { id: 'prefs-title' }, 'Preferences'),
      h('button.icon-btn.tiny', { type: 'button', tabindex: -1, title: `Close (Esc, ${keymap.keys('app.settings').join('')})`, 'aria-label': 'Close', onclick: () => close() }, icon('x', 12))),
    h('div.palette-head', null, icon('search'), input),
    h('div.prefs-body', null, nav, list));
  const overlay = h('div.overlay.prefs-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  let items = [], idx = -1, current = section || null, busy = false;

  const sw = (on) => h('span.switch' + (on ? '.on' : ''), { 'aria-hidden': 'true' }, h('span.switch-knob'));
  function control(r) {
    if (r.kind === 'switch' && r.move) {
      const mv = (dir, ic, label, off) => h('button.icon-btn.tiny', { type: 'button', tabindex: -1, disabled: off, title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); run(r, dir); } }, icon(ic, 12));
      return h('div.prefs-move', null, mv('up', 'chevronUp', 'Move up', r.first), mv('down', 'chevronDown', 'Move down', r.last), r.fixed ? h('span.switch-spacer', { 'aria-hidden': 'true' }) : sw(r.value));
    }
    if (r.kind === 'switch') return sw(r.value);
    if (r.kind === 'info') return h('span.prefs-info', null, r.value);
    if (r.kind === 'action') return h('button.btn.subtle.small', { type: 'button', tabindex: -1, onclick: (e) => { e.stopPropagation(); run(r); } }, r.value);
    if (r.kind === 'choice') {
      return h('div.setup-seg', { role: 'group', 'aria-label': r.label }, r.options.map((o) => h('button', {
        type: 'button', tabindex: -1, 'aria-pressed': String(o.id === r.value), title: o.label,
        onclick: (e) => { e.stopPropagation(); run(r, o.id); },
      }, o.icon ? icon(o.icon, 12) : null, o.label)));
    }
    return null;
  }
  function rowEl(r) {
    if (r.kind === 'config') {
      const c = r.value;
      return h('div.prefs-row.prefs-config', {
        role: 'listitem', title: c.scope === 'local' ? 'Click to edit' : `${c.scope} value: read-only here`,
        onclick: () => run(r),
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Edit…', icon: 'edit', disabled: c.scope !== 'local', run: () => run(r) },
            { label: 'Copy Value', icon: 'copy', run: () => run(r, 'copy') },
            { label: 'Delete', icon: 'trash', danger: true, disabled: c.scope !== 'local', run: () => run(r, 'unset') },
          ]);
        },
      }, h('span.mono.prefs-key', null, c.key), h('span.config-val', null, c.value));
    }
    const label = r.kind === 'switch' && !r.fixed ? `${r.label}: ${r.value ? 'on' : 'off'}` : r.label;
    return h('div.prefs-row', {
      role: 'listitem', 'aria-label': label, 'data-id': r.id,
      onclick: () => { if (r.kind === 'switch') run(r, !r.value); else if (r.kind === 'action') run(r); },
    }, r.icon ? h('span.prefs-icon', null, icon(r.icon, 14)) : null, h('div.setup-text', null, h('div.setup-label', null, r.label), r.detail ? h('div.setup-detail', null, r.detail) : null), control(r));
  }

  function render() {
    const keep = items[idx]?.dataset.key;
    const sections = prefSections(getRows(), input.value);
    items = [];
    // Each section is one group of rows. Git config rows are grouped by scope under a small heading instead of a
    // badge on every row.
    const scopeNote = { local: 'click to edit', global: 'read-only here', system: 'read-only here' };
    list.replaceChildren(...sections.map((sec) => h('section.prefs-section', { 'data-section': sec.id },
      h('h3.prefs-heading', null, sec.label),
      h('div.prefs-group', null, sec.rows.flatMap((r, i) => {
        const el = rowEl(r);
        el.dataset.key = r.id;
        el._row = r;
        el.addEventListener('mousemove', () => { if (idx !== items.indexOf(el)) { idx = items.indexOf(el); mark(false); } });
        items.push(el);
        const scope = r.kind === 'config' && r.value.scope;
        if (!scope || sec.rows[i - 1]?.value?.scope === scope) return [el];
        return [h('div.prefs-subhead', { 'aria-hidden': 'true' }, scope[0].toUpperCase() + scope.slice(1), h('span', null, ` · ${scopeNote[scope] || 'read-only here'}`)), el];
      })))));
    if (!sections.length) list.append(h('div.palette-empty', null, 'No preferences match'));
    const shown = new Set(sections.map((s) => s.id));
    nav.replaceChildren(...PREF_SECTIONS.map((s) => h('button.prefs-nav-item', {
      type: 'button', tabindex: -1, disabled: !shown.has(s.id), 'aria-current': String(s.id === current),
      onclick: () => show(s.id),
    }, icon(s.icon, 14), s.label)));
    idx = keep ? items.findIndex((el) => el.dataset.key === keep) : -1;
    mark(false);
  }
  function mark(scroll = true) {
    items.forEach((el, i) => el.classList.toggle('active', i === idx));
    if (idx >= 0) {
      current = items[idx]._row.section;
      if (scroll) items[idx].scrollIntoView({ block: 'nearest' });
    }
    for (const b of nav.children) b.setAttribute('aria-current', String(b.textContent === PREF_SECTIONS.find((s) => s.id === current)?.label));
  }
  // Jump to a section: its first row becomes the active one, at the top of the list.
  function show(id) {
    const i = items.findIndex((el) => el._row.section === id);
    current = id;
    if (i < 0) return mark(false);
    idx = i;
    mark(false);
    list.scrollTop = items[i].closest('.prefs-section').offsetTop - list.offsetTop;
    input.focus();
  }
  async function run(r, value) {
    if (busy) return;
    idx = items.findIndex((el) => el._row === r);
    busy = true;
    try { await act(r, value); } finally { busy = false; }
    if (overlay.isConnected && !overlay.classList.contains('closing')) { render(); input.focus(); }
  }
  function activate(dir = 0) {
    const r = items[idx]?._row;
    if (!r) return false;
    if (r.kind === 'choice') { run(r, dir ? nextChoice(r, dir) : nextChoice(r, 1)); return true; }
    if (dir) return false;
    if (r.kind === 'switch') run(r, !r.value);
    else if (r.kind === 'action' || r.kind === 'config') run(r);
    else return false;
    return true;
  }
  function step(dir) {
    if (!items.length) return;
    const secs = [...new Set(items.map((el) => el._row.section))];
    const at = secs.indexOf(items[idx]?._row.section ?? current);
    show(secs[Math.max(0, Math.min(secs.length - 1, at < 0 ? 0 : at + dir))]);
  }
  function find() { input.focus(); input.select(); }
  function close() {
    if (!overlay.isConnected || overlay.classList.contains('closing')) return;
    overlay.classList.remove('in'); overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 100);
    prev?.focus?.();
    onClose?.();
  }

  input.addEventListener('input', () => { idx = -1; render(); if (items.length) { idx = 0; mark(); } });
  overlay.addEventListener('keydown', (e) => {
    // A dialog or menu opened from a row handles its own keys.
    if (!box.contains(e.target) && e.target !== overlay) return;
    const id = keymap.match('prefs', e);
    if (id === 'prefs.next') { e.preventDefault(); idx = Math.min(idx + 1, items.length - 1); mark(); }
    else if (id === 'prefs.prev') { e.preventDefault(); idx = Math.max(idx - 1, -1); mark(); }
    else if (id === 'prefs.nextSection') { e.preventDefault(); step(1); }
    else if (id === 'prefs.prevSection') { e.preventDefault(); step(-1); }
    else if (id === 'prefs.toggle') { if (activate()) e.preventDefault(); }
    else if (id === 'prefs.right' || id === 'prefs.left') { if (activate(id === 'prefs.right' ? 1 : -1)) e.preventDefault(); }
    else if ((id === 'prefs.moveUp' || id === 'prefs.moveDown') && items[idx]?._row.move) { e.preventDefault(); run(items[idx]._row, id === 'prefs.moveUp' ? 'up' : 'down'); }
    else if (id === 'prefs.unset' && items[idx]?._row.kind === 'config') { e.preventDefault(); run(items[idx]._row, 'unset'); }
    else if (id === 'prefs.find') { e.preventDefault(); find(); }
    else if (id === 'prefs.close') {
      e.preventDefault(); e.stopPropagation();
      if (input.value) { input.value = ''; idx = -1; render(); find(); } else close();
    }
  });

  document.body.append(overlay);
  render();
  requestAnimationFrame(() => { overlay.classList.add('in'); if (section) show(section); });
  input.focus();
  return { close, find, refresh: render, show };
}
