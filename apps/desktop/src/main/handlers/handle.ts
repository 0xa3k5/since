// Registers IPC handlers that only answer the app's own page.
import electron from 'electron';
const { ipcMain } = electron;
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GIT, APP_PREFIX, APP_CHANNELS } from '../../shared/channels.ts';
import type { AppChannel } from '../../shared/channels.ts';
import type { IpcError, IpcResult } from '../../shared/ipc-contract.ts';

type Event = Electron.IpcMainInvokeEvent;
/** An IPC handler: the event, then the renderer's arguments, untrusted until ipc.ts checks them. */
export type Handler = (e: Event, ...args: unknown[]) => unknown;

// Every IPC channel goes through here: calls are only accepted from our own renderer page,
// loaded from the app bundle into a window's main frame. Arguments are checked by ipc.js.
const RENDERER_URL = pathToFileURL(path.join(import.meta.dirname, '..', '..', 'renderer', 'index.html')).href;
function trustedSender(e: Event): boolean {
  const frame = e.senderFrame;
  if (!frame || frame.parent) return false;
  try {
    const u = new URL(frame.url);
    u.search = ''; u.hash = '';
    return u.href === RENDERER_URL;
  } catch { return false; }
}
export function handle(channel: `app:${AppChannel}` | typeof GIT, fn: Handler): void {
  // Only channels in the IPC contract get a handler, so the renderer's types match what's registered.
  const known = channel === GIT || (channel.startsWith(APP_PREFIX) && (APP_CHANNELS as readonly string[]).includes(channel.slice(APP_PREFIX.length)));
  if (!known) throw new Error(`IPC channel "${channel}" is not in src/shared/channels.ts`);
  ipcMain.handle(channel, (e, ...args) => {
    if (!trustedSender(e)) throw new Error(`Blocked IPC "${channel}" from ${e.senderFrame?.url || 'unknown frame'}`);
    return fn(e, ...args);
  });
}

export function serializeError(error: unknown): IpcError {
  const err = error as { message?: string; stderr?: string | null; code?: string | number | null; kind?: string; moved?: IpcError['moved']; step?: IpcError['step'] };
  return { message: err.message || String(err), stderr: err.stderr || null, code: err.code || err.kind || null, ...(err.moved ? { moved: err.moved } : {}), ...(err.step ? { step: err.step } : {}) };
}
// Wraps a handler so it returns { ok } or { error } instead of throwing across IPC.
export const okCall = <R>(fn: (e: Event, ...args: unknown[]) => R | Promise<R>) => async (e: Event, ...args: unknown[]): Promise<IpcResult<R>> => {
  try { return { ok: await fn(e, ...args) }; } catch (err) { return { error: serializeError(err) }; }
};

