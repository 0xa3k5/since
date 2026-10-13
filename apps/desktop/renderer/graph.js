// Commit graph layout + canvas painter.
// Layout is a single O(n · lanes) pass, done incrementally as the log streams in;
// painting only touches visible rows.

export const LANE_W = 14;
export const GRAPH_PAD = 12;
export const MAX_LANES = 28;

export const PALETTE = [
  '#5e6ad2', '#26b5ce', '#4cb782', '#f2c94c', '#f2994a',
  '#eb5757', '#bb87fc', '#4ea7fc', '#e46a76', '#9cc65f',
];

// Lane state between rows. Row i's layout depends only on commits[0..i], so the graph is built
// incrementally as the log streams in, and can be cut back to any prefix when history changes.
// `pos` maps each sha waiting in a lane to its lane index (an array when several lanes converge
// on it), so a row costs O(parents) instead of scans over every open lane: big histories run
// hundreds of lanes wide.
const newState = () => ({ lanes: [], laneColor: [], colorSeq: 0, maxLanes: 1, pos: new Map() });
// Checkpoints keep only the arrays; `pos` is rebuilt when one is restored.
const snapshot = (s) => ({ lanes: s.lanes.slice(), laneColor: s.laneColor.slice(), colorSeq: s.colorSeq, maxLanes: s.maxLanes });
function restore(cp) {
  const st = { ...cp, lanes: cp.lanes.slice(), laneColor: cp.laneColor.slice(), pos: new Map() };
  st.lanes.forEach((sha, j) => { if (sha !== null && sha !== undefined) occupy(st, j, sha); });
  return st;
}

function occupy(st, j, sha) {
  st.lanes[j] = sha;
  const p = st.pos.get(sha);
  if (p === undefined) st.pos.set(sha, j);
  else if (typeof p === 'number') st.pos.set(sha, p < j ? [p, j] : [j, p]);
  else { p.push(j); p.sort((x, y) => x - y); }
}
const laneOf = (st, sha) => {
  const p = st.pos.get(sha);
  return p === undefined ? -1 : typeof p === 'number' ? p : p[0];
};

// Lay out one commit, advancing `st`. With `full`, also returns the lines through the row.
function step(st, c, full) {
  const { lanes, laneColor } = st;
  const freeSlot = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  let col = laneOf(st, c.sha);
  let color;
  const top = full ? [] : null;
  const pass = full ? [] : null;
  if (col === -1) {
    col = freeSlot();
    color = st.colorSeq++;
  } else {
    color = laneColor[col];
  }
  // Lanes waiting for this commit end here.
  const mine = st.pos.get(c.sha);
  if (mine !== undefined) {
    st.pos.delete(c.sha);
    if (typeof mine === 'number') lanes[mine] = null;
    else for (const j of mine) lanes[j] = null;
  }
  if (full) {
    const ends = mine === undefined ? [] : typeof mine === 'number' ? [mine] : mine;
    for (let j = 0, e = 0; j < lanes.length; j++) {
      if (e < ends.length && ends[e] === j) { top.push(j, laneColor[j]); e++; continue; }
      const s = lanes[j];
      if (s !== null && s !== undefined) pass.push(j, laneColor[j]);
    }
  }
  const bottom = full ? [] : null;
  for (let p = 0; p < c.parents.length; p++) {
    const ps = c.parents[p];
    let k = laneOf(st, ps);
    const colFree = lanes[col] === null || lanes[col] === undefined;
    if (p === 0 && k > col && colFree) {
      // Keep the first-parent line straight; the other lane converges into it at the parent row.
      k = col;
      occupy(st, k, ps);
      laneColor[k] = color;
    } else if (k === -1) {
      if (p === 0 && (lanes[col] === null || lanes[col] === undefined)) {
        k = col;
        laneColor[k] = color;
      } else {
        k = freeSlot();
        laneColor[k] = st.colorSeq++;
      }
      occupy(st, k, ps);
    }
    if (full) bottom.push(k, laneColor[k]);
  }
  while (lanes.length && (lanes[lanes.length - 1] === null || lanes[lanes.length - 1] === undefined)) lanes.pop();
  if (lanes.length > st.maxLanes) st.maxLanes = lanes.length;
  if (col + 1 > st.maxLanes) st.maxLanes = col + 1;
  return full ? { col, color, top, pass, bottom, merge: c.parents.length > 1 } : { col, color };
}

// Rows per checkpoint. Only each row's lane and colour are stored; the lines through a row are
// recomputed on demand from the nearest checkpoint, a block at a time, for the rows on screen.
// That keeps memory flat (no per-row line lists) on million-commit histories.
// Rows on screen are built in smaller runs: the checkpoint is replayed cheaply up to the run,
// and only the run itself gets its full line lists.
const BLOCK = 256;
const RUN = 32;
const CACHED_RUNS = 64;

// Incremental graph over `commits` (an array the caller appends to). Call sync() after appending.
export function createGraph(commits, from = null, upTo = 0) {
  let n = 0;
  let cols = new Int32Array(1024);
  let colors = new Int32Array(1024);
  let checkpoints = [snapshot(newState())]; // checkpoints[b] = lane state before row b * BLOCK
  let st = newState();
  const runs = new Map(); // run -> full rows, most recently used last

  const grow = (need) => {
    if (need <= cols.length) return;
    let size = cols.length;
    while (size < need) size *= 2;
    const c = new Int32Array(size); c.set(cols.subarray(0, n)); cols = c;
    const k = new Int32Array(size); k.set(colors.subarray(0, n)); colors = k;
  };

  // Advance from row n to `end`.
  const advance = (end) => {
    grow(end);
    for (let i = n; i < end; i++) {
      const r = step(st, commits[i], false);
      cols[i] = r.col;
      colors[i] = r.color;
      if ((i + 1) % BLOCK === 0) checkpoints.push(snapshot(st));
    }
    runs.delete(Math.floor(n / RUN)); // the old last run may have been partial
    n = end;
  };

  // Rewind to a prefix of `m` rows.
  const rewind = (m) => {
    const b = Math.floor(m / BLOCK);
    checkpoints.length = b + 1;
    st = restore(checkpoints[b]);
    for (const k of [...runs.keys()]) if (k * RUN >= b * BLOCK) runs.delete(k);
    n = b * BLOCK;
    advance(m);
  };

  if (from) {
    n = Math.min(upTo, from.length);
    const b = Math.floor(n / BLOCK);
    grow(Math.max(n, 1024));
    const src = from._arrays();
    cols.set(src.cols.subarray(0, b * BLOCK));
    colors.set(src.colors.subarray(0, b * BLOCK));
    checkpoints = src.checkpoints.slice(0, b + 1); // checkpoints are never mutated, so sharing is safe
    rewind(n);
  }

  const g = {
    get length() { return n; },
    get maxLanes() { return st.maxLanes; },
    col: (i) => cols[i],
    color: (i) => colors[i],
    // Lay out any commits appended since the last call.
    sync() { if (commits.length > n) advance(commits.length); return g; },
    // Forget rows from `m` on (the caller trims `commits` to match).
    truncate(m) { if (m < n) rewind(m); return g; },
    // Full row (lines in and out) for display.
    row(i) {
      if (i < 0 || i >= n) return null;
      const r = Math.floor(i / RUN);
      let rows = runs.get(r);
      if (rows) { runs.delete(r); runs.set(r, rows); return rows[i - r * RUN]; }
      const start = r * RUN;
      const end = Math.min(n, start + RUN);
      const s = restore(checkpoints[Math.floor(start / BLOCK)]);
      for (let k = Math.floor(start / BLOCK) * BLOCK; k < start; k++) step(s, commits[k], false);
      rows = [];
      for (let k = start; k < end; k++) rows.push(step(s, commits[k], true));
      if (end === start + RUN) {
        runs.set(r, rows);
        if (runs.size > CACHED_RUNS) runs.delete(runs.keys().next().value);
      }
      return rows[i - start];
    },
    // A new graph over `other` (whose first `m` commits match ours), reusing our layout of them.
    fork(other, m) { return createGraph(other, g, m); },
    _arrays: () => ({ cols, colors, checkpoints }),
  };
  return g;
}

// Lay out a complete list in one go.
export function layout(commits) {
  return createGraph(commits).sync();
}

export function graphWidth(maxLanes) {
  return GRAPH_PAD * 2 + (Math.min(maxLanes, MAX_LANES) - 1) * LANE_W + 2;
}

const laneX = (l) => GRAPH_PAD + Math.min(l, MAX_LANES - 1) * LANE_W;

// Paint rows [first, last] onto ctx. y of row i = i * rowH - scrollTop.
export function paint(ctx, graph, { first, last, rowH, scrollTop, width, height, headSha, commits, selected, bg }) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  const colors = PALETTE;
  const col = (c) => colors[c % colors.length];

  for (let i = first; i <= last; i++) {
    const r = graph.row(i);
    if (!r) continue;
    const y0 = i * rowH - scrollTop;
    const mid = y0 + rowH / 2;
    const y1 = y0 + rowH;
    const xc = laneX(r.col);
    for (let k = 0; k < r.pass.length; k += 2) {
      // Lanes past MAX_LANES all share the last column: one line there is enough.
      if (k && r.pass[k - 2] >= MAX_LANES - 1) break;
      const x = laneX(r.pass[k]);
      ctx.strokeStyle = col(r.pass[k + 1]);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
    for (let k = 0; k < r.top.length; k += 2) {
      const x = laneX(r.top[k]);
      ctx.strokeStyle = col(r.top[k + 1]);
      ctx.beginPath(); ctx.moveTo(x, y0);
      if (x === xc) ctx.lineTo(xc, mid);
      else ctx.bezierCurveTo(x, mid, xc, y0, xc, mid);
      ctx.stroke();
    }
    for (let k = 0; k < r.bottom.length; k += 2) {
      const x = laneX(r.bottom[k]);
      ctx.strokeStyle = col(r.bottom[k + 1]);
      ctx.beginPath(); ctx.moveTo(xc, mid);
      if (x === xc) ctx.lineTo(x, y1);
      else ctx.bezierCurveTo(xc, y1, x, mid, x, y1);
      ctx.stroke();
    }
  }
  // Nodes on top of lines.
  for (let i = first; i <= last; i++) {
    const r = graph.row(i);
    if (!r) continue;
    const mid = i * rowH - scrollTop + rowH / 2;
    const xc = laneX(r.col);
    const c = col(r.color);
    const isHead = commits[i].sha === headSha;
    ctx.beginPath();
    ctx.arc(xc, mid, isHead ? 5 : 4, 0, Math.PI * 2);
    if (r.merge) {
      ctx.fillStyle = bg; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = c; ctx.stroke(); ctx.lineWidth = 1.6;
    } else {
      ctx.fillStyle = c; ctx.fill();
    }
    if (isHead) {
      ctx.beginPath(); ctx.arc(xc, mid, 8, 0, Math.PI * 2);
      ctx.strokeStyle = c; ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.6;
    }
    if (selected && commits[i].sha === selected) {
      ctx.beginPath(); ctx.arc(xc, mid, 2, 0, Math.PI * 2); ctx.fillStyle = bg; ctx.fill();
    }
  }
}

export function laneColor(graph, i) {
  return i != null && i < graph.length ? PALETTE[graph.color(i) % PALETTE.length] : PALETTE[0];
}
