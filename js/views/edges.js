// Edges: the model against the sportsbook's posted player props.
//
// The lines are fetched by this phone, from ESPN's public odds feed, the same
// way ESPN's own site loads them -- the app's hosted files contain no odds at
// all (see nflpred/publish.py). The comparison is the desktop app's
// (nflpred/market.py vegas_edges), done here.

import { probOver } from '../engine.js';
import { dropdown, onPick, esc, avatar, posPill, statusTag, num, pct, store, empty, skeleton, toast, fmtKickoff } from '../ui.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const PROP_STATS = {
  'Total Passing Yards (incl. overtime)': 'passing_yards',
  'Total Pass Attempts (incl. overtime)': 'attempts',
  'Total Pass Completions (incl. overtime)': 'completions',
  'Total Passing Touchdowns (incl. overtime)': 'passing_tds',
  'Total Passing Interceptions (incl. overtime)': 'passing_interceptions',
  'Total Rushing Yards (incl. overtime)': 'rushing_yards',
  'Total Carries (incl. overtime)': 'carries',
  'Total Rushing Attempts (incl. overtime)': 'carries',
  'Total Receiving Yards (incl. overtime)': 'receiving_yards',
  'Total Receptions (incl. overtime)': 'receptions',
};
const STAT_LABEL = {
  passing_yards: 'Pass yds', attempts: 'Pass att', completions: 'Completions', passing_tds: 'Pass TD',
  passing_interceptions: 'INT', rushing_yards: 'Rush yds', carries: 'Carries',
  receiving_yards: 'Rec yds', receptions: 'Receptions',
};
// In-play boards already know part of the outcome; never compare against them.
const LIVE_BOOK_MARKERS = ['live odds', 'live-odds', 'in-play', 'inplay', 'live betting'];
const PROB_SHRINK = 0.35;             // market.PROB_SHRINK
const GHOST_LINE_PLAY_PROB = 0.05;    // market.GHOST_LINE_PLAY_PROB
const PPR_VALUE = { passing_yards: 0.04, passing_tds: 4.0, passing_interceptions: 2.0, rushing_yards: 0.10,
  rushing_tds: 6.0, receiving_yards: 0.10, receiving_tds: 6.0, receptions: 1.0,
  attempts: 0.30, completions: 0.45, carries: 0.43 };
const LINES_TTL = 30 * 60 * 1000;

const st = { stat: 'ALL', pos: 'ALL', side: 'ALL', q: '', sort: store.get('edges.sort', 'impact'),
  view: store.get('edges.view', 'prop'), loading: null, edges: null, fetchedAt: null, week: null };
const SORTS = [['impact', 'Biggest gap'], ['edge', 'Most confident'], ['kickoff', 'Kickoff time'], ['name', 'Player A–Z']];

const https = (ref) => String(ref || '').replace('http://', 'https://');

async function getJSON(url) {
  const r = await fetch(url, { method: 'GET', credentials: 'omit' });
  if (!r.ok) throw new Error(`ESPN returned ${r.status}`);
  return r.json();
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (_) { out[k] = null; } }
  }));
  return out;
}

/** Every main player-prop line for a week, as {espn, stat, line, book}. */
async function fetchLines(season, week) {
  const idx = await getJSON(`${CORE}/seasons/${season}/types/2/weeks/${week}/events?limit=40`);
  const events = (idx.items || []).map((i) => https(i.$ref)).filter(Boolean);
  const perGame = await pool(events, 6, async (ref) => {
    const ev = await getJSON(ref);
    const comp = (ev.competitions || [])[0];
    const oddsRef = comp && comp.odds && comp.odds.$ref;
    if (!oddsRef) return [];
    const odds = await getJSON(https(oddsRef));
    const rows = [];
    for (const board of odds.items || []) {
      const book = (board.provider || {}).name || 'book';
      if (LIVE_BOOK_MARKERS.some((m) => book.toLowerCase().includes(m))) continue;
      const propRef = (board.propBets || {}).$ref;
      if (!propRef) continue;
      const props = await getJSON(`${https(propRef)}&limit=1000`);
      for (const item of props.items || []) {
        const stat = PROP_STATS[((item.type || {}).name || '').trim()];
        if (!stat) continue;
        const m = String((item.athlete || {}).$ref || '').match(/\/athletes\/(\d+)/);
        if (!m) continue;
        const line = Number((((item.current || {}).target) || {}).value);
        if (!Number.isFinite(line)) continue;
        rows.push({ espn: m[1], stat, line, book });
      }
    }
    return rows;
  });
  // Main line only: whole-number quotes are the alternate ladder's long shots.
  const groups = new Map();
  for (const r of perGame.flat().filter(Boolean)) {
    if (r.line % 1 === 0) continue;
    const k = `${r.book}|${r.espn}|${r.stat}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const rows of groups.values()) {
    const vals = rows.map((r) => r.line).sort((a, b) => a - b);
    const mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
    out.push(rows.reduce((best, r) => (Math.abs(r.line - mid) < Math.abs(best.line - mid) ? r : best)));
  }
  return out;
}

const calibrate = (p) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
  return 1 / (1 + Math.exp(-PROB_SHRINK * Math.log(q / (1 - q))));
};

/** The model against each line (port of market.vegas_edges). */
function computeEdges(ctx, lines) {
  const byEspn = new Map();
  for (const p of ctx.week.order) if (p.espn) byEspn.set(String(p.espn), p);
  const rows = [];
  for (const ln of lines) {
    const p = byEspn.get(ln.espn);
    if (!p) continue;
    const summary = (ctx.week.stats[p.id] || {})[ln.stat];
    if (!summary) continue;
    const prob = probOver(summary, ln.line);
    if (prob == null) continue;
    const play = Number(p.play || 0);
    if (play < GHOST_LINE_PLAY_PROB) continue;           // he will not dress; the prop voids
    const model = Number(summary.mean || 0);
    let cp = prob, cm = model;
    if (play > 0.05 && ln.line > 0) { cp = Math.min(prob / play, 1); cm = model / play; }
    const pOver = calibrate(cp);
    rows.push({ player: p, stat: ln.stat, line: ln.line, book: ln.book, model: cm,
      prob_over: pOver, side: pOver > 0.5 ? 'Over' : 'Under', edge: Math.abs(pOver - 0.5),
      impact: Math.abs(cm - ln.line) * (PPR_VALUE[ln.stat] || 0) });
  }
  return rows;
}

function cached(week) {
  const c = store.get(`lines.${week}`, null);
  return c && Date.now() - c.at < LINES_TTL ? c : null;
}

async function ensureLines(ctx, force = false) {
  const week = ctx.meta.week;
  if (!force && st.edges && st.week === week) return;
  const c = !force && cached(week);
  if (c) {
    st.edges = computeEdges(ctx, c.lines); st.fetchedAt = c.at; st.week = week; return;
  }
  if (!st.loading) {
    st.loading = fetchLines(ctx.meta.season, week).then((lines) => {
      store.set(`lines.${week}`, { at: Date.now(), lines });
      st.edges = computeEdges(ctx, lines); st.fetchedAt = Date.now(); st.week = week;
    }).finally(() => { st.loading = null; });
  }
  await st.loading;
}

/** Lines for one player, for the player card (only if already loaded). */
export function linesFor(ctx, id) {
  if (!st.edges) {
    const c = cached(ctx.meta.week);
    if (!c) return '';
    st.edges = computeEdges(ctx, c.lines); st.week = ctx.meta.week; st.fetchedAt = c.at;
  }
  const rows = st.edges.filter((e) => e.player.id === id);
  if (!rows.length) return '';
  return `<div class="section-title">Sportsbook lines</div><div class="card flush"><table class="tbl">
    <thead><tr><th>Prop</th><th class="r">Line</th><th class="r">Model</th><th class="r">Lean</th></tr></thead>
    <tbody>${rows.map((e) => `<tr><td>${esc(STAT_LABEL[e.stat] || e.stat)}</td><td class="r">${num(e.line)}</td>
      <td class="r">${num(e.model)}</td><td class="r"><span class="badge ${e.side === 'Over' ? 'w' : 'l'}">${e.side} ${pct(e.side === 'Over' ? e.prob_over : 1 - e.prob_over)}</span></td></tr>`).join('')}
    </tbody></table></div>`;
}

const INT_STATS = new Set(['passing_tds', 'passing_interceptions', 'receptions', 'carries', 'completions', 'attempts']);
const fmtLine = (stat, v) => num(v, INT_STATS.has(stat) ? 1 : 1);
const leanProb = (e) => (e.side === 'Over' ? e.prob_over : 1 - e.prob_over);

/** A small track: where the line sits, where the model sits. */
function gapBar(e) {
  const hi = Math.max(e.line, e.model) * 1.25 || 1;
  const x = (v) => Math.max(0, Math.min(100, (v / hi) * 100));
  const a = x(Math.min(e.line, e.model)), b = x(Math.max(e.line, e.model));
  const col = e.side === 'Over' ? 'var(--good)' : 'var(--bad)';
  return `<div class="gapbar"><span class="fill" style="left:${a}%;width:${Math.max(1, b - a)}%;background:${col}"></span>
    <span class="ln" style="left:calc(${x(e.line)}% - 1px)"></span><span class="md" style="left:calc(${x(e.model)}% - 5px);background:${col}"></span></div>`;
}

function leanBadge(e) {
  return `<div class="lean ${e.side === 'Over' ? 'over' : 'under'}"><span>${e.side.toUpperCase()}</span><strong>${pct(leanProb(e))}</strong></div>`;
}

function propCard(e) {
  const p = e.player;
  const gap = e.model - e.line;
  return `<div class="card edge-card" data-player="${esc(p.id)}">
    <div class="edge-top">${avatar({ ...p, position: p.pos })}
      <div class="pmain"><div class="pname">${posPill(p.pos)}<span class="n">${esc(p.name)}</span>${statusTag(p.status, p.injury)}</div>
        <div class="pline">${esc(p.team)}${p.opp ? ` vs ${esc(p.opp)}` : ''}${p.kickoff ? ` · ${esc(fmtKickoff(p.kickoff))}` : ''}</div></div>
      ${leanBadge(e)}</div>
    <div class="edge-stat">${esc(STAT_LABEL[e.stat] || e.stat)}</div>
    <div class="edge-nums">
      <div><div class="l">Line</div><div class="v">${fmtLine(e.stat, e.line)}</div></div>
      <div><div class="l">Model</div><div class="v">${num(e.model)}</div></div>
      <div><div class="l">Gap</div><div class="v ${gap >= 0 ? 'up' : 'down'}">${gap >= 0 ? '+' : '−'}${num(Math.abs(gap))}</div></div>
    </div>
    ${gapBar(e)}
  </div>`;
}

function playerCard(rows) {
  const p = rows[0].player;
  return `<div class="card flush edge-card">
    <div class="edge-top" style="padding:12px 14px 6px" data-player="${esc(p.id)}">${avatar({ ...p, position: p.pos })}
      <div class="pmain"><div class="pname">${posPill(p.pos)}<span class="n">${esc(p.name)}</span>${statusTag(p.status, p.injury)}</div>
        <div class="pline">${esc(p.team)}${p.opp ? ` vs ${esc(p.opp)}` : ''}${p.kickoff ? ` · ${esc(fmtKickoff(p.kickoff))}` : ''}</div></div></div>
    <table class="tbl"><thead><tr><th>Prop</th><th class="r">Line</th><th class="r">Model</th><th class="r">Lean</th></tr></thead>
    <tbody>${rows.map((e) => `<tr><td>${esc(STAT_LABEL[e.stat] || e.stat)}</td><td class="r">${fmtLine(e.stat, e.line)}</td>
      <td class="r">${num(e.model)}</td><td class="r"><span class="badge ${e.side === 'Over' ? 'w' : 'l'}">${e.side} ${pct(leanProb(e))}</span></td></tr>`).join('')}</tbody></table>
  </div>`;
}

export async function render(host, ctx, stale) {
  if (!st.edges || st.week !== ctx.meta.week) {
    host.innerHTML = `<div class="card"><h2>Model vs the sportsbook</h2><p class="muted" style="margin:0;font-size:14px">Fetching this week's player props…</p></div>${skeleton(6)}`;
    try { await ensureLines(ctx); } catch (err) {
      if (stale()) return;
      host.innerHTML = empty('Could not load the lines', `${esc(err.message)}. Props usually post by Wednesday.`, '📉');
      return;
    }
    if (stale()) return;
  }
  const all = st.edges || [];
  const stats = [...new Set(all.map((e) => e.stat))].sort((a, b) => Object.keys(STAT_LABEL).indexOf(a) - Object.keys(STAT_LABEL).indexOf(b));
  if (st.stat !== 'ALL' && !stats.includes(st.stat)) st.stat = 'ALL';

  host.innerHTML = `
    <input type="search" id="ed-q" placeholder="Search a player or team" value="${esc(st.q)}" autocomplete="off" autocorrect="off" spellcheck="false">
    <div class="chips" style="margin-top:10px">${['ALL', ...stats].map((s) => `<button class="chip ${s === st.stat ? 'active' : ''}" data-stat="${s}">${s === 'ALL' ? 'All props' : esc(STAT_LABEL[s] || s)}</button>`).join('')}</div>
    <div class="chips">${['ALL', 'QB', 'RB', 'WR', 'TE'].map((x) => `<button class="chip ${x === st.pos ? 'active' : ''}" data-pos="${x}">${x === 'ALL' ? 'All positions' : x}</button>`).join('')}
      ${['ALL', 'Over', 'Under'].map((x) => `<button class="chip ${x === st.side ? 'active' : ''}" data-side="${x}">${x === 'ALL' ? 'Over & Under' : `${x}s`}</button>`).join('')}</div>
    <div class="row" style="margin-bottom:12px;justify-content:space-between">
      ${dropdown('ed-sort', SORTS, st.sort, { prefix: 'Sort', label: 'Sort' })}
      <div class="seg" style="margin:0;flex-shrink:0"><button data-view="prop" class="${st.view === 'prop' ? 'active' : ''}">By prop</button><button data-view="player" class="${st.view === 'player' ? 'active' : ''}">By player</button></div>
    </div>
    <div id="ed-list"></div>
    <p class="note">Lines are DraftKings' main props as ESPN shows them, loaded by your phone${st.fetchedAt ? ` at ${new Date(st.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.
      <strong>Over 57%</strong> means the result landed over the line in 57% of the model's simulated games (assuming he plays, as a prop does).
      “Gap” is model minus line. For entertainment and fantasy research — not betting advice.</p>
    <button class="btn block" id="ed-refresh">Reload lines</button>`;

  const list = host.querySelector('#ed-list');
  const draw = () => {
    const q = st.q.trim().toLowerCase();
    let rows = all.filter((e) => (st.stat === 'ALL' || e.stat === st.stat)
      && (st.pos === 'ALL' || e.player.pos === st.pos)
      && (st.side === 'ALL' || e.side === st.side)
      && (!q || e.player.name.toLowerCase().includes(q) || (e.player.team || '').toLowerCase() === q));
    const key = {
      impact: (a, b) => b.impact - a.impact,
      edge: (a, b) => b.edge - a.edge,
      kickoff: (a, b) => String(a.player.kickoff).localeCompare(String(b.player.kickoff)) || b.impact - a.impact,
      name: (a, b) => a.player.name.localeCompare(b.player.name) || a.stat.localeCompare(b.stat),
    }[st.sort] || ((a, b) => b.impact - a.impact);
    rows = rows.slice().sort(key);
    const overs = rows.filter((e) => e.side === 'Over').length;
    const summary = `<p class="faint" style="margin:0 4px 10px;font-size:13px">${rows.length} prop${rows.length === 1 ? '' : 's'} · ${overs} over · ${rows.length - overs} under</p>`;
    if (!rows.length) {
      list.innerHTML = all.length ? empty('No props match', 'Try clearing a filter or the search.', '🔎')
        : empty('No lines posted yet', 'Player props usually appear midweek. Check back later.', '📉');
      return;
    }
    if (st.view === 'player') {
      const groups = new Map();
      for (const e of rows) { if (!groups.has(e.player.id)) groups.set(e.player.id, []); groups.get(e.player.id).push(e); }
      list.innerHTML = summary + [...groups.values()].slice(0, 60).map(playerCard).join('');
    } else {
      list.innerHTML = summary + rows.slice(0, 80).map(propCard).join('');
    }
  };
  draw();

  const q = host.querySelector('#ed-q');
  q.addEventListener('input', () => { st.q = q.value; draw(); });
  host.querySelectorAll('[data-stat]').forEach((b) => b.addEventListener('click', () => { st.stat = b.dataset.stat; render(host, ctx, stale); }));
  host.querySelectorAll('[data-pos]').forEach((b) => b.addEventListener('click', () => { st.pos = b.dataset.pos; render(host, ctx, stale); }));
  host.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { st.side = b.dataset.side; render(host, ctx, stale); }));
  onPick(host.querySelector('#ed-sort'), SORTS, (v) => { st.sort = v; store.set('edges.sort', st.sort); draw(); });
  host.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    st.view = b.dataset.view; store.set('edges.view', st.view); render(host, ctx, stale);
  }));
  host.querySelector('#ed-refresh').addEventListener('click', async () => {
    try { await ensureLines(ctx, true); toast('Lines reloaded'); } catch (err) { toast(err.message); }
    render(host, ctx, stale);
  });
}
