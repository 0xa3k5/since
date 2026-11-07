import { toast } from '../lib/ui.ts';
import { renderTabs } from './tabs-view.js';
import { api } from '../lib/app-helpers.ts';

// Updates
// here we tell the user and offer the restart. Results of a manual check show in the window that asked.

let update = { status: 'idle' };
let checkingToast = null, availableToast = null;
const announced = new Set();
const checkUpdates = () => api.app('check-updates');
const installUpdate = () => api.app('install-update');
async function toggleAutoUpdate() {
  const s = await api.app('set-auto-update', update.auto === false);
  toast(s.auto ? 'Automatic update checks are on' : 'Automatic update checks are off', { kind: 'success', detail: s.auto ? 'Since checks at launch and once a day.' : 'Check any time with ⌘K → Check for updates.' });
}

function showUpdate(s) {
  update = s;
  const manual = s.manual && document.hasFocus();
  const once = (key) => { if (announced.has(key) && !manual) return false; announced.add(key); return true; };
  if (s.status !== 'checking') { checkingToast?.close(); checkingToast = null; }
  if (s.status === 'checking' && manual && !checkingToast) checkingToast = toast('Checking for updates…', { kind: 'busy', timeout: 0 });
  else if (s.status === 'idle' && manual) toast('Since is up to date', { kind: 'success', detail: `Version ${s.current}` });
  else if (s.status === 'downloading' && manual) toast(`Downloading Since ${s.version}…`, { detail: 'It installs when you restart.' });
  else if (s.status === 'ready' && once(`ready ${s.version}`)) {
    availableToast?.close(); availableToast = null;
    toast(`Since ${s.version} is ready`, { kind: 'success', detail: 'Restart to finish updating.', timeout: 0, action: { label: 'Restart to update', run: installUpdate } });
  } else if (s.status === 'available' && once(`available ${s.version}`)) {
    availableToast?.close();
    availableToast = toast(`Since ${s.version} is available`, {
      detail: s.error ? `It couldn't be installed automatically: ${s.error}` : 'Download it to update.',
      timeout: 12_000,
      action: s.page ? { label: 'Download', run: () => api.app('external', s.page) } : null,
    });
  } else if (s.status === 'error' && manual) toast('Couldn’t check for updates', { kind: 'error', detail: s.error });
  else if (s.status === 'disabled' && manual) toast('Updates come with the packaged app', { detail: 'Development builds don’t update themselves.' });
}

// The window's tabs (AK-634), drawn by every tab's page.
const TAB_KEYS = ['tab.n1', 'tab.n2', 'tab.n3', 'tab.n4', 'tab.n5', 'tab.n6', 'tab.n7', 'tab.n8'];
let tabList = [], canReopenTab = false;
const showTabs = (list, canReopen) => { tabList = list; canReopenTab = Boolean(canReopen); renderTabs(document.getElementById('tabstrip'), list, (action, id) => api.app('tab', action, id)); };

// Other modules assign these through setters: an imported binding can't be assigned.
function setUpdate(value) { return (update = value); }

export { canReopenTab, tabList, TAB_KEYS, update, installUpdate, checkUpdates, toggleAutoUpdate, setUpdate, showUpdate, showTabs };
