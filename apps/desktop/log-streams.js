'use strict';
// The log streams a repo session has open, pulled by the renderer chunk by chunk
// (see renderer/log.js and streamLog in git.js).

const git = require('./git');

// A read of a stream that is gone (closed, evicted, or its session disposed or replaced) returns
// CLOSED, never null: null means "end of log", and a history cut short must never be mistaken for
// a complete one. It is a value rather than an error because it is expected when the user opens
// another repository mid-load, and the renderer may see it before it has cancelled that load.
// A git process that dies mid-log still throws (see streamLog).
const CLOSED = false;

// Ids are unique across sessions, so a stale id from a replaced session can never read the
// next repository's stream.
let seq = 0;

class LogStreams {
  // onEnd(log) runs once a stream has been read to the end.
  constructor(root, { max = 6, onEnd } = {}) {
    this.root = root;
    this.max = max;
    this.onEnd = onEnd;
    this.logs = new Map(); // id -> { stream, opts, fast }
    this.disposed = false;
  }

  async open(opts) {
    const fast = await git.hasCommitGraph(this.root);
    if (this.disposed) return { id: ++seq, fast }; // an id nothing answers to: reads get CLOSED
    const stream = git.streamLog(this.root, opts);
    const id = ++seq;
    this.logs.set(id, { stream, opts, fast });
    for (const [old, l] of this.logs) if (this.logs.size > this.max && old !== id) { l.stream.close(); this.logs.delete(old); }
    return { id, fast };
  }

  async read(id) {
    const l = this.logs.get(id);
    if (!l) return CLOSED;
    const text = await l.stream.read();
    if (this.logs.get(id) !== l) return CLOSED; // closed while we waited
    if (text === null) {
      this.logs.delete(id);
      this.onEnd?.(l);
    }
    return text;
  }

  close(id) {
    this.logs.get(id)?.stream.close();
    this.logs.delete(id);
  }

  dispose() {
    this.disposed = true;
    for (const l of this.logs.values()) l.stream.close();
    this.logs.clear();
  }
}

module.exports = { LogStreams, CLOSED };
