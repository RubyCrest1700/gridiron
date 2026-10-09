// One game: score or kickoff, the betting line, each side's implied points,
// and every projected player from both teams.

import { esc, logo, teamName, teamColor, fmtKickoff, num, playerRow, rangeBar } from '../ui.js';

export function gameStatus(g) {
  if (g.final) return 'Final';
  if (g.state === 'in') return `<span class="live-dot"></span>${esc(g.detail || 'Live')}`;
  return esc(fmtKickoff(g.kickoff));
}

/** Implied points from the spread (home perspective, + = home favoured) and total. */
export function implied(g) {
  if (g.total == null || g.spread == null) return null;
  return { home: g.total / 2 + g.spread / 2, away: g.total / 2 - g.spread / 2 };
}

function teamBlock(ctx, team, imp) {
  const players = ctx.week.order.filter((p) => p.team === team && (p.ppr || 0) >= 0.5);
  const a = (id) => (ctx.week.actuals || {})[id];
  return `<div class="card flush" style="border-left:3px solid ${teamColor(team)}">
    <h2 style="display:flex;align-items:center;gap:8px">${logo(team)}${esc(teamName(team))}${imp != null ? `<span class="faint" style="margin-left:auto;text-transform:none;letter-spacing:0">implied ${num(imp)} pts</span>` : ''}</h2>
    <div class="list">${players.map((p) => {
      const act = a(p.id);
      return playerRow({ ...p, position: p.pos }, {
        attrs: `data-player="${esc(p.id)}"`,
        sub: rangeBar(p.range, p.ppr, p.team),
        right: act ? `<div class="pts">${num(act[0])}<small>${act[1] ? 'final' : 'live'} · proj ${num(p.ppr)}</small></div>`
          : `<div class="pts">${num(p.ppr)}<small>proj</small></div>`,
      });
    }).join('') || '<p class="muted" style="padding:12px;margin:0">No projected players.</p>'}</div></div>`;
}

export function openGame(ctx, gameId) {
  const g = (ctx.meta.games || []).find((x) => x.game_id === gameId);
  if (!g) return;
  const imp = implied(g);
  const fav = g.spread == null ? '' : g.spread === 0 ? "Pick'em" : `${g.spread > 0 ? g.home : g.away} −${Math.abs(g.spread)}`;
  const started = g.final || g.state === 'in';
  const wind = (ctx.week.order.find((p) => p.team === g.home) || {}).wind;
  ctx.openSheet(`
    <div class="scoreline" style="margin:4px 0 14px">
      <div class="tm">${logo(g.away, 'lg')}<div><div>${esc(g.away)}</div>${started ? `<div class="sc">${num(g.away_score, 0)}</div>` : ''}</div></div>
      <div class="faint" style="text-align:center;font-size:12.5px">${gameStatus(g)}</div>
      <div class="tm home"><div style="text-align:right"><div>${esc(g.home)}</div>${started ? `<div class="sc">${num(g.home_score, 0)}</div>` : ''}</div>${logo(g.home, 'lg')}</div>
    </div>
    <div class="meta-chips" style="margin:0 0 14px">${fav ? `<span>${esc(fav)}</span>` : ''}${g.total ? `<span>O/U ${g.total}</span>` : ''}
      ${imp ? `<span>${esc(g.away)} ${num(imp.away)} · ${esc(g.home)} ${num(imp.home)}</span>` : ''}${wind != null ? `<span>Wind ${num(wind, 0)} mph</span>` : ''}</div>
    ${teamBlock(ctx, g.away, imp && imp.away)}
    ${teamBlock(ctx, g.home, imp && imp.home)}`);
}

