// The player card: slides up from the bottom when a player is tapped.

import { esc, avatar, posPill, statusTag, fmtKickoff, num, rangeBar, teamName, teamColor, versus } from '../ui.js';
import { playerSamples } from '../engine.js';
import { densityChart, formChart } from '../charts.js';
import { newsFor, showPlayer } from './news.js';
import { addToCompare } from './compare.js';
import { scheduleAheadHtml, dynastyRowHtml, PPR_SETTINGS } from './trades.js';
import { myTeams } from './leagues.js';
import { playerLeaguesHtml } from './myteams.js';

const STAT_LABELS = [
  ['attempts', 'Pass att'], ['completions', 'Completions'], ['passing_yards', 'Pass yds'],
  ['passing_tds', 'Pass TD'], ['passing_interceptions', 'INT'],
  ['carries', 'Carries'], ['rushing_yards', 'Rush yds'], ['rushing_tds', 'Rush TD'],
  ['targets', 'Targets'], ['receptions', 'Receptions'], ['receiving_yards', 'Rec yds'], ['receiving_tds', 'Rec TD'],
];
const SHOWN_BY_POS = {
  QB: ['attempts', 'completions', 'passing_yards', 'passing_tds', 'passing_interceptions', 'carries', 'rushing_yards', 'rushing_tds'],
  RB: ['carries', 'rushing_yards', 'rushing_tds', 'targets', 'receptions', 'receiving_yards', 'receiving_tds'],
  WR: ['targets', 'receptions', 'receiving_yards', 'receiving_tds', 'carries', 'rushing_yards'],
  TE: ['targets', 'receptions', 'receiving_yards', 'receiving_tds'],
};
const LOG_SHOWN = {
  QB: [['passing_yards', 'Yds'], ['passing_tds', 'TD'], ['passing_interceptions', 'INT'], ['rushing_yards', 'Rush']],
  RB: [['carries', 'Car'], ['rushing_yards', 'Yds'], ['receptions', 'Rec'], ['receiving_yards', 'RecY']],
  WR: [['targets', 'Tgt'], ['receptions', 'Rec'], ['receiving_yards', 'Yds'], ['receiving_tds', 'TD']],
  TE: [['targets', 'Tgt'], ['receptions', 'Rec'], ['receiving_yards', 'Yds'], ['receiving_tds', 'TD']],
};

let logsPromise = null;

export async function renderPlayer(host, ctx, id) {
  const p = ctx.week.players.get(id);
  if (!p) { host.innerHTML = '<p class="muted">No projection for this player this week.</p>'; return; }
  const stats = ctx.week.stats[id] || {};
  const scale = p.play > 0.05 && p.play < 0.95 ? 1 / p.play : 1;   // shown if he plays, like a prop
  const fav = ctx.favorites.has(id);
  const a = (ctx.week.actuals || {})[id];
  const samples = playerSamples(ctx.week.sims, id, null, p.pos);

  const statCells = (SHOWN_BY_POS[p.pos] || []).filter((k) => stats[k])
    .map((k) => `<div class="stat"><div class="k">${esc(STAT_LABELS.find((s) => s[0] === k)[1])}</div>
      <div class="v">${num(stats[k].mean * scale, k.endsWith('_tds') || k === 'passing_interceptions' ? 2 : 1)}</div></div>`).join('');

  host.innerHTML = `
    <div class="ph">${avatar({ ...p, position: p.pos }, 'lg')}
      <div style="min-width:0">
        <h3>${esc(p.name)}</h3>
        <div class="pname" style="margin-top:4px">${posPill(p.pos)}<span class="muted" style="font-size:14.5px">${esc(teamName(p.team))}${versus(p.team, p.opp) ? ` ${esc(versus(p.team, p.opp))}` : ''}</span>${statusTag(p.status, p.injury)}</div>
        <div class="faint" style="font-size:13.5px;margin-top:2px">${esc(fmtKickoff(p.kickoff))}${p.injury ? ` · ${esc(p.injury)}` : ''}</div>
      </div>
    </div>
    <div class="row pl-actions">
      <button class="btn grow" id="pl-fav">${fav ? '★ Favorite' : '☆ Favorite'}</button>
      <button class="btn grow" id="pl-cmp">⚖ Start/Sit</button>
    </div>
    <div id="pl-leagues"></div>
    <div class="stat-grid" style="margin-bottom:12px">
      ${a ? `<div class="stat"><div class="k">${a[1] ? 'Scored' : 'Live'}</div><div class="v">${num(a[0])}</div></div>` : ''}
      <div class="stat"><div class="k">Projected PPR</div><div class="v">${num(p.ppr)}</div></div>
      ${p.ppr_if != null && p.status && p.status !== 'Active' ? `<div class="stat"><div class="k">If he plays</div><div class="v">${num(p.ppr_if)}</div></div>` : ''}
      ${p.range ? `<div class="stat"><div class="k">Likely range</div><div class="v">${num(p.range.p10, 0)}–${num(p.range.p90, 0)}</div></div>` : ''}
      ${p.play != null ? `<div class="stat"><div class="k">Chance he plays</div><div class="v">${Math.round(p.play * 100)}%</div></div>` : ''}
    </div>
    ${samples ? `<div class="card" style="padding:10px 12px 8px">${densityChart([{ samples, color: teamColor(p.team), label: p.name }], { height: 150 })}
      <p class="note" style="margin:4px 0 0">His PPR points across 1,000 simulated games.</p></div>`
      : p.range ? `<div style="margin:0 2px 14px">${rangeBar(p.range, p.ppr, p.team)}
      <div class="row faint" style="justify-content:space-between;font-size:11.5px;margin-top:4px"><span>0</span><span>floor ${num(p.range.p10)} · ceiling ${num(p.range.p90)}</span><span>40</span></div></div>` : ''}
    ${statCells ? `<div class="section-title" style="margin-top:4px">Projected line${scale !== 1 ? ' (if he plays)' : ''}</div><div class="stat-grid">${statCells}</div>` : ''}
    <div class="section-title">Game context</div>
    <div class="card" style="margin:0">
      ${p.implied != null ? `<div class="kv"><span class="muted">Team implied points</span><span>${num(p.implied)}</span></div>` : ''}
      ${p.spread != null ? `<div class="kv"><span class="muted">Spread</span><span>${p.spread > 0 ? `favoured by ${num(p.spread)}` : p.spread < 0 ? `underdog by ${num(-p.spread)}` : "pick'em"}</span></div>` : ''}
      ${p.tgt_share ? `<div class="kv"><span class="muted">Target share</span><span>${Math.round(p.tgt_share * 100)}%</span></div>` : ''}
      ${p.rush_share ? `<div class="kv"><span class="muted">Carry share</span><span>${Math.round(p.rush_share * 100)}%</span></div>` : ''}
      ${p.wind != null ? `<div class="kv"><span class="muted">Wind</span><span>${num(p.wind, 0)} mph</span></div>` : ''}
    </div>
    <div id="pl-ahead"></div>
    <div id="pl-dyn">${ctx.tab === 'leagues' ? dynastyRowHtml(ctx.leagueDynasty, id) : ''}</div>
    <div id="pl-lines"></div>
    <div class="section-title">Recent games</div>
    <div id="pl-form"></div>
    <div id="pl-log" class="card flush"><p class="muted" style="padding:12px">Loading…</p></div>
    <div id="pl-news"></div>`;

  host.querySelector('#pl-fav').addEventListener('click', (e) => {
    ctx.toggleFavorite(id);
    e.currentTarget.textContent = ctx.favorites.has(id) ? '★ Favorite' : '☆ Favorite';
  });
  host.querySelector('#pl-cmp').addEventListener('click', () => {
    addToCompare(id); ctx.closeSheet(); ctx.go('compare');
  });
  // Whose he is in each of your leagues (nothing when none are connected).
  myTeams(ctx).then((teams) => {
    const el = host.querySelector('#pl-leagues');
    if (el && teams.length) el.innerHTML = playerLeaguesHtml(teams, id);
  }).catch(() => {});
  newsFor(ctx, id).then((html) => {
    const el = host.querySelector('#pl-news');
    if (!el || !html) return;
    el.innerHTML = html;
    const all = el.querySelector('[data-all-news]');
    if (all) all.addEventListener('click', () => { ctx.closeSheet(); showPlayer(ctx, id); });
    el.querySelectorAll('.ptag[data-player]').forEach((t) => t.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); ctx.openPlayer(t.dataset.player);
    }));
  });

  // Schedule ahead (rest of season), in the open league's scoring when the
  // card was opened from a league, else full PPR.
  ctx.loadFile('ros.json').then((ros) => {
    const box = host.querySelector('#pl-ahead');
    if (!box || !ros) return;
    const ls = ctx.tab === 'leagues' && ctx.leagueScoring;
    box.innerHTML = scheduleAheadHtml(ros, id, ls ? ls.settings : PPR_SETTINGS, ls ? ls.playoffStart : 0);
  }).catch(() => {});

  // Prop lines, when the Edges screen has already fetched them this session.
  try {
    const { linesFor } = await import('./edges.js');
    const html = linesFor(ctx, id);
    if (html) host.querySelector('#pl-lines').innerHTML = html;
  } catch (_) { /* optional */ }

  if (!logsPromise) logsPromise = ctx.loadFile('logs.json').catch(() => ({}));
  const logs = await logsPromise;
  const rows = ((logs.players || {})[id] || []);
  const cols = logs.cols || [];
  const idx = (c) => cols.indexOf(c);
  const shown = LOG_SHOWN[p.pos] || LOG_SHOWN.WR;
  const box = host.querySelector('#pl-log');
  if (!box) return;
  if (rows.length) {
    const games = rows.slice().reverse().map((r) => ({ pts: r[idx('fantasy_points_ppr')] || 0,
      label: `${r[0] !== ctx.meta.season ? `'${String(r[0]).slice(2)} ` : ''}W${r[1]}` }));
    host.querySelector('#pl-form').innerHTML = `<div class="card" style="padding:10px 12px 6px">${formChart(games, p.ppr, teamColor(p.team))}</div>`;
  }
  box.innerHTML = rows.length ? `<div class="scroll-x"><table class="tbl">
    <thead><tr><th>Wk</th><th>Opp</th>${shown.map(([, l]) => `<th class="r">${l}</th>`).join('')}<th class="r">PPR</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="faint">${r[1]}${r[0] !== ctx.meta.season ? `<span style="font-size:10px"> '${String(r[0]).slice(2)}</span>` : ''}</td>
      <td>${esc(r[2] || '')}</td>${shown.map(([k]) => `<td class="r">${num(r[idx(k)], 0)}</td>`).join('')}
      <td class="r"><strong>${num(r[idx('fantasy_points_ppr')])}</strong></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted" style="padding:12px;margin:0">No recent games on record.</p>';
}
