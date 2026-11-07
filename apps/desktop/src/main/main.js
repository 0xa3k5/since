'use strict';
// The main process entry: loads every module (IPC handlers, windows, menu, lock-down) and opens the first window when the app is ready.
const { app, nativeTheme, nativeImage, session: electronSession } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const updater = require('./updater');
const pkg = require('../../package.json');
const prMedia = require('./pr-media.ts');
const keymap = require('../renderer/palette/keymap.js');
require('./user-data');
require('./handlers/git');
require('./handlers/app');
require('./handlers/ai');
require('./handlers/prs');
require('./windows');
require('./menu');
require('./lockdown');
const { isMac, readSettings, THEMES } = require('./settings');
const { openFolder, broadcast, setWindowFocus, createWindow, openLastWindow, hosts } = require('./windows');
const { useGit } = require('./handlers/app');
const { media } = require('./handlers/prs');
const { buildMenu } = require('./menu');
const { lockDownSession } = require('./lockdown');

app.on('open-file', (ev, p) => {
  ev.preventDefault();
  if (app.isReady()) openFolder(p); else app.once('ready', () => openFolder(p));
});

app.whenReady().then(() => {
  app.setName('Since');
  app.setAboutPanelOptions({
    copyright: 'Copyright (C) 2026 0xa3k5 and Since contributors',
    credits: 'GPL-3.0-or-later\nhttps://github.com/0xa3k5/since/blob/main/LICENSE',
  });
  // Packaged builds carry build/icon.icns; `pnpm start` would show Electron's icon in the Dock.
  if (!app.isPackaged && isMac) {
    const dockIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.icns'));
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  }
  lockDownSession(electronSession.defaultSession);
  electronSession.defaultSession.protocol.handle(prMedia.SCHEME, (req) => media.video(req));
  useGit(readSettings().gitPath);
  const saved = readSettings().theme;
  nativeTheme.themeSource = THEMES.includes(saved) ? saved : 'system';
  keymap.setOverrides(readSettings().keymap);
  updater.init({
    auto: () => readSettings().autoUpdate !== false,
    feed: pkg.updates?.feed,
    page: pkg.updates?.page,
    devFeed: app.isPackaged ? null : process.env.SINCE_UPDATE_FEED,
    onChange: (state) => {
      buildMenu();
      broadcast('update', { ...state, page: updater.page() });
    },
  });
  lockDownSession(electronSession.fromPartition(updater.PARTITION, { cache: false }), updater.allowedOrigins());
  buildMenu();
  setWindowFocus(() => { buildMenu(); });
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-'));
  // pnpm runs workspace scripts inside apps/desktop; resolve relative paths against where the user ran pnpm.
  const repoPath = arg && path.resolve(process.env.INIT_CWD || process.cwd(), arg);
  if (repoPath && fs.existsSync(repoPath)) createWindow(repoPath, { restore: true }); else openLastWindow();
  app.on('activate', () => { if (!hosts.size) openLastWindow(); });
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
