import { h, icon, kbd } from './ui.js';
import * as keymap from './keymap.js';
import { shortcutSections } from './shortcuts.js';

// The Keyboard Shortcuts window (⌘/, Help → Keyboard Shortcuts, ⌘K). Lists every keymap command once, the
// active view's section first. Type to search by action or key; ↑↓ move, ⌘F returns to the search, Esc clears
// the search and then closes. Returns { close, find, refresh } so the menu's ⌘/ and ⌘F can drive an open window
// and a keymap change (from any window) redraws it.
//
// Click a row (or ↵) to change its keys: click a key to record a new one, + adds one, Reset restores the
// defaults. While recording, Esc cancels and ⌫ removes the key; for a view, a plain letter waits a moment for a
// second key (G then C). Keys another command uses offer Replace (unbinds it) or Cancel; keys macOS keeps are refused.

const CHORD_WAIT = 800;

export function shortcutsWindow({ first, save, actions = {}, onClose }) {
  const prev = document.activeElement;
  const input = h('input.palette-input.shortcuts-search', {
    placeholder: 'Search by action or key…', spellcheck: false, autocomplete: 'off', 'aria-label': 'Search shortcuts', 'aria-controls': 'shortcuts-list',
  });
  const list = h('div.shortcuts-list', { id: 'shortcuts-list', role: 'list' });
  const foot = h('div.shortcuts-foot', null,
    h('span.shortcuts-hint', null, 'Click a shortcut to change it'),
    h('button.btn.ghost.small', { onclick: () => actions.importShortcuts?.() }, 'Import…'),
    h('button.btn.ghost.small', { onclick: () => actions.exportShortcuts?.() }, 'Export…'),
    h('button.btn.ghost.small', { onclick: () => actions.resetShortcuts?.() }, 'Reset All'));
  const box = h('div.palette.shortcuts', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'shortcuts-title' },
    h('div.shortcuts-title', null, h('h2', { id: 'shortcuts-title' }, 'Keyboard Shortcuts'), kbd(...keymap.keys('help.shortcuts'))),
    h('div.palette-head', null, icon('search'), input),
    list, foot);
  const overlay = h('div.overlay.shortcuts-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  let rows = [], idx = -1;
  let editing = null; // the ids of the row being edited, joined
  let rec = null; // { id, index, steps, timer } while recording
  let note = null; // { id, text } or { id, index, binding, clash } for a conflict

  function render() {
    const custom = new Set(keymap.COMMANDS.map((c) => c.id).filter(keymap.isCustom));
    const sections = shortcutSections({ first, query: input.value, custom });
    rows = [];
    list.replaceChildren(...sections.map((s, si) => h('section.shortcuts-section', { 'aria-label': s.title },
      h('h3.palette-group', null, s.title, si === 0 && s.id === first && !input.value.trim() ? h('span.shortcuts-here', null, 'This view') : null),
      s.rows.map((r) => {
        const key = r.ids.join(' ');
        const el = h('div.shortcuts-row' + (editing === key ? '.editing' : ''), {
          role: 'listitem', 'data-ids': key,
          onmousemove: () => { idx = rows.indexOf(el); mark(); },
          onclick: () => toggleEdit(key),
        },
        h('span.palette-label', null, r.label),
        r.custom ? h('span.shortcuts-custom', { title: 'You changed this shortcut' }, 'Custom') : null,
        h('span.shortcuts-keys', null, r.keys.flatMap((caps, i) => [i ? h('span.shortcuts-or', null, 'or') : null, kbd(...caps)])));
        el.keyIds = key;
        rows.push(el);
        return editing === key ? [el, editor(r.ids)] : el;
      }))));
    if (!rows.length) list.append(h('div.palette-empty', null, 'No shortcuts match'));
    idx = Math.min(idx, rows.length - 1);
    mark(false);
    // A redraw replaces the focused button; keep keys inside the window (the recorder listens on it).
    if (rec) list.querySelector('.shortcuts-binding.recording')?.focus();
    else if (!box.contains(document.activeElement)) input.focus({ preventScroll: true });
  }

  // The edit panel under a row: one line per command (two for a ↓ ↑ pair).
  function editor(ids) {
    return h('div.shortcuts-edit', { onclick: (e) => e.stopPropagation() }, ids.map((id) => {
      const cmd = keymap.command(id);
      const list = keymap.bindings(id);
      const recording = rec?.id === id;
      const slot = (b, i) => (recording && rec.index === i
        ? h('button.shortcuts-binding.recording', { 'aria-label': 'Recording' }, rec.steps.length ? kbd(...keymap.caps(rec.steps.join(' '))) : 'Press new keys…')
        : h('button.shortcuts-binding', { title: 'Change', onclick: () => record(id, i) }, kbd(...keymap.caps(b))));
      return h('div.shortcuts-edit-line', { 'data-id': id },
        ids.length > 1 ? h('span.shortcuts-edit-label', null, cmd.label) : null,
        cmd.reserved
          ? h('span.shortcuts-note', null, 'macOS and the app menu own this shortcut, so it can’t be changed.')
          : [list.map(slot),
            recording && rec.index === list.length ? slot(null, list.length) : h('button.btn.ghost.small', { title: 'Add a shortcut', onclick: () => record(id, list.length) }, icon('plus', 12), 'Add'),
            keymap.isCustom(id) ? h('button.btn.ghost.small', { onclick: () => apply(id, [...keymap.defaults(id)]) }, 'Reset') : null],
        note?.id === id ? noteEl() : null);
    }));
  }

  function noteEl() {
    if (!note.clash) return h('div.shortcuts-note.error', { role: 'alert' }, note.text);
    const names = note.clash.map((x) => `“${keymap.command(x).label}”`).join(' and ');
    return h('div.shortcuts-note', { role: 'alert' },
      h('span', null, kbd(...keymap.caps(note.binding)), ` is used by ${names}.`),
      h('button.btn.primary.small', { onclick: () => replace() }, 'Replace'),
      h('button.btn.ghost.small', { onclick: () => { note = null; render(); } }, 'Cancel'));
  }

  function toggleEdit(key) {
    stopRecording();
    note = null;
    editing = editing === key ? null : key;
    render();
  }

  function record(id, index) {
    stopRecording();
    note = null;
    rec = { id, index, steps: [], timer: null };
    api('keymap-recording', true);
    render();
  }
  function stopRecording() {
    if (!rec) return;
    clearTimeout(rec.timer);
    rec = null;
    api('keymap-recording', false);
  }

  function onRecordKey(e) {
    e.preventDefault(); e.stopImmediatePropagation();
    const { id, index } = rec;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === 'Escape') { stopRecording(); return render(); }
    if (plain && e.key === 'Backspace' && !rec.steps.length) {
      stopRecording();
      const list = keymap.bindings(id).filter((_, i) => i !== index);
      return apply(id, list);
    }
    const step = keymap.fromEvent(e);
    if (!step) return;
    rec.steps.push(step);
    clearTimeout(rec.timer);
    if (rec.steps.length === 1 && id.startsWith('view.') && /^[a-z0-9]$/.test(step)) {
      rec.timer = setTimeout(() => finish(), CHORD_WAIT);
      return render();
    }
    finish();
  }

  function finish() {
    const { id, index, steps } = rec;
    stopRecording();
    const binding = steps.join(' ');
    const reason = keymap.refusal(id, binding);
    if (reason) { note = { id, text: reason }; return render(); }
    const clash = keymap.conflicts(id, binding);
    if (clash.length) { note = { id, index, binding, clash }; return render(); }
    apply(id, put(id, index, binding));
  }

  const put = (id, index, binding) => {
    const list = [...keymap.bindings(id)];
    list[index] = binding;
    return list;
  };

  // Replace: take the keys from every command that has them, then give them to this one.
  function replace() {
    const { id, index, binding, clash } = note;
    let o = keymap.getOverrides();
    for (const x of clash) o = keymap.withBinding(o, x, keymap.bindings(x).filter((b) => !keymap.collides(b, binding)));
    apply(id, put(id, index, binding), o);
  }

  async function apply(id, list, base = keymap.getOverrides()) {
    note = null;
    try { keymap.setOverrides(await save(keymap.withBinding(base, id, list))); }
    catch (e) { note = { id, text: `Couldn’t save the shortcut: ${e.message}` }; }
    render();
  }

  function mark(scroll = true) {
    rows.forEach((el, i) => el.classList.toggle('active', i === idx));
    if (idx >= 0 && scroll) rows[idx].scrollIntoView({ block: 'nearest' });
    else if (idx < 0) list.scrollTop = 0;
  }
  function find() { stopRecording(); input.focus(); input.select(); }
  function close() {
    if (!overlay.isConnected || overlay.classList.contains('closing')) return;
    stopRecording();
    overlay.classList.remove('in'); overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 100);
    prev?.focus?.();
    onClose?.();
  }

  input.addEventListener('input', () => { idx = -1; editing = null; note = null; render(); });
  overlay.addEventListener('keydown', (e) => { if (rec) onRecordKey(e); }, true);
  overlay.addEventListener('keydown', (e) => {
    const id = keymap.match('shortcuts', e);
    if (id === 'shortcuts.next') { e.preventDefault(); idx = Math.min(idx + 1, rows.length - 1); mark(); }
    else if (id === 'shortcuts.prev') { e.preventDefault(); idx = Math.max(idx - 1, -1); mark(); }
    else if (id === 'shortcuts.find') { e.preventDefault(); find(); }
    else if (id === 'shortcuts.edit' && idx >= 0 && document.activeElement === input) { e.preventDefault(); toggleEdit(rows[idx].keyIds); }
    else if (id === 'shortcuts.close') {
      e.preventDefault(); e.stopPropagation();
      if (note || editing) { note = null; editing = null; render(); find(); }
      else if (input.value) { input.value = ''; idx = -1; render(); find(); } else close();
    }
  });

  document.body.append(overlay);
  render();
  requestAnimationFrame(() => overlay.classList.add('in'));
  input.focus();
  return { close, find, refresh: render };
}

const api = (channel, ...args) => window.gitlanes.app(channel, ...args).catch(() => {});
