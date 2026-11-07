// The IPC contract between the main process, the preload bridge (`window.since`) and the
// renderer: which channels exist and what crosses them, so a call on a channel that doesn't
// exist, or a listener that expects the wrong payload, fails `tsc`. The main process still checks
// every argument at run time (src/main/ipc.js): the renderer is untrusted, and these types can't
// vouch for what it actually sends.
//
// Payloads typed `unknown` here get their real types when the main process that produces them
// moves to TypeScript.

import type { AppChannel, GitMethod, PushChannel } from './channels.ts';
import type { GitInfo } from './git-types.ts';

export type Theme = 'system' | 'light' | 'dark';
export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'available' | 'ready' | 'error' | 'disabled';
/** Where updating stands; `current` is the running version, `auto` whether daily checks are on. */
export interface UpdateState { status: UpdateStatus; version?: string | undefined; error?: string | undefined; manual?: boolean | undefined; current?: string | undefined; auto?: boolean }

/** A failure carried across IPC as data instead of a thrown error (serializeError in src/main/handlers/handle.js). */
export interface IpcError {
  message: string;
  stderr: string | null;
  code: string | number | null;
  /** What a failed git step had already moved, so the renderer can say so (journal.js). */
  moved?: unknown;
  /** The step a multi-step operation stopped at. */
  step?: unknown;
}

/** What a git call, or an app call wrapped in okCall, resolves to: the result or the failure. */
export type IpcResult<T> = { ok: T; error?: undefined } | { ok?: undefined; error: IpcError };

/** The arguments each push channel's listeners receive. */
export interface PushArgs {
  'repo:changed': [changed: { refs: boolean; workdir: boolean }];
  command: [command: string, ...args: unknown[]];
  'clone:progress': [line: string];
  theme: [mode: Theme, opts: { announce: boolean }];
  update: [state: UpdateState & { page: string | null }];
  keymap: [overrides: unknown];
  'cleanup:progress': [progress: { done: number; total: number }];
  tabs: [tabs: unknown[], hasClosedTabs: boolean];
  git: [info: GitInfo | null];
}

/** `window.since`, as src/preload/preload.ts exposes it. */
export interface SinceBridge {
  git(method: GitMethod, ...args: unknown[]): Promise<IpcResult<unknown>>;
  app(channel: AppChannel, ...args: unknown[]): Promise<unknown>;
  /** Listens to a push channel; returns the function that stops listening. */
  on<C extends PushChannel>(channel: C, fn: (...args: PushArgs[C]) => void): () => void;
}

// PushArgs has an entry for every push channel and no others.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type PushArgsMatchPush = Assert<Same<keyof PushArgs, PushChannel>>;
