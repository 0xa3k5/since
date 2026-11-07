'use strict';
// The renderer code that used to be app.js (the entry and the area modules split out of it), as one
// string, for tests that check what it does by reading it.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'src', 'renderer');
const FILES = ['app.js', 'branches/remote-ops.js', 'commit/ai-message.js', 'commit/commit-view.js', 'commit/external-tools.js', 'commit/identity-check.js', 'commit/split.js', 'commit/stashes.js', 'graph/commit-actions.js', 'graph/load.js', 'graph/map.js', 'graph/quick-view.js', 'history/file-history.js', 'history/reflog.js', 'history/snapshots.js', 'lanes/worktrees.js', 'lib/app-helpers.js', 'lib/bridge.js', 'lib/upcalls.js', 'palette/palette.js', 'prs/prs-page.js', 'settings/prefs-window.js', 'shell/navigation.js', 'shell/shell.js', 'shell/theme.js', 'shell/updates.js', 'welcome/welcome.js'];
const appSource = () => FILES.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

module.exports = { FILES, appSource };
