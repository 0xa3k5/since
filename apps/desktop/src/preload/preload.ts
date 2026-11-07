// The sandboxed bridge: exposes `window.since` to the renderer and nothing else. A sandboxed
// preload can't load local files, so the push channels are copied here; their type and
// test/channels.test.js keep the copy equal to src/shared/channels.ts.
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { PushChannel } from '../shared/channels.ts';
import type { PushArgs, SinceBridge } from '../shared/ipc-contract.ts';

const allowed: readonly PushChannel[] = ['repo:changed', 'command', 'clone:progress', 'theme', 'update', 'keymap', 'cleanup:progress', 'tabs', 'git'];

const since: SinceBridge = {
  git: (method, ...args) => ipcRenderer.invoke('git', method, ...args),
  app: (channel, ...args) => ipcRenderer.invoke(`app:${channel}`, ...args),
  on: (channel, fn) => {
    if (!allowed.includes(channel)) return () => {};
    // The main process is trusted to send each channel's payload (PushArgs).
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => fn(...(args as PushArgs[typeof channel]));
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
};

contextBridge.exposeInMainWorld('since', since);
