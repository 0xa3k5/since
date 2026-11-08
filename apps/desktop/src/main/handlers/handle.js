'use strict';
// Registers IPC handlers that only answer the app's own page.
const { ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { GIT, APP_PREFIX, APP_CHANNELS } = require('../../shared/channels.ts');

// Every IPC channel goes through here: calls are only accepted from our own renderer page,
// loaded from the app bundle into a window's main frame. Arguments are checked by ipc.js.
const RENDERER_URL = pathToFileURL(path.join(__dirname, '..', '..', 'renderer', 'index.html')).href;
function trustedSender(e) {
  const frame = e.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const u = new URL(frame.url);
    u.search = ''; u.hash = '';
    return u.href === RENDERER_URL;
  } catch { return false; }
}
function handle(channel, fn) {
  // Only channels in the IPC contract get a handler, so the renderer's types match what's registered.
  const known = channel === GIT || (channel.startsWith(APP_PREFIX) && APP_CHANNELS.includes(channel.slice(APP_PREFIX.length)));
  if (!known) throw new Error(`IPC channel "${channel}" is not in src/shared/channels.ts`);
  ipcMain.handle(channel, (e, ...args) => {
    if (!trustedSender(e)) throw new Error(`Blocked IPC "${channel}" from ${e.senderFrame?.url || 'unknown frame'}`);
    return fn(e, ...args);
  });
}

function serializeError(err) {
  return { message: err.message || String(err), stderr: err.stderr || null, code: err.code || err.kind || null, ...(err.moved ? { moved: err.moved } : {}), ...(err.step ? { step: err.step } : {}) };
}
// Wraps a handler so it returns { ok } or { error } instead of throwing across IPC.
const okCall = (fn) => async (e, ...args) => {
  try { return { ok: await fn(e, ...args) }; } catch (err) { return { error: serializeError(err) }; }
};

module.exports = { handle, serializeError, okCall };
