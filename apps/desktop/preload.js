'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitlanes', {
  git: (method, ...args) => ipcRenderer.invoke('git', method, ...args),
  app: (channel, ...args) => ipcRenderer.invoke(`app:${channel}`, ...args),
  on: (channel, fn) => {
    const allowed = ['repo:changed', 'command', 'clone:progress'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
