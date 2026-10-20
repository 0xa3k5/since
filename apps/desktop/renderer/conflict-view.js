import { h, icon, confirm } from './ui.js';
import { parseConflicts, sideChoice, blockResult, composeResult, hasMarkers, keepLineEndings } from './conflict.js';
import * as keymap from './keymap.js';

const CONTEXT = 3; // unchanged lines shown around each conflict
// Editor state per path, kept while the status refreshes underneath (file watcher).
const states = new Map();

// Shortcuts inside the editor. Shown in the header, the ⌘K palette and the hint bar.
export const CONFLICT_KEYS = {
  next: [']'], prev: ['['], ours: ['O'], theirs: ['T'], both: ['B'], reset: ['⌫'],
  allOurs: ['⇧', 'O'], allTheirs: ['⇧', 'T'], edit: ['E'],
};

// info: the `conflict` read ({ path, kind, text, ours, theirs, base }).
// ctx: { mod, onResolve(text), onSide(side), onMergetool(), badge }
export function conflictEditor(info, ctx) {
  const resolveKbd = [ctx.mod, 'S'];
  let st = states.get(info.path);
  if (!st || st.source !== info.text) {
    const segs = info.text == null ? [] : parseConflicts(info.text);
    const blocks = segs.filter((s) => s.type === 'conflict');
    st = { source: info.text, segs, blocks, choices: blocks.map(() => null), cur: 0, manual: null, editing: false };
    states.set(info.path, st);
  }
  for (const k of states.keys()) if (k !== info.path) states.delete(k);
  const { segs, blocks, choices } = st;
  const el = h('div.cf');
  const scroll = h('div.diff-scroll.cf-scroll');
  let textarea = null;

  const resultText = () => st.manual ?? composeResult(segs, choices);
  const done = () => choices.filter(Boolean).length;

  function set(i, side) {
    if (!blocks[i] || st.manual != null) return;
    choices[i] = side ? sideChoice(blocks[i], side) : null;
    // Taking a side moves on to the next unresolved conflict.
    if (side) { const n = choices.findIndex((c, j) => !c && j > i); if (n !== -1) st.cur = n; }
    render(true);
  }
  function toggleLine(i, part, li) {
    if (st.manual != null) return;
    const c = choices[i] || sideChoice(blocks[i], null);
    c[part][li] = !c[part][li];
    choices[i] = c;
    st.cur = i;
    render();
  }
  function all(side) { blocks.forEach((b, i) => { choices[i] = sideChoice(b, side); }); render(); }
  function move(d) {
    if (!blocks.length) return;
    st.cur = Math.max(0, Math.min(blocks.length - 1, st.cur + d));
    render(true);
  }
  function toggleEdit() {
    if (info.kind !== 'text') return;
    st.editing = !st.editing;
    render();
    if (st.editing) textarea?.focus();
  }
  async function resolve() {
    if (info.kind !== 'text') return;
    const text = keepLineEndings(info.text, st.editing && textarea ? textarea.value : resultText());
    if (hasMarkers(text) && !(await confirm('Conflict markers are still in the file', `${blocks.length - done()} conflict${blocks.length - done() === 1 ? '' : 's'} not resolved. Mark the file resolved with the markers left in?`, { submit: 'Mark resolved' }))) return;
    ctx.onResolve(text);
  }

  const btn = (label, keys, run, opts = {}) => h('button.btn.ghost.tiny' + (opts.on ? '.on' : ''), { title: keys ? `${opts.title || label} (${keys.join('')})` : opts.title || label, disabled: opts.disabled, onclick: (e) => { e.stopPropagation(); run(); } }, label);

  function head() {
    const n = blocks.length;
    return h('div.diff-head', null, ctx.badge, h('span.mono', null, info.path), h('span.spacer'),
      info.kind === 'text' && n ? h('span.cf-progress' + (done() === n ? '.ok' : ''), null, `${done()}/${n} resolved`) : null,
      info.kind === 'text' && n ? [
        btn('All ours', CONFLICT_KEYS.allOurs, () => all('ours'), { disabled: st.manual != null }),
        btn('All theirs', CONFLICT_KEYS.allTheirs, () => all('theirs'), { disabled: st.manual != null }),
      ] : null,
      info.kind === 'text' ? btn('Edit result', CONFLICT_KEYS.edit, toggleEdit, { on: st.editing }) : null,
      h('button.icon-btn', { title: `Open in your mergetool (${ctx.mod}⇧M)`, onclick: ctx.onMergetool }, icon('merge', 14)),
      info.kind === 'text' ? h('button.btn.primary.small', { title: `Save the result and mark the file resolved (${resolveKbd.join('')})`, onclick: resolve }, 'Mark resolved') : null,
    );
  }

  // Binary, missing or very large files: pick a whole side.
  function wholeSide() {
    const what = { binary: 'This is a binary file or a symlink.', missing: 'One side deleted this file.', large: 'This file is too large for the built-in editor.', encoding: 'This file is not UTF-8 text.' }[info.kind];
    const side = (s) => h('button.btn.small', { onclick: () => ctx.onSide(s) },
      s === 'ours' ? (info.ours ? 'Use ours' : 'Use ours (delete)') : (info.theirs ? 'Use theirs' : 'Use theirs (delete)'));
    return h('div.cf-whole', null, icon('merge', 28), h('div', null, what), h('div.muted', null, 'Pick the version to keep.'),
      h('div.cf-whole-btns', null, side('ours'), side('theirs')));
  }

  const lineEl = (text, cls, onclick) => h('div.cf-line' + cls, { onclick }, h('span.code', null, text.replace(/\r$/, '') || ' '));

  function blockEl(b, i) {
    const c = choices[i];
    const locked = st.manual != null;
    const col = (part, label) => h('div.cf-col.cf-' + part, null,
      h('div.cf-col-head', null, part === 'ours' ? 'Ours' : part === 'theirs' ? 'Theirs' : 'Base', label ? h('span.muted', null, ` · ${label}`) : null),
      b[part].length ? b[part].map((l, li) => lineEl(l, part === 'base' ? '' : '.pick' + (c?.[part][li] ? '.on' : ''), part === 'base' || locked ? null : () => toggleLine(i, part, li)))
        : h('div.cf-none', null, 'no lines'));
    const result = blockResult(b, c);
    return h('div.cf-block' + (i === st.cur ? '.cur' : '') + (c ? '.done' : ''), { onclick: () => { if (st.cur !== i) { st.cur = i; render(); } } },
      h('div.cf-block-head', null,
        h('span.cf-title', null, `Conflict ${i + 1} of ${blocks.length}`), h('span.spacer'),
        btn('Ours', CONFLICT_KEYS.ours, () => set(i, 'ours'), { disabled: locked, title: 'Take our lines' }),
        btn('Theirs', CONFLICT_KEYS.theirs, () => set(i, 'theirs'), { disabled: locked, title: 'Take their lines' }),
        btn('Both', CONFLICT_KEYS.both, () => set(i, 'both'), { disabled: locked, title: 'Take ours, then theirs' }),
        btn('Theirs + ours', null, () => set(i, 'both-rev'), { disabled: locked, title: 'Take theirs, then ours' }),
        c ? btn('Reset', CONFLICT_KEYS.reset, () => set(i, null), { disabled: locked, title: 'Back to unresolved' }) : null,
      ),
      h('div.cf-cols' + (b.base ? '.three' : ''), null, col('ours', b.oursLabel), b.base ? col('base', b.baseLabel) : null, col('theirs', b.theirsLabel)),
      h('div.cf-result', null, h('div.cf-col-head', null, 'Result'),
        c ? (result.length ? result.map((l) => lineEl(l, '')) : h('div.cf-none', null, 'empty — both sides dropped')) : h('div.cf-none', null, 'Pick a side, or click lines to keep them')),
    );
  }

  function textEl(seg, prev, next) {
    const ls = seg.lines;
    const show = (a) => a.map((l) => lineEl(l, '.ctx'));
    const top = prev ? CONTEXT : 0, bottom = next ? CONTEXT : 0;
    if (ls.length <= top + bottom + 1) return h('div.cf-text', null, show(ls));
    return h('div.cf-text', null, show(ls.slice(0, top)), h('div.cf-fold', null, `⋯ ${ls.length - top - bottom} unchanged lines`), show(ls.slice(ls.length - bottom)));
  }

  function body() {
    if (info.kind !== 'text') return wholeSide();
    if (st.editing) {
      textarea = h('textarea.cf-edit', { spellcheck: false, value: resultText() });
      textarea.value = resultText();
      textarea.addEventListener('input', () => { st.manual = textarea.value; });
      return h('div.cf-edit-wrap', null,
        st.manual != null ? h('div.cf-note', null, 'Edited by hand. Per-conflict picks are locked until you discard your edits.',
          h('button.btn.ghost.tiny', { onclick: () => { st.manual = null; render(); } }, 'Discard edits')) : null,
        textarea);
    }
    if (!blocks.length) return h('div.cf-whole', null, icon('check', 28), h('div', null, 'No conflict markers left in this file'), h('div.muted', null, `Mark it resolved to stage it (${resolveKbd.join('')}).`));
    let bi = 0;
    return h('div.cf-body', null, segs.map((s, si) => (s.type === 'conflict' ? blockEl(s, bi++) : textEl(s, segs[si - 1], segs[si + 1]))));
  }

  function hint() {
    if (info.kind !== 'text') return null;
    return h('div.diff-hint', null, st.editing ? `Edit the result, then ${resolveKbd.join('')} to save and mark resolved · E or Esc to go back`
      : `${CONFLICT_KEYS.next.join('')} / ${CONFLICT_KEYS.prev.join('')} next / previous · O ours · T theirs · B both · ⌫ reset · E edit result · ${resolveKbd.join('')} mark resolved · click lines to pick them`);
  }

  function render(focusCur = false) {
    const top = scroll.scrollTop;
    textarea = null;
    scroll.replaceChildren(body());
    scroll.scrollTop = top;
    el.replaceChildren(...[head(), scroll, hint()].filter(Boolean));
    if (focusCur) scroll.querySelector('.cf-block.cur')?.scrollIntoView({ block: 'nearest' });
  }
  render(true);

  const actions = {
    next: () => move(1), prev: () => move(-1),
    ours: () => set(st.cur, 'ours'), theirs: () => set(st.cur, 'theirs'), both: () => set(st.cur, 'both'), reset: () => set(st.cur, null),
    allOurs: () => all('ours'), allTheirs: () => all('theirs'), edit: toggleEdit, resolve,
  };

  // Returns true when the key was handled.
  function key(e) {
    const id = keymap.match('conflict', e);
    if (id === 'conflict.resolve') { e.preventDefault(); resolve(); return true; }
    if (e.target === textarea) { if (id === 'conflict.closeEdit') { e.preventDefault(); toggleEdit(); return true; } return false; }
    if (info.kind !== 'text') return false;
    const run = {
      'conflict.next': actions.next, 'conflict.prev': actions.prev, 'conflict.ours': actions.ours, 'conflict.theirs': actions.theirs,
      'conflict.both': actions.both, 'conflict.allOurs': actions.allOurs, 'conflict.allTheirs': actions.allTheirs,
      'conflict.edit': actions.edit, 'conflict.reset': actions.reset,
    }[id];
    if (!run) return false;
    e.preventDefault();
    run();
    return true;
  }

  return { el, key, actions, info, blocks: () => blocks.length, editing: () => st.editing };
}
