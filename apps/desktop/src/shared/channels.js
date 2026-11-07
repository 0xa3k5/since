'use strict';
// IPC channel names shared by the main process and the preload script. The preload runs
// sandboxed and can't require local files, so it keeps a copy of PUSH; test/channels.test.js
// checks that the copy and every channel the main process uses match this list.

/** The invoke channel for git calls: method name, then its arguments. */
const GIT = 'git';
/** Prefix of every app-level invoke channel (`app:open-file`, …). */
const APP_PREFIX = 'app:';
/** Channels the main process pushes to the renderer. The preload lets only these through. */
const PUSH = Object.freeze(['repo:changed', 'command', 'clone:progress', 'theme', 'update', 'keymap', 'cleanup:progress', 'tabs', 'git']);

module.exports = { GIT, APP_PREFIX, PUSH };
