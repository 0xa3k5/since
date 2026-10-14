import { h, icon, kbd } from './ui.js';
import * as keymap from './keymap.js';
import { shortcutSections } from './shortcuts.js';

// The Keyboard Shortcuts window (⌘/, Help → Keyboard Shortcuts, ⌘K). Lists every keymap command once, the
// active view's section first. Type to search by action or key; ↑↓ move, ⌘F returns to the search, Esc clears
// the search and then closes. Returns { close, find } so the menu's ⌘/ and ⌘F can drive an open window.

export function shortcutsWindow({ first, custom, onClose }) {
  const prev = document.activeElement;
  const input = h('input.palette-input.shortcuts-search', {
    placeholder: 'Search by action or key…', spellcheck: false, autocomplete: 'off', 'aria-label': 'Search shortcuts', 'aria-controls': 'shortcuts-list',
  });
  const list = h('div.shortcuts-list', { id: 'shortcuts-list', role: 'list' });
  const box = h('div.palette.shortcuts', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcuts-title' },
    h('div.shortcuts-title', null, h('h2', { id: 'shortcuts-title' }, 'Keyboard Shortcuts'), kbd(...keymap.keys('help.shortcuts'))),
    h('div.palette-head', null, icon('search'), input),
    list);
  const overlay = h('div.overlay.shortcuts-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  let rows = [], idx = -1;

  function render() {
    const sections = shortcutSections({ first, query: input.value, custom });
    rows = [];
    list.replaceChildren(...sections.map((s, si) => h('section.shortcuts-section', { 'aria-label': s.title },
      h('h3.palette-group', null, s.title, si === 0 && s.id === first && !input.value.trim() ? h('span.shortcuts-here', null, 'This view') : null),
      s.rows.map((r) => {
        const el = h('div.shortcuts-row', { role: 'listitem', onmousemove: () => { idx = rows.indexOf(el); mark(); } },
          h('span.palette-label', null, r.label),
          r.custom ? h('span.shortcuts-custom', { title: 'You changed this shortcut' }, 'Custom') : null,
          h('span.shortcuts-keys', null, r.keys.flatMap((caps, i) => [i ? h('span.shortcuts-or', null, 'or') : null, kbd(...caps)])));
        rows.push(el);
        return el;
      }))));
    if (!rows.length) list.append(h('div.palette-empty', null, 'No shortcuts match'));
    idx = Math.min(idx, rows.length - 1);
    mark();
  }
  function mark() {
    rows.forEach((el, i) => el.classList.toggle('active', i === idx));
    if (idx >= 0) rows[idx].scrollIntoView({ block: 'nearest' });
    else list.scrollTop = 0;
  }
  function find() { input.focus(); input.select(); }
  function close() {
    if (!overlay.isConnected || overlay.classList.contains('closing')) return;
    overlay.classList.remove('in'); overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 100);
    prev?.focus?.();
    onClose?.();
  }

  input.addEventListener('input', () => { idx = -1; render(); });
  overlay.addEventListener('keydown', (e) => {
    const id = keymap.match('shortcuts', e);
    if (id === 'shortcuts.next') { e.preventDefault(); idx = Math.min(idx + 1, rows.length - 1); mark(); }
    else if (id === 'shortcuts.prev') { e.preventDefault(); idx = Math.max(idx - 1, -1); mark(); }
    else if (id === 'shortcuts.find') { e.preventDefault(); find(); }
    else if (id === 'shortcuts.close') {
      e.preventDefault(); e.stopPropagation();
      if (input.value) { input.value = ''; idx = -1; render(); find(); } else close();
    }
  });

  document.body.append(overlay);
  render();
  requestAnimationFrame(() => overlay.classList.add('in'));
  input.focus();
  return { close, find };
}
