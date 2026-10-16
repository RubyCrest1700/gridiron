// Small SVG charts, drawn from the actual simulated games (ported from web/app.js).

import { esc } from './ui.js';

export const COLORS = ['#60a5fa', '#f59e5b', '#34d399', '#c084fc'];

function kde(samples, lo, hi, points = 90) {
  const n = samples.length;
  let mean = 0;
  for (const v of samples) mean += v;
  mean /= n || 1;
  let sd = 0;
  for (const v of samples) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / (n || 1)) || 1;
  const bw = 1.06 * sd * n ** -0.2;
  const xs = [], ys = [];
  for (let i = 0; i < points; i++) {
    const x = lo + (i / (points - 1)) * (hi - lo);
    let y = 0;
    for (let j = 0; j < n; j++) { const z = (x - samples[j]) / bw; y += Math.exp(-0.5 * z * z); }
    xs.push(x); ys.push(y);
  }
  const max = Math.max(...ys) || 1;
  return { xs, ys: ys.map((y) => y / max) };
}

const q = (arr, p) => {
  const s = Float64Array.from(arr).sort();
  const pos = p * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

let uid = 0;

/** Overlaid outcome curves. series: [{samples, color, label}]. A single series
 *  also gets its floor / median / ceiling marked. */
export function densityChart(series, { height = 170, label = 'Range of fantasy points' } = {}) {
  const W = 360, H = height, padL = 6, padR = 6, padT = series.length === 1 ? 20 : 10, padB = 22;
  const lo = Math.min(0, ...series.map((s) => q(s.samples, 0.01)));
  const hi = Math.max(10, ...series.map((s) => q(s.samples, 0.99))) * 1.05;
  const X = (v) => padL + ((v - lo) / (hi - lo)) * (W - padL - padR);
  const Y = (v) => padT + (1 - v) * (H - padT - padB);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
  const step = hi > 45 ? 10 : 5;
  for (let t = 0; t <= hi; t += step) {
    svg += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${padT}" y2="${H - padB}"/><text x="${X(t)}" y="${H - 6}" text-anchor="middle">${t}</text>`;
  }
  svg += `<line class="axis" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/>`;
  for (const s of series) {
    const { xs, ys } = kde(s.samples, lo, hi);
    const pts = xs.map((x, k) => `${X(x).toFixed(1)},${Y(ys[k]).toFixed(1)}`).join(' ');
    const gid = `dc${++uid}`;
    svg += `<defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${s.color}" stop-opacity="${series.length > 1 ? 0.22 : 0.4}"/>
        <stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>
      <polygon points="${X(lo)},${Y(0)} ${pts} ${X(hi)},${Y(0)}" fill="url(#${gid})"/>
      <polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
    if (series.length === 1) {
      [[0.1, 'floor'], [0.5, 'median'], [0.9, 'ceiling']].forEach(([p, lab]) => {
        const v = q(s.samples, p);
        svg += `<line x1="${X(v)}" x2="${X(v)}" y1="${padT + 4}" y2="${H - padB}" stroke="${s.color}" stroke-opacity=".55" stroke-dasharray="3 3"/>
          <text x="${X(v)}" y="${padT - 6}" text-anchor="middle" style="fill:var(--text-dim)">${lab} ${v.toFixed(1)}</text>`;
      });
    }
  }
  return `${svg}</svg>`;
}

/** Recent games as bars, with this week's projection as a dashed line.
 *  games: [{label, pts}] oldest first. */
export function formChart(games, projection, color) {
  const W = 360, H = 150, padL = 6, padR = 6, padT = 18, padB = 22;
  const vals = games.map((g) => g.pts ?? 0);
  const top = Math.max(10, projection || 0, ...vals) * 1.15;
  const bw = (W - padL - padR) / Math.max(games.length, 1);
  const Y = (v) => padT + (1 - Math.max(0, v) / top) * (H - padT - padB);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Recent fantasy points">`;
  games.forEach((g, i) => {
    const v = vals[i];
    const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
    const beat = projection != null && v >= projection;
    svg += `<rect x="${x}" y="${Y(v)}" width="${w}" height="${H - padB - Y(v)}" rx="4" fill="${color}" fill-opacity="${beat ? 0.9 : 0.45}"/>
      <text x="${x + w / 2}" y="${Y(v) - 4}" text-anchor="middle" style="fill:var(--text-dim)">${v.toFixed(1)}</text>
      <text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${esc(g.label)}</text>`;
  });
  if (projection != null) {
    svg += `<line x1="${padL}" x2="${W - padR}" y1="${Y(projection)}" y2="${Y(projection)}" stroke="var(--text)" stroke-dasharray="5 4" stroke-opacity=".6"/>
      <text x="${W - padR}" y="${Y(projection) - 5}" text-anchor="end" style="fill:var(--text)">this week ${projection.toFixed(1)}</text>`;
  }
  return `${svg}<line class="axis" x1="${padL}" x2="${W - padR}" y1="${H - padB}" y2="${H - padB}"/></svg>`;
}
