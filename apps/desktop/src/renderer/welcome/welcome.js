import { h, toast, confirm } from '../lib/ui.ts';
import { setSwatches } from '../commit/diff.js';
import * as keymap from '../palette/keymap.ts';
import { setupView } from '../settings/setup-view.js';
import { shortcutsWindow } from '../palette/shortcuts-view.js';
import { SETUP_PREF, setupValues } from '../settings/setup.js';
import { up } from '../lib/upcalls.ts';
import { state, api, savePref, MOD } from '../lib/app-helpers.js';
import { THEMES, setTheme } from '../shell/theme.js';
import { update, setUpdate } from '../shell/updates.js';
import { aiOn, setupAi } from '../commit/ai-message.js';

// Welcome screen / repository lifecycle

// The welcome tour; ⌘Z / ⇧⌘Z drive it while no repository is open.
let tour = null;

// "Choose your defaults" (setup.js): first launch shows it in the tour's place; ⌘K reopens
// it. Switches write the same saved choices as ⌘K and the View menu, and apply at once.
const setupState = () => setupValues({ show: state.show, autoUpdate: update.auto });
async function setupFeature(id, on) {
  if (id === 'autoUpdate') { const s = await api.app('set-auto-update', on); setUpdate({ ...update, auto: s.auto }); return; }
  if (state.show[id] === on) return;
  if (state.repo) return up.toggleShow(id);
  state.show[id] = on;
  savePref('show', state.show);
  if (id === 'swatches') setSwatches(on);
}
// The PR row: a switch once GitHub CLI is installed and logged in, else Set up…. Without a
// repository the main process can't answer yet, so the row offers Set up….
async function prSetup() {
  const st = await api.app('pr-state').catch(() => null);
  if (!st) return { on: false, setup: true };
  return { on: st.enabled, setup: !st.enabled && (st.gh === 'missing' || up.prLoggedOut) };
}
const aiLabel = () => (aiOn() && state.ai.providers.find((p) => p.id === state.ai.provider)?.label) || 'Off';
function setupPanel(onDone, done) {
  let pr = { on: false, setup: true };
  const view = setupView({
    mod: MOD, values: setupState(), theme: state.theme, themes: THEMES, ai: aiLabel(), onToggle: setupFeature, onTheme: setTheme, done,
    onAi: async () => { await setupAi(); return aiLabel(); },
    pr: { setup: true },
    onPr: async (on) => { await (on ? up.setupPrs({ ask: false }) : up.turnOffPrs()); return prSetup(); },
    onDone: () => { savePref(SETUP_PREF, { done: true }); onDone(); },
  });
  // The AI choice is saved by the main process; show it once it's read.
  Promise.all([api.app('ai-settings').then((a) => { state.ai = a; }).catch(() => {}), prSetup().then((p) => { pr = p; })])
    .then(() => view.refresh({ ...setupState(), prs: pr.on }, state.theme, aiLabel(), pr));
  return view.el;
}
function openSetup() {
  if (!state.repo) return up.renderWelcome({ setup: true });
  if (document.querySelector('.overlay')) return;
  const prev = document.activeElement;
  const close = () => { overlay.classList.remove('in'); setTimeout(() => overlay.remove(), 120); prev?.focus?.(); };
  const view = setupPanel(close, 'Done');
  const overlay = h('div.overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, view);
  overlay.addEventListener('keydown', (e) => { if (keymap.match('dialog', e) === 'dialog.cancel') { e.stopPropagation(); close(); } });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('in'));
  view.querySelector('.switch')?.focus();
}

// The Keyboard Shortcuts window, with the keys of the view on screen listed first.
let shortcuts = null;
function shortcutsScope() {
  if (!state.repo) return tour ? 'tour' : 'recent';
  if (state.fileHistory) return 'fileHistory';
  if (state.review) return 'review';
  if (state.split) return 'split';
  if (state.quick) return 'quick';
  if (['remoteList', 'tagList', 'submoduleList'].includes(state.view)) return 'list';
  return ['commit', 'stashes', 'snapshots', 'worktrees', 'catchup', 'branches'].includes(state.view) ? state.view : 'map';
}
function openShortcuts() {
  if (shortcuts) return shortcuts.close();
  // A palette that just ran this command is still fading out; only a live dialog blocks the window.
  if (document.querySelector('.overlay:not(.closing)')) return;
  shortcuts = shortcutsWindow({
    first: shortcutsScope(),
    save: (o) => api.app('set-keymap', o),
    actions: { exportShortcuts, importShortcuts, resetShortcuts },
    onClose: () => { shortcuts = null; },
  });
}
// Export / import / reset the custom shortcuts (Keyboard Shortcuts window and ⌘K).
async function exportShortcuts() {
  try { const file = await api.app('keymap-export'); if (file) toast('Exported your shortcuts', { kind: 'success', detail: file }); }
  catch (e) { toast('Couldn’t export shortcuts', { kind: 'error', detail: e.message }); }
}
async function importShortcuts() {
  try { if (await api.app('keymap-import')) toast('Imported shortcuts', { kind: 'success' }); }
  catch (e) { toast('Couldn’t import shortcuts', { kind: 'error', detail: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
}
async function resetShortcuts() {
  if (!Object.keys(keymap.getOverrides()).length) return toast('Your shortcuts are already the defaults');
  if (!await confirm('Reset every shortcut to its default?', 'Your custom shortcuts are removed.', { submit: 'Reset All' })) return;
  await api.app('set-keymap', {});
  toast('Shortcuts reset to the defaults', { kind: 'success' });
}

// Other modules assign these through setters: an imported binding can't be assigned.
function setTour(value) { return (tour = value); }

export { exportShortcuts, importShortcuts, resetShortcuts, openShortcuts, openSetup, aiLabel, tour, setupPanel, setTour, shortcuts };
