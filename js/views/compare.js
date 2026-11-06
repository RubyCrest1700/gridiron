// Start / Sit: who scores the most, across the same simulated games.
//
// One table, a column per player -- photo and name on top, then each measure
// straight across, the best in each row highlighted -- so it is obvious at a
// glance who is being compared and who comes out ahead. Boom and bust are
// counted from the stored simulations themselves.

import * as E from '../engine.js';
import * as SL from '../sleeper.js';
import { esc, avatar, posPill, statusTag, num, pct, store, empty } from '../ui.js';
import { COLORS, densityChart } from '../charts.js';

const MAX = 4;
// "Boom" and "bust" lines by position, roughly a top-5 and a sub-replacement week (PPR).
const BOOM = { QB: 25, RB: 20, WR: 20, TE: 15 };
const BUST = { QB: 12, RB: 8, WR: 8, TE: 5 };
const st = { ids: store.get('compare', []), q: '', scoring: store.get('compare.scoring', 'ppr') };

async function leagueScoring() {
  const id = store.get('leagues.current', null);
  if (!id) return null;
  try { const lg = await SL.league(id); return lg ? { id, name: lg.name, settings: lg.scoring_settings } : null; } catch (_) { return null; }
}

function positionRanks(ctx) {
  const out = new Map();
  const seen = {};
  for (const p of ctx.week.order) {
    seen[p.pos] = (seen[p.pos] || 0) + 1;
    out.set(p.id, `${p.pos}${seen[p.pos]}`);
  }
  return out;
}

const share = (arr, f) => { let c = 0; for (const v of arr) if (f(v)) c++; return arr.length ? c / arr.length : 0; };
const shortName = (n) => {
  const parts = String(n).split(' ');
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : n;
};

function save() { store.set('compare', st.ids); }

export async function render(host, ctx) {
  st.ids = st.ids.filter((id) => ctx.week.players.has(id)).slice(0, MAX);
  const lg = await leagueScoring();
  if (st.scoring !== 'ppr' && (!lg || lg.id !== st.scoring)) st.scoring = 'ppr';
  const players = st.ids.map((id) => ctx.week.players.get(id));
  const scoring = st.scoring !== 'ppr' && lg ? E.compileScoring(lg.settings) : null;
  const scoringName = scoring ? lg.name : 'PPR';
  const posOf = (id) => (ctx.week.players.get(id) || {}).pos;
  const res = players.length >= 2 ? E.compare(ctx.week.sims, st.ids, scoring, posOf) : null;
  const ok = !!(res && res.available);
  const samples = players.map((p, k) => (ok ? res.samples[k] : E.playerSamples(ctx.week.sims, p.id, scoring, p.pos)));
  const ranks = positionRanks(ctx);

  let html = `<div class="card">
      <input type="search" id="cs-q" placeholder="${players.length >= MAX ? `Add a player (replaces ${esc(players[0].name)})` : 'Add a player to compare…'}" value="${esc(st.q)}" autocomplete="off" autocorrect="off" spellcheck="false">
      <div id="cs-sug" class="list"></div>
      ${lg ? `<div class="seg" style="margin:12px 0 0">
        <button data-sc="ppr" class="${st.scoring === 'ppr' ? 'active' : ''}">PPR</button>
        <button data-sc="${esc(lg.id)}" class="${st.scoring === lg.id ? 'active' : ''}">${esc(lg.name)}</button></div>` : ''}
    </div>`;

  if (!players.length) {
    const sug = ctx.week.order.filter((p) => p.pos === 'WR').slice(4, 6);
    html += empty('Who should you start?', 'Add two to four players to see how often each one comes out on top.', '⚖️');
    if (sug.length === 2) html += `<button class="btn block" id="cs-demo">Try ${esc(sug[0].name)} vs ${esc(sug[1].name)}</button>`;
  } else {
    // The verdict, in one line.
    if (ok) {
      const w = res.p_best;
      const best = w.indexOf(Math.max(...w));
      const margin = w[best] - Math.max(...w.filter((_, i) => i !== best));
      const word = margin < 0.06 ? 'Coin flip — slight edge to' : margin < 0.15 ? 'Lean' : 'Start';
      html += `<div class="card verdict-line">${word} <strong>${esc(players[best].name)}</strong>: scores the most in
        <strong>${pct(w[best])}</strong> of ${res.n.toLocaleString()} simulated games (${esc(scoringName)}).</div>`;
    }

    // One row of numbers per measure; the best value in each row highlighted.
    const stats = players.map((p, i) => {
      const s = samples[i];
      return {
        win: ok ? res.p_best[i] : null,
        proj: s ? s.reduce((a, v) => a + v, 0) / s.length : p.ppr,
        floor: s ? E.quantile(s, 0.1) : (p.range || {}).p10,
        ceil: s ? E.quantile(s, 0.9) : (p.range || {}).p90,
        boom: s && BOOM[p.pos] ? share(s, (v) => v >= BOOM[p.pos]) : null,
        bust: s && BUST[p.pos] ? share(s, (v) => v < BUST[p.pos]) : null,
        play: p.play,
      };
    });
    const bestOf = (key, lowIsBest = false) => {
      const vals = stats.map((x) => x[key]).filter((v) => v != null);
      if (vals.length < 2) return null;
      return lowIsBest ? Math.min(...vals) : Math.max(...vals);
    };
    const cols = players.length;
    const row = (label, key, fmt, lowIsBest = false, extra = () => '') => {
      const b = bestOf(key, lowIsBest);
      return `<div class="cmp-lab">${label}</div>${stats.map((x, i) => `<div class="cmp-val${b != null && x[key] === b ? ' best' : ''}">${x[key] == null ? '—' : fmt(x[key])}${extra(x, i)}</div>`).join('')}`;
    };
    html += `<div class="card">
      <div class="row" style="justify-content:space-between;margin:-4px 0 6px">
        <div class="section-title" style="margin:0">Comparing ${cols}</div>
        <button class="link-btn" id="cs-clear">Clear all</button>
      </div>
      <div class="cmp-table" style="grid-template-columns: 64px repeat(${cols}, minmax(0, 1fr))">
        <div></div>
        ${players.map((p, i) => `<div class="cmp-head" style="--c:${COLORS[i]}">
          <span data-player="${esc(p.id)}">${avatar({ ...p, position: p.pos })}</span>
          <div class="nm" data-player="${esc(p.id)}">${esc(cols > 2 ? shortName(p.name) : p.name)}</div>
          <div class="sub">${esc(ranks.get(p.id) || p.pos)} · ${esc(p.team)}${p.opp ? ` v ${esc(p.opp)}` : ''}</div>
          ${statusTag(p.status, p.injury)}
          <button class="cmp-remove" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">✕ Remove</button>
        </div>`).join('')}
        ${ok ? row('Scores most', 'win', (v) => `<span class="cmp-win">${pct(v)}</span>`, false,
          (x, i) => `<div class="bar"><span style="width:${(x.win * 100).toFixed(1)}%;background:${COLORS[i]}"></span></div>`) : ''}
        ${row('Projected', 'proj', (v) => num(v))}
        ${row('Floor', 'floor', (v) => num(v))}
        ${row('Ceiling', 'ceil', (v) => num(v))}
        ${row('Boom', 'boom', (v) => pct(v))}
        ${row('Bust', 'bust', (v) => pct(v), true)}
        ${row('Plays', 'play', (v) => pct(v))}
      </div>
      <p class="note" style="margin-bottom:0">Floor and ceiling are the 10th and 90th percentile. Boom is a ${Object.entries(BOOM).map(([k, v]) => `${k} ${v}+`).join(', ')} game;
        bust is under ${Object.entries(BUST).map(([k, v]) => `${k} ${v}`).join(', ')}. Best in each row in green.
        ${ok && res.corr != null ? ` These two are simulated together (correlation ${res.corr}).` : ''}</p>
    </div>`;
    if (players.length === 1) html += '<p class="note">Add one more player to compare.</p>';

    const series = players.map((p, i) => ({ samples: samples[i], color: COLORS[i], label: p.name })).filter((x) => x.samples);
    if (series.length) {
      html += `<div class="card"><h2>Range of outcomes</h2>
        ${densityChart(series)}
        <div class="legend">${series.map((x) => `<span><i style="background:${x.color}"></i>${esc(x.label)}</span>`).join('')}</div>
        <p class="note">Where each player's ${esc(scoringName)} points land across the simulated games. Wider means more volatile; a hump at zero is the chance he doesn't play.</p></div>`;
    }
  }
  host.innerHTML = html;

  const q = host.querySelector('#cs-q');
  const sug = host.querySelector('#cs-sug');
  const suggest = () => {
    const t = q.value.trim().toLowerCase();
    st.q = q.value;
    if (t.length < 2) { sug.innerHTML = ''; return; }
    const hits = ctx.week.order.filter((p) => (p.name.toLowerCase().includes(t) || (p.team || '').toLowerCase() === t)
      && !st.ids.includes(p.id)).slice(0, 6);
    sug.innerHTML = hits.map((p) => `<div class="prow" data-tap data-add="${esc(p.id)}">${avatar({ ...p, position: p.pos })}
      <div class="pmain"><div class="pname">${posPill(p.pos)}<span class="n">${esc(p.name)}</span>${statusTag(p.status, p.injury)}</div>
      <div class="pline">${esc(ranks.get(p.id) || p.pos)} · ${esc(p.team)} vs ${esc(p.opp || '')} · proj ${num(p.ppr)}</div></div>
      <span class="badge start">+ Add</span></div>`).join('');
  };
  q.addEventListener('input', suggest);
  suggest();
  sug.addEventListener('click', (e) => {
    const el = e.target.closest('[data-add]');
    if (!el) return;
    if (st.ids.length >= MAX) st.ids.shift();
    st.ids.push(el.dataset.add);
    st.q = '';
    save();
    render(host, ctx);
  });
  const demo = host.querySelector('#cs-demo');
  if (demo) demo.addEventListener('click', () => {
    st.ids = ctx.week.order.filter((p) => p.pos === 'WR').slice(4, 6).map((p) => p.id);
    save(); render(host, ctx);
  });
  const clear = host.querySelector('#cs-clear');
  if (clear) clear.addEventListener('click', () => { st.ids = []; save(); render(host, ctx); });
  host.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    st.ids = st.ids.filter((x) => x !== b.dataset.remove);
    save();
    render(host, ctx);
  }));
  host.querySelectorAll('[data-sc]').forEach((b) => b.addEventListener('click', () => {
    st.scoring = b.dataset.sc; store.set('compare.scoring', st.scoring); render(host, ctx);
  }));
}

/** Add a player to Start/Sit from elsewhere (the player card). */
export function addToCompare(id) {
  const ids = store.get('compare', []).filter((x) => x !== id);
  if (ids.length >= MAX) ids.shift();
  ids.push(id);
  store.set('compare', ids);
  st.ids = ids;
}
