// Merge plan sheet (Review's Ready to merge, AK-279): a safe order for the ready PRs, worked out
// locally (merge-plan.js), what would conflict afterwards among the PRs that aren't ready, then
// "Squash and merge N in order" merges them on GitHub one at a time. Before each merge the main
// process checks the PR and the base haven't changed since the plan; if they have, it stops and
// offers to re-plan. Remote merges can't be undone, so the sheet says so before the button.
//
// AK-542: every ready PR and whole native stack starts ticked; Space unticks one and the order is
// planned again. A stack is one row (→ shows its PRs), merged in one step with GitHub's stack
// merge. The split button's ▾ (⌥↵) picks the method, remembered per repo. "Clean up after
// merging" (off every time) removes each merged PR's worktree and local branch, undoably.
import { h, icon, kbd, toast, contextMenu, tipFor } from './ui.js';
import * as keymap from './keymap.js';
import { METHODS, METHOD_NAMES, statusText, forcedText, blockedText, warningText, startMethod, mergeLabel, orderLabel } from './merge-plan.js';

// ready / others: inbox PRs ({ number, title, head }) in Review's order; known: every inbox PR
// (titles and links for a stack's upper PRs); base: the base branch; remote: the PRs' remote name;
// method: start with this one (⌘K "Merge plan: rebase"), else the repo's; call: api.app;
// onSendBack(number) opens that PR's Send back sheet; onUndo() undoes the clean up; onDone()
// refreshes Review once anything merged.
let open = false;
export function openMergePlan({ ready, others = [], known = [], base, remote, method: asked = null, call, onSendBack = () => {}, onUndo = () => {}, onDone = () => {} }) {
  if (open) return;
  open = true;
  const prsBy = new Map([...known, ...ready, ...others].map((p) => [p.number, p]));
  const titleOf = (n) => prsBy.get(n)?.title || '';
  const othersArg = others.filter((p) => p.head).map((p) => ({ number: p.number, head: p.head }));
  let plan = null;
  let phase = 'planning'; // planning | planned | merging | stopped | done | failed
  let stopReason = '';
  let merged = 0;
  let total = 0;
  const status = new Map(); // unit key (PR number or stack id) → { text, kind }
  let left = ready.map((p) => p.number);
  let method = asked || 'squash';
  let methods = null; // { allowed, default, saved } from the first plan
  const tried = new Set();
  let picked = null; // unit keys ticked; null until the first plan: everything
  const notReady = new Map(); // number → why GitHub won't merge it now
  const stacks = new Map(); // id → { id, prs, linear, blocker }
  const expanded = new Set();
  let focusKey = null;
  let cleanup = false;
  const cleaned = { worktrees: 0, branches: 0, steps: 0, skipped: [], errors: [], undone: false }; // steps: journal entries

  const desc = h('div.dialog-desc');
  const body = h('div.dialog-body.mergeplan');
  const primary = h('button.btn.primary', { type: 'submit' });
  const caret = h('button.btn.primary.mergeplan-caret', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Choose the merge method', 'data-tip': tipFor('Merge method', 'mergePlan.methods'), onclick: () => methodMenu() }, icon('chevronDown', 12));
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => close() }, 'Cancel', kbd(...keymap.keys('dialog.cancel')));
  const form = h('form.dialog.wide.mergeplan-sheet', { onsubmit: (e) => { e.preventDefault(); next(); } },
    h('div.dialog-head', null, h('div.dialog-title', null, 'Merge plan'), desc),
    body,
    h('div.dialog-foot', null, cancel, h('span.mergeplan-split', null, primary, caret)));

  const prev = document.activeElement;
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, form);
  overlay.addEventListener('keydown', onKey);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));

  // Units: a ready PR's number, or a stack's id. Stack PRs never plan on their own.
  const memberOf = (n) => [...stacks.values()].find((st) => st.prs.includes(n));
  const stackOk = (st) => st.linear && !st.blocker;
  const singles = () => left.filter((n) => !memberOf(n) && !notReady.has(n));
  const pickable = () => [...singles(), ...[...stacks.values()].filter(stackOk).map((st) => st.id)];
  const isPicked = (k) => picked === null || picked.has(k);
  const running = () => phase === 'merging' || phase === 'done' || (phase === 'stopped' && merged > 0);
  const editable = () => phase === 'planned' || phase === 'planning' || phase === 'failed' || (phase === 'stopped' && !merged);

  const label = (n) => h('span.mergeplan-pr', null, h('b', null, `#${n}`), ` ${titleOf(n)}`);
  const stackLabel = (st) => h('span.mergeplan-pr', null, h('b', null, `Stack · #${st.prs[0]} → #${st.prs[st.prs.length - 1]}`), ` ${titleOf(st.prs[0])} `, h('span.mergeplan-tag', null, `${st.prs.length} PRs`));
  const sendBackLink = (n) => h('button.btn.ghost.small', { type: 'button', title: `Open #${n}’s fix prompt`, onclick: () => { close(); onSendBack(n); } }, 'Fix prompt');
  const stText = (text, kind) => h('span.mergeplan-status' + (kind ? `.${kind}` : ''), null, kind === 'busy' ? icon('fetch', 11) : kind === 'ok' ? icon('check', 11) : null, text);

  // One row of the order: a tick box (disabled when it can't be picked), its place, a ▸ for a
  // stack, the PR or stack, then its status. Rows are one tab stop: ↑↓ move, Space ticks.
  function unitRow({ key, n = null, can = true, status: st, extra = null, warn = false }) {
    const st0 = typeof key === 'string' ? stacks.get(key) : null;
    const on = can && isPicked(key);
    const box = editable() ? h('input', { type: 'checkbox', tabIndex: -1, checked: on, disabled: !can || phase === 'planning', 'aria-hidden': 'true', onclick: (e) => { e.preventDefault(); toggle(key); } }) : null;
    const chev = st0 ? h('span.mergeplan-chev', { onclick: () => expand(key, !expanded.has(key)) }, icon(expanded.has(key) ? 'chevronDown' : 'chevron', 12)) : null;
    const row = h('div.mergeplan-row.mergeplan-unit' + (warn ? '.warn' : '') + (on ? '' : '.off'), {
      tabIndex: key === focusKey ? 0 : -1, 'data-key': String(key), role: 'option', 'aria-selected': String(on), 'aria-disabled': String(!can),
      'aria-expanded': st0 ? String(expanded.has(key)) : undefined, onfocus: () => { focusKey = key; },
    }, box, h('span.mergeplan-n', null, n ? `${n}` : ''), chev, st0 ? stackLabel(st0) : label(key), st, extra);
    if (!st0 || !expanded.has(key)) return [row];
    return [row, ...st0.prs.map((x, i) => h('div.mergeplan-sub', null, label(x),
      st0.blocker?.number === x ? stText(st0.blocker.reason.replace(/\.$/, ''), 'warn') : i === 0 ? stText('bottom') : null))];
  }

  function render() {
    const order = plan?.order || [];
    const keys = pickable();
    const rows = [];
    desc.textContent = running() ? `Merging into ${base} · ${merged} of ${total} done` : `Merge the PRs you pick into ${base}, in an order with no conflicts`;
    if (phase === 'planning') rows.push(h('div.muted', null, 'Working out a safe order…'));
    else if (phase === 'failed') rows.push(h('div.review-reason.mergeplan-wrap', null, stopReason));
    if (plan) {
      const inPlan = new Set(order.map((s) => s.stack ?? s.number));
      const pickedN = keys.filter(isPicked).length;
      rows.push(h('span.field-label', null, order.length || pickedN ? orderLabel(running() ? order.length : pickedN, keys.length, running()) : 'Nothing can merge clean right now'));
      order.forEach((step, i) => {
        const key = step.stack ?? step.number;
        const st = status.get(key);
        rows.push(h('div.mergeplan-group', null, ...unitRow({ key, n: i + 1, status: st ? stText(st.text, st.kind) : stText(statusText(step, [...stacks.values()]), 'clean') })));
      });
      for (const b of plan.blocked) {
        const key = b.stack ?? b.number;
        rows.push(h('div.mergeplan-group', null, ...unitRow({ key, warn: true, status: stText(blockedText(b), 'warn'), extra: typeof key === 'number' ? sendBackLink(key) : null })));
        inPlan.add(key);
      }
      if (!running()) for (const k of keys) if (!inPlan.has(k) && !isPicked(k)) rows.push(h('div.mergeplan-group', null, ...unitRow({ key: k, status: stText('not in this plan', 'muted') })));
      for (const f of plan.forced) rows.push(h('div.mergeplan-note', null, forcedText(f, [...stacks.values()]).replace(/^./, (c) => c.toUpperCase())));
      if (!plan.complete) rows.push(h('div.mergeplan-note', null, 'There were too many orders to try them all; this is the best one found.'));
      if (expanded.size && !running()) rows.push(h('div.mergeplan-note', null, 'A stack merges as a whole, bottom to top, with GitHub’s stack merge.'));
      // Ready in Review but GitHub won't merge them now, and stacks that can't go whole.
      const bad = [...stacks.values()].filter((st) => !stackOk(st));
      const notNow = left.filter((n) => notReady.has(n) && !memberOf(n));
      if (!running() && (bad.length || notNow.length)) {
        rows.push(h('span.field-label', null, `Can’t be picked · ${bad.length + notNow.length}`));
        for (const st of bad) {
          const why = st.blocker ? stText(`#${st.blocker.number} isn’t ready, so the stack can’t merge`, 'warn') : stText('Needs a rebase first', 'warn');
          const url = !st.blocker && st.prs.map((x) => prsBy.get(x)?.url).find(Boolean);
          const gh = url ? h('button.btn.ghost.small', { type: 'button', onclick: () => call('external', url) }, 'Open on GitHub') : null;
          rows.push(h('div.mergeplan-group', null, ...unitRow({ key: st.id, can: false, status: why, extra: gh })));
        }
        for (const n of notNow) rows.push(h('div.mergeplan-group', null, ...unitRow({ key: n, can: false, status: stText(notReady.get(n).replace(/\.$/, ''), 'warn') })));
      }
      if (plan.warnings.length) {
        rows.push(h('span.field-label', null, `Will conflict afterwards · ${plan.warnings.length}`));
        for (const w of plan.warnings) rows.push(h('div.mergeplan-row.warn', null, h('span.mergeplan-status.warn', null, warningText(w)), h('span.muted.mergeplan-title', null, titleOf(w.number)), sendBackLink(w.number)));
      }
      if (running()) rows.push(h('div.mergeplan-note', null, `${METHOD_NAMES[method]}${cleanup ? ' · cleaning up after each merge' : ''}`));
      else if (order.length) {
        const box = h('input', { type: 'checkbox', checked: cleanup, onchange: () => { cleanup = box.checked; } });
        rows.push(h('label.mergeplan-opt', null, box, h('span', null, 'Clean up after merging', h('small', null, 'Remove each merged PR’s worktree and local branch. ⌘Z undoes it.'))));
      }
      if (phase === 'stopped') rows.push(h('div.review-reason.mergeplan-wrap', null, `Stopped: ${stopReason}. Re-plan to check the rest again.`));
      if (cleaned.worktrees || cleaned.branches) {
        const parts = [cleaned.worktrees && plural(cleaned.worktrees, 'worktree'), cleaned.branches && plural(cleaned.branches, 'branch')].filter(Boolean).join(' and ');
        const undo = h('button.btn.ghost.small', { type: 'button', disabled: cleaned.undone || phase === 'merging', onclick: async () => { cleaned.undone = true; render(); for (let i = 0; i < cleaned.steps; i++) await onUndo(); } }, icon('undo', 12), cleaned.undone ? 'Undone' : 'Undo');
        rows.push(h('div.mergeplan-row.mergeplan-cleaned', null, stText(`Cleaned up ${parts}`, 'ok'), undo));
      }
      for (const sk of cleaned.skipped) rows.push(h('div.mergeplan-note', null, `Kept ${sk.name}: ${sk.message}`));
      for (const err of cleaned.errors) rows.push(h('div.review-reason.mergeplan-wrap', null, `Couldn’t clean up: ${err}`));
      if (phase === 'planned' && order.length) rows.push(h('div.pr-remote-note', null, `Merges happen on GitHub and can’t be undone: ⌘Z won’t reverse them. They run one at a time, and stop if a PR, its checks or review, or ${base} changes on the way.`));
      if (!running()) rows.push(h('div.muted.mergeplan-note', null, 'Text conflicts only. Whether the result builds is up to CI.'));
    }
    const hadFocus = body.contains(document.activeElement);
    body.replaceChildren(...rows);
    if (hadFocus) focusRow(focusKey);
    const n = order.length;
    primary.replaceChildren(...(phase === 'planned' && n ? [icon('merge', 12), mergeLabel(method, n)]
      : phase === 'stopped' ? [icon('fetch', 12), 'Re-plan'] : phase === 'merging' ? ['Merging…'] : phase === 'planning' ? [mergeLabel(method, n || 0)] : ['Done']), kbd(...keymap.keys('mergePlan.merge')));
    primary.disabled = phase === 'planning' || phase === 'merging';
    caret.hidden = !editable();
    caret.disabled = phase === 'planning' || !methods;
    cancel.disabled = phase === 'merging';
    cancel.hidden = phase === 'done';
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : w.endsWith('h') ? 'es' : 's'}`;
  const rowEls = () => [...body.querySelectorAll('.mergeplan-unit')];
  function focusRow(key) {
    const els = rowEls();
    const el = els.find((r) => r.dataset.key === String(key)) || els[0];
    if (!el) return primary.focus();
    els.forEach((r) => { r.tabIndex = r === el ? 0 : -1; });
    el.focus();
  }
  const keyOfEl = (el) => (/^\d+$/.test(el.dataset.key) ? Number(el.dataset.key) : el.dataset.key);

  function toggle(key) {
    if (!editable() || phase === 'planning' || !pickable().includes(key)) return;
    // The plan takes native stacks all together (or none), so with two or more, one can't go alone yet.
    if (typeof key === 'string' && [...stacks.values()].filter(stackOk).length > 1) return toast('Stacks are picked together for now', { detail: 'Untick a single pull request instead, or merge the stacks on GitHub.' });
    picked ??= new Set(pickable());
    if (picked.has(key)) picked.delete(key); else picked.add(key);
    focusKey = key;
    replan();
  }
  function expand(key, on) {
    if (!stacks.has(key)) return;
    if (on) expanded.add(key); else expanded.delete(key);
    focusKey = key;
    render();
    focusRow(key);
  }

  function onKey(e) {
    if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); return close(); }
    const id = keymap.match('mergePlan', e);
    if (!id) return;
    const row = e.target.closest?.('.mergeplan-unit');
    if (id === 'mergePlan.methods') { e.preventDefault(); return methodMenu(); }
    if (id === 'mergePlan.merge') { if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return; e.preventDefault(); return next(); }
    if (!row) return;
    const key = keyOfEl(row);
    e.preventDefault();
    if (id === 'mergePlan.toggle') toggle(key);
    else if (id === 'mergePlan.expand') expand(key, true);
    else if (id === 'mergePlan.collapse') expand(key, false);
    else if (id === 'mergePlan.next' || id === 'mergePlan.prev') {
      const els = rowEls();
      const i = els.indexOf(row) + (id === 'mergePlan.next' ? 1 : -1);
      if (els[i]) focusRow(keyOfEl(els[i]));
    }
  }

  function methodMenu() {
    if (!editable() || !methods || phase === 'planning') return;
    const r = caret.getBoundingClientRect();
    const blurb = { squash: `One commit per PR on ${base}`, merge: 'Keeps every commit, adds a merge commit per PR', rebase: `Puts each PR’s commits on ${base}, no merge commit` };
    contextMenu(r.right - 280, r.top - 4, METHODS.map((m) => {
      const off = !methods.allowed.includes(m);
      return { label: [h('span.mergeplan-mname', null, METHOD_NAMES[m]), h('small', null, off ? 'Off in this repo’s settings' : blurb[m])], icon: m === method ? 'check' : null, disabled: off, run: () => pick(m) };
    }), { focus: METHODS.filter((m) => methods.allowed.includes(m)).indexOf(method) });
    // Open upwards, above the split button, like a pop-up button's menu.
    const menu = document.querySelector('body > .menu:last-of-type');
    if (menu) menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 6)}px`;
  }
  function pick(m) {
    call('merge-method-save', m).catch(() => {});
    if (m === method) return;
    method = m;
    replan();
  }

  async function replan() {
    phase = 'planning';
    status.clear();
    render();
    tried.add(method);
    const anyStack = !stacks.size || [...stacks.values()].some((st) => stackOk(st) && isPicked(st.id));
    const nums = left.filter((n) => (memberOf(n) ? anyStack : isPicked(n) || notReady.has(n)));
    const res = await call('merge-plan', remote, base, nums, othersArg, { method, stacks: anyStack }).catch((e) => ({ error: { message: e.message } }));
    if (!open) return;
    if (res?.error) {
      // Before the first plan the repo's methods aren't known: a method it turns off is tried once.
      const nextTry = !methods && /off in this repo/i.test(res.error.message) && METHODS.find((m) => !tried.has(m));
      if (nextTry) { if (asked === method) toast(res.error.message); method = nextTry; return replan(); }
      plan = null; phase = 'failed'; stopReason = `Couldn’t plan: ${res.error.message}`;
      return render();
    }
    const first = !methods;
    plan = res.ok;
    methods = plan.methods || { allowed: METHODS, default: null, saved: null };
    for (const st of plan.stacks || []) stacks.set(st.id, st);
    // A PR that wasn't ready and is now joins the picks; the rest stay out.
    for (const n of nums) if (notReady.has(n) && !plan.skipped.some((sk) => sk.number === n)) { notReady.delete(n); picked?.add(n); }
    for (const sk of plan.skipped) notReady.set(sk.number, sk.reason);
    if (first) {
      const want = asked && methods.allowed.includes(asked) ? asked : startMethod({ saved: methods.saved, allowed: methods.allowed, fallback: methods.default });
      if (asked && want === asked) call('merge-method-save', asked).catch(() => {});
      if (want !== method) { method = want; return replan(); }
    }
    phase = 'planned';
    render();
    if (first || !body.contains(document.activeElement)) focusRow(focusKey);
  }

  async function mergeAll() {
    phase = 'merging';
    total = plan.order.length;
    let baseSha = plan.baseSha;
    for (const step of plan.order) {
      const key = step.stack ?? step.number;
      const prs = step.prs || [step.number];
      const n = prs[prs.length - 1];
      status.set(key, { text: step.stack ? 'Merging the stack…' : 'Merging…', kind: 'busy' });
      render();
      const arg = step.stack
        ? { baseSha, method, cleanup, stack: prs.map((x) => ({ number: x, snap: plan.snapshots[x] })) }
        : { baseSha, method, cleanup, snap: plan.snapshots[n] };
      const res = baseSha
        ? await call('merge-plan-merge', remote, base, n, arg).catch((e) => ({ error: { message: e.message } }))
        : { ok: { stop: `couldn’t confirm where ${base} is after the last merge` } };
      if (res?.error || res.ok.stop) {
        status.set(key, { text: res.error ? 'Not merged' : 'Not merged: stopped', kind: 'warn' });
        stopReason = res.error ? `${step.stack ? `The stack #${prs[0]} → #${n}` : `#${n}`} failed: ${res.error.message}` : res.ok.stop;
        phase = 'stopped';
        break;
      }
      status.set(key, { text: 'Merged', kind: 'ok' });
      merged++;
      left = left.filter((x) => !prs.includes(x));
      const c = res.ok.cleaned;
      if (c) {
        cleaned.worktrees += c.worktrees;
        cleaned.branches += c.branches;
        if (c.worktrees || c.branches) cleaned.steps++; // each merge's clean up is its own undo step
        cleaned.skipped.push(...c.skipped);
        if (c.error) cleaned.errors.push(c.error);
      }
      baseSha = res.ok.commit;
    }
    if (phase === 'merging') { phase = 'done'; toast(`Merged ${merged} in order`, { kind: 'success' }); }
    render();
    primary.focus();
  }

  function next() {
    if (phase === 'planned' && plan?.order.length) return mergeAll();
    if (phase === 'stopped') return replan();
    if (phase !== 'merging' && phase !== 'planning') close();
  }

  function close() {
    if (phase === 'merging') return;
    open = false;
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 120);
    prev?.focus?.();
    if (merged || cleaned.undone) onDone();
  }
  replan();
}
