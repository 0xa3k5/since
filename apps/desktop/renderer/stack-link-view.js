// Make it a GitHub stack (AK-556): joins a chain of PRs (each targeting the branch of the one
// before it) into a native GitHub stack with `gh stack link` (main process, AK-555), all or
// nothing. Without GitHub CLI's stack extension the dialog installs it first, then asks. The list
// runs bottom to top; while linking each PR is ticked off; when GitHub refuses one, that PR turns
// red with the reason under it, nothing is linked and the button becomes Try again. A stack can't
// be unlinked, so it always asks first. Used from Merge plan's Pick step and ⌘K.
import { h, icon, kbd, toast } from './ui.js';
import * as keymap from './keymap.js';

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// chain: { prs: [bottom…top] }; prs: Map number → { title, branch }; base / remote: the chain's;
// extension: gh-stack installed; call: api.app; onLinked() once the stack exists.
let open = false;
export function openStackLink({ chain, prs = new Map(), base, remote, extension = true, call, onLinked = () => {} }) {
  if (open) return;
  open = true;
  const nums = chain.prs;
  let phase = extension ? 'confirm' : 'install'; // install | installing | confirm | linking | linked
  let failed = null; // { number, reason } from the last try
  let error = '';
  const marks = new Map(); // number → busy | ok

  const title = h('div.dialog-title');
  const body = h('div.dialog-body.stacklink');
  const primary = h('button.btn.primary', { type: 'submit' });
  const cancel = h('button.btn.ghost', { type: 'button', onclick: () => close() }, 'Cancel', kbd(...keymap.keys('dialog.cancel')));
  const form = h('form.dialog.stacklink-sheet', { onsubmit: (e) => { e.preventDefault(); next(); } },
    h('div.dialog-head', null, title), body, h('div.dialog-foot', null, cancel, h('span.spacer'), primary));
  const prev = document.activeElement;
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, form);
  overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); close(); } });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));

  function row(n, i) {
    const p = prs.get(n) || {};
    const fail = failed?.number === n;
    const m = fail ? 'fail' : marks.get(n);
    const lead = m === 'ok' ? icon('check', 11) : m === 'busy' ? icon('fetch', 11) : m === 'fail' ? icon('x', 11) : String(i + 1);
    return h('div.stacklink-pr' + (m ? `.${m}` : ''), { role: 'listitem' },
      h('span.stacklink-i', null, lead),
      h('span.stacklink-t', null, h('b', null, `#${n}`), ` ${p.title || ''}`),
      p.branch ? h('span.stacklink-b', null, p.branch) : null,
      fail ? h('span.stacklink-reason', null, failed.reason) : null);
  }

  function render() {
    const installing = phase === 'install' || phase === 'installing';
    title.replaceChildren(installing ? 'Install GitHub’s stack extension' : 'Make it a GitHub stack');
    if (installing) {
      body.replaceChildren(
        h('p.stacklink-p', null, 'Stacks are made with GitHub CLI’s stack extension. It isn’t installed.'),
        h('p.stacklink-p', null, h('code', null, 'gh extension install github/gh-stack')),
        error ? h('div.review-reason', null, error) : null);
    } else {
      body.replaceChildren(
        h('div.stacklink-list', { role: 'list', 'aria-label': `Pull requests, bottom to top, onto ${base}` }, ...nums.map(row)),
        error ? h('div.stacklink-error', { role: 'alert' }, error) : null,
        h('div.stacklink-fact', null, `Changes these ${nums.length} pull requests on GitHub, for everyone who works on them. A stack can’t be unlinked.`));
    }
    const busy = phase === 'installing' || phase === 'linking' || phase === 'linked';
    primary.replaceChildren(
      phase === 'install' ? 'Install' : phase === 'installing' ? 'Installing…' : busy ? 'Linking…' : failed || error ? 'Try again' : 'Make it a stack',
      busy ? null : kbd('↵'));
    primary.disabled = busy;
    cancel.disabled = busy;
  }

  async function next() {
    if (phase === 'install') return install();
    if (phase === 'confirm') return link();
  }

  async function install() {
    phase = 'installing'; error = '';
    render();
    const res = await call('pr-stack-install', remote).catch((e) => ({ error: { message: e.message } }));
    if (!open) return;
    if (res?.error) { phase = 'install'; error = res.error.message; render(); return primary.focus(); }
    toast('Installed gh-stack');
    phase = 'confirm';
    render();
    primary.focus();
  }

  async function link() {
    phase = 'linking'; failed = null; error = ''; marks.clear();
    for (const n of nums) marks.set(n, 'busy');
    render();
    const res = await call('pr-stack-link', remote, base, nums).catch((e) => ({ error: { message: e.message } }));
    if (!open) return;
    const out = res?.ok;
    if (res?.error || out?.failed) {
      marks.clear();
      failed = out?.failed || null;
      error = res?.error ? res.error.message : 'Nothing was linked.';
      phase = 'confirm';
      render();
      body.querySelector('.stacklink-pr.fail')?.scrollIntoView({ block: 'nearest' });
      return primary.focus();
    }
    // Linked: tick the PRs off bottom to top, then close.
    phase = 'linked';
    for (const n of nums) { marks.set(n, 'ok'); render(); if (!still()) await wait(40); }
    await wait(still() ? 0 : 240);
    toast(`#${nums[0]} → #${nums[nums.length - 1]} is a GitHub stack`);
    onLinked();
    close(true);
  }

  function close(force = false) {
    if (!force && (phase === 'installing' || phase === 'linking' || phase === 'linked')) return;
    open = false;
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 120);
    prev?.focus?.();
  }

  render();
  primary.focus();
}
