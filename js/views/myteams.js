// My teams: every league you're in on one screen -- this week's matchup and
// what needs fixing on each team, then every player across them.

import * as E from '../engine.js';
import * as MT from '../myteams.js';
import { esc, num, pct, playerRow, rangeBar, skeleton, empty } from '../ui.js';
import { playerLine, right } from './week.js';

const SEGS = [['teams', 'Teams'], ['mine', 'My players'], ['against', 'Facing']];
const st = { seg: 'teams' };     // not remembered: the app opens on your teams

// engine.leagueView is the heavy part; keep each league's until its rosters,
// matchups or the projections change.
const seen = new Map();
function viewFor(t) {
  const c = seen.get(t.id);
  if (c && c.rosters === t.sl.rosters && c.matchups === t.sl.matchups && c.rid === t.rid && c.wk === t.wk) return c.view;
  const view = E.leagueView(t.wk, t.sl, t.rid);
  seen.set(t.id, { rosters: t.sl.rosters, matchups: t.sl.matchups, rid: t.rid, wk: t.wk, view });
  return view;
}

const WHY = { bye: 'on bye', empty: 'empty' };
function flags(c) {
  const out = [];
  if (c.alerts.length) {
    out.push(`<div class="tc-flag bad">⚠ Starting ${c.alerts.map((a) => (a.name
      ? `${esc(a.name)} (${esc(WHY[a.why] || a.why)})` : `an empty ${esc(a.slot)} slot`)).join(', ')}</div>`);
  }
  if (c.changes) {
    out.push(`<div class="tc-flag warn">↑ ${c.changes} lineup change${c.changes === 1 ? '' : 's'} suggested${c.gain >= 0.05 ? `, worth +${num(c.gain)}` : ''}</div>`);
  }
  if (!out.length) out.push('<div class="tc-flag ok">✓ Lineup set</div>');
  return out.join('');
}

export function cardHtml(c) {
  const better = c.win != null && c.winBest > c.win + 0.004;
  return `<div class="card team-card" data-league="${esc(c.id)}" role="button" tabindex="0">
    <div class="tc-top"><span class="tc-lg">${esc(c.league)}</span><span class="tc-go">Open ›</span></div>
    ${c.opp ? `<div class="mu sm">
        <div class="side"><div class="t">${esc(c.team)}</div><div class="r">${esc(c.record)}</div><div class="big">${num(c.me)}</div></div>
        <div class="vs">vs</div>
        <div class="side opp"><div class="t">${esc(c.opp)}</div><div class="r">${esc(c.oppRecord)}</div><div class="big">${num(c.them)}</div></div>
      </div>
      <div class="winbar"><span class="me" style="width:${(c.win * 100).toFixed(1)}%"></span><span class="op" style="flex:1"></span></div>
      <div class="winlab"><span>Win chance <strong style="color:var(--text)">${pct(c.win)}</strong></span>
        ${better ? `<span>with changes <strong style="color:var(--good)">${pct(c.winBest)}</strong></span>` : ''}</div>`
    : `<div class="tc-none"><strong>${esc(c.team)}</strong> · ${esc(c.record)} · no matchup this week</div>`}
    ${flags(c)}
  </div>`;
}

function headline(cards, total) {
  const s = MT.summary(cards);
  if (cards.length < total) return `<span>Reading ${total} leagues…</span>`;
  return `<span>${s.teams} team${s.teams === 1 ? '' : 's'}</span>
    ${s.playing ? `<span>Favored in ${s.favored} of ${s.playing}</span>` : ''}
    <span>${s.toFix ? `${s.toFix} lineup${s.toFix === 1 ? '' : 's'} to check` : 'All lineups set'}</span>`;
}

const WHERE = { start: 'Starting', bench: 'Bench', ir: 'IR', taxi: 'Taxi' };

function playersHtml(ctx, rows, mode) {
  if (!rows.length) {
    return empty(mode === 'mine' ? 'No players found' : 'Nobody to face yet',
      mode === 'mine' ? 'Your rosters look empty.' : 'Your opponents have not set lineups, or there are no matchups this week.', '🏈');
  }
  const proj = (e) => { const p = e.id && ctx.week.players.get(e.id); return p ? p.ppr || 0 : -1; };
  const sorted = rows.slice().sort((a, b) => (b.leagues.length - a.leagues.length) || (proj(b) - proj(a)));
  const multi = rows.filter((e) => e.leagues.length > 1).length;
  const row = (e) => {
    const p = e.id ? ctx.week.players.get(e.id) : null;
    const tags = mode === 'mine'
      ? e.leagues.map((g) => `<span class="lt ${g.where}"><b>${WHERE[g.where]}</b> ${esc(g.name)}</span>`).join('')
      : e.leagues.map((g) => `<span class="lt opp"><b>Facing</b> ${esc(g.name)}</span>`).join('')
        + e.mine.map((n) => `<span class="lt start"><b>Yours</b> ${esc(n)}</span>`).join('');
    return playerRow(p ? { ...p, position: p.pos } : { name: e.name, position: e.pos, team: e.team }, {
      attrs: p ? `data-player="${esc(e.id)}"` : '',
      sub: `${p ? `${playerLine(p)}${rangeBar(p.range, p.ppr, p.team)}` : esc(e.team || '')}<div class="lts">${tags}</div>`,
      right: p ? right(ctx, p) : '<div class="pts faint">—</div>',
    });
  };
  const note = mode === 'mine'
    ? `${rows.length} players on your teams${multi ? `; ${multi} on more than one` : ''}.`
    : `${rows.length} players start against you this week${multi ? `; ${multi} in more than one league` : ''}.`;
  return `<div class="meta-chips" style="margin:0 0 10px"><span>${note}</span></div>
    <div class="card flush list">${sorted.map(row).join('')}</div>
    <p class="note">Points are standard PPR here, since each league scores differently. Open a league for its own scoring.${mode === 'against' ? ' "Yours" marks a player you also start somewhere else.' : ''}</p>`;
}

/** teams: leagues.myTeams(); others: [{id, name}] leagues with no team of
 *  yours; open(id) shows one league; manage() opens the league list. */
export async function renderOverview(host, ctx, { teams, others = [], open, manage, stale = () => false }) {
  host.innerHTML = `
    <div class="league-head">
      <div class="seg grow" style="margin:0">${SEGS.map(([k, l]) => `<button data-mt="${k}" class="${st.seg === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <button class="link-btn" id="mt-manage" style="flex-shrink:0">Manage</button>
    </div>
    <div id="mt-body">${skeleton(5)}</div>`;
  host.querySelector('#mt-manage').addEventListener('click', manage);
  const body = host.querySelector('#mt-body');
  let seq = 0;

  const drawTeams = async () => {
    const my = ++seq;
    const cards = [];
    const paint = () => {
      body.innerHTML = `<div class="meta-chips" style="margin:0 0 10px">${headline(cards, teams.length)}</div>
        ${cards.map(cardHtml).join('')}${cards.length < teams.length ? skeleton(2) : ''}
        ${others.length ? `<div class="card"><h2>Other leagues</h2>${others.map((o) => `<button class="btn block" data-league="${esc(o.id)}" style="margin-top:8px">${esc(o.name)}</button>`).join('')}</div>` : ''}
        ${cards.length === teams.length ? '<p class="note">Tap a team for its matchup, lineup, waivers and trades. Make changes in Sleeper or ESPN: this app can only read your leagues.</p>' : ''}`;
    };
    paint();
    for (const t of teams) {
      // Each league is a full simulation pass: let the screen paint between them.
      await new Promise((r) => setTimeout(r, 0));
      if (my !== seq || stale() || !body.isConnected) return;
      try { cards.push(MT.teamCard(viewFor(t))); } catch (err) { console.error(err); }
      paint();
    }
  };
  const draw = () => {
    if (st.seg === 'teams') { drawTeams(); return; }
    seq += 1;
    const x = MT.exposure(teams);
    body.innerHTML = playersHtml(ctx, st.seg === 'mine' ? x.mine : x.against, st.seg);
  };
  host.querySelectorAll('[data-mt]').forEach((b) => b.addEventListener('click', () => {
    st.seg = b.dataset.mt;
    host.querySelectorAll('[data-mt]').forEach((x) => x.classList.toggle('active', x === b));
    draw();
  }));
  body.addEventListener('click', (e) => {
    const c = e.target.closest('[data-league]');
    if (c) open(c.dataset.league);
  });
  draw();
}

const STATUS = {
  start: ['You start him', 'ok'], bench: ['On your bench', 'ok'], ir: ['On your IR', 'ok'], taxi: ['On your taxi squad', 'ok'],
  opp: ['Your opponent this week', 'bad'], other: ['Rostered', ''], free: ['Free agent', 'warn'],
};

/** The player card's "In your leagues" block; '' when there is nothing to say. */
export function playerLeaguesHtml(teams, modelId) {
  const rows = MT.playerInLeagues(teams, modelId);
  if (!rows.length) return '';
  return `<div class="section-title">In your leagues</div><div class="card" style="margin:0 0 12px">
    ${rows.map((r) => `<div class="kv"><span class="muted clip1">${esc(r.league)}</span>
      <span class="own ${STATUS[r.status][1]}">${r.status === 'other' ? `${esc(r.team)} has him` : `${STATUS[r.status][0]}${r.team ? ` <span class="faint">(${esc(r.team)})</span>` : ''}`}</span></div>`).join('')}
  </div>`;
}
