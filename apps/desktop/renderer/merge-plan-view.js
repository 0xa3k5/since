// Merge plan sheet (Review's Ready to merge, AK-279): a safe order for the ready PRs, worked out
// locally (merge-plan.js), what would conflict afterwards among the PRs that aren't ready, then
// "Merge N in order" squash-merges them on GitHub one at a time. Before each merge the main process
// checks the PR and the base haven't changed since the plan; if they have, it stops and offers to
// re-plan. Remote merges can't be undone, so the sheet says so before the button.
import { h, icon, kbd, toast } from './ui.js';
import * as keymap from './keymap.js';
import { statusText, forcedText, blockedText, warningText } from './merge-plan.js';

// ready / others: inbox PRs ({ number, title, head }) in Review's order; base: the base branch;
// remote: the PRs' remote name; call: api.app; onSendBack(number) opens that PR's Send back sheet;
// onDone() refreshes Review once anything merged.
let open = false;
export function openMergePlan({ ready, others = [], base, remote, call, onSendBack = () => {}, onDone = () => {} }) {
  if (open) return;
  open = true;
  const titles = new Map([...ready, ...others].map((p) => [p.number, p.title]));
  const othersArg = others.filter((p) => p.head).map((p) => ({ number: p.number, head: p.head }));
  let plan = null;
  let phase = 'planning'; // planning | planned | merging | stopped | done | failed
  let stopReason = '';
  let merged = 0;
  const status = new Map(); // number → { text, kind }
  let left = ready.map((p) => p.number);

  const body = h('div.dialog-body.mergeplan');
  const primary = h('button.btn.primary', { type: 'submit' });
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => close() }, 'Cancel', kbd(...keymap.keys('dialog.cancel')));
  const form = h('form.dialog.wide.mergeplan-sheet', { onsubmit: (e) => { e.preventDefault(); next(); } },
    h('div.dialog-head', null, h('div.dialog-title', null, 'Merge plan'),
      h('div.dialog-desc', null, `Squash-merge the ready pull requests into ${base} in an order with no conflicts`)),
    body,
    h('div.dialog-foot', null, cancel, primary));

  const prev = document.activeElement;
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, form);
  overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); close(); } });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));

  const label = (n) => h('span.mergeplan-pr', null, h('b', null, `#${n}`), ` ${titles.get(n) || ''}`);
  const sendBackLink = (n) => h('button.btn.ghost.small', { type: 'button', title: `Open #${n}’s fix prompt`, onclick: () => { close(); onSendBack(n); } }, 'Fix prompt');

  function render() {
    const order = plan?.order || [];
    const rows = [];
    if (phase === 'planning') rows.push(h('div.muted', null, 'Working out a safe order…'));
    else if (phase === 'failed') rows.push(h('div.review-reason.mergeplan-wrap', null, stopReason));
    if (plan) {
      rows.push(h('span.field-label', null, order.length ? `Order · ${order.length}` : 'Nothing can merge clean right now'));
      order.forEach((step, i) => {
        const st = status.get(step.number);
        rows.push(h('div.mergeplan-row', null, h('span.mergeplan-n', null, `${i + 1}`), label(step.number),
          h('span.mergeplan-status' + (st?.kind ? `.${st.kind}` : '.clean'), null, st?.kind === 'busy' ? icon('fetch', 11) : st?.kind === 'ok' ? icon('check', 11) : null, st ? st.text : statusText(step))));
      });
      for (const f of plan.forced) rows.push(h('div.mergeplan-note', null, forcedText(f)));
      if (!plan.complete) rows.push(h('div.mergeplan-note', null, 'There were too many orders to try them all; this is the best one found.'));
      for (const b of plan.blocked) rows.push(h('div.mergeplan-row.warn', null, label(b.number), h('span.mergeplan-status.warn', null, blockedText(b)), sendBackLink(b.number)));
      for (const sk of plan.skipped) rows.push(h('div.mergeplan-row.warn', null, label(sk.number), h('span.mergeplan-status.warn', null, `Left out: ${sk.reason}`)));
      if (plan.warnings.length) {
        rows.push(h('span.field-label', null, `Will conflict afterwards · ${plan.warnings.length}`));
        for (const w of plan.warnings) rows.push(h('div.mergeplan-row.warn', null, h('span.mergeplan-status.warn', null, warningText(w)), h('span.muted.mergeplan-title', null, titles.get(w.number) || ''), sendBackLink(w.number)));
      }
      if (phase === 'stopped') rows.push(h('div.review-reason.mergeplan-wrap', null, `Stopped: ${stopReason}. Re-plan to check the rest again.`));
      if (phase === 'planned' && order.length) rows.push(h('div.pr-remote-note', null, `Merges happen on GitHub and can’t be undone: ⌘Z won’t reverse them. They run one at a time, and stop if a PR, its checks or review, or ${base} changes on the way.`));
      rows.push(h('div.muted.mergeplan-note', null, 'Text conflicts only. Whether the result builds is up to CI.'));
    }
    body.replaceChildren(...rows);
    const n = order.length;
    primary.replaceChildren(...(phase === 'planned' && n ? [icon('merge', 12), `Merge ${n} in order`]
      : phase === 'stopped' ? [icon('fetch', 12), 'Re-plan'] : phase === 'merging' ? ['Merging…'] : ['Done']), kbd(...keymap.keys('dialog.submit')));
    primary.disabled = phase === 'planning' || phase === 'merging';
    cancel.disabled = phase === 'merging';
    cancel.hidden = phase === 'done';
  }

  async function replan() {
    phase = 'planning';
    status.clear();
    render();
    const res = await call('merge-plan', remote, base, left, othersArg).catch((e) => ({ error: { message: e.message } }));
    if (!open) return;
    if (res?.error) { plan = null; phase = 'failed'; stopReason = `Couldn’t plan: ${res.error.message}`; } else { plan = res.ok; phase = 'planned'; }
    render();
    primary.focus();
  }

  async function mergeAll() {
    phase = 'merging';
    let baseSha = plan.baseSha;
    for (const step of plan.order) {
      const n = step.number;
      status.set(n, { text: 'Merging…', kind: 'busy' });
      render();
      const res = baseSha
        ? await call('merge-plan-merge', remote, base, n, { baseSha, snap: plan.snapshots[n] }).catch((e) => ({ error: { message: e.message } }))
        : { ok: { stop: `couldn’t confirm where ${base} is after the last merge` } };
      if (res?.error || res.ok.stop) {
        status.set(n, { text: res.error ? 'Not merged' : 'Not merged: stopped', kind: 'warn' });
        stopReason = res.error ? `#${n} failed: ${res.error.message}` : res.ok.stop;
        phase = 'stopped';
        break;
      }
      status.set(n, { text: 'Merged', kind: 'ok' });
      merged++;
      left = left.filter((x) => x !== n);
      baseSha = res.ok.commit;
    }
    if (phase === 'merging') { phase = 'done'; toast(`Merged ${merged} pull request${merged === 1 ? '' : 's'} in order`, { kind: 'success' }); }
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
    if (merged) onDone();
  }
  replan();
}
