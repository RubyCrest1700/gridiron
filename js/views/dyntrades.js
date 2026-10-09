// Phone screens for dynasty leagues: the calculator's picks and verdicts,
// the outlook switch, suggestions, the stash list and the player-card row.
// All numbers come from the shared modules (dyntrade, dynasty, picks).

import * as DT from '../dyntrade.js';
import { isPick } from '../picks.js';
import { esc, num, pct, posPill } from '../ui.js';

export const FALLBACK_NOTE = DT.FALLBACK_NOTE;
export const PICKS_NOTE = DT.PICKS_NOTE;
const pp = (v) => `${v > 0 ? '+' : ''}${Math.round(100 * v)}%`;
const tone = (v) => (v > 0.0049 ? 'good' : v < -0.0049 ? 'bad' : 'muted');

/** A team's draft picks as picker items (see tradepick.js). */
export function pickItems(ctx, rid, owner) {
  const D = ctx.D;
  if (!D.picks) return [];
  const last = D.season + D.H;
  return DT.picksOf(ctx, rid).map((id) => {
    const ppw = Array.from({ length: D.H }, (_, h) => D.pickPpw(id, h)).reduce((a, b) => a + b, 0) / D.H;
    return { id, name: D.picks.label(id), pos: 'PK', rid, owner,
      line: ppw > 0 ? `${num(ppw)} pts/wk a season, ${D.season + 1}-${String(last).slice(2)}`
        : `Too far out to value (rookie arrives past ${last})` };
  });
}

export function outlookSwitch(cur) {
  return `<div class="seg dyn-outlook" role="group" aria-label="Your outlook">${Object.entries(DT.OUTLOOK_LABEL).map(([k, l]) =>
    `<button class="${k === cur ? 'active' : ''}" data-outlook="${k}">${esc(l)}</button>`).join('')}</div>`;
}

function verdictPill(s, who) {
  if (!s.label) return '';
  if (s.label === 'tossup') return '<span class="verdict tossup">Roughly even</span>';
  const p = s.label === 'helps' ? s.prob : 1 - s.prob;
  return `<span class="verdict ${s.label}">${s.label === 'helps' ? 'Helps' : 'Hurts'} ${who} (${pct(p)})</span>`;
}

/** One side of a dynasty trade: title odds now and in each season ahead. */
export function sideHtml(ctx, s, who) {
  const { n, f } = DT.nowLater(ctx, s);
  const y0 = ctx.D.season + 1;
  return `<div class="trade-side">
    <div class="row" style="justify-content:space-between;gap:8px"><strong>${esc(s.team)}</strong>${verdictPill(s, who)}</div>
    <div class="kv"><span class="muted">This season (title odds)</span><span class="delta ${tone(n)}">${s.now ? pp(n) : '—'}</span></div>
    <div class="kv"><span class="muted">Next ${ctx.D.H} seasons</span><span class="delta ${tone(f)}">${pp(f)}</span></div>
    <div class="meta-chips" style="margin-top:6px">${s.later.map((l, h) => `<span>${y0 + h}: ${pct(l.before)} → ${pct(l.after)}</span>`).join('')}</div>
  </div>`;
}

/** Age, now and each season ahead for the players in a trade. */
export function playersTable(ctx, ids) {
  const y0 = ctx.D.season + 1;
  const rows = ids.filter((x) => !isPick(x)).map((sid) => {
    const p = ctx.L.player(sid), c = ctx.D.card(sid);
    return `<tr><td>${posPill(p.pos)} ${esc(p.name)}${c.age ? ` <span class="faint">${Math.floor(c.age)}</span>` : ''}
      ${c.start && c.start[0] > 0.05 ? `<div class="faint">${pct(c.start[0])} starter by ${y0}</div>` : ''}</td>
      <td class="r">${ctx.L.weeks.length ? `${num(p.play)}<div class="faint">${pct(p.play > 0 ? p.ppg / p.play : 0)}</div>` : '—'}</td>${c.play.map((v, h) => `<td class="r">${num(v)}<div class="faint">${pct(c.games[h])}</div></td>`).join('')}</tr>`;
  }).join('');
  if (!rows) return '';
  return `<div class="scroll-x"><table class="tbl"><thead><tr><th>Player</th><th class="r">Now</th>
    ${Array.from({ length: ctx.D.H }, (_, h) => `<th class="r">${y0 + h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="note">${DT.PLAYS_NOTE}</p>`;
}

export function suggHtml(ctx, list, stats) {
  return `<h2>Suggested trades</h2>${list.length ? list.map((c, i) => `
    <div class="sugg" data-sugg="${i}">
      <div class="row" style="justify-content:space-between"><strong>With ${esc(c.team)}</strong>
        <span class="faint" style="font-size:12px">Helps you ${pct(c.grade.sides[0].prob)} · them ${pct(c.grade.sides[1].prob)}</span></div>
      <div class="pline">You send <strong>${c.sendA.map((x) => esc(DT.itemName(ctx, x))).join(', ')}</strong> · you get <strong>${c.sendB.map((x) => esc(DT.itemName(ctx, x))).join(', ')}</strong></div>
      <p class="note" style="margin-top:4px">${esc(c.reason)}</p></div>`).join('')
    : '<p class="note">No trade found that clearly helps both sides right now.</p>'}
    <p class="note">Deals both teams come out ahead on, on average, now and later combined, and that neither is more likely to hurt than help — each judged by its own outlook. The percentage is how sure the model is it helps. Tap one to open it in the calculator.${stats && stats.searched < stats.of ? ` Searched ${stats.searched} of ${stats.of} teams in the time allowed.` : ''}</p>`;
}

export function stashHtml(ctx, pos) {
  const y0 = ctx.D.season + 1;
  const list = ctx.D.stash(80).filter((p) => pos === 'ALL' || p.pos === pos).slice(0, 25);
  return `<div class="card flush"><h2>Stash — future value</h2><div class="list">${list.map((p) => `<div class="prow">
      <div class="pmain"><div class="pname">${posPill(p.pos)}<span class="n">${esc(p.name)}</span></div>
      <div class="pline">${p.age ? `${Math.floor(p.age)} yrs` : ''}${p.start && p.start[0] > 0.05 ? ` · ${pct(p.start[0])} starter by ${y0}` : ''}</div></div>
      <div class="pright"><div class="pts">${num(p.ppg[0])}<small>pts/g ${y0}</small></div></div></div>`).join('')
    || '<p class="muted" style="padding:12px;margin:0">No unrostered player projects for future value here.</p>'}</div></div>
    <p class="note">Unrostered, ranked by projected points over the next ${ctx.D.H} seasons (this season left out), in this league's scoring.</p>`;
}

/** The "Dynasty outlook" row on a player card. */
export function playerRowHtml(ctx, sid) {
  if (!sid) return '';
  const c = ctx.D.card(sid);
  if (!c.ppg.some((v) => v > 0)) return '';
  const y0 = ctx.D.season + 1;
  return `<div class="section-title">Dynasty outlook</div>
    <div class="ahead">${c.play.map((v, h) => `<div class="wk"><div class="faint">${y0 + h}</div><strong>${num(v)}</strong><div class="faint">${pct(c.games[h])}</div></div>`).join('')}</div>
    <p class="note">${c.age ? `Age ${Math.floor(c.age)}. ` : 'Age unknown. '}In this league's scoring. ${DT.PLAYS_NOTE}${c.start && c.start[0] > 0.05 ? ` ${pct(c.start[0])} chance he's the starter in ${y0}.` : ''}</p>`;
}
