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
//
// AK-549: a sentence at the top names what's in the way. "Merges now" lists the order; "Needs
// something first" groups the rest by blocker (merge-plan.js groupNeeds), each group with who has
// to act and its fixes: View failure, Re-run, Merge anyway, Copy fix prompts, Mark ready, Approve.
import { h, icon, kbd, toast, contextMenu, tipFor } from './ui.js';
import * as keymap from './keymap.js';
import { METHODS, METHOD_NAMES, statusText, forcedText, warningText, startMethod, mergeLabel, orderLabel, unitLabel, blockerText, mainBlocker, ownBlockers, anywayOnly, groupNeeds, groupChecks, planSummary, stackName, cleanTitle } from './merge-plan.js';
import { buildPrompt } from './send-back.js';

// ready / others: inbox PRs ({ number, title, head }) in Review's order; known: every inbox PR
// (titles and links for a stack's upper PRs); base: the base branch; remote: the PRs' remote name;
// method: start with this one (⌘K "Merge plan: rebase"), else the repo's; anyway: start with Merge
// anyway on (⌘K "Merge plan: merge anyway"); call: api.app;
// onSendBack(number) opens that PR's Send back sheet; onUndo() undoes the clean up; onDone()
// refreshes Review once anything merged.
let open = false;
export function openMergePlan({ ready, others = [], known = [], base, remote, method: asked = null, anyway: startAnyway = false, call, onSendBack = () => {}, onUndo = () => {}, onDone = () => {} }) {
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
  let anyway = startAnyway === true; // take PRs whose only failing or running checks aren't required
  const blockersBy = new Map(); // number → the plan's blockers for it (AK-550)
  let groups = []; // the last render's "Needs something first" groups
  let fixing = false;
  const cleaned = { worktrees: 0, branches: 0, steps: 0, skipped: [], errors: [], undone: false }; // steps: journal entries

  const desc = h('div.dialog-desc');
  const body = h('div.dialog-body.mergeplan');
  const primary = h('button.btn.primary', { type: 'submit' });
  const caret = h('button.btn.primary.mergeplan-caret', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Choose the merge method', 'data-tip': tipFor('Merge method', 'mergePlan.methods'), onclick: () => methodMenu() }, icon('chevronDown', 12));
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => close() }, 'Cancel', kbd(...keymap.keys('dialog.cancel')));
  const form = h('form.dialog.wide.mergeplan-sheet', { onsubmit: (e) => { e.preventDefault(); next(); } },
    h('div.dialog-head', null, h('div.dialog-title', null, `Merge plan · into ${base}`), desc),
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

  const label = (n, clean = false) => h('span.mergeplan-pr', null, h('b', null, `#${n}`), ` ${clean ? cleanTitle(titleOf(n)) : titleOf(n)}`);
  const stackLabel = (st) => h('span.mergeplan-pr', null, h('b', null, `Stack · ${stackName(st.prs.map(titleOf)) || `#${st.prs[0]} → #${st.prs[st.prs.length - 1]}`}`), ' ',
    h('span.mergeplan-tag', null, `${st.prs.length} PRs`), h('span.mergeplan-range', null, ` #${st.prs[0]} → #${st.prs[st.prs.length - 1]}`));
  const sendBackLink = (n) => h('button.btn.ghost.small', { type: 'button', title: `Open #${n}’s fix prompt`, onclick: () => { close(); onSendBack(n); } }, 'Fix prompt');
  const stText = (text, kind) => h('span.mergeplan-status' + (kind ? `.${kind}` : ''), null, kind === 'busy' ? icon('fetch', 11) : kind === 'ok' ? icon('check', 11) : null, text);
  const own = (n) => ownBlockers(blockersBy.get(n) || []);
  const prStatus = (n) => { const b = mainBlocker(own(n)); return b ? stText(blockerText(b, [...stacks.values()]).replace(/\.$/, ''), 'warn') : stText('', 'ok'); };

  // One row: a tick box (disabled, with the reason as its tooltip, when it can't be picked), its
  // place in the order (order rows only), a chevron for a stack, the PR or stack with the reason it
  // waits wrapping below it, then its status. Rows are one tab stop: ↑↓ move, Space ticks.
  function unitRow({ key, n = null, can = true, status: st = null, extra = null, why = null, reason = '' }) {
    const st0 = typeof key === 'string' ? stacks.get(key) : null;
    const on = can && isPicked(key);
    let box = null;
    if (editable()) {
      box = h('input', { type: 'checkbox', tabIndex: -1, checked: on, disabled: !can || phase === 'planning', 'aria-hidden': 'true', onclick: (e) => { e.preventDefault(); toggle(key); } });
      if (!can) box = h('span.mergeplan-box', { 'data-tip': `Can’t pick it yet: ${reason || 'GitHub won’t merge it now'}` }, box);
    }
    const chev = st0 ? h('span.mergeplan-chev', { onclick: () => expand(key, !expanded.has(key)) }, icon(expanded.has(key) ? 'chevronUp' : 'chevronDown', 12)) : null;
    const main = h('span.mergeplan-main', null, st0 ? stackLabel(st0) : label(key), why ? h('span.mergeplan-why', null, why) : null);
    const row = h('div.mergeplan-row.mergeplan-unit' + (why ? '.has-why' : '') + (on ? '' : '.off'), {
      tabIndex: key === focusKey ? 0 : -1, 'data-key': String(key), role: 'option', 'aria-selected': String(on), 'aria-disabled': String(!can),
      'aria-description': !can ? `Can’t pick it yet: ${reason}` : undefined,
      'aria-expanded': st0 ? String(expanded.has(key)) : undefined, onfocus: () => { focusKey = key; },
    }, box, n === null ? null : h('span.mergeplan-n', null, n ? `${n}` : ''), chev, main, st, extra);
    if (!st0 || !expanded.has(key)) return [row];
    return [row, ...st0.prs.map((x) => h('div.mergeplan-sub', null, label(x, true), prStatus(x)))];
  }

  // ── Needs something first (AK-549) ──
  // Entries: PRs and stacks that can't merge yet, with the blockers that decide their group.
  function needEntries() {
    const out = [];
    const sts = [...stacks.values()];
    for (const b of plan.blocked) {
      const blockers = [{ kind: 'conflicts-pr', required: true, with: b.with, files: b.files }];
      out.push({ key: b.stack ?? b.number, prs: b.stack ? stacks.get(b.stack)?.prs || [] : [b.number], blockers, picked: true,
        why: b.with != null ? `${blockerText(blockers[0], sts)}. Merge ${unitLabel(b.with, sts)} first, then rebase` : `Conflicts in ${blockers[0].files?.length ? blockers[0].files.slice(0, 2).join(', ') : 'some files'} once the PRs above merge` });
    }
    for (const st of sts) {
      if (stackOk(st)) continue;
      const by = st.blocker ? own(st.blocker.number) : [];
      const blockers = st.blocker ? (by.length ? by : [{ kind: 'other', required: true, detail: st.blocker.reason }]) : [{ kind: 'rebase', required: true, detail: 'Its history isn’t linear, so it needs a rebase first' }];
      const kind = mainBlocker(blockers).kind;
      const text = blockerText(mainBlocker(blockers), sts).replace(/\.$/, '');
      const hits = st.prs.filter((x) => own(x).some((b) => b.kind === kind)).length || 1;
      // The PR that blocks the stack, in place; when it's every PR in the stack, just say so.
      const why = !st.blocker ? text : hits > 1 ? `${text} on ${hits === st.prs.length ? `all ${hits}` : `${hits} of ${st.prs.length}, first #${st.blocker.number}`}` : `#${st.blocker.number} holds up the stack: ${text}`;
      out.push({ key: st.id, prs: st.prs, via: st.blocker?.number ?? null, blockers, hits, why });
    }
    for (const n of left) {
      if (!notReady.has(n) || memberOf(n)) continue;
      const by = own(n);
      const blockers = by.length ? by : [{ kind: 'other', required: true, detail: notReady.get(n) }];
      out.push({ key: n, prs: [n], blockers, why: blockers.map((b) => blockerText(b, sts).replace(/\.$/, '')).join(' · ') });
    }
    return out;
  }
  const prsWith = (es, test) => es.flatMap((e) => e.prs.filter((x) => own(x).some(test)));
  // Merge anyway takes a PR (or a whole stack) only when nothing GitHub requires is in the way.
  const canAnyway = (e) => !e.picked && e.prs.every((x) => !own(x).length || anywayOnly(own(x))) && e.prs.some((x) => own(x).length);
  const whoOf = (g) => {
    if (g.id === 'check-failed') return g.entries.every((e) => e.blockers.filter((b) => b.kind === 'check-failed').every((b) => !b.required)) ? 'Not required' : 'Needs a fix';
    if (g.id === 'check-running') return 'Waiting on CI';
    if (g.id === 'draft') return 'You';
    if (g.id === 'review') return prsWith(g.entries, (b) => b.kind === 'needs-review' && b.canApprove).length ? 'You' : 'Needs a reviewer';
    return 'Needs a fix';
  };
  const TITLES = { 'check-failed': 'A check failed', 'check-running': 'Checks still running', conflicts: 'Conflicts', review: 'Needs a review', draft: 'Draft', behind: `Behind ${base}`, other: 'Can’t merge yet' };
  const GLYPHS = { 'check-failed': 'x', 'check-running': 'pending', conflicts: 'merge', review: 'eye', draft: 'edit', behind: 'rebase', other: 'warning' };
  const names = (list, max = 3) => (list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`);
  function explain(g) {
    const n = g.entries.length;
    if (g.id === 'check-failed' || g.id === 'check-running') {
      const checks = groupChecks(g.entries, g.id);
      const req = checks.filter((c) => c.required).map((c) => c.name);
      const what = checks.length ? `${names(checks.map((c) => c.name))} ${g.id === 'check-failed' ? 'failed' : 'still running'}${n > 1 ? ` on ${n}` : ''}.` : '';
      const quick = g.id === 'check-failed' && checks.some((c) => c.quick) ? ' It finished almost at once, so it probably never ran. Is CI out of minutes?' : '';
      const rule = !checks.length ? '' : !req.length ? ` ${base} doesn’t require ${checks.length === 1 ? 'it' : 'them'}.` : req.length === checks.length ? ` ${base} requires ${checks.length === 1 ? 'it' : 'them'}.` : ` ${base} requires ${names(req)}.`;
      return `${what}${quick}${rule}${g.id === 'check-running' ? ' Plan again once they pass.' : ''}`.trim();
    }
    if (g.id === 'conflicts') return 'Each needs a rebase onto what it conflicts with.';
    if (g.id === 'review') {
      const bs = g.entries.flatMap((e) => e.blockers).filter((b) => b.kind === 'needs-review');
      const need = Math.max(1, ...bs.map((b) => b.approvals || 0));
      const asked = [...new Set(bs.flatMap((b) => b.who || []))];
      return `${bs.some((b) => b.changes) ? 'Changes were requested. ' : ''}${base} needs ${need === 1 ? 'an approval' : `${need} approvals`}.${asked.length ? ` Asked: ${names(asked)}.` : ''}`;
    }
    if (g.id === 'draft') return 'Drafts can’t merge until they’re marked ready.';
    if (g.id === 'behind') return `${base} requires branches to be up to date before they merge.`;
    return 'GitHub won’t merge these yet.';
  }

  // A group's fixes, each with its sheet key: [{ id, label, run, primary }].
  function actionsOf(g) {
    const es = g.entries;
    const acts = [];
    if (g.id === 'check-failed') {
      const failed = (x) => own(x).find((b) => b.kind === 'check-failed');
      const first = es.flatMap((e) => (e.via ? [e.via, ...e.prs] : e.prs)).find((x) => failed(x));
      const url = first && (failed(first).checks.find((c) => c.url)?.url || (prsBy.get(first)?.url && `${prsBy.get(first).url}/checks`));
      acts.push({ id: 'mergePlan.viewFailure', label: es.length === 1 && es[0].via && es[0].hits === 1 ? `View #${es[0].via}’s failure` : 'View failure', run: () => (url ? call('external', url) : toast('GitHub didn’t link the failure')) });
      const re = prsWith(es, (b) => b.kind === 'check-failed' && b.rerun);
      if (re.length) acts.push({ id: 'mergePlan.rerun', label: 'Re-run', run: () => rerun(re) });
    }
    if ((g.id === 'check-failed' || g.id === 'check-running') && es.some(canAnyway)) acts.push({ id: 'mergePlan.anyway', label: 'Merge anyway', primary: !plan.order.length, run: () => { anyway = true; replan(); } });
    if (g.id === 'conflicts' || g.id === 'behind') {
      const prs = es.filter((en) => typeof en.key === 'number').map((en) => en.key);
      if (prs.length) acts.push({ id: 'mergePlan.copyPrompts', label: prs.length === 1 ? 'Copy fix prompt' : `Copy fix prompts for ${prs.length}`, primary: true, run: () => copyPrompts(prs, g.id) });
    }
    if (g.id === 'draft') {
      const prs = prsWith(es, (b) => b.kind === 'draft');
      if (prs.length) acts.push({ id: 'mergePlan.markReady', label: 'Mark ready', run: () => fix(prs, 'pr-ready', (k) => `Marked ${k === 1 ? 'it' : k} ready for review`) });
    }
    if (g.id === 'review') {
      const prs = prsWith(es, (b) => b.kind === 'needs-review' && b.canApprove);
      if (prs.length) acts.push({ id: 'mergePlan.approve', label: prs.length === 1 ? `Approve #${prs[0]}` : `Approve ${prs.length}`, run: () => fix(prs, 'pr-approve', (k) => `Approved ${k === 1 ? `#${prs[0]}` : k}`) });
    }
    return acts;
  }

  function groupEl(g) {
    const prsN = g.entries.reduce((k, e) => k + e.prs.length, 0);
    const who = whoOf(g);
    const head = h('div.mergeplan-ghead', null, h('span.mergeplan-glyph', null, icon(GLYPHS[g.id], 13)),
      h('div.mergeplan-gt', null, h('span.mergeplan-gtitle', null, TITLES[g.id], h('span.mergeplan-count', null, ` · ${prsN}`)), h('small', null, explain(g))),
      h('span.mergeplan-who' + (who === 'You' ? '.you' : ''), null, who));
    const rows = g.entries.flatMap((e) => unitRow({ key: e.key, can: Boolean(e.picked), why: e.why, reason: e.why, extra: null }));
    const acts = actionsOf(g).map((a) => h('button.btn.small' + (a.primary ? '.primary' : '.ghost'), { type: 'button', disabled: fixing || phase === 'planning', 'data-tip': tipFor(a.label, a.id), onclick: () => a.run() }, a.label, kbd(...keymap.keys(a.id))));
    return h('div.mergeplan-grp', { 'data-group': g.id }, head, ...rows, acts.length ? h('div.mergeplan-acts', null, ...acts) : null);
  }

  // Fixes on GitHub, one PR at a time; the plan is worked out again afterwards.
  async function fix(prs, channel, done) {
    if (fixing) return;
    fixing = true; render();
    let k = 0;
    for (const x of prs) {
      const res = await call(channel, remote, x, {}).catch((e) => ({ error: { message: e.message } }));
      if (res?.error) { toast(`Couldn’t do that on #${x}`, { kind: 'error', detail: res.error.message }); break; }
      k++;
    }
    fixing = false;
    if (!open) return;
    if (k) toast(done(k), { kind: 'success' });
    replan();
  }
  async function rerun(prs) {
    if (fixing) return;
    fixing = true; render();
    let runs = 0;
    for (const x of prs) {
      const res = await call('pr-rerun-failed', remote, x).catch((e) => ({ error: { message: e.message } }));
      if (res?.error) { toast(`Couldn’t re-run #${x}’s checks`, { kind: 'error', detail: res.error.message }); break; }
      runs += res.ok?.runs?.length || 0;
    }
    fixing = false;
    if (!open) return;
    if (runs) toast(`Re-running ${runs} failed run${runs === 1 ? '' : 's'}`, { kind: 'success', detail: 'Plan again once they pass.' });
    else toast('Nothing to re-run', { detail: 'Only GitHub Actions runs can be re-run from here.' });
    render();
  }
  async function copyPrompts(prs, id) {
    const text = prs.map((x) => {
      const pr = { ...prsBy.get(x), number: x, title: titleOf(x), base, mergeable: false };
      if (id === 'behind') return `PR #${x} "${pr.title}" is behind ${base}, and ${base} requires branches to be up to date. Rebase ${pr.branch || 'it'} onto ${base}, run the tests, then push.`;
      const conflicts = own(x).filter((b) => b.kind === 'conflicts-base' || b.kind === 'conflicts-pr').map((b) => ({ with: b.kind === 'conflicts-pr' && b.with != null ? unitLabel(b.with, [...stacks.values()]) : base, base: b.kind === 'conflicts-base', files: b.files || [] }));
      const blocked = plan.blocked.find((b) => b.number === x);
      if (!conflicts.length && blocked) conflicts.push({ with: blocked.with != null ? unitLabel(blocked.with, [...stacks.values()]) : 'the PRs merged before it', files: blocked.files || [] });
      return buildPrompt({ pr, conflicts }, 'conflict', undefined, { base });
    }).join('\n\n---\n\n');
    const res = await call('copy', text).catch((e) => ({ error: { message: e.message } }));
    if (res?.error) return toast('Couldn’t copy', { kind: 'error', detail: res.error.message });
    toast(prs.length === 1 ? 'Copied the fix prompt' : `Copied ${prs.length} fix prompts`, { kind: 'success' });
  }

  function render() {
    const order = plan?.order || [];
    const keys = pickable();
    const sts = [...stacks.values()];
    const rows = [];
    groups = plan && !running() ? groupNeeds(needEntries()) : [];
    if (running()) desc.textContent = `Merging into ${base} · ${merged} of ${total} done`;
    else if (!plan) desc.textContent = phase === 'failed' ? 'Couldn’t work out an order.' : 'Working out a safe order…';
    else {
      const now = order.reduce((k, st) => k + (st.prs?.length || 1), 0);
      const sum = planSummary({ now, groups, base });
      desc.replaceChildren(h('span.mergeplan-lead', null, sum.lead), sum.rest);
    }
    if (phase === 'planning' && !plan) rows.push(h('div.muted', null, 'Working out a safe order…'));
    else if (phase === 'failed') rows.push(h('div.review-reason.mergeplan-wrap', null, stopReason));
    if (plan) {
      const inPlan = new Set(order.map((s) => s.stack ?? s.number));
      for (const b of plan.blocked) inPlan.add(b.stack ?? b.number);
      const unpicked = running() ? [] : keys.filter((k) => !inPlan.has(k) && !isPicked(k));
      const label = running() ? orderLabel(order.length, keys.length, true) : `Merges now · ${order.reduce((k, st) => k + (st.prs?.length || 1), 0)}`;
      rows.push(h('div.mergeplan-sec', null, h('span.field-label', null, label), order.length > 1 && !running() ? h('span.mergeplan-sec-hint', null, 'in this order') : null));
      order.forEach((step, i) => {
        const key = step.stack ?? step.number;
        const st = status.get(key);
        rows.push(h('div.mergeplan-group', null, ...unitRow({ key, n: i + 1, status: st ? stText(st.text, st.kind) : stText(statusText(step, sts), 'clean') })));
      });
      for (const k of unpicked) rows.push(h('div.mergeplan-group', null, ...unitRow({ key: k, n: '', status: stText('not in this plan', 'muted') })));
      if (!order.length && !unpicked.length && !running()) rows.push(h('div.mergeplan-note', null, groups.length ? 'Nothing yet. Pick a fix below.' : 'Nothing is ready to merge.'));
      for (const f of plan.forced) rows.push(h('div.mergeplan-note', null, forcedText(f, sts).replace(/^./, (c) => c.toUpperCase())));
      if (!plan.complete) rows.push(h('div.mergeplan-note', null, 'There were too many orders to try them all; this is the best one found.'));
      if (expanded.size && !running() && order.some((s) => s.stack)) rows.push(h('div.mergeplan-note', null, 'A stack merges as a whole, bottom to top, with GitHub’s stack merge.'));
      if (anyway && !running()) {
        const back = h('button.btn.ghost.small', { type: 'button', disabled: phase === 'planning', onclick: () => { anyway = false; replan(); } }, 'Hold them back');
        rows.push(h('div.mergeplan-row.mergeplan-anyway', null, h('span.mergeplan-status.warn', null, icon('warning', 11), `Merging past checks ${base} doesn’t require`), back));
      }
      // Ready in Review but GitHub won't merge them now, grouped by what's in the way (AK-549).
      if (groups.length) {
        const all = groups.flatMap((g) => g.entries);
        const stackN = all.filter((en) => typeof en.key === 'string').length;
        const prN = all.reduce((k, e) => k + e.prs.length, 0);
        rows.push(h('div.mergeplan-sec', null, h('span.field-label', null, `Needs something first · ${stackN ? `${stackN} stack${stackN === 1 ? '' : 's'}, ${prN} PRs` : prN}`)));
        for (const g of groups) rows.push(groupEl(g));
      }
      if (plan.warnings.length) {
        rows.push(h('div.mergeplan-sec', null, h('span.field-label', null, `Will conflict afterwards · ${plan.warnings.length}`)));
        for (const w of plan.warnings) rows.push(h('div.mergeplan-row.warn', null, h('span.mergeplan-main', null, h('span.mergeplan-pr', null, h('b', null, `#${w.number}`), ` ${titleOf(w.number)}`), h('span.mergeplan-why', null, warningText(w))), sendBackLink(w.number)));
      }
      if (running()) rows.push(h('div.mergeplan-fine', null, `${METHOD_NAMES[method]}${cleanup ? ' · cleaning up after each merge' : ''}`));
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
      for (const sk of cleaned.skipped) rows.push(h('div.mergeplan-fine', null, `Kept ${sk.name}: ${sk.message}`));
      for (const err of cleaned.errors) rows.push(h('div.review-reason.mergeplan-wrap', null, `Couldn’t clean up: ${err}`));
      if (phase === 'planned' && order.length) rows.push(h('div.pr-remote-note', null, `Merges happen on GitHub and can’t be undone: ⌘Z won’t reverse them. They run one at a time, and stop if a PR, its checks or review, or ${base} changes on the way.`));
      if (!running()) rows.push(h('div.mergeplan-fine', null, 'Text conflicts only. Whether the result builds is up to CI.'));
    }
    const hadFocus = body.contains(document.activeElement);
    body.replaceChildren(...rows);
    if (hadFocus) focusRow(focusKey);
    const n = order.length;
    // The button always names the method and the count; Done only once the merges have run.
    primary.replaceChildren(...(phase === 'planned' && n ? [icon('merge', 12), mergeLabel(method, n)]
      : phase === 'stopped' ? [icon('fetch', 12), 'Re-plan'] : phase === 'merging' ? ['Merging…'] : phase === 'done' ? ['Done']
        : phase === 'failed' ? [icon('fetch', 12), 'Plan again'] : [icon('merge', 12), mergeLabel(method, n || 0)]), kbd(...keymap.keys('mergePlan.merge')));
    primary.disabled = phase === 'planning' || phase === 'merging' || (phase === 'planned' && !n);
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

  const FIXES = new Map([['mergePlan.anyway', 'merge anyway'], ['mergePlan.viewFailure', 'view'], ['mergePlan.rerun', 're-run'], ['mergePlan.approve', 'approve'], ['mergePlan.markReady', 'mark ready'], ['mergePlan.copyPrompts', 'copy a fix prompt for']]);
  function onKey(e) {
    if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); return close(); }
    const id = keymap.match('mergePlan', e);
    if (!id) return;
    const row = e.target.closest?.('.mergeplan-unit');
    if (id === 'mergePlan.methods') { e.preventDefault(); return methodMenu(); }
    if (FIXES.has(id)) {
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      // The focused row's group first, then the first group that offers the fix.
      const at = e.target.closest?.('.mergeplan-grp')?.dataset.group;
      const g = [...groups.filter((x) => x.id === at), ...groups].find((x) => actionsOf(x).some((a) => a.id === id));
      const act = g && actionsOf(g).find((a) => a.id === id);
      if (!act || fixing || phase === 'planning' || !editable()) return toast(`Nothing to ${FIXES.get(id)} here`);
      return act.run();
    }
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
    const res = await call('merge-plan', remote, base, nums, othersArg, { method, stacks: anyStack, anyway }).catch((e) => ({ error: { message: e.message } }));
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
    for (const n of nums) blockersBy.set(n, plan.blockers?.[n] || []);
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
    if (phase === 'planned') return; // nothing picked merges now: the button stays, disabled
    if (phase === 'stopped' || phase === 'failed') return replan();
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
