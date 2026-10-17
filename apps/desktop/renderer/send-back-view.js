// Send back sheet (Review, AK-279): why the row is stuck, and an editable prompt built from facts
// (send-back.js) to hand to whoever fixes it. Local until you click: the commits on the base come
// from git; the failed CI log and posting a PR comment are `gh` calls on their own buttons, only
// while pull requests are on. The clipboard is written only by Copy prompt.
import { h, icon, kbd, toast, dialog, confirm } from './ui.js';
import * as keymap from './keymap.js';
import { TEMPLATE_IDS, TEMPLATE_LABELS, PLACEHOLDERS, templateFor, buildPrompt, appendLog } from './send-back.js';
import { stuckReason } from './review-rows.js';

const FROM = { repo: 'this repository’s', default: 'your default', builtin: 'the built-in' };

// row: a reviewRows row; base: the base branch; prsOn: pull requests on here; remote: the PR's
// remote name; call: api.app; git: the renderer's git(method, ...args).
let opening = false; // one sheet at a time, even while the first is still loading its facts
export async function openSendBack({ row, base = null, prsOn = false, remote = null, call, git }) {
  if (opening || document.querySelector('.dialog.sendback')) return;
  opening = true;
  try { await show({ row, base, prsOn, remote, call, git }); } finally { opening = false; }
}

async function show({ row, base, prsOn, remote, call, git }) {
  const { pr, lane } = row;
  const reason = stuckReason(row, { base, max: 20 }) || 'Nothing is stuck right now.';
  let templates = await call('sendback-templates').catch(() => null);
  let id = templateFor(row);
  let log = '';
  let edited = false;
  // The commits on the base that touched each file conflicting with it (local git, no network).
  let touches = {};
  const files = [...new Set((row.conflicts || []).filter((c) => c.base).flatMap((c) => c.files || []))];
  const head = lane?.head || lane?.branch;
  if (files.length && head && base) touches = await git('baseTouches', head, base, files).catch(() => ({}));

  const text = () => buildPrompt(row, id, templates ? Object.fromEntries(TEMPLATE_IDS.map((t) => [t, templates[t].text])) : undefined, { base, touches, log, reason });
  const area = h('textarea.input.sendback-prompt', { rows: 14, spellcheck: false, value: text(), 'aria-label': 'Prompt', oninput: () => { edited = true; } });
  const source = h('span.muted.sendback-source');
  const select = h('select.input', { 'aria-label': 'Template', onchange: () => { id = select.value; refill(); } },
    TEMPLATE_IDS.map((t) => h('option', { value: t, selected: t === id }, TEMPLATE_LABELS[t])));
  const syncSource = () => { source.textContent = templates ? `From ${FROM[templates[id].from]} template` : ''; };
  // Rebuilding drops hand edits, so ask first once there are some. → false when the user kept them.
  async function refill() {
    if (edited && !(await confirm('Replace your edits?', 'The prompt is rebuilt from the template.', { submit: 'Replace', destructive: false }))) return false;
    area.value = text();
    edited = false;
    syncSource();
    return true;
  }

  const title = pr ? `Fix prompt for #${pr.number}` : `Fix prompt for ${row.branch || row.title}`;
  const logBtn = prsOn && pr?.checks === 'failure' && remote ? h('button.btn.ghost', { type: 'button', title: 'Fetch the last 20 lines of the failed GitHub Actions log (gh run view --log-failed)', onclick: () => addLog() }, icon('external', 12), 'Add failed CI log') : null;
  const postBtn = prsOn && pr && remote ? h('button.btn.ghost', { type: 'button', title: `Post the prompt as a comment on #${pr.number} (gh pr comment)`, onclick: () => post() }, icon('external', 12), 'Post as PR comment') : null;
  const copyBtn = h('button.btn.primary', { type: 'submit' }, icon('copy', 12), 'Copy prompt', kbd(...keymap.keys('dialog.submit')));
  const form = h('form.dialog.wide.sendback', { onsubmit: (e) => { e.preventDefault(); copy(); } },
    h('div.dialog-head', null, h('div.dialog-title', null, title),
      h('div.dialog-desc', null, pr ? `${pr.title} · ${pr.branch || row.branch} → ${pr.base || base || 'base'}` : `${row.branch || row.title} → ${base || 'base'}`)),
    h('div.dialog-body', null,
      h('div.field', null, h('span.field-label', null, 'Why it’s stuck'), h('div.review-reason.sendback-reason', null, reason)),
      h('div.sendback-bar', null, h('label.sendback-template', null, h('span.field-label', null, 'Template'), select), source,
        h('button.btn.ghost', { type: 'button', title: 'Edit this template for this repository or for every repository', onclick: () => editTemplate() }, icon('edit', 12), 'Edit template…')),
      area,
      logBtn || postBtn ? h('div.sendback-bar', null, logBtn, postBtn) : null),
    h('div.dialog-foot', null,
      h('button.btn.ghost', { type: 'button', onclick: () => close() }, 'Cancel', kbd(...keymap.keys('dialog.cancel'))),
      copyBtn));
  area.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.submit') { e.preventDefault(); form.requestSubmit(); } });
  syncSource();

  const prev = document.activeElement;
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, form);
  overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); close(); } });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  copyBtn.focus();

  function close() {
    overlay.classList.remove('in');
    setTimeout(() => overlay.remove(), 120);
    prev?.focus?.();
  }
  async function copy() {
    await call('copy', area.value);
    toast('Prompt copied', { kind: 'success' });
    close();
  }
  async function addLog() {
    logBtn.disabled = true;
    const t = toast(`Fetching the failed log of #${pr.number}…`, { kind: 'busy', timeout: 0 });
    const res = await call('pr-failed-log', remote, pr.number).catch((e) => ({ error: { message: e.message } }));
    t.close();
    logBtn.disabled = false;
    if (res?.error) return toast('Couldn’t fetch the failed log', { kind: 'error', detail: res.error.message });
    if (!res.ok.log) return toast('No failed GitHub Actions log to add', { detail: 'The failing checks may run outside GitHub Actions.' });
    log = res.ok.log;
    if (!(await refill())) area.value = appendLog(area.value, log); // kept the edits: the log goes at the end
  }
  async function post() {
    if (!(await confirm(`Post the prompt on #${pr.number}?`, 'It’s added as a comment on GitHub, where everyone with access sees it. This can’t be undone from GitLanes.', { submit: 'Post comment', destructive: false }))) return;
    postBtn.disabled = true;
    const res = await call('pr-comment', remote, pr.number, { body: area.value }).catch((e) => ({ error: { message: e.message } }));
    postBtn.disabled = false;
    if (res?.error) return toast(`Couldn’t comment on #${pr.number}`, { kind: 'error', detail: res.error.message });
    toast(`Posted on #${pr.number}`, { kind: 'success' });
    close();
  }
  async function editTemplate() {
    const cur = templates?.[id];
    const v = await dialog({
      title: `Edit the ${TEMPLATE_LABELS[id]} template`,
      description: `Placeholders: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}. Leave it empty to go back to ${cur?.from === 'repo' ? 'your default' : 'the built-in one'}.`,
      wide: true,
      submit: 'Save template',
      fields: [
        { name: 'text', multiline: true, rows: 12, value: cur?.text || '' },
        { name: 'scope', type: 'select', label: 'Use it for', value: cur?.from === 'default' ? 'default' : 'repo', options: [{ value: 'repo', label: 'This repository' }, { value: 'default', label: 'Every repository (your default)' }] },
      ],
    });
    if (!v) return;
    try { templates = await call('sendback-template-save', id, v.text, v.scope); } catch (e) { return toast('Couldn’t save the template', { kind: 'error', detail: e.message }); }
    if (edited) await refill(); // asks before dropping hand edits
    else area.value = text();
    syncSource();
    toast(`Saved the ${TEMPLATE_LABELS[id]} template`, { kind: 'success' });
  }
}
