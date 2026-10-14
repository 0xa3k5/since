// Trial / licence UI: the topbar chip and the licence window. The main process owns the state
// (licence/index.js); this only shows it and forwards actions.
import { h, $, icon, kbd, toast, confirm } from './ui.js';
import * as keymap from './keymap.js';

const api = window.gitlanes;
const isMac = navigator.platform.startsWith('Mac');
export const LICENCE_KBD = isMac ? ['⌥', '⌘', 'L'] : ['Ctrl', 'Alt', 'L'];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function call(channel, ...args) {
  const r = await api.app(channel, ...args);
  if (r?.error) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
  return r?.ok;
}
export const buy = async () => { if (!(await api.app('licence-buy'))) toast('Buying isn’t set up in this build yet', { kind: 'error' }); };
const portal = async () => { if (!(await api.app('licence-portal'))) toast('The customer portal isn’t set up in this build yet', { kind: 'error' }); };

// Small status chip for the topbar. Nothing is shown once GitLanes is licensed.
export function licenceChip(s, onclick) {
  if (!s || s.mode === 'licensed') return null;
  const title = `Licence (${LICENCE_KBD.join('')})`;
  if (s.mode === 'trial') return h('button.licence-chip', { onclick, title }, icon('key', 12), `Trial · ${plural(s.trialDaysLeft, 'day')} left`);
  if (s.mode === 'unverified') return h('button.licence-chip.warn', { onclick, title }, icon('warning', 12), 'Verify licence');
  if (s.mode === 'revoked') return h('button.licence-chip.warn', { onclick, title }, icon('warning', 12), 'Licence inactive');
  return h('button.licence-chip.expired', { onclick, title }, icon('key', 12), 'Read-only · Buy GitLanes');
}

export function trialLine(s) {
  if (!s || s.mode === 'licensed') return null;
  if (s.mode === 'trial') return `Free trial: ${plural(s.trialDaysLeft, 'day')} left`;
  if (s.mode === 'unverified') return 'Read-only until your licence is verified';
  if (s.mode === 'revoked') return s.canMutate ? 'Licence inactive · trial still running' : 'Licence inactive · read-only';
  return 'Trial ended · read-only';
}

function copy(s) {
  switch (s.mode) {
    case 'licensed': return ['GitLanes is licensed', 'Thank you for buying GitLanes. Updates are included for life.'];
    case 'unverified': return ['Verify your licence', `GitLanes couldn’t check your licence for ${plural(s.graceDays, 'day')}, so it’s read-only for now. Your repositories are untouched. Connect to the internet and check again.`];
    case 'revoked': return ['Your licence isn’t active', `The licence server says this key is no longer active on this Mac. ${s.canMutate ? `Your trial still has ${plural(s.trialDaysLeft, 'day')} left.` : 'GitLanes is read-only for now; your repositories are untouched.'} If you think that’s wrong, check again. Otherwise deactivate it here and enter another key.`];
    case 'trial': return [`Free trial: ${plural(s.trialDaysLeft, 'day')} left`, 'Everything works during the trial. Afterwards GitLanes stays read-only, so you can still browse history and diffs, until you add a licence.'];
    default: return ['Your trial has ended', 'GitLanes is read-only now. You can still open repositories, browse history and read diffs. Buy GitLanes to make changes again: one payment, updates for life.'];
  }
}

const row = (label, value) => h('div.prop', null, h('span.prop-label', null, label), h('span.prop-value', null, value));
const day = (t) => new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });

// The licence window. `blocked` is set when a change was refused because the app is read-only.
export async function openLicence({ blocked = false } = {}) {
  if ($('.licence-overlay')) return;
  let status = await api.app('licence');
  let busy = null, error = null;
  const prev = document.activeElement;
  const input = h('input.input.mono', { type: 'text', placeholder: 'Paste your licence key', spellcheck: false, autocomplete: 'off', 'aria-label': 'Licence key',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); activate(); } } });
  const box = h('div.dialog.licence', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'licence-title' });
  const overlay = h('div.overlay.licence-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, box);
  overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel' && !$('.overlay:not(.licence-overlay)')) { e.stopPropagation(); close(); } });
  const off = api.on('licence', (s) => { status = s; render(); });

  async function run(label, fn) {
    busy = label; error = null; render();
    try { await fn(); } catch (e) { error = e.message; }
    busy = null; render();
  }
  const activate = () => run('Activating…', async () => {
    status = await call('licence-activate', input.value);
    if (status.mode === 'licensed') { input.value = ''; close(); toast('GitLanes is licensed. Thank you!', { kind: 'success' }); }
  });
  const check = () => run('Checking…', async () => {
    status = await call('licence-refresh');
    if (status.lastError) error = status.lastError;
  });
  const deactivate = async () => {
    const ok = await confirm('Deactivate this Mac?', `This frees one of your ${plural(status.licence?.limit || status.activationLimit, 'Mac')}. GitLanes on this Mac goes back to ${status.trialDaysLeft ? 'the trial' : 'read-only'} until you enter the key again.`, { submit: 'Deactivate' });
    if (ok) run('Deactivating…', async () => { status = await call('licence-deactivate'); });
  };

  function render() {
    const s = status;
    const [title, desc] = copy(s);
    const hadFocus = document.activeElement === input;
    const lic = s.licence;
    const keyEntry = s.mode === 'trial' || s.mode === 'expired';
    const btn = (cls, label, onclick, extra) => h('button.btn.' + cls, { type: 'button', disabled: Boolean(busy), onclick }, label, extra);
    box.replaceChildren(
      h('div.dialog-head', null,
        h('div.licence-mark', null, icon(s.mode === 'licensed' ? 'check' : s.mode === 'unverified' || s.mode === 'revoked' ? 'warning' : 'key', 16)),
        s.profile !== 'production' ? h('span.licence-profile', { title: 'Payments go to the test store in this build' }, `${s.profile} store`) : null,
        h('div.dialog-title', { id: 'licence-title' }, title),
        h('div.dialog-desc', null, blocked && !s.canMutate ? 'That change wasn’t made. ' + desc : desc)),
      h('div.dialog-body', null,
        s.notice && s.mode !== 'revoked' ? h('div.licence-note.warn', { role: 'status' }, icon('warning', 14), h('span', null, s.notice.message)) : null,
        lic ? h('div.licence-props', null,
          row('Licensed to', [lic.name, lic.email].filter(Boolean).join(' · ') || '—'),
          row('Key', h('span.mono', null, lic.maskedKey)),
          row('Macs', lic.limit ? `Up to ${lic.limit} at once` : 'Unlimited'),
          lic.revoked ? row('Status', 'Not active on this Mac') : row('Verified', s.lastError ? `${day(lic.validatedAt)} · offline, ${plural(lic.offlineDaysLeft, 'day')} left to verify` : day(lic.validatedAt)),
        ) : null,
        keyEntry ? h('label.field', null, h('span.field-label', null, 'Licence key'), input,
          h('span.field-hint', null, `It’s in your purchase email. One licence covers up to ${plural(s.activationLimit, 'Mac')}.`)) : null,
        error ? h('div.licence-note.error', { role: 'alert' }, icon('warning', 14), h('span', null, error)) : null,
      ),
      h('div.dialog-foot', null,
        keyEntry ? [
          btn('ghost', 'Not now', close, kbd(...keymap.keys('dialog.cancel'))),
          btn('subtle', 'Buy GitLanes', buy, icon('external', 13)),
          btn('primary', busy || 'Activate', activate, busy ? null : kbd('↵')),
        ] : [
          btn('ghost', 'Deactivate this Mac', deactivate),
          s.portalUrl ? btn('subtle', 'Manage activations', portal, icon('external', 13)) : null,
          s.mode === 'revoked' ? btn('subtle', 'Buy GitLanes', buy, icon('external', 13)) : null,
          s.mode === 'unverified' || s.mode === 'revoked'
            ? btn('primary', busy || 'Check again', check)
            : [btn('subtle', busy || 'Check now', check), btn('primary', 'Done', close, kbd(...keymap.keys('dialog.cancel')))],
        ],
      ),
    );
    if (hadFocus || (keyEntry && !box.contains(document.activeElement))) input.focus();
    else if (!box.contains(document.activeElement)) box.querySelector('.btn.primary')?.focus();
  }

  function close() {
    off();
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 120);
    prev?.focus?.();
  }

  document.body.append(overlay);
  render();
  requestAnimationFrame(() => overlay.classList.add('in'));
}
