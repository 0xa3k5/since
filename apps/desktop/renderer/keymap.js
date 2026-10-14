// The keymap: every keyboard shortcut in GitLanes, in one place. Renderer handlers dispatch by command id
// (`match`), main.js builds menu accelerators from it (`accelerator`), menus and ⌘K show its labels (`keys`),
// and the website's /shortcuts page imports it. Loaded by the renderer as an ES module and by main.js via require.
//
// A binding is "Mod+Shift+F": modifiers, then one key. Mod is ⌘ on macOS and Ctrl elsewhere (either works when
// matching, as before); Ctrl is the Control key itself. A space separates the steps of a chord ("g c": G, then C).
// The key is an `e.key` value (letters lower case, Space for ' '), or an `e.code` name (KeyO, Comma, Backslash)
// where ⌥ or ⇧ changes the character the key types. Shift is part of a letter binding ("Shift+S" is ⇧S); for other
// keys a binding with no modifiers also matches with ⇧ held, unless a Shift binding in the same scope wins.
// `group` is the /shortcuts page section (null: not listed there yet); `pair` shows a second command's keys beside
// this one (↓ ↑). `reserved` marks keys macOS or the app menu owns (⌘, ⌘Q…), which must never be rebound.
// The user can rebind the rest (Keyboard Shortcuts window): `setOverrides` layers their changes over `keys`.

export const SCOPES = {
  global: 'Anywhere in a repository',
  menu: 'Menu bar',
  map: 'Map',
  quick: 'Quick View',
  commit: 'Commit view',
  message: 'Commit message box',
  split: 'Split commit',
  diff: 'Diff view',
  stashes: 'Stashes',
  snapshots: 'Snapshots',
  worktrees: 'Worktrees',
  lanes: 'Lanes',
  review: 'Review branch',
  recent: 'Welcome screen',
  conflict: 'Conflict editor',
  fileHistory: 'File history',
  setup: 'Choose defaults',
  shortcuts: 'Keyboard Shortcuts window',
  dialog: 'Dialogs and menus',
  tour: 'Tour',
};

const c = (scope, group, id, label, keys, extra) => ({ id, label, scope, group, keys: [].concat(keys), ...extra });

export const COMMANDS = [
  // Menu bar: accelerators in main.js. `menu` is the menu the item sits in.
  c('menu', 'file', 'app.settings', 'Settings…', 'Mod+,', { reserved: true }),
  c('menu', 'file', 'app.licence', 'Enter Licence Key…', 'Mod+Alt+L'),
  c('menu', 'file', 'file.newWindow', 'New Window', 'Mod+Shift+N'),
  c('menu', 'file', 'file.init', 'New Repository…', 'Mod+N'),
  c('menu', 'file', 'file.open', 'Open Repository…', 'Mod+O'),
  c('menu', 'file', 'file.clone', 'Clone Repository…', 'Mod+Shift+O'),
  c('menu', 'file', 'file.repoSwitch', 'Switch Repository…', 'Mod+Alt+KeyO'),
  c('menu', 'file', 'file.close', 'Close Window', 'Mod+W', { reserved: true, role: true }),
  c('menu', 'file', 'app.quit', 'Quit GitLanes', 'Mod+Q', { reserved: true, role: true }),
  c('menu', 'file', 'app.hide', 'Hide GitLanes', 'Mod+H', { reserved: true, role: true }),
  c('menu', 'edit', 'edit.undo', 'Undo', 'Mod+Z'),
  c('menu', 'edit', 'edit.redo', 'Redo', 'Mod+Shift+Z'),
  c('menu', 'edit', 'edit.find', 'Find…', 'Mod+F'),
  c('menu', 'view', 'view.palette', 'Command Menu', 'Mod+K'),
  c('menu', 'help', 'help.shortcuts', 'Keyboard Shortcuts', 'Mod+Slash'),
  c('menu', 'views', 'view.map', 'Map', ['Mod+1', 'g m']),
  c('menu', 'views', 'view.commit', 'Commit', ['Mod+2', 'g c']),
  c('menu', 'views', 'view.stashes', 'Stashes', ['Mod+3', 'g s']),
  c('menu', 'views', 'view.snapshots', 'Snapshots', ['Mod+4', 'g h']),
  c('menu', 'views', 'view.reflog', 'Reflog', ['Mod+5', 'g r']),
  c('menu', 'views', 'view.config', 'Configuration', 'Mod+6'),
  c('menu', 'views', 'view.worktrees', 'Worktrees', ['Mod+7', 'g w']),
  c('menu', 'views', 'view.lanes', 'Lanes', ['Mod+8', 'g l']),
  c('menu', 'view', 'view.sidebar', 'Toggle Sidebar', 'Mod+Backslash'),
  c('menu', 'view', 'view.tags', 'Show Tags', 'Mod+Alt+T'),
  c('menu', 'view', 'view.remotes', 'Show Remote Branches', 'Mod+Alt+R'),
  c('menu', 'view', 'view.swatches', 'Show Colour Swatches in Diffs', 'Mod+Alt+C'),
  // ⌃⌘T on macOS ("T" for Theme); ⌘⇧T and ⌥⌘T are already taken.
  c('menu', 'view', 'view.cycleTheme', 'Cycle Theme', 'Ctrl+Mod+T', { other: 'Ctrl+Alt+Shift+T' }),
  c('menu', 'repository', 'repo.fetch', 'Fetch All', 'Mod+Shift+F'),
  c('menu', 'repository', 'repo.pull', 'Pull Current Branch', 'Mod+Shift+L'),
  c('menu', 'repository', 'repo.push', 'Push Current Branch', 'Mod+Shift+P'),
  c('menu', 'repository', 'repo.stash', 'Stash Changes…', 'Mod+Shift+S'),
  c('menu', 'repository', 'repo.stashStaged', 'Stash Staged Changes…', 'Mod+Alt+S'),
  c('menu', 'repository', 'repo.worktreeAdd', 'New Worktree…', 'Mod+Alt+N'),
  c('menu', 'repository', 'repo.worktreeSwitch', 'Switch Worktree…', 'Mod+Alt+W'),
  c('menu', 'repository', 'repo.submodules', 'Open Submodule…', 'Mod+Alt+B'),
  c('menu', 'repository', 'repo.submoduleUpdate', 'Update Submodules', 'Mod+Alt+U'),
  c('menu', 'repository', 'repo.lfs', 'Git LFS Files…', 'Mod+Alt+F'),
  c('menu', 'repository', 'repo.difftool', 'Open in Difftool', 'Mod+Shift+D'),
  c('menu', 'repository', 'repo.conflicts', 'Resolve Conflicts', 'Mod+Alt+M'),
  c('menu', 'repository', 'repo.mergetool', 'Open in Mergetool', 'Mod+Shift+M'),
  c('menu', 'repository', 'repo.fileHistory', 'File History & Blame…', 'Mod+Shift+H'),
  c('menu', 'repository', 'repo.review', 'Review Branch…', 'Mod+Alt+V'),
  c('menu', 'repository', 'repo.identity', 'Commit Identity…', 'Mod+Alt+I'),
  c('menu', 'repository', 'repo.aiMessage', 'Write Commit Message with AI', 'Mod+Alt+G'),
  c('menu', 'repository', 'repo.prs', 'Pull Requests…', 'Mod+Alt+P'),
  c('menu', 'repository', 'repo.prRefresh', 'Refresh Pull Requests', 'Mod+Alt+Shift+P'),
  c('menu', 'repository', 'repo.prCreate', 'New Pull Request…', 'Mod+Alt+Shift+N'),
  c('menu', 'repository', 'repo.prCheckout', 'Check Out Pull Request…', 'Mod+Alt+Shift+O'),
  c('menu', 'repository', 'repo.prWorktree', 'Check Out Pull Request in New Worktree…', 'Mod+Alt+Shift+L'),
  c('menu', 'repository', 'repo.prApprove', 'Approve Pull Request…', 'Mod+Alt+Shift+A'),
  c('menu', 'repository', 'repo.prMerge', 'Merge Pull Request…', 'Mod+Alt+Shift+M'),
  c('menu', 'repository', 'repo.prClose', 'Close Pull Request…', 'Mod+Alt+Shift+W'),
  c('menu', 'repository', 'repo.reveal', 'Open in Finder', 'Mod+Shift+R'),
  c('menu', 'repository', 'repo.terminal', 'Open in Terminal', 'Mod+Shift+T'),
  c('menu', 'repository', 'repo.origin', 'Open Origin in Browser', 'Mod+Shift+G'),

  // Anywhere in a repository (window keydown in app.js).
  c('global', 'global', 'global.search', 'Search commits', '/'),
  c('global', 'global', 'global.close', 'Close Quick View', 'Escape'),
  c('global', 'global', 'global.setup', 'Choose defaults', 'Mod+Shift+Comma'),
  c('global', null, 'global.detail', 'Show or hide the detail panel', 'Mod+Alt+Backslash'),
  c('global', 'global', 'global.prs', 'Turn pull requests on or off', 'Mod+Alt+Shift+KeyG'),
  c('global', 'global', 'global.prHide', 'Hide or show pull requests in this repository', 'Mod+Alt+Shift+KeyH'),

  // Map, with the commit list focused.
  c('map', 'map', 'map.next', 'Next / previous commit', 'ArrowDown', { pair: 'map.prev' }),
  c('map', null, 'map.prev', 'Previous commit', 'ArrowUp'),
  c('map', 'map', 'map.pageDown', 'Page down / up', 'PageDown', { pair: 'map.pageUp' }),
  c('map', null, 'map.pageUp', 'Page up', 'PageUp'),
  c('map', 'map', 'map.first', 'First / last commit', 'Home', { pair: 'map.last' }),
  c('map', null, 'map.last', 'Last commit', 'End'),
  c('map', 'map', 'map.quick', 'Quick View (or pick the search result)', 'Enter'),
  c('map', 'map', 'map.detail', 'Show or hide the detail panel', 'Space'),
  c('map', 'map', 'map.clearSearch', 'Clear search', 'Escape'),
  c('map', 'map', 'map.head', 'Jump to HEAD', 'h'),
  c('map', 'map', 'map.copySha', 'Copy SHA', 'Mod+c'),
  c('map', 'map', 'map.copyLink', 'Copy link to commit', 'Mod+Shift+C'),
  // Commit actions: single keys on the selected commit. The commit's right-click menu shows the same keys.
  c('map', 'commit-actions', 'commit.checkoutBranch', 'Checkout branch', 'Mod+Enter'),
  c('map', 'commit-actions', 'commit.checkout', 'Checkout (detached)', 'o'),
  c('map', 'commit-actions', 'commit.diffHead', 'Diff with HEAD', 'd'),
  c('map', 'commit-actions', 'commit.branch', 'Create Branch…', 'b'),
  c('map', 'commit-actions', 'commit.tag', 'Create Tag…', 't'),
  c('map', 'commit-actions', 'commit.worktree', 'New Worktree Here…', 'w'),
  c('map', 'commit-actions', 'commit.merge', 'Merge into Current', 'm'),
  c('map', 'commit-actions', 'commit.rebase', 'Rebase Current onto This', 'r'),
  c('map', 'commit-actions', 'commit.cherryPick', 'Cherry-pick onto Current', 'p'),
  c('map', 'commit-actions', 'commit.revert', 'Revert', 'v'),
  c('map', 'commit-actions', 'commit.edit', 'Edit Message…', 'e'),
  c('map', 'commit-actions', 'commit.squash', 'Squash with Parent', 's'),
  c('map', 'commit-actions', 'commit.fixup', 'Fixup with Parent', 'f'),
  c('map', 'commit-actions', 'commit.split', 'Split Commit…', 'Shift+S'),
  c('map', 'commit-actions', 'commit.drop', 'Delete Commit', ['Backspace', 'Delete']),
  c('map', 'commit-actions', 'commit.author', 'View Author on GitHub', 'Shift+A'),

  // Quick View.
  c('quick', 'quick-view', 'quick.next', 'Next / previous file', 'ArrowDown', { pair: 'quick.prev' }),
  c('quick', null, 'quick.prev', 'Previous file', 'ArrowUp'),
  c('quick', 'quick-view', 'quick.close', 'Back to the map', ['Escape', 'Space']),

  // Commit view (file lists), then the message box.
  c('commit', 'commit-view', 'cv.next', 'Next / previous file', 'ArrowDown', { pair: 'cv.prev' }),
  c('commit', null, 'cv.prev', 'Previous file', 'ArrowUp'),
  c('commit', 'commit-view', 'cv.extendNext', 'Extend the selection (also ⇧-click; ⌘-click adds one file)', 'Shift+ArrowDown'),
  c('commit', null, 'cv.extendPrev', 'Extend the selection up', 'Shift+ArrowUp'),
  c('commit', 'commit-view', 'cv.selectAll', 'Select every file in the list', 'Mod+a'),
  c('commit', 'commit-view', 'cv.single', 'Back to a single file', 'Escape'),
  c('commit', 'commit-view', 'cv.stage', 'Stage or unstage the selected files', 'Enter'),
  c('commit', 'commit-view', 'cv.discard', 'Discard the selected unstaged files (undoable)', ['Backspace', 'Delete']),
  c('commit', 'commit-view', 'cv.message', 'Write the commit message', 'c'),
  c('message', 'commit-view', 'message.commit', 'Commit', 'Mod+Enter'),

  // Split commit.
  c('split', null, 'split.next', 'Next file', 'ArrowDown'),
  c('split', null, 'split.prev', 'Previous file', 'ArrowUp'),
  c('split', null, 'split.toggleFile', 'Select or deselect the file', 'a'),
  c('split', null, 'split.message', 'Write the commit messages', 'c'),
  c('split', null, 'split.leave', 'Leave the message box', 'Escape'),
  c('split', null, 'split.submit', 'Split commit', 'Mod+Enter'),

  // Diff with HEAD.
  c('diff', null, 'diff.close', 'Back', 'Escape'),

  // Stashes and Snapshots lists.
  c('stashes', null, 'stashes.next', 'Next stash', 'ArrowDown'),
  c('stashes', null, 'stashes.prev', 'Previous stash', 'ArrowUp'),
  c('snapshots', null, 'snapshots.next', 'Next snapshot', 'ArrowDown'),
  c('snapshots', null, 'snapshots.prev', 'Previous snapshot', 'ArrowUp'),
  c('snapshots', null, 'snapshots.restore', 'Restore the snapshot', 'Enter'),

  // Worktrees.
  c('worktrees', null, 'worktrees.next', 'Next worktree', 'ArrowDown'),
  c('worktrees', null, 'worktrees.prev', 'Previous worktree', 'ArrowUp'),
  c('worktrees', null, 'worktrees.switch', 'Switch to the worktree', 'Enter'),
  c('worktrees', null, 'worktrees.window', 'Open the worktree in a new window', 'Mod+Enter'),
  c('worktrees', null, 'worktrees.lock', 'Lock or unlock', 'l'),
  c('worktrees', null, 'worktrees.remove', 'Remove the worktree', ['Backspace', 'Delete']),
  c('worktrees', null, 'worktrees.add', 'New worktree', 'n'),
  c('lanes', null, 'lanes.next', 'Next lane', ['ArrowDown', 'j']),
  c('lanes', null, 'lanes.prev', 'Previous lane', ['ArrowUp', 'k']),
  c('lanes', null, 'lanes.open', 'Open the lane in the map', 'Enter'),
  c('lanes', null, 'lanes.filter', 'Filter lanes', '/'),
  c('lanes', null, 'lanes.clear', 'Clear the filter', 'Escape'),
  c('lanes', null, 'lanes.agents', 'Agent lanes only', 'a'),
  c('lanes', null, 'lanes.conflicts', 'Lanes with predicted conflicts only', 'c'),
  c('lanes', null, 'lanes.review', 'Review the lane’s branch', 'r'),
  c('review', null, 'review.next', 'Next file', ['ArrowDown', 'j']),
  c('review', null, 'review.prev', 'Previous file', ['ArrowUp', 'k']),
  c('review', null, 'review.tick', 'Mark the file reviewed (or not)', 'v'),
  c('review', null, 'review.delta', 'Only what changed since you last looked', 'd'),
  c('review', null, 'review.close', 'Back', 'Escape'),

  // Welcome screen: recent repositories.
  c('recent', null, 'recent.next', 'Next repository', 'ArrowDown'),
  c('recent', null, 'recent.prev', 'Previous repository', 'ArrowUp'),
  c('recent', null, 'recent.open', 'Open the repository', 'Enter'),

  // Conflict editor (text conflicts in the Commit view).
  c('conflict', null, 'conflict.resolve', 'Mark resolved', 'Mod+s'),
  c('conflict', null, 'conflict.next', 'Next conflict', ']'),
  c('conflict', null, 'conflict.prev', 'Previous conflict', '['),
  c('conflict', null, 'conflict.ours', 'Take ours', 'o'),
  c('conflict', null, 'conflict.theirs', 'Take theirs', 't'),
  c('conflict', null, 'conflict.both', 'Take both', 'b'),
  c('conflict', null, 'conflict.allOurs', 'Take ours for every conflict', 'Shift+O'),
  c('conflict', null, 'conflict.allTheirs', 'Take theirs for every conflict', 'Shift+T'),
  c('conflict', null, 'conflict.edit', 'Edit the result', 'e'),
  c('conflict', null, 'conflict.reset', 'Reset the conflict', ['Backspace', 'Delete']),
  c('conflict', null, 'conflict.closeEdit', 'Stop editing', 'Escape'),

  // File history & blame.
  c('fileHistory', null, 'fileHistory.close', 'Close', 'Escape'),
  c('fileHistory', null, 'fileHistory.next', 'Next commit', 'ArrowDown'),
  c('fileHistory', null, 'fileHistory.prev', 'Previous commit', 'ArrowUp'),
  c('fileHistory', null, 'fileHistory.show', 'Show the commit in the map', 'Enter'),
  c('fileHistory', null, 'fileHistory.open', 'Quick View the commit', 'Space'),

  // Choose defaults.
  c('setup', null, 'setup.done', 'Done', 'Mod+Enter'),

  // The Keyboard Shortcuts window.
  c('shortcuts', null, 'shortcuts.next', 'Next shortcut', 'ArrowDown'),
  c('shortcuts', null, 'shortcuts.prev', 'Previous shortcut', 'ArrowUp'),
  c('shortcuts', null, 'shortcuts.find', 'Search shortcuts', 'Mod+f'),
  c('shortcuts', null, 'shortcuts.edit', 'Change the shortcut', 'Enter'),
  c('shortcuts', null, 'shortcuts.close', 'Clear the search, then close', 'Escape'),

  // Dialogs, context menus and the ⌘K menu.
  c('dialog', null, 'dialog.cancel', 'Close', 'Escape'),
  c('dialog', null, 'dialog.submit', 'Submit a multi-line field', 'Mod+Enter'),
  c('dialog', null, 'menu.next', 'Next item', ['ArrowDown', 'Ctrl+n']),
  c('dialog', null, 'menu.prev', 'Previous item', ['ArrowUp', 'Ctrl+p']),
  c('dialog', null, 'menu.choose', 'Choose the item', 'Enter'),

  // Tour: the practice graph and the lesson tabs.
  c('tour', null, 'tour.next', 'Next commit', 'ArrowDown'),
  c('tour', null, 'tour.prev', 'Previous commit', 'ArrowUp'),
  c('tour', null, 'tour.squash', 'Squash (practice)', 's'),
  c('tour', null, 'tour.rebase', 'Rebase (practice)', 'r'),
  c('tour', null, 'tour.cherryPick', 'Cherry-pick (practice)', 'p'),
  c('tour', null, 'tour.nextTab', 'Next lesson', 'ArrowRight'),
  c('tour', null, 'tour.prevTab', 'Previous lesson', 'ArrowLeft'),
];

const BY_ID = new Map(COMMANDS.map((x) => [x.id, x]));
export const command = (id) => BY_ID.get(id);

const IS_MAC = typeof process !== 'undefined' && process.platform
  ? process.platform === 'darwin'
  : /^Mac/.test(globalThis.navigator?.platform ?? '');

/** The default bindings of a command on this platform. */
export function defaults(id, mac = IS_MAC) {
  const cmd = BY_ID.get(id);
  if (!cmd) throw new Error(`keymap: unknown command ${id}`);
  return !mac && cmd.other ? [].concat(cmd.other) : cmd.keys;
}

// Custom bindings: the user's overrides from settings.json `keymap`, { id: [binding…] } ([] means no keys).
// Only changed commands are stored; a command with no override uses its defaults.
let overrides = {};

/** Valid overrides only: known, non-reserved commands with parseable bindings. Drops everything else. */
export function sanitize(o) {
  const out = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [id, list] of Object.entries(o)) {
    const cmd = BY_ID.get(id);
    if (!cmd || cmd.reserved || !Array.isArray(list) || list.length > 4) continue;
    const ok = list.filter((b) => {
      if (typeof b !== 'string' || !b || b.length > 40) return false;
      try { return parse(b).length <= 2; } catch { return false; }
    });
    if (ok.length === list.length) out[id] = [...new Set(ok)];
  }
  return out;
}

export function setOverrides(o) { overrides = sanitize(o); }
export const getOverrides = () => structuredClone(overrides);
export const isCustom = (id) => Object.hasOwn(overrides, id);

/** The bindings of a command on this platform: the user's if they changed it, else the defaults. */
export function bindings(id, mac = IS_MAC) {
  return isCustom(id) ? overrides[id] : defaults(id, mac);
}

/** The overrides with `id` set to `list`; a list equal to the defaults removes the override. */
export function withBinding(o, id, list, mac = IS_MAC) {
  const next = { ...o };
  const same = list.length === defaults(id, mac).length && list.every((b, i) => normalize(b) === normalize(defaults(id, mac)[i]));
  if (same) delete next[id]; else next[id] = [...new Set(list)];
  return next;
}

const MOD_TOKENS = ['Mod', 'Ctrl', 'Alt', 'Shift'];
const CODES = { Comma: ',', Backslash: '\\', Period: '.', Slash: '/' };
const isCode = (k) => /^(Key[A-Z]|Digit\d)$/.test(k) || k in CODES;

/** "Mod+Shift+F" → { mods: Set, key: 'f' }. A chord is several of these. */
export function parse(binding) {
  return binding.split(' ').map((step) => {
    const parts = step.split('+');
    // A trailing "+" key would split into empty parts; no binding uses one.
    const key = parts.pop();
    for (const m of parts) if (!MOD_TOKENS.includes(m)) throw new Error(`keymap: bad modifier ${m} in ${binding}`);
    return { mods: new Set(parts), key };
  });
}

const isLetter = (k) => /^[a-z]$/i.test(k);

/** Does a keydown event press this step? `loose` lets ⇧ through for keys that aren't letters. */
function pressed(step, e, loose) {
  const { mods, key } = step;
  if (mods.has('Mod') ? !(e.metaKey || e.ctrlKey) : (e.metaKey || (e.ctrlKey && !mods.has('Ctrl')))) return false;
  if (mods.has('Ctrl') && !e.ctrlKey) return false;
  if (mods.has('Alt') !== !!e.altKey) return false;
  const shift = mods.has('Shift');
  if (isCode(key)) return e.code === key && shift === !!e.shiftKey;
  if (isLetter(key)) return e.key?.length === 1 && e.key.toLowerCase() === key.toLowerCase() && shift === !!e.shiftKey;
  if (e.key !== (key === 'Space' ? ' ' : key)) return false;
  return shift === !!e.shiftKey || (loose && !mods.size);
}

const inScope = (scope) => COMMANDS.filter((x) => x.scope === scope);

/**
 * The command a keydown event runs in `scope`, or null. `pending` is the first key of a chord already pressed
 * (see `chordStart`); without it, chord bindings don't match.
 */
export function match(scope, e, pending = null, mac = IS_MAC) {
  const cmds = inScope(scope);
  for (const loose of [false, true]) {
    for (const cmd of cmds) {
      for (const b of bindings(cmd.id, mac)) {
        const steps = parse(b);
        if (pending ? steps.length === 2 && steps[0].key === pending && pressed(steps[1], e, loose)
          : steps.length === 1 && pressed(steps[0], e, loose)) return cmd.id;
      }
    }
  }
  return null;
}

/** If the event starts a chord in `scope` (the G of "G then C"), its key; otherwise null. */
export function chordStart(scope, e, mac = IS_MAC) {
  for (const cmd of inScope(scope)) {
    for (const b of bindings(cmd.id, mac)) {
      const steps = parse(b);
      if (steps.length === 2 && pressed(steps[0], e, false)) return steps[0].key;
    }
  }
  return null;
}

const KEY_LABELS = { Enter: '↵', Backspace: '⌫', Delete: '⌫', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', PageUp: 'Page Up', PageDown: 'Page Down' };
const keyLabel = (k) => KEY_LABELS[k] ?? CODES[k] ?? (/^Key[A-Z]$/.test(k) ? k.slice(3) : /^Digit\d$/.test(k) ? k.slice(5) : k.toUpperCase());

/**
 * A binding as the keycaps the app shows: ['⌘', '⇧', 'F'] (['Ctrl', '⇧', 'F'] off macOS), in binding order.
 * Defaults to the command's first binding; `index` picks another one (null if there's none). A chord shows its
 * steps in a row.
 */
export function keys(id, { index = 0, mac = IS_MAC } = {}) {
  const b = bindings(id, mac)[index];
  if (b == null) return index ? null : []; // [] when the user removed every key, so callers can spread it
  return caps(b, mac);
}

/** Any binding as keycaps, like `keys`. */
export function caps(binding, mac = IS_MAC) {
  const MOD = { Mod: mac ? '⌘' : 'Ctrl', Ctrl: mac ? '⌃' : 'Ctrl', Alt: '⌥', Shift: '⇧' };
  return parse(binding).flatMap((s) => [...[...s.mods].map((m) => MOD[m]), keyLabel(s.key)]);
}

const ACCEL = { Mod: 'CmdOrCtrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const ACCEL_KEYS = { Backslash: '\\', Comma: ',', Space: 'Space', Enter: 'Enter', Escape: 'Escape' };

/** The Electron menu accelerator for a command ("CmdOrCtrl+Shift+F"), from its first single-step binding. */
export function accelerator(id, mac = IS_MAC) {
  const b = bindings(id, mac).find((x) => !x.includes(' '));
  if (!b) return undefined;
  const [{ mods, key }] = parse(b);
  const k = ACCEL_KEYS[key] ?? CODES[key] ?? (/^Key[A-Z]$/.test(key) ? key.slice(3) : /^Digit\d$/.test(key) ? key.slice(5) : key.length === 1 ? key.toUpperCase() : key);
  const mod = [...mods].map((m) => (m === 'Mod' && mods.has('Ctrl') && mac ? 'Cmd' : ACCEL[m]));
  return [...mod, k].join('+');
}

// ---------------------------------------------------------------------------
// Rebinding: recording keys, conflicts and refused keys.

const MAC_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

/** A binding in one spelling, for comparing: "Mod+Alt+KeyO" and "Mod+Alt+o" are the same keys. */
export function normalize(binding) {
  return parse(binding).map(({ mods, key }) => {
    let k = /^Key[A-Z]$/.test(key) ? key.slice(3) : /^Digit\d$/.test(key) ? key.slice(5) : CODES[key] ?? key;
    if (k.length === 1) k = k.toLowerCase();
    return [...MAC_ORDER.filter((m) => mods.has(m)), k].join('+');
  }).join(' ');
}

/**
 * A keydown event as one binding step ("Mod+Shift+F"), or null while only modifiers are down. Letters use the
 * typed letter, except with ⌥ (which changes the character) where the key code is used, like the defaults.
 */
export function fromEvent(e, mac = IS_MAC) {
  if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const mods = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (mac && e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const code = e.code || '';
  let key;
  if (e.key === ' ') key = 'Space';
  else if (/^[a-z]$/i.test(e.key) && !e.altKey) key = e.key.toLowerCase();
  else if (/^Key[A-Z]$/.test(code)) key = e.altKey ? code : code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(code)) key = e.altKey || e.shiftKey ? code : code.slice(5);
  else if (code in CODES && (e.altKey || e.shiftKey)) key = code;
  else key = e.key;
  return [...mods, key].join('+');
}

// Scopes that are live at the same time: the menu bar and the "anywhere" keys run in every view.
const overlaps = (a, b) => a === b || [a, b].some((s) => s === 'menu' || s === 'global');

/**
 * The commands that `binding` would collide with if given to `id`: the same keys in the same or an overlapping
 * scope, or a single key that starts one of their chords (or the reverse).
 */
export function conflicts(id, binding, mac = IS_MAC) {
  const me = BY_ID.get(id);
  return COMMANDS.filter((cmd) => cmd.id !== id && overlaps(cmd.scope, me.scope)
    && bindings(cmd.id, mac).some((b) => collides(b, binding))).map((cmd) => cmd.id);
}

/** Do two bindings clash: the same keys, or one is a single key that starts the other's chord? */
export function collides(a, b) {
  const [m, n] = [normalize(a), normalize(b)];
  if (m === n) return true;
  if (m.includes(' ') === n.includes(' ')) return false;
  return m.includes(' ') ? m.split(' ')[0] === n : n.split(' ')[0] === m;
}

// Keys macOS keeps for itself. The app's own reserved commands (⌘Q, ⌘W, ⌘H, ⌘,) are added from the keymap.
const SYSTEM = {
  'Mod+Tab': 'switches apps', 'Mod+Shift+Tab': 'switches apps', 'Mod+`': 'switches windows',
  'Mod+Space': 'opens Spotlight', 'Ctrl+Space': 'switches input sources', 'Mod+Alt+Space': 'opens a Finder search',
  'Mod+Alt+Escape': 'opens Force Quit', 'Mod+M': 'minimises the window', 'Mod+Alt+H': 'hides other apps', 'Mod+Alt+D': 'shows or hides the Dock',
  'Mod+Shift+3': 'takes a screenshot', 'Mod+Shift+4': 'takes a screenshot', 'Mod+Shift+5': 'takes a screenshot',
  'Mod+Ctrl+Q': 'locks the screen', 'Mod+Shift+Q': 'logs out',
  'Ctrl+ArrowUp': 'opens Mission Control', 'Ctrl+ArrowDown': 'shows app windows', 'Ctrl+ArrowLeft': 'switches Spaces', 'Ctrl+ArrowRight': 'switches Spaces',
  'Mod+Ctrl+F': 'toggles full screen',
};
const SYSTEM_KEYS = new Map(Object.entries(SYSTEM).map(([k, v]) => [normalize(k), v]));

/** Why `binding` can't be given to `id` (a sentence), or null when it can. */
export function refusal(id, binding, mac = IS_MAC) {
  const cmd = BY_ID.get(id);
  if (!cmd) return 'Unknown command.';
  if (cmd.reserved) return 'macOS and the app menu own this shortcut, so it can’t be changed.';
  let steps;
  try { steps = parse(binding); } catch { return 'Those keys can’t be used.'; }
  const n = normalize(binding);
  const reserved = COMMANDS.find((x) => x.reserved && defaults(x.id, mac).some((b) => normalize(b) === n));
  if (reserved) return `${keys(reserved.id, { mac }).join('')} is kept for “${reserved.label}”.`;
  // Off macOS, Mod is Ctrl, so a few system keys read differently; only macOS's list is enforced there too.
  const why = SYSTEM_KEYS.get(n) ?? (n.startsWith('Ctrl+') ? SYSTEM_KEYS.get(n.replace('Ctrl+', 'Mod+')) : null);
  if (mac && why) return `macOS uses these keys: it ${why}.`;
  if (steps.length === 2 && steps.some((s) => s.mods.size)) return 'A two-key shortcut uses plain keys, like G then C.';
  // Chords are dispatched for the views only (G then C).
  if (steps.length === 2 && !id.startsWith('view.')) return 'Only the views (G then C) take a two-key shortcut.';
  if (cmd.scope === 'menu') {
    // Menu items run anywhere, even while typing, so they need ⌘, ⌃ or ⌥.
    if (steps.length === 1 && !['Mod', 'Ctrl', 'Alt'].some((m) => steps[0].mods.has(m)) && !/^F\d+$/.test(steps[0].key)) return 'Menu commands need ⌘, ⌃ or ⌥, so they don’t fire while you type.';
  }
  return null;
}
