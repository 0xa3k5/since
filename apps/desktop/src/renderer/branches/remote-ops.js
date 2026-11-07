import { toast, dialog, confirm, contextMenu, palette } from '../lib/ui.ts';
import { remoteNameError, remoteUsage, removeRemoteWarning } from '../settings/remotes.js';
import { up } from '../lib/upcalls.ts';
import { state, keyText, api } from '../lib/app-helpers.ts';
import { act } from '../lib/bridge.js';

// Remote operations

// Managing remotes: add, edit URL, rename, remove (Remotes section, ⌥⇧⌘R, ⌘K, Preferences → Repository).
// Each is one undoable step (journal.runRemote); removing a remote that has branches asks first.
const remoteDone = { then: () => up.refreshRemotes() };
async function addRemote() {
  if (!state.repo) return;
  const v = await dialog({
    title: 'Add remote',
    fields: [
      { name: 'name', label: 'Name', value: state.remotes.length ? '' : 'origin', placeholder: 'upstream' },
      { name: 'url', label: 'URL', placeholder: 'git@github.com:owner/repo.git' },
    ],
    submit: 'Add',
  });
  if (!v) return;
  const name = v.name.trim(), url = v.url.trim(), bad = remoteNameError(name, state.remotes) || (url ? null : 'Enter a URL');
  if (bad) return toast(bad, { kind: 'error' });
  return act(`Add remote ${name}`, 'addRemote', [name, url], { success: `Added remote ${name}`, ...remoteDone });
}
async function editRemoteUrl(r) {
  const v = await dialog({ title: `Edit URL of ${r.name}`, fields: [{ name: 'url', label: 'URL', value: r.setUrl ?? r.url }], submit: 'Save' });
  const url = v?.url.trim();
  if (!url || url === (r.setUrl ?? r.url)) return;
  return act(`Edit URL of ${r.name}`, 'setRemoteUrl', [r.name, url], { success: `Changed the URL of ${r.name}`, ...remoteDone });
}
async function renameRemote(r) {
  const v = await dialog({ title: `Rename ${r.name}`, description: 'Its remote branches and the upstreams that point at it are renamed too.', fields: [{ name: 'name', label: 'New name', value: r.name }], submit: 'Rename' });
  const name = v?.name.trim();
  if (!v || name === r.name) return;
  const bad = remoteNameError(name, state.remotes, r.name);
  if (bad) return toast(bad, { kind: 'error' });
  return act(`Rename remote ${r.name} to ${name}`, 'renameRemote', [r.name, name], { success: `Renamed ${r.name} to ${name}`, ...remoteDone });
}
async function removeRemote(r) {
  const warn = removeRemoteWarning(remoteUsage(state.refs, r.name), keyText('edit.undo'));
  if (warn && !(await confirm(`Remove remote ${r.name}?`, warn, { submit: 'Remove' }))) return;
  return act(`Remove remote ${r.name}`, 'removeRemote', [r.name], { success: `Removed remote ${r.name}`, ...remoteDone });
}
const remoteItems = (r, group = `Remote ${r.name}`) => [
  { group, label: `Edit URL of ${r.name}…`, icon: 'edit', detail: r.label, keywords: 'remote url change set-url', run: () => editRemoteUrl(r) },
  { group, label: `Rename ${r.name}…`, icon: 'edit', keywords: 'remote rename', run: () => renameRemote(r) },
  { group, label: `Remove ${r.name}…`, icon: 'trash', keywords: 'remote remove delete', run: () => removeRemote(r) },
];
function remoteMenu(x, y, r) {
  contextMenu(x, y, [
    ...remoteItems(r).map(({ group, detail, keywords, ...i }) => ({ ...i, danger: i.icon === 'trash' })),
    '-',
    { label: 'Copy URL', icon: 'copy', run: () => up.copy(r.url, 'Copied URL') },
    r.web ? { label: 'Open on Hosting Service', icon: 'external', run: () => api.app('external', r.web) } : null,
    { label: 'Add Remote…', icon: 'plus', run: () => addRemote() },
  ].filter(Boolean));
}
// ⌥⇧⌘R: every remote action in one searchable list.
function remotesSwitcher() {
  if (!state.repo) return;
  palette(() => [
    { group: 'Remotes', label: 'Add remote…', icon: 'plus', keywords: 'remote new origin upstream fork', run: () => addRemote() },
    ...state.remotes.flatMap((r) => remoteItems(r)),
  ], { placeholder: 'Manage remotes…' });
}

// PRs refresh in the background, so Fetch resolves without waiting on `gh`.
function fetchAll() { return act('Fetch', 'fetch', [], { busy: 'Fetching all remotes…', success: 'Fetched all remotes', undoable: false, then: () => { up.refreshPrs().then(up.prefetchOnOpen); } }); }
function pull() { return act('Pull', 'pull', [], { busy: `Pulling ${state.head.branch || ''}…`, success: 'Pulled' }); }
async function push(force) { return act('Push', 'push', [{ force: force === true }], { busy: `Pushing ${state.head.branch || ''}…`, success: `Pushed ${state.head.branch || ''}`, undoable: false }); }

// Lower modules call these through `up` (lib/upcalls.js).
Object.assign(up, { push });

export { editRemoteUrl, remoteMenu, addRemote, fetchAll, pull, push, remotesSwitcher, remoteItems };
