// This Week: every projected player, and the week's games.

import { esc, rangeBar, fmtKickoff, playerRow, logo, teamName, store, empty, num, versus, lastName } from '../ui.js';
import { openGame, gameStatus, implied } from './game.js';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const PAGE = 60;
const st = { mode: store.get('week.mode', 'players') === 'games' ? 'games' : 'players', pos: store.get('week.pos', 'ALL'), q: '', shown: PAGE };

function actualOf(ctx, id) {
  const a = (ctx.week.actuals || {})[id];
  return a ? { pts: a[0], final: !!a[1] } : null;
}

export function playerLine(p) {
  const when = p.kickoff ? fmtKickoff(p.kickoff) : '';
  const vs = versus(p.team, p.opp);
  return `${esc(p.team || '')}${vs ? ` ${esc(vs)}` : ''}${when ? ` · ${esc(when)}` : ''}`;
}

export function right(ctx, p) {
  const a = actualOf(ctx, p.id);
  if (a) return `<div class="pts">${num(a.pts)}<small>${a.final ? 'final' : 'live'} · proj ${num(p.ppr)}</small></div>`;
  const ifp = p.ppr_if != null && p.status && p.status !== 'Active' ? `<small>${num(p.ppr_if)} if plays</small>` : '<small>proj</small>';
  return `<div class="pts">${num(p.ppr)}${ifp}</div>`;
}

function playersHtml(ctx) {
  const q = st.q.trim().toLowerCase();
  let rows = ctx.week.order.filter((p) => (st.pos === 'ALL' || p.pos === st.pos)
    && (!q || p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase() === q));
  const total = rows.length;
  rows = rows.slice(0, st.shown);
  if (!rows.length) return empty('No players match', 'Try another position or name.', '🔎');
  return `<div class="card flush list">${rows.map((p) => playerRow({ ...p, position: p.pos }, {
    attrs: `data-player="${esc(p.id)}"`,
    sub: `${playerLine(p)}${rangeBar(p.range, p.ppr, p.team)}`,
    right: right(ctx, p),
  })).join('')}</div>
  ${total > st.shown ? `<button class="btn block" data-more>Show more (${total - st.shown})</button>` : ''}`;
}

function gamesHtml(ctx) {
  const games = (ctx.meta.games || []).slice().sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  const top = (team) => ctx.week.order.filter((p) => p.team === team).slice(0, 3)
    .map((p) => `${esc(lastName(p.name))} ${num(p.ppr)}`).join(' · ');
  return games.map((g) => {
    const fav = g.spread == null ? '' : g.spread === 0 ? "Pick'em" : `${g.spread > 0 ? g.home : g.away} −${Math.abs(g.spread)}`;
    const started = g.final || g.state === 'in';
    const imp = implied(g);
    return `<div class="card game-card" data-game="${esc(g.game_id)}">
      <div class="row" style="justify-content:space-between">
        <div class="row">${logo(g.away, 'lg')}<strong>${esc(g.away)}</strong>${started ? `<strong class="tabular">${num(g.away_score, 0)}</strong>` : ''}
          <span class="faint">@</span>${logo(g.home, 'lg')}<strong>${esc(g.home)}</strong>${started ? `<strong class="tabular">${num(g.home_score, 0)}</strong>` : ''}</div>
        <span class="faint" style="font-size:13px;text-align:right">${gameStatus(g)}</span>
      </div>
      <div class="meta-chips">${fav ? `<span>${esc(fav)}</span>` : ''}${g.total ? `<span>O/U ${g.total}</span>` : ''}${imp ? `<span>${esc(g.away)} ${num(imp.away)} · ${esc(g.home)} ${num(imp.home)}</span>` : ''}</div>
      <div class="note" style="margin-top:8px">${esc(teamName(g.away))}: ${top(g.away)}<br>${esc(teamName(g.home))}: ${top(g.home)}</div>
    </div>`;
  }).join('') || empty('No games this week');
}

export async function render(host, ctx) {
  host.innerHTML = `
    <div class="seg" role="tablist">
      <button data-mode="players" class="${st.mode === 'players' ? 'active' : ''}">Players</button>
      <button data-mode="games" class="${st.mode === 'games' ? 'active' : ''}">Games</button>
    </div>
    <div id="wk-controls" ${st.mode === 'players' ? '' : 'hidden'}>
      <input type="search" id="wk-q" placeholder="Search players or a team (e.g. PIT)" value="${esc(st.q)}" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="chips" style="margin-top:10px">${POSITIONS.map((p) => `<button class="chip ${p === st.pos ? 'active' : ''}" data-pos="${p}">${p === 'ALL' ? 'All' : p}</button>`).join('')}</div>
    </div>
    <div id="wk-body"></div>`;

  const body = host.querySelector('#wk-body');
  const redraw = async () => {
    body.innerHTML = st.mode === 'players' ? playersHtml(ctx) : gamesHtml(ctx);
  };
  await redraw();
  host.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    st.mode = b.dataset.mode; store.set('week.mode', st.mode); render(host, ctx);
  }));
  host.querySelectorAll('[data-pos]').forEach((b) => b.addEventListener('click', () => {
    st.pos = b.dataset.pos; st.shown = PAGE; store.set('week.pos', st.pos); render(host, ctx);
  }));
  const q = host.querySelector('#wk-q');
  if (q) q.addEventListener('input', () => { st.q = q.value; st.shown = PAGE; redraw(); });
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) { st.shown += PAGE; redraw(); return; }
    const g = e.target.closest('[data-game]');
    if (g) openGame(ctx, g.dataset.game);
  });
}
