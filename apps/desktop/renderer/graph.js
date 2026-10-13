// Commit graph layout + canvas painter.
// Layout is a single O(n · lanes) pass; painting only touches visible rows.

export const LANE_W = 14;
export const GRAPH_PAD = 12;
export const MAX_LANES = 28;

// Lane colours live in styles.css (--lane-0 … --lane-9) so they follow the theme.
export const LANES = 10;
export const laneVar = (n) => `var(--lane-${n % LANES})`;

export function readPalette(el = document.documentElement) {
  const cs = getComputedStyle(el);
  return Array.from({ length: LANES }, (_, i) => cs.getPropertyValue(`--lane-${i}`).trim());
}

export function layout(commits) {
  const lanes = [];
  const laneColor = [];
  const rows = new Array(commits.length);
  let colorSeq = 0;
  let maxLanes = 1;

  const freeSlot = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let col = lanes.indexOf(c.sha);
    let color;
    const top = [];
    const pass = [];
    if (col === -1) {
      col = freeSlot();
      color = colorSeq++;
    } else {
      color = laneColor[col];
    }
    for (let j = 0; j < lanes.length; j++) {
      const s = lanes[j];
      if (s === null || s === undefined) continue;
      if (s === c.sha) { top.push(j, laneColor[j]); lanes[j] = null; }
      else pass.push(j, laneColor[j]);
    }
    const bottom = [];
    for (let p = 0; p < c.parents.length; p++) {
      const ps = c.parents[p];
      let k = lanes.indexOf(ps);
      const colFree = lanes[col] === null || lanes[col] === undefined;
      if (p === 0 && k > col && colFree) {
        // Keep the first-parent line straight; the other lane converges into it at the parent row.
        k = col;
        lanes[k] = ps;
        laneColor[k] = color;
      } else if (k === -1) {
        if (p === 0 && (lanes[col] === null || lanes[col] === undefined)) {
          k = col;
          laneColor[k] = color;
        } else {
          k = freeSlot();
          laneColor[k] = colorSeq++;
        }
        lanes[k] = ps;
      }
      bottom.push(k, laneColor[k]);
    }
    while (lanes.length && (lanes[lanes.length - 1] === null || lanes[lanes.length - 1] === undefined)) lanes.pop();
    if (lanes.length > maxLanes) maxLanes = lanes.length;
    if (col + 1 > maxLanes) maxLanes = col + 1;
    rows[i] = { col, color, top, pass, bottom, merge: c.parents.length > 1 };
  }
  return { rows, maxLanes };
}

export function graphWidth(maxLanes) {
  return GRAPH_PAD * 2 + (Math.min(maxLanes, MAX_LANES) - 1) * LANE_W + 2;
}

const laneX = (l) => GRAPH_PAD + Math.min(l, MAX_LANES - 1) * LANE_W;

// Paint rows [first, last] onto ctx. y of row i = i * rowH - scrollTop.
export function paint(ctx, graph, { first, last, rowH, scrollTop, width, height, headSha, commits, selected, bg, colors }) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  const col = (c) => colors[c % colors.length];

  for (let i = first; i <= last; i++) {
    const r = graph.rows[i];
    if (!r) continue;
    const y0 = i * rowH - scrollTop;
    const mid = y0 + rowH / 2;
    const y1 = y0 + rowH;
    const xc = laneX(r.col);
    for (let k = 0; k < r.pass.length; k += 2) {
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
    const r = graph.rows[i];
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
  const r = graph.rows[i];
  return laneVar(r ? r.color : 0);
}
