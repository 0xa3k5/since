import { h, icon, kbd, loading, toast, timeAgo, avatar } from '../lib/ui.ts';
import { renderDiff, hunkKeys, statusBadge } from './diff.js';
import * as keymap from '../palette/keymap.ts';
import { up } from '../lib/upcalls.js';
import { state, isEditable } from '../lib/app-helpers.js';
import { git, act } from '../lib/bridge.js';

// Split commit: pick the lines that become the first commit; the rest become the second.

// `branch`: the commit is on that branch, not this one: Split switches there first (switchRewrite).
async function openSplit(c, branch = null) {
  if (!c) return;
  try { await git('checkSplit', c.sha, ...(branch ? [branch] : [])); } catch (e) { toast('Can’t split this commit', { kind: 'error', detail: e.message }); return; }
  state.quick = null;
  state.fileHistory = null;
  state.review = null;
  state.split = { sha: c.sha, branch };
  up.renderTopbar();
  up.renderView();
}
function closeSplit(select = true) {
  const sha = state.split?.sha;
  state.split = null;
  up.renderTopbar();
  up.renderView();
  if (select && sha) up.selectCommit(sha, 'center');
}

function splitView({ sha, branch }) {
  const el = h('div.quick.split', { tabIndex: 0 });
  const side = h('div.quick-side.split-side');
  const files = h('div.file-list.split-files');
  const main = h('div.quick-main', null, loading('Loading commit…'));
  el.append(side, main);
  let diffs = [], current = null, full = false;
  const picked = new Map(); // path -> Set of line keys in the first commit
  const whole = new Set(); // files without lines (binary, mode-only) going whole into the first commit

  const changeKeys = (d) => d.hunks.flatMap((hk, hi) => hunkKeys(hk, hi));
  const fileState = (d) => {
    const total = changeKeys(d).length;
    const n = total ? picked.get(d.path).size : whole.has(d.path) ? 1 : 0;
    return n === 0 ? 'none' : n >= (total || 1) ? 'all' : 'some';
  };
  const statusOf = (d) => (d.header.some((l) => l.startsWith('new file')) ? 'A' : d.header.some((l) => l.startsWith('deleted file')) ? 'D' : 'M');

  const first = h('textarea.composer-input.split-msg', { placeholder: 'Message for the selected changes', spellcheck: true, rows: 3 });
  const second = h('textarea.composer-input.split-msg', { placeholder: 'Message for the remaining changes', spellcheck: true, rows: 3 });
  const summary = h('div.split-summary');
  const splitBtn = h('button.btn.primary.wide', { onclick: () => submit() }, 'Split commit', kbd(...keymap.keys('split.submit')));
  for (const t of [first, second]) {
    t.addEventListener('input', update);
    t.addEventListener('keydown', (e) => {
      const id = keymap.match('split', e);
      if (id === 'split.submit') { e.preventDefault(); submit(); }
      else if (id === 'split.leave') { e.preventDefault(); e.stopPropagation(); el.focus(); }
    });
  }

  function toggleFile(d) {
    const keys = changeKeys(d);
    const on = fileState(d) !== 'all';
    if (!keys.length) on ? whole.add(d.path) : whole.delete(d.path);
    else picked.set(d.path, new Set(on ? keys : []));
    renderFiles();
    if (d.path === current) renderFile();
    update();
  }

  function renderFiles() {
    files.replaceChildren(...diffs.map((d) => {
      const st = fileState(d);
      const box = h('input', { type: 'checkbox', title: 'Put the whole file in the first commit', checked: st === 'all', onclick: (e) => e.stopPropagation(), onchange: () => toggleFile(d) });
      box.indeterminate = st === 'some';
      const total = changeKeys(d).length;
      const row = up.fileRow({ path: d.path, status: statusOf(d) }, () => { current = d.path; full = false; renderFiles(); renderFile(); },
        h('span.split-count', null, total ? `${picked.get(d.path).size}/${total}` : ''));
      row.prepend(box);
      row.dataset.path = d.path;
      row.classList.toggle('active', d.path === current);
      return row;
    }));
  }

  function renderFile() {
    const d = diffs.find((x) => x.path === current);
    if (!d) return main.replaceChildren(h('div.empty', null, 'No changes in this commit'));
    const sel = picked.get(d.path);
    const hunkBtns = [];
    const label = (keys) => (keys.every((k) => sel.has(k)) ? 'Deselect hunk' : 'Select hunk');
    const onSelect = () => { hunkBtns.forEach(([b, keys]) => { b.textContent = label(keys); }); renderFiles(); update(); };
    const hunkActions = (hi, hunk) => {
      const keys = hunkKeys(hunk, hi);
      const b = h('button.btn.ghost.tiny', { onclick: () => { const all = keys.every((k) => sel.has(k)); keys.forEach((k) => (all ? sel.delete(k) : sel.add(k))); renderFile(); onSelect(); } }, label(keys));
      hunkBtns.push([b, keys]);
      return b;
    };
    main.replaceChildren(
      h('div.diff-head', null, statusBadge(statusOf(d)), h('span.mono', null, d.path), h('span.spacer'),
        h('button.btn.subtle.small', { onclick: () => toggleFile(d) }, fileState(d) === 'all' ? 'Deselect file' : 'Select file', kbd(...keymap.keys('split.toggleFile')))),
      h('div.diff-scroll', null, renderDiff(d, { selectable: true, selection: sel, onSelect, hunkActions, full, onShowAll: () => { full = true; renderFile(); } })),
    );
  }

  function selection() {
    const out = {};
    for (const d of diffs) {
      const st = fileState(d);
      if (st === 'all') out[d.path] = 'all';
      else if (st === 'some') out[d.path] = [...picked.get(d.path)];
    }
    return out;
  }

  function update() {
    const n = diffs.filter((d) => fileState(d) !== 'none').length;
    const allIn = diffs.length && diffs.every((d) => fileState(d) === 'all');
    summary.textContent = !n ? 'Select the changes for the first commit.' : allIn ? 'Leave at least one change for the second commit.' : `First commit: changes in ${n} of ${diffs.length} file${diffs.length > 1 ? 's' : ''}. The rest go into the second.`;
    summary.classList.toggle('warn', !n || !!allIn);
    splitBtn.disabled = !n || !!allIn || !first.value.trim() || !second.value.trim();
  }

  async function submit() {
    update();
    if (splitBtn.disabled) { (!first.value.trim() ? first : !second.value.trim() ? second : null)?.focus(); return; }
    const extra = { files: selection(), messages: [first.value, second.value] };
    const ok = branch ? await up.switchRewrite('split', { sha }, branch, extra) : await act('Split commit', 'rewrite', ['split', sha, extra], { busy: 'Splitting commit…' });
    if (ok) closeSplit(false);
  }

  (async () => {
    let c;
    try { [c, diffs] = await Promise.all([up.loadCommit(sha), git('commitDiffs', sha)]); } catch (e) { main.replaceChildren(h('div.empty', null, e.message)); return; }
    for (const d of diffs) picked.set(d.path, new Set());
    current = diffs[0]?.path || null;
    first.value = c.message;
    side.replaceChildren(
      h('div.quick-head', null,
        h('button.btn.ghost.small', { onclick: () => closeSplit() }, icon('chevron', 12), 'Back', kbd(...keymap.keys('global.close'))),
        h('div.quick-title', null, `Split “${c.message.split('\n')[0]}”`),
        h('div.quick-meta', null, avatar(c.author, c.email, 16), c.author, ' · ', timeAgo(c.time), ' · ', h('span.mono', null, c.sha.slice(0, 7))),
      ),
      files,
      h('div.composer.split-composer', null,
        h('label.field', null, h('span.field-label', null, h('span.split-dot.one'), 'First commit · selected changes'), first),
        h('label.field', null, h('span.field-label', null, h('span.split-dot.two'), 'Second commit · remaining changes'), second),
        summary, splitBtn),
    );
    renderFiles();
    renderFile();
    update();
    el.focus();
  })();

  el.addEventListener('keydown', (e) => {
    if (isEditable(e.target)) return;
    const id = keymap.match('split', e);
    const i = diffs.findIndex((d) => d.path === current);
    if (id === 'split.next' || id === 'split.prev') {
      e.preventDefault();
      const n = diffs[Math.max(0, Math.min(diffs.length - 1, i + (id === 'split.next' ? 1 : -1)))];
      if (n) { current = n.path; full = false; renderFiles(); renderFile(); files.querySelector('.file-row.active')?.scrollIntoView({ block: 'nearest' }); }
    } else if (id === 'split.toggleFile' && diffs[i]) { e.preventDefault(); toggleFile(diffs[i]); }
    else if (id === 'split.message') { e.preventDefault(); (first.value.trim() ? second : first).focus(); }
  });
  return el;
}

export { splitView, openSplit, closeSplit };
