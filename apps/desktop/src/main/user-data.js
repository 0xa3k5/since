'use strict';
// Runs first: carries settings over from the app's old name.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// The app was called GitLanes before: carry its settings, recent repositories and local storage over
// once (not Chromium's caches or locks). Never overwrites anything already there, and never into an
// explicit --user-data-dir (e2e sandboxes).
const oldUserData = path.join(app.getPath('appData'), 'GitLanes');
if (!app.commandLine.hasSwitch('user-data-dir') && !['settings.json', 'recent.json'].some((f) => fs.existsSync(path.join(app.getPath('userData'), f))) && fs.existsSync(oldUserData)) {
  const keep = (src) => { const top = path.relative(oldUserData, src).split(path.sep)[0]; return !top || top.endsWith('.json') || top === 'Local Storage'; };
  try { fs.cpSync(oldUserData, app.getPath('userData'), { recursive: true, force: false, filter: keep }); } catch (err) { console.warn('could not copy the old app data', err.message); }
}
