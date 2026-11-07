'use strict';
// main.js runs top-level code as soon as it loads (IPC handlers, menus). Load it with electron
// stubbed so a handler registered before its helper is declared fails here, not at app start.
const test = require('node:test');
const assert = require('node:assert');
const { useElectron } = require('./fake-electron.js');
const os = require('node:os');

// Every property is another stub, every call returns one. The app never gets ready, so no window opens.
function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'whenReady') return () => new Promise(() => {});
      if (k === 'getPath') return () => os.tmpdir();
      if (k === 'getVersion') return () => '0.0.0';
      if (k === 'isPackaged') return false;
      return stub();
    },
  });
}

test('main.js loads without errors', () => {
  const channels = [];
  const electron = stub();
  const ipcMain = { handle: (ch) => channels.push(ch), on() {}, removeHandler() {} };
  const fake = new Proxy({}, { get: (_t, k) => (k === 'ipcMain' ? ipcMain : electron[k]) });
  useElectron(fake);
  try {
    require('../src/main/main.js');
  } finally {
    useElectron({});
  }
  assert.ok(channels.includes('app:git-info'));
  assert.ok(channels.includes('app:ai-preview'));
});
