// The application menu and the keymap it shows. Rebuilt when another module calls menuChanged().
import electron from 'electron';
const { app, BaseWindow, dialog, Menu } = electron;
import fs from 'node:fs';
import * as updater from './updater.ts';
import * as check from './ipc.ts';
import { onMenuChange, menuChanged } from './app-events.ts';
import * as keymap from '../renderer/palette/keymap.ts';
import { isMac, writeSettings, readRecent, THEMES, THEME_LABELS, currentTheme } from './settings.ts';
import { sessions } from './session.ts';
import { handle } from './handlers/handle.ts';
import { broadcast, windowOf, activeTab, focusedHost, newTab, createWindow, hasClosedTabs, reopenClosed, closeTab, setTheme, cycleTheme, TAB_KEYS } from './windows.ts';
import { setAutoUpdate } from './handlers/app.ts';

type Item = Electron.MenuItemConstructorOptions;
// Menu items that only show when `cond` holds.
const when = (cond: boolean, items: Item[]): Item[] => (cond ? items : []);
const acc = (id: string): string | undefined => keymap.accelerator(id, isMac) ?? undefined;

// Custom key bindings: overrides only, under `keymap` in settings.json. A change rebuilds the menu and reaches
// every window, so menus, ⌘K and the rest show the new keys without a restart.
function setKeymap(o: Record<string, unknown>) {
  keymap.setOverrides(o);
  const next = keymap.getOverrides();
  writeSettings({ keymap: next });
  menuChanged();
  broadcast('keymap', next);
  return next;
}
handle('app:keymap', () => keymap.getOverrides());
// While the Keyboard Shortcuts window records new keys, the menu must not run the keys being pressed.
// A reload or crash mid-record must not leave the menu shortcuts off for that window.
const recordWatched = new WeakSet<Electron.WebContents>();
handle('app:keymap-recording', (e, on) => {
  const wc = e.sender;
  wc.setIgnoreMenuShortcuts(check.bool(on, 'recording'));
  if (!on || recordWatched.has(wc)) return;
  recordWatched.add(wc);
  const off = () => { if (!wc.isDestroyed()) wc.setIgnoreMenuShortcuts(false); };
  wc.on('did-navigate', off);
  wc.on('render-process-gone', off);
});
handle('app:set-keymap', (_e, o) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new check.IpcArgError('key bindings: expected an object');
  return setKeymap(o as Record<string, unknown>); // sanitize() drops unknown commands, reserved keys and bad bindings
});
handle('app:keymap-export', async (e) => {
  const opts: Electron.SaveDialogOptions = { defaultPath: 'since-shortcuts.json', message: 'Export your custom shortcuts' };
  const win = windowOf(e);
  const res = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts));
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, JSON.stringify({ since: 'keymap', version: 1, keymap: keymap.getOverrides() }, null, 2));
  return res.filePath;
});
handle('app:keymap-import', async (e) => {
  const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }], message: 'Import shortcuts' };
  const win = windowOf(e);
  const res = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
  if (res.canceled || !res.filePaths[0]) return null;
  let data: { since?: unknown; gitlanes?: unknown; keymap?: unknown } | null;
  try { data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')); } catch { throw new Error('That file isn\u2019t a shortcuts file.'); }
  const o = data?.since === 'keymap' || data?.gitlanes === 'keymap' ? data.keymap : data; // gitlanes: exports from before the rename
  return setKeymap({ ...keymap.getOverrides(), ...keymap.sanitize(o) });
});
const send = (cmd: string, ...args: unknown[]) => () => activeTab()?.webContents.send('command', cmd, ...args);


export function buildMenu(): void {
  const item = (label: string, accelerator: string | undefined, cmd: string, ...args: unknown[]): Item => ({ label, accelerator, click: send(cmd, ...args) });
  const journal = sessions.get(activeTab()?.id ?? -1)?.journal;
  const front = focusedHost();
  const open = front?.tabs || [];
  const nextUndo = journal?.undo.top, nextRedo = journal?.redo.top;
  const update = updater.getState();
  const updateItem: Item = update.status === 'ready'
    ? { label: `Restart to Update to ${update.version}`, click: () => updater.install() }
    : { label: 'Check for Updates…', enabled: update.status !== 'checking', click: () => updater.check({ manual: true }) };
  const autoItem: Item = { label: 'Automatically Check for Updates', type: 'checkbox', checked: update.auto !== false, click: (mi) => setAutoUpdate(mi.checked) };
  const template: Item[] = [
    ...when(isMac, [{
      label: app.name,
      submenu: [{ role: 'about' }, updateItem, autoItem, { type: 'separator' }, item('Settings…', acc('app.settings'), 'preferences'), { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
    }]),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: acc('file.newTab'), click: newTab },
        { label: 'New Window', accelerator: acc('file.newWindow'), click: () => createWindow() },
        { label: 'Reopen Closed Tab', accelerator: acc('file.reopenTab'), enabled: hasClosedTabs(), click: reopenClosed },
        item('New Repository…', acc('file.init'), 'init'),
        item('Open Repository…', acc('file.open'), 'open'),
        item('Clone Repository…', acc('file.clone'), 'clone'),
        item('Switch Repository…', acc('file.repoSwitch'), 'repoSwitch'),
        {
          label: 'Open Recent',
          submenu: readRecent().slice(0, 10).map((rr) => ({ label: rr.name, sublabel: rr.root, click: send('open', rr.root) })),
        },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: acc('file.close'), click: () => closeTab() },
        { label: 'Close Window', accelerator: acc('file.closeWindow'), click: () => BaseWindow.getFocusedWindow()?.close() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item(nextUndo ? `Undo ${nextUndo.label}` : 'Undo', acc('edit.undo'), 'undo'),
        item(nextRedo ? `Redo ${nextRedo.label}` : 'Redo', acc('edit.redo'), 'redo'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', acc('edit.find'), 'search'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Command Menu', acc('view.palette'), 'palette'),
        { type: 'separator' },
        item('Back', acc('view.back'), 'back'),
        item('Forward', acc('view.forward'), 'forward'),
        { type: 'separator' },
        item('Since', acc('view.catchup'), 'view', 'catchup'),
        item('Review', acc('view.lanes'), 'view', 'lanes'),
        item('Map', acc('view.map'), 'view', 'map'),
        item('Commit', acc('view.commit'), 'view', 'commit'),
        { type: 'separator' },
        item('Branches', acc('view.branches'), 'view', 'branches'),
        item('Remotes', acc('view.remoteList'), 'view', 'remoteList'),
        item('Tags', acc('view.tagList'), 'view', 'tagList'),
        item('Worktrees', acc('view.worktrees'), 'view', 'worktrees'),
        item('Stashes', acc('view.stashes'), 'view', 'stashes'),
        item('Submodules', acc('view.submoduleList'), 'view', 'submoduleList'),
        { type: 'separator' },
        item('Repository Settings…', acc('view.config'), 'preferences', 'repository'),
        { type: 'separator' },
        item('Toggle Sidebar', acc('view.sidebar'), 'sidebar'),
        item('Show Tags', acc('view.tags'), 'toggle', 'tags'),
        item('Show Remote Branches', acc('view.remotes'), 'toggle', 'remotes'),
        item('Show Colour Swatches in Diffs', acc('view.swatches'), 'toggle', 'swatches'),
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            ...THEMES.map((mode): Item => ({ label: THEME_LABELS[mode], type: 'radio', checked: currentTheme() === mode, click: () => setTheme(mode) })),
            { type: 'separator' },
            { label: 'Cycle Theme', accelerator: acc('view.cycleTheme'), click: cycleTheme },
          ],
        },
        { type: 'separator' },
        // No window reload in packaged builds: ⌘R stays free for Review's reload, and a window reload drops
        // in-memory state (AK-362). Dev builds keep it on F5.
        ...when(!app.isPackaged, [{ role: 'reload', accelerator: 'F5' }, { role: 'toggleDevTools' }]), { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        item('History & Recovery', acc('view.snapshots'), 'view', 'snapshots'),
        item('Reflog', acc('view.reflog'), 'view', 'reflog'),
      ],
    },
    {
      label: 'Repository',
      submenu: [
        item('Fetch All', acc('repo.fetch'), 'fetch'),
        item('Pull Current Branch', acc('repo.pull'), 'pull'),
        item('Push Current Branch', acc('repo.push'), 'push'),
        item('Push All Tags', undefined, 'pushTags'),
        { type: 'separator' },
        item('Stash Changes…', acc('repo.stash'), 'stashSave'),
        item('Stash Staged Changes…', acc('repo.stashStaged'), 'stashStaged'),
        item('Reset Hard to HEAD…', undefined, 'resetHard'),
        { type: 'separator' },
        item('New Worktree…', acc('repo.worktreeAdd'), 'worktreeAdd'),
        item('Switch Branch…', acc('repo.branchSwitch'), 'branchSwitch'),
        item('Switch Worktree…', acc('repo.worktreeSwitch'), 'worktreeSwitch'),
        { type: 'separator' },
        item('Open Submodule…', acc('repo.submodules'), 'submodules'),
        item('Update Submodules', acc('repo.submoduleUpdate'), 'submoduleUpdate'),
        { type: 'separator' },
        item('Git LFS Files…', acc('repo.lfs'), 'lfs'),
        item('Open in Difftool', acc('repo.difftool'), 'difftool'),
        item('Resolve Conflicts', acc('repo.conflicts'), 'conflicts'),
        item('Open in Mergetool', acc('repo.mergetool'), 'mergetool'),
        item('File History & Blame…', acc('repo.fileHistory'), 'fileHistory'),
        item('Review Branch…', acc('repo.review'), 'review'),
        item('Commit Identity…', acc('repo.identity'), 'identity'),
        item('Remotes…', acc('repo.remotes'), 'remotes'),
        item('Write Commit Message with AI', acc('repo.aiMessage'), 'aiMessage'),
        item('AI Commit Messages…', undefined, 'aiSetup'),
        { type: 'separator' },
        item('Pull Requests…', acc('repo.prs'), 'prs'),
        item('Refresh Pull Requests', acc('repo.prRefresh'), 'prRefresh'),
        item('New Pull Request…', acc('repo.prCreate'), 'prCreate'),
        item('Check Out Pull Request…', acc('repo.prCheckout'), 'prCheckout'),
        item('Check Out Pull Request in New Worktree…', acc('repo.prWorktree'), 'prWorktree'),
        item('Approve Pull Request…', acc('repo.prApprove'), 'prApprove'),
        item('Merge Pull Request…', acc('repo.prMerge'), 'prMerge'),
        item('Request Changes on Pull Request…', acc('repo.prChanges'), 'prChanges'),
        item('Close Pull Request…', acc('repo.prClose'), 'prClose'),
        { type: 'separator' },
        item('Open in Finder', acc('repo.reveal'), 'reveal'),
        item('Open in Terminal', acc('repo.terminal'), 'terminal'),
        item('Open in Hosting Service', undefined, 'hosting'),
        item('Open Origin in Browser', acc('repo.origin'), 'origin'),
      ],
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        // ⌃Tab and ⌃⇧Tab are taken by each tab's page (Tab), so the menu only shows them.
        { label: 'Show Previous Tab', accelerator: acc('tab.prev'), registerAccelerator: false, enabled: open.length > 1, click: () => front?.step(-1) },
        { label: 'Show Next Tab', accelerator: acc('tab.next'), registerAccelerator: false, enabled: open.length > 1, click: () => front?.step(1) },
        ...when(open.length > 1, [
          { type: 'separator' },
          ...open.slice(0, TAB_KEYS.length).map((t, i): Item => ({ label: t.title, type: 'checkbox', checked: t === front?.active, accelerator: acc(TAB_KEYS[i] ?? ''), click: () => front?.select(t) })),
          { label: 'Last Tab', accelerator: acc('tab.last'), click: () => front?.pick(9) },
        ]),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    { role: 'help', submenu: [item('Keyboard Shortcuts', acc('help.shortcuts'), 'shortcuts')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
onMenuChange(buildMenu);

