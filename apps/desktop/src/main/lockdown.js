'use strict';
// Lock-down: sandbox every renderer, refuse navigation, permissions and requests outside the allow-list.
const { app, shell, protocol } = require('electron');
const check = require('./ipc.ts');
const prMedia = require('./pr-media.ts');

// ---------------------------------------------------------------------------
// Lockdown. Since talks to the network only through the git processes it starts; the
// renderer never does. See docs/security.md.

app.enableSandbox();

// No page in any webContents (including ones we never meant to create) may navigate,
// redirect, open windows or attach <webview>s. Web links open in the user's browser.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.on('will-redirect', (ev) => ev.preventDefault());
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    try { shell.openExternal(check.webUrl(url)); } catch { /* not a web link: drop it */ }
    return { action: 'deny' };
  });
});

// What a session may load: its own files, inline data: images and DevTools in development
// (ipc.requestAllowed), plus the https origins in `allow`. Only the updater's private
// "since-updates" session gets any: the update feed's host.
function lockDownSession(ses, allow = []) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = check.requestAllowed(details.url, allow);
    if (!allowed) console.warn('blocked request', details.url.slice(0, 200));
    callback({ cancel: !allowed });
  });
}

app.on('session-created', (ses) => lockDownSession(ses));
// PR videos stream through the main process (pr-media.js); registered before ready, as Electron requires.
protocol.registerSchemesAsPrivileged([{ scheme: prMedia.SCHEME, privileges: { stream: true, secure: true } }]);

module.exports = { lockDownSession };
