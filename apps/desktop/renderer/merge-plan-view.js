// Merge plan sheet (Review's Ready to merge, AK-279): a safe order for the ready PRs, worked out
// locally (merge-plan.js), what would conflict afterwards among the PRs that aren't ready, then
// "Squash & Merge N in order" merges them on GitHub one at a time. Before each merge the main
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
//
// AK-556: a stack row is tagged Chain or GitHub stack. In Pick, a chain that can be linked offers
// Make it a GitHub stack (S on the row, stack-link-view.js); one that can't says why.
import { h, icon, kbd, toast, contextMenu, tipFor } from './ui.js';
import * as keymap from './keymap.js';
import { METHODS, METHOD_NAMES, statusText, forcedText, warningText, startMethod, mergeLabel, unitLabel, blockerText, mainBlocker, ownBlockers, anywayOnly, groupNeeds, groupChecks, stackName, cleanTitle } from './merge-plan.js';
import { buildPrompt } from './send-back.js';
import { openStackLink } from './stack-link-view.js';

// ready / others: inbox PRs ({ number, title, head }) in Review's order; known: every inbox PR
// (titles and links for a stack's upper PRs); base: the base branch; remote: the PRs' remote name;
// method: start with this one (⌘K "Merge plan: rebase"), else the repo's; anyway: start with Merge
// anyway on (⌘K "Merge plan: merge anyway"); call: api.app;
// onSendBack(number) opens that PR's Send back sheet; onUndo() undoes the clean up; onDone()
// refreshes Review once anything merged.
let open = false;
export function openMergePlan({ ready, others = [], known = [], base, remote, method: asked = null, anyway: startAnyway = true, targets = [], chosen = true, onTarget = null, call, onSendBack = () => {}, onUndo = () => {}, onDone = () => {} }) {
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
  const stacks = new Map(); // id → { id, prs, linear, blocker, native }
  const chains = new Map(); // id → { native, linkable, why } from app:pr-chains (AK-556)
  let extension = false; // GitHub CLI's stack extension is installed
  const expanded = new Set();
  let focusKey = null;
  let cleanup = false;
  // GitHub's own rules (AK): checks the base doesn't require hold nothing back. Merge lists them, with "Hold them back".
  let anyway = true; // Review passes anyway: false by default; GitHub's own rules win. ⌘K "merge anyway" is the same.
  const blockersBy = new Map(); // number → the plan's blockers for it (AK-550)
  let groups = []; // the last render's "Needs something first" groups
  let fixing = false;
  const cleaned = { worktrees: 0, branches: 0, steps: 0, skipped: [], errors: [], undone: false }; // steps: journal entries

  // AK-549 v2: three steps. Pick what to merge (what's ready starts ticked), Fix what's in the way
  // (one card per ticked PR or stack that can't merge yet), Merge in order. The stepper is the only
  // way between steps; the footer's step button is secondary until the last step.
  let step = 1;
  const wanted = new Set(); // PRs and stacks that can't merge yet, ticked in Pick: they get a card in Fix
  const body = h('div.dialog-body.mergeplan');
  const stepper = h('nav.mergeplan-stepper', { 'aria-label': 'Merge plan steps' });
  const primary = h('button.btn.primary', { type: 'submit' });
  const caret = h('button.btn.primary.mergeplan-caret', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Choose the merge method', 'data-tip': tipFor('Merge method', 'mergePlan.methods'), onclick: () => methodMenu() }, icon('chevronDown', 12));
  const split = h('span.mergeplan-split', null, primary, caret);
  const onward = h('button.btn', { type: 'button', onclick: () => goStep(step + 1) });
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => close() }, 'Cancel', kbd(...keymap.keys('dialog.cancel')));
  // The branch it merges into (AK-541, option A): any landing branch with open PRs. Switching opens
  // the plan again for that branch; the choice is remembered per repo.
  const targetBtn = h('button.mergeplan-target', { type: 'button', 'aria-haspopup': 'menu', 'data-tip': tipFor('Merge into', 'mergePlan.target'), onclick: () => targetMenu() }, base, targets.length > 1 ? icon('chevronDown', 12) : null);
  function targetMenu() {
    if (!onTarget || targets.length < 2 || phase === 'merging') return;
    const r = targetBtn.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, targets.map((t) => ({
      label: [h('span.mergeplan-mname', null, t.name), h('small', null, `${t.ready} ready · ${t.open} open`)],
      icon: t.name === base ? 'check' : null,
      run: () => { if (t.name !== base) { close(); onTarget(t.name); } },
    })), { focus: Math.max(0, targets.findIndex((t) => t.name === base)) });
  }
  const form = h('form.dialog.wide.mergeplan-sheet', { onsubmit: (e) => { e.preventDefault(); next(); } },
    h('div.dialog-head', null, h('div.dialog-title', null, 'Merge plan · into ', targetBtn)),
    stepper,
    body,
    h('div.dialog-foot', null, cancel, h('span.spacer'), onward, split));

  const prev = document.activeElement;
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, form);
  overlay.addEventListener('keydown', onKey);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));

  // Units: a ready PR's number, or a stack's id. Stack PRs never plan on their own.
  const memberOf = (n) => [...stacks.values()].find((st) => st.prs.includes(n));
  const stackOk = (st) => st.linear && !st.blocker;
  const fileNames = (fs = []) => (fs.length <= 3 ? fs.join(', ') : `${fs.slice(0, 3).join(', ')} and ${fs.length - 3} more`);
  const partialText = (k) => {
    const pt = stacks.get(k)?.partial;
    if (!pt) return null;
    const files = pt.files.map((f) => f.split('/').pop());
    return pt.upTo ? `Merges #${stacks.get(k).prs[0]} → #${pt.upTo}. #${pt.at} conflicts with ${base} in ${fileNames(files)}` : `#${pt.at} conflicts with ${base} in ${fileNames(files)}`;
  };
  const singles = () => left.filter((n) => !memberOf(n) && !notReady.has(n));
  const pickable = () => [...singles(), ...[...stacks.values()].filter(stackOk).map((st) => st.id)];
  const isPicked = (k) => picked === null || picked.has(k);
  const running = () => phase === 'merging' || phase === 'done' || (phase === 'stopped' && merged > 0);
  const editable = () => phase === 'planned' || phase === 'planning' || phase === 'failed' || (phase === 'stopped' && !merged);

  const label = (n, clean = false) => h('span.mergeplan-pr', null, h('b', null, `#${n}`), ` ${clean ? cleanTitle(titleOf(n)) : titleOf(n)}`);
  const isNative = (st) => Boolean(st.native || chains.get(st.id)?.native);
  const stackLabel = (st) => h('span.mergeplan-pr', null, h('span.mergeplan-kind' + (isNative(st) ? '.native' : ''), null, isNative(st) ? 'GitHub stack' : 'Chain'), ' ', h('b', null, `${stackName(st.prs.map(titleOf)) || `#${st.prs[0]} → #${st.prs[st.prs.length - 1]}`}`), ' ',
    h('span.mergeplan-tag', null, `${st.prs.length} PRs`), h('span.mergeplan-range', null, ` #${st.prs[0]} → #${st.prs[st.prs.length - 1]}`));
  const sendBackLink = (n) => h('button.btn.ghost.small', { type: 'button', title: `Open #${n}’s fix prompt`, onclick: () => { close(); onSendBack(n); } }, 'Fix prompt');
  const stText = (text, kind) => h('span.mergeplan-status' + (kind ? `.${kind}` : ''), null, kind === 'busy' ? icon('fetch', 11) : kind === 'ok' ? icon('check', 11) : null, text);
  const own = (n) => ownBlockers(blockersBy.get(n) || []);
  const prStatus = (n) => { const b = mainBlocker(own(n)); return b ? stText(blockerText(b, [...stacks.values()]).replace(/\.$/, ''), 'warn') : stText('', 'ok'); };

  // Every PR and stack in Review's order; a stack's PRs are one unit.
  function allKeys() {
    const out = [];
    for (const n of left) { const k = memberOf(n)?.id ?? n; if (!out.includes(k)) out.push(k); }
    return out;
  }
  const isReady = (k) => pickable().includes(k);
  const ticked = (k) => (isReady(k) ? isPicked(k) : wanted.has(k));
  const prCount = (keys) => keys.reduce((s, k) => s + (stacks.get(k)?.prs.length || 1), 0);

  // One row: a tick box (never disabled: a PR that can't merge yet goes to Fix), its place in the
  // order (Merge only), a chevron for a stack, the PR or stack with why it waits below it, then its
  // status. Rows are one tab stop: ↑↓ move, Space ticks.
  function unitRow({ key, n = null, box = true, status: st = null, extra = null, why = null, note = null }) {
    const st0 = typeof key === 'string' ? stacks.get(key) : null;
    const on = ticked(key);
    const cb = box && editable() ? h('input', { type: 'checkbox', tabIndex: -1, checked: on, 'aria-hidden': 'true', onclick: (e) => { e.preventDefault(); toggle(key); } }) : null;
    const chev = st0 ? h('button.mergeplan-chev' + (expanded.has(key) ? '.open' : ''), { type: 'button', tabIndex: -1, 'aria-label': expanded.has(key) ? 'Hide the stack’s pull requests' : 'Show the stack’s pull requests', onclick: () => expand(key, !expanded.has(key)) }, icon('chevronDown', 12)) : null;
    const main = h('span.mergeplan-main', null, st0 ? stackLabel(st0) : label(key), why ? h('span.mergeplan-why', null, why) : null, note ? h('span.mergeplan-why', null, note) : null);
    const row = h('div.mergeplan-row.mergeplan-unit' + (why ? '.has-why' : '') + (box && !on ? '.off' : ''), {
      tabIndex: key === focusKey ? 0 : -1, 'data-key': String(key), role: 'option', 'aria-selected': String(on),
      'aria-expanded': st0 ? String(expanded.has(key)) : undefined, onfocus: () => { focusKey = key; },
    }, cb, n === null ? null : h('span.mergeplan-n', null, n ? `${n}` : ''), chev, main, st, extra);
    if (!st0 || !expanded.has(key)) return [row];
    return [row, h('div.mergeplan-subs', { 'data-key': `${key}-subs` }, ...st0.prs.map((x) => h('div.mergeplan-sub', null, label(x, true), prStatus(x))))];
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
      const blockers = st.blocker ? (by.length ? by : [{ kind: 'other', required: true, detail: st.blocker.reason }]) : [{ kind: 'rebase', required: true, detail: 'It has merge commits. GitHub merges a stack only after it’s rebased' }];
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
  const names = (list, max = 3) => (list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`);
  function explain(g) {
    const n = g.entries.length;
    if (g.id === 'check-failed' || g.id === 'check-running') {
      const checks = groupChecks(g.entries, g.id);
      const req = checks.filter((c) => c.required).map((c) => c.name);
      const k = checks.length;
      const what = k ? `${k === 1 ? '1 check' : `${k} checks`} ${g.id === 'check-failed' ? 'failed' : 'still running'}${n > 1 ? ` on ${n}` : ''}: ${names(checks.map((c) => c.name))}.` : '';
      const quick = g.id === 'check-failed' && checks.some((c) => c.quick) ? ` ${k === 1 ? 'It' : 'They'} finished within seconds, so ${k === 1 ? 'it' : 'they'} probably didn’t run.` : '';
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

  // Fix: one card per ticked PR or stack that can't merge yet, each with its own fixes.
  const fixEntries = () => groups.flatMap((g) => g.entries.map((e) => ({ g, e }))).filter(({ e }) => e.picked || wanted.has(e.key));
  const groupOf = (k) => groups.find((g) => g.entries.some((en) => en.key === k));
  function card({ g, e }) {
    const one = { id: g.id, entries: [e] };
    const who = whoOf(one);
    const busy = fixing || phase === 'planning';
    const acts = actionsOf(one).map((a) => h('button.btn.small' + (a.primary ? '.primary' : '.ghost'), { type: 'button', disabled: busy, 'data-tip': tipFor(a.label, a.id), onclick: () => a.run() }, a.label, kbd(...keymap.keys(a.id))));
    // Two picked PRs that change the same lines: only one merges now. Taking the other unticks this one's rival.
    const rival = plan.blocked.find((b) => (b.stack ?? b.number) === e.key)?.with;
    if (rival != null) acts.unshift(h('button.btn.small.primary', { type: 'button', disabled: busy, onclick: () => instead(e.key, rival) }, `Merge ${unitLabel(e.key, [...stacks.values()])} instead`));
    // GitHub's stack page has the Rebase stack button.
    const url = e.blockers?.some((b) => b.kind === 'rebase') && prsBy.get(e.prs[0])?.url;
    if (url) acts.unshift(h('button.btn.small.primary', { type: 'button', disabled: busy, onclick: () => call('external', url) }, 'Rebase on GitHub'));
    acts.push(h('button.btn.small.ghost', { type: 'button', disabled: busy, onclick: () => leaveOut(e.key) }, 'Leave it out'));
    const more = ['conflicts', 'other'].includes(g.id) ? '' : explain(one);
    return h('div.mergeplan-card', { 'data-key': `card-${e.key}`, 'data-group': g.id },
      ...unitRow({ key: e.key, box: false, status: stText(TITLES[g.id], 'warn') }),
      h('div.mergeplan-fix', null,
        h('div.mergeplan-fix-t', null, h('span', null, e.why), h('span.mergeplan-who' + (who === 'You' ? '.you' : ''), null, who)),
        more ? h('small', null, more) : null,
        h('div.mergeplan-acts', null, ...acts)));
  }
  function instead(key, rival) {
    picked ??= new Set(pickable());
    picked.delete(rival);
    picked.add(key);
    toast(`Unticked ${unitLabel(rival, [...stacks.values()])}`);
    replan();
  }
  async function leaveOut(key) {
    await shrink(body.querySelector(`[data-key="card-${key}"]`));
    if (isReady(key)) { picked ??= new Set(pickable()); picked.delete(key); return replan(); }
    wanted.delete(key);
    render();
  }
  function pickAll(on) {
    picked = new Set(on ? pickable() : []);
    wanted.clear();
    if (on) for (const k of allKeys()) if (!isReady(k)) wanted.add(k);
    replan();
  }
  function goStep(k) {
    if (k < 1 || k > 3 || k === step || !editable()) return;
    const dir = k > step ? 1 : -1;
    step = k;
    render({ slide: dir });
  }

  // Motion: rows that move slide to their new place, a stack's PRs grow open and shrink shut,
  // a card that's left out shrinks away, and changing step slides the body. Off with reduced motion.
  const EASE = 'cubic-bezier(.2,.7,.2,1)';
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function shrink(el) {
    if (!el || still()) return Promise.resolve();
    el.style.overflow = 'hidden';
    return el.animate([{ height: `${el.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' }], { duration: 180, easing: EASE, fill: 'forwards' }).finished.catch(() => {});
  }
  function place(rows, slide) {
    const before = new Map([...body.querySelectorAll('[data-key]')].map((el) => [el.dataset.key, el.getBoundingClientRect().top]));
    body.replaceChildren(...rows);
    if (still()) return;
    if (slide) { body.animate([{ opacity: 0, transform: `translateX(${slide * 12}px)` }, { opacity: 1, transform: 'none' }], { duration: 180, easing: EASE }); return; }
    for (const el of body.querySelectorAll('[data-key]')) {
      const was = before.get(el.dataset.key);
      if (was != null) {
        const dy = was - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 220, easing: EASE });
      } else if (before.size && el.classList.contains('mergeplan-subs')) {
        el.animate([{ height: '0px', opacity: 0 }, { height: `${el.offsetHeight}px`, opacity: 1 }], { duration: 180, easing: EASE });
      }
    }
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

  const STEPS = ['Pick', 'Fix', 'Merge'];
  function render({ slide = 0 } = {}) {
    const order = plan?.order || [];
    const sts = [...stacks.values()];
    const nowN = order.reduce((k, st) => k + (st.prs?.length || 1), 0);
    groups = plan && !running() ? groupNeeds(needEntries()) : [];
    const fixes = plan ? fixEntries() : [];
    if (running()) step = 3;

    stepper.replaceChildren(...STEPS.map((name, i) => {
      const k = i + 1;
      const on = step === k && !running();
      const done = running() || step > k;
      const count = !plan ? '' : k === 1 ? prCount(allKeys().filter(ticked)) : k === 2 ? fixes.length : nowN;
      return h('button.mergeplan-step' + (on ? '.on' : done ? '.done' : ''), { type: 'button', disabled: !editable(), 'aria-current': on ? 'step' : undefined, onclick: () => goStep(k) },
        h('span.mergeplan-track'),
        h('span.mergeplan-slabel', null, h('span.mergeplan-dot', null, done && !on ? icon('check', 10) : String(k)), name, count === '' ? null : h('span.mergeplan-scount', null, String(count))));
    }));

    const rows = [];
    if (phase === 'failed') rows.push(h('div.review-reason.mergeplan-wrap', null, stopReason));
    if (!plan) {
      if (phase !== 'failed') rows.push(h('div.mergeplan-empty', null, 'Working out a safe order…'));
    } else if (step === 1) {
      const keys = allKeys();
      const on = keys.filter(ticked);
      const all = h('input', { type: 'checkbox', checked: on.length > 0 && on.length === keys.length, 'aria-label': 'Pick all or none', onclick: (e) => { e.preventDefault(); pickAll(on.length !== keys.length); } });
      all.indeterminate = on.length > 0 && on.length < keys.length;
      rows.push(h('label.mergeplan-all', null, all, h('span', null, 'What do you want to merge?'), h('span.mergeplan-sec-hint', null, `${prCount(on)} of ${prCount(keys)}`)));
      for (const k of keys) {
        const g = groupOf(k);
        const e = g?.entries.find((x) => x.key === k);
        const st = stacks.get(k);
        const c = st && !isNative(st) ? chains.get(k) : null;
        const link = c?.linkable && editable() ? h('button.btn.small.mergeplan-link', { type: 'button', tabIndex: -1, 'data-tip': tipFor('Make it a GitHub stack', 'mergePlan.stackLink'), onclick: () => stackLink(k) }, 'Make it a GitHub stack') : null;
        rows.push(h('div.mergeplan-group', null, ...unitRow({ key: k, why: e?.why || partialText(k), note: c && !c.linkable ? c.why : null, extra: link, status: g ? stText(TITLES[g.id], 'warn') : (stacks.get(k)?.prs || [k]).some((x) => own(x).length) ? stText('Checks failed, not required', 'warn') : stText('Ready', 'ok') })));
      }
    } else if (step === 2) {
      if (!fixes.length) rows.push(h('div.mergeplan-empty', null, 'Nothing to fix.'));
      for (const f of fixes) rows.push(card(f));
    } else {
      if (!order.length && !running()) rows.push(h('div.mergeplan-empty', null, 'Nothing can merge yet.'));
      order.forEach((st, i) => {
        const key = st.stack ?? st.number;
        const s = status.get(key);
        rows.push(h('div.mergeplan-group', null, ...unitRow({ key, n: i + 1, box: false, why: partialText(key), status: s ? stText(s.text, s.kind) : stText(statusText(st, sts), 'clean') })));
      });
      if (!running()) {
        for (const f of plan.forced) rows.push(h('div.mergeplan-note', null, forcedText(f, sts).replace(/^./, (c) => c.toUpperCase())));
        if (!plan.complete) rows.push(h('div.mergeplan-note', null, 'There were too many orders to try them all; this is the best one found.'));
        if (anyway) rows.push(h('div.mergeplan-row.mergeplan-anyway', null, h('span.mergeplan-status.warn', null, icon('warning', 11), `Merging past checks ${base} doesn’t require`),
          h('button.btn.ghost.small', { type: 'button', disabled: phase === 'planning', onclick: () => { anyway = false; replan(); } }, 'Hold them back')));
        if (plan.warnings.length) {
          rows.push(h('div.mergeplan-sec', null, h('span.field-label', null, `Will conflict afterwards · ${plan.warnings.length}`)));
          for (const w of plan.warnings) rows.push(h('div.mergeplan-row.warn', null, h('span.mergeplan-main', null, h('span.mergeplan-pr', null, h('b', null, `#${w.number}`), ` ${titleOf(w.number)}`), h('span.mergeplan-why', null, warningText(w))), sendBackLink(w.number)));
        }
        if (order.length) {
          const box = h('input', { type: 'checkbox', checked: cleanup, onchange: () => { cleanup = box.checked; } });
          rows.push(h('label.mergeplan-opt', null, box, h('span', null, 'Clean up after merging', h('small', null, 'Remove each merged PR’s worktree and local branch. ⌘Z undoes it.'))));
          rows.push(h('div.pr-remote-note', null, `Merges happen on GitHub and can’t be undone. They run one at a time and stop if a PR, its checks or review, or ${base} changes on the way.`));
        }
      } else rows.push(h('div.mergeplan-fine', null, `${METHOD_NAMES[method]}${cleanup ? ' · cleaning up after each merge' : ''}`));
      if (phase === 'stopped') rows.push(h('div.review-reason.mergeplan-wrap', null, `Stopped: ${stopReason}.`));
      if (cleaned.worktrees || cleaned.branches) {
        const parts = [cleaned.worktrees && plural(cleaned.worktrees, 'worktree'), cleaned.branches && plural(cleaned.branches, 'branch')].filter(Boolean).join(' and ');
        const undo = h('button.btn.ghost.small', { type: 'button', disabled: cleaned.undone || phase === 'merging', onclick: async () => { cleaned.undone = true; render(); for (let i = 0; i < cleaned.steps; i++) await onUndo(); } }, icon('undo', 12), cleaned.undone ? 'Undone' : 'Undo');
        rows.push(h('div.mergeplan-row.mergeplan-cleaned', null, stText(`Cleaned up ${parts}`, 'ok'), undo));
      }
      for (const sk of cleaned.skipped) rows.push(h('div.mergeplan-fine', null, `Kept ${sk.name}: ${sk.message}`));
      for (const err of cleaned.errors) rows.push(h('div.review-reason.mergeplan-wrap', null, `Couldn’t clean up: ${err}`));
    }
    const hadFocus = body.contains(document.activeElement);
    place(rows, slide);
    if (hadFocus && !slide) focusRow(focusKey);

    // Steps 1 and 2: a secondary button to the next step. Merge: the split button, named for the method.
    const last = step === 3 || running() || phase === 'failed';
    onward.hidden = last;
    onward.replaceChildren(STEPS[step] || '');
    onward.disabled = phase === 'planning' && !plan;
    split.hidden = !last;
    const n = order.length;
    primary.replaceChildren(...(phase === 'stopped' ? [icon('fetch', 12), 'Re-plan'] : phase === 'merging' ? ['Merging…'] : phase === 'done' ? ['Done']
      : phase === 'failed' ? [icon('fetch', 12), 'Plan again'] : [icon('merge', 12), mergeLabel(method, n)]), kbd(...keymap.keys('mergePlan.merge')));
    primary.disabled = phase === 'planning' || phase === 'merging' || (phase === 'planned' && !n);
    caret.hidden = !editable() || phase === 'failed';
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
    if (!editable() || phase === 'planning') return;
    focusKey = key;
    // Not ready yet: ticking it only gives it a card in Fix, so there's nothing to plan again.
    if (!isReady(key)) { if (wanted.has(key)) wanted.delete(key); else wanted.add(key); return render(); }
    // The plan takes native stacks all together (or none), so with two or more, one can't go alone yet.
    if (typeof key === 'string' && [...stacks.values()].filter(stackOk).length > 1) return toast('Stacks are picked together for now', { detail: 'Untick a single pull request instead, or merge the stacks on GitHub.' });
    picked ??= new Set(pickable());
    if (picked.has(key)) picked.delete(key); else picked.add(key);
    replan();
  }
  async function expand(key, on) {
    if (!stacks.has(key)) return;
    if (!on) await shrink(body.querySelector(`[data-key="${key}-subs"]`));
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
    if (id === 'mergePlan.target') { if (e.target.tagName === 'INPUT') return; e.preventDefault(); return targetMenu(); }
    if (FIXES.has(id)) {
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      // The focused row's group first, then the first group that offers the fix.
      const at = e.target.closest?.('.mergeplan-card')?.dataset.group;
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
    else if (id === 'mergePlan.stackLink') stackLink(key);
    else if (id === 'mergePlan.next' || id === 'mergePlan.prev') {
      const els = rowEls();
      const i = els.indexOf(row) + (id === 'mergePlan.next' ? 1 : -1);
      if (els[i]) focusRow(keyOfEl(els[i]));
    }
  }

  // Chains vs GitHub stacks (AK-555/556): asked once the plan has stacks, and again after a link.
  async function loadChains() {
    const res = await call('pr-chains', remote, base).catch(() => null);
    if (!open || !res?.ok) return;
    extension = res.ok.extension;
    chains.clear();
    for (const c of res.ok.chains) chains.set(c.id, c);
    render();
  }
  function stackLink(key) {
    const st = stacks.get(key);
    if (!st) return toast('Not a chain', { detail: 'Focus a chain of pull requests first.' });
    if (isNative(st)) return toast('Already a GitHub stack');
    const c = chains.get(key);
    if (!c) return toast('Still checking the chain', { detail: 'Try again in a moment.' });
    if (!c.linkable) return toast('Can’t make it a GitHub stack', { detail: c.why || undefined });
    if (!editable()) return;
    const prs = new Map(st.prs.map((n) => [n, { title: titleOf(n), branch: prsBy.get(n)?.branch }]));
    openStackLink({ chain: st, prs, base, remote, extension, call, onLinked: () => { loadChains(); replan(); } });
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
    // A stack that's held back is always planned again, so a fix (Merge anyway, a rebase) shows up.
    const anyStack = !stacks.size || [...stacks.values()].some((st) => !stackOk(st) || isPicked(st.id));
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
    // The plan's stacks replace the last ones: a stale "#222 holds up the stack" never lingers.
    if (plan.stacks) { stacks.clear(); for (const st of plan.stacks) stacks.set(st.id, st); }
    if (first && stacks.size) loadChains();
    // A PR that wasn't ready and is now joins the picks; the rest stay out.
    for (const n of nums) if (notReady.has(n) && !plan.skipped.some((sk) => sk.number === n)) { notReady.delete(n); picked?.add(n); }
    for (const sk of plan.skipped) notReady.set(sk.number, sk.reason);
    for (const n of nums) blockersBy.set(n, plan.blockers?.[n] || []);
    // First time in this repo: start on its default branch when that has open PRs.
    if (first && !chosen && onTarget && plan.defaultBranch && plan.defaultBranch !== base && targets.some((t) => t.name === plan.defaultBranch)) { close(); return onTarget(plan.defaultBranch, { save: false }); }
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
    if (step !== 3 && editable() && phase !== 'failed') return; // Enter only merges; the stepper moves between steps
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
