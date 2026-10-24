// Trades, team needs, playoff odds, rest-of-season waivers and "schedule
// ahead": the rest-of-season tools for one league. All the numbers come from
// the shared modules (valuer, trade, season), which the desktop app uses too.

import * as V from '../valuer.js';
import * as T from '../trade.js';
import * as S from '../season.js';
import * as DT from '../dyntrade.js';
import * as SL from '../sleeper.js';
import * as PK from '../picks.js';
import * as DV from './dyntrades.js';
import * as PKR from './tradepick.js';
import { CONF } from '../confidence.js';
import { DCONF } from '../confidence_dynasty.js';
import { PPR_SETTINGS, scoreOne, activeWeeks, LAST_WEEK } from '../ros.js';
import { esc, num, pct, signed, posPill, dropdown, onPick, empty, skeleton, foldedTable } from '../ui.js';

const rosCache = new Map();          // ros.json version -> promise
const cache = new Map();             // league + data version + rosters -> data
const st = { key: null, other: null, send: new Set(), get: new Set() };

// Changes whenever a roster does (waiver claim, completed trade).
const rosterPrint = (sl) => (sl.rosters || []).map((r) => `${r.roster_id}:${[...(r.players || [])].sort().join(',')}`
  + `|${(r.reserve || []).join(',')}|${(r.taxi || []).join(',')}`).join(';');

/** The league valued for the rest of the season, cached per league, published
 *  data version and rosters. Failures are never cached. */
export async function loadLeague(ctx, sl, sleeperMap, scheduleFn) {
  const ver = (ctx.meta.files || {})['ros.json'] || ctx.meta.generated_at;
  if (!rosCache.has(ver)) {
    const p = ctx.loadFile('ros.json');
    rosCache.set(ver, p);
    p.catch(() => rosCache.delete(ver));
  }
  const ros = await rosCache.get(ver).catch(() => null);
  if (!ros) return null;
  const dynasty = isDynasty(sl);
  // Dynasty leagues: who owns which pick, read before the cache lookup -- a
  // pick-only trade in Sleeper changes no roster, but must change the key.
  const picksRaw = dynasty ? await readPicks(sl.league.league_id) : null;
  const key = leagueKey(sl, ver, dynasty ? (ctx.meta.files || {})['dynasty.json'] : null, picksRaw);
  const hit = cache.get(key);
  // An app left open across a kickoff must drop the week that just started.
  if (hit && activeWeeks(ros, new Date()).length === hit.L.weeks.length) return hit;
  const L = V.makeLeague({ league: sl.league, rosters: sl.rosters, users: sl.users, ros, sleeperMap });
  let schedule;
  try { schedule = await scheduleFn(); } catch (_) { schedule = null; }
  // No schedule, no odds (and not cached, so the next open tries again).
  const data = { L, ros, schedule: schedule || {}, scheduleOk: !!schedule, weekly: null, odds: null,
    base4k: null, memo: new Map(), dctx: null, dynNote: null };
  if (dynasty) await loadDynasty(ctx, sl, data, picksRaw);
  // A dynasty league whose values or picks didn't load is not cached either.
  if (schedule && (!dynasty || (data.dctx && !data.dynNote))) cache.set(key, data);
  return data;
}

/** The league cache key: league, published data versions, rosters and -- in
 *  dynasty leagues -- pick ownership and draft status. */
export function leagueKey(sl, rosVer, dynVer = null, picksRaw = null) {
  const pk = picksRaw && picksRaw.traded ? [...picksRaw.traded]
    .map((t) => `${t.season}:${t.round}:${t.roster_id}>${t.owner_id}`).sort().join(',')
    + `/${(picksRaw.drafts || []).map((d) => `${d.season}:${d.status}:${d.draft_order ? JSON.stringify(d.draft_order) : ''}`
      + `:${Array.isArray(d.picks) ? d.picks.length : ''}`).sort().join(',')}`
    : (picksRaw ? 'picks-failed' : '');
  return `${sl.league.league_id}|${rosVer}|${dynVer || ''}|${pk}|${rosterPrint(sl)}`;
}

/** {traded, drafts}, or {} when Sleeper didn't answer (never an empty list
 *  standing in for "no pick ever moved"). */
async function readPicks(leagueId) {
  try {
    const [traded, drafts] = await Promise.all([SL.tradedPicks(leagueId), SL.drafts(leagueId)]);
    if (!Array.isArray(traded) || !Array.isArray(drafts)) return {};
    return { traded, drafts: await PK.withDraftPicks(drafts, (id) => SL.draftPicks(id)) };
  } catch (_) { return {}; }
}

const isDynasty = (sl) => sl.league.source !== 'espn' && Number((sl.league.settings || {}).type) === 2;

const dynCache = new Map();          // dynasty.json version -> promise
/** Dynasty values and this league's picks onto `data` (data.dctx), or a
 *  note saying what couldn't be loaded. Never throws. */
async function loadDynasty(ctx, sl, data, picksRaw) {
  const ver = (ctx.meta.files || {})['dynasty.json'];
  if (!ver) { data.dynNote = DT.FALLBACK_NOTE; return; }
  if (!dynCache.has(ver)) {
    const p = ctx.loadFile('dynasty.json');
    dynCache.set(ver, p);
    p.catch(() => dynCache.delete(ver));
  }
  const dyn = await dynCache.get(ver).catch(() => null);
  // The same builder the PC uses (dyntrade.dynastyContext).
  const picks = picksRaw && picksRaw.traded ? { rosters: sl.rosters, ...picksRaw } : null;
  const { dctx, note } = DT.dynastyContext(data.L, dyn, picks, data);
  data.dctx = dctx;
  data.dynNote = note;
}

/** The outlook switch is remembered per league on this device. */
function savedOutlook(leagueId) {
  try { return localStorage.getItem(`dyn-outlook:${leagueId}`) || 'auto'; } catch (_) { return 'auto'; }
}
function saveOutlook(leagueId, v) {
  try { localStorage.setItem(`dyn-outlook:${leagueId}`, v); } catch (_) { /* private mode */ }
}

const hasPlayoffs = (L) => Number((L.league.settings || {}).playoff_week_start || 0) > 0;
const oddsKey = (L) => (hasPlayoffs(L) ? 'title' : 'best_record');
const SUGG_SIMS = 4000;

/** Season odds now (null once the playoffs have started). */
function baseOdds(data) {
  if (!data.weekly) data.weekly = S.teamWeekly(data.L);
  if (!data.scheduleOk) return null;
  if (data.odds === null) data.odds = S.seasonOdds(data.L, data.schedule, data.weekly) || false;
  return data.odds || null;
}

/** Odds after replacing two teams' rosters, with the same number of seasons
 *  (and seed) as the baseline it is compared with. */
function oddsWith(data, rosterA, ridA, rosterB, ridB, nSims = 10000) {
  if (!baseOdds(data)) return null;
  const weekly = new Map(data.weekly);
  weekly.set(ridA, data.L.value(rosterA, 'scen').weekly);
  weekly.set(ridB, data.L.value(rosterB, 'scen').weekly);
  return S.seasonOdds(data.L, data.schedule, weekly, { nSims });
}

function memo(data, key, fn) {
  if (!data.memo.has(key)) data.memo.set(key, fn());
  return data.memo.get(key);
}

function verdictPill(ppw, who) {
  const v = T.verdict(ppw);
  if (!v.label) return '';
  if (v.label === 'tossup') return '<span class="verdict tossup">Toss-up</span>';
  const p = v.label === 'helps' ? v.prob : 1 - v.prob;
  return `<span class="verdict ${v.label}">Likely ${v.label === 'helps' ? 'helps' : 'hurts'} ${who} (${pct(p)})</span>`;
}

const names = (xs) => xs.map((p) => `${esc(p.name)}${p.status ? ` (${esc(p.status)})` : ''}`).join(', ');

function oddsLine(L, before, after) {
  if (!before || !after) return '';
  if (!hasPlayoffs(L)) {
    return `<div class="kv"><span class="muted">Best record</span><span>${pct(before.best_record)} → <strong>${pct(after.best_record)}</strong></span></div>`;
  }
  return `<div class="kv"><span class="muted">Title odds</span><span>${pct(before.title)} → <strong>${pct(after.title)}</strong></span></div>
    <div class="kv"><span class="muted">Playoff odds</span><span>${pct(before.playoff)} → <strong>${pct(after.playoff)}</strong></span></div>`;
}

function sideHtml(L, side, who, before, after) {
  const chips = Object.entries(side.bySlot).filter(([, v]) => Math.abs(v) >= 0.1)
    .map(([g, v]) => `<span>${esc(g)} ${v > 0 ? '+' : ''}${v.toFixed(1)}</span>`).join('');
  return `<div class="trade-side">
    <div class="row" style="justify-content:space-between;gap:8px"><strong>${esc(side.team)}</strong>${verdictPill(side.ppw.all, who)}</div>
    ${oddsLine(L, before, after)}
    ${side.ppw.po != null && side.ppw.reg != null
      ? `<div class="kv"><span class="muted">Points a week, regular season</span><span>${signed(side.ppw.reg)}</span></div>
         <div class="kv"><span class="muted">Points a week, playoff weeks</span><span>${signed(side.ppw.po)}</span></div>`
      : `<div class="kv"><span class="muted">Points a week, rest of season</span><span>${signed(side.ppw.reg ?? side.ppw.all)}</span></div>`}
    ${chips ? `<div class="meta-chips" style="margin-top:6px">${chips}</div>` : ''}
    ${side.drops.length ? `<p class="note" style="margin-top:6px">Drops ${names(side.drops)} to make room.</p>` : ''}
    ${side.adds.length ? `<p class="note" style="margin-top:6px">Adds ${names(side.adds)} from waivers to fill the spot.</p>` : ''}
    ${(side.fills || []).length ? `<p class="note" style="margin-top:6px">Counts a waiver pickup for the spot it leaves empty: ${side.fills.map((f) => `${esc(f.name)} (${esc(f.pos)})`).join(', ')}.</p>` : ''}
  </div>`;
}

/** A team's players as picker items, best first. */
export function playerItems(L, t) {
  return L.tradeable(t).map(L.player).filter((p) => p.modelled || p.pos)
    .sort((a, b) => b.season - a.season)
    .map((p) => ({ id: p.sid, name: p.name, pos: p.pos, rid: t.roster_id, owner: t.name,
      line: `${p.modelled ? `${num(p.play)} pts/game` : 'not projected'}${p.status ? ` · ${esc(p.status)}` : ''}` }));
}

/** The one-line answer at the top of a graded trade, for your side. */
export function headline(label, prob, detail) {
  if (!label) return '';
  const text = label === 'tossup' ? 'Roughly even for you'
    : `${label === 'helps' ? 'Likely helps you' : 'Likely hurts you'} (${pct(label === 'helps' ? prob : 1 - prob)})`;
  return `<div class="tr-head ${label}"><strong>${text}</strong>${detail ? `<span>${detail}</span>` : ''}</div>`;
}

/** The calculator card: partner, the two sides as chips, the result under them. */
function calcHtml(o) {
  const any = o.send.length || o.get.length;
  const add = o.picks ? 'Add player or pick' : 'Add player';
  return `<div class="card" id="tr-calc"><h2>Trade calculator</h2>
      ${dropdown('tr-team', o.otherOpts, o.other, { prefix: 'With', label: 'Trade partner' })}
      ${o.top || ''}
      ${PKR.sideHtml('send', 'You send', o.send, add)}
      ${PKR.sideHtml('get', 'You get', o.get, add)}
      <div id="tr-result">${any ? skeleton(2) : `<p class="note">${o.intro}</p>`}</div>
      ${any ? '<button class="link-btn" data-clear>Clear trade</button>' : ''}
      ${o.notes || ''}
    </div>`;
}

/** Chips, "+ Add" and the picker. o: {st, rid, teams: Map, itemsOf(rid), draw}. */
function wireCalc(host, ctx, o) {
  const { st: s, draw } = o;
  host.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
    (b.dataset.rm === 'send' ? s.send : s.get).delete(b.dataset.sid);
    draw();
  }));
  const clear = host.querySelector('[data-clear]');
  if (clear) clear.addEventListener('click', () => { s.send.clear(); s.get.clear(); draw(); });
  host.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
    const mine = b.dataset.add === 'send';
    const set = mine ? s.send : s.get;
    PKR.openPicker(ctx, {
      title: mine ? 'You send' : 'You get',
      placeholder: mine ? 'Search your roster' : 'Search any player in the league',
      from: () => (mine ? 'Your roster' : o.teams.get(s.other).name),
      items: () => o.itemsOf(mine ? o.rid : s.other),
      // Typing a name on the "get" side looks through every other team.
      wide: mine ? null : () => [...o.teams.values()].filter((t) => t.roster_id !== o.rid).flatMap((t) => o.itemsOf(t.roster_id)),
      chosen: () => set,
      toggle: (it) => {
        let note = '';
        if (!mine && it.rid !== s.other) { s.other = it.rid; s.get.clear(); note = `Now trading with ${it.owner}`; }
        if (set.has(it.id)) set.delete(it.id); else set.add(it.id);
        return note;
      },
      onClose: () => {
        if (!host.isConnected) return;
        draw();
        const r = host.querySelector('#tr-calc');
        if (r) r.scrollIntoView({ block: 'start' });
      },
    });
  }));
}

function idpNote(L) {
  return (L.league.roster_positions || []).some((s) => ['DL', 'LB', 'DB', 'IDP_FLEX'].includes(s))
    ? '<p class="note">Individual defenders aren\'t valued for the rest of the season yet.</p>' : '';
}

/** The Trades sub-tab, dynasty leagues: this season and the next three in
 *  title odds, picks in the pickers, the outlook switch. Works in the offseason. */
function renderDynasty(host, ctx, sl, rid, data) {
  const { L, dctx } = data;
  const lid = L.league.league_id;
  const key = `${lid}|${rid}|dyn`;
  if (st.key !== key) Object.assign(st, { key, other: null, send: new Set(), get: new Set(), outlook: savedOutlook(lid) });
  const users = [...L.teams.values()].filter((t) => t.roster_id !== rid).sort((a, b) => a.name.localeCompare(b.name));
  if (!users.length) { host.innerHTML = empty('No one to trade with', 'This league has only one team.'); return; }
  if (!L.teams.has(st.other)) st.other = users[0].roster_id;
  const otherOpts = users.map((t) => [t.roster_id, t.name]);
  const me = L.teams.get(rid);
  const needs = () => memo(data, `dneeds|${rid}`, () => DT.dynastyNeeds(dctx, rid)
    .concat(L.weeks.length ? T.teamNeeds(L, rid).lines : []).slice(0, 8));

  const items = new Map();
  const itemsOf = (r) => {
    if (!items.has(r)) items.set(r, playerItems(L, L.teams.get(r)).concat(DV.pickItems(dctx, r, L.teams.get(r).name)));
    return items.get(r);
  };

  const draw = () => {
    const chosen = (set, r) => itemsOf(r).filter((it) => set.has(it.id));
    host.innerHTML = `
      ${calcHtml({ otherOpts, other: st.other, top: DV.outlookSwitch(st.outlook), picks: !!dctx.D.picks,
        send: chosen(st.send, rid), get: chosen(st.get, st.other),
        intro: `Add players or picks to each side. Graded in title odds: this season plus the next ${dctx.D.H}, in this league's scoring, on the lineups each team could set — each side by its own outlook.`,
        notes: `${data.dynNote ? `<p class="note">${esc(data.dynNote)}</p>` : ''}<p class="note">Make trades in Sleeper — this app can only read your league.</p>` })}
      <div class="card"><h2>What your team needs</h2>
        <ul class="needs">${needs().map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>
      <div class="card" id="tr-sugg"><h2>Suggested trades</h2>${DCONF.measured ? skeleton(3)
        : '<p class="note">Suggestions appear once the history test has calibrated the grades.</p>'}</div>
      ${idpNote(L)}`;
    onPick(host.querySelector('#tr-team'), otherOpts, (v) => { st.other = Number(v); st.get = new Set(); draw(); });
    host.querySelectorAll('[data-outlook]').forEach((b) => b.addEventListener('click', () => {
      st.outlook = b.dataset.outlook; saveOutlook(lid, st.outlook); draw();
    }));
    wireCalc(host, ctx, { st, rid, teams: L.teams, itemsOf, draw });
    if (st.send.size || st.get.size) setTimeout(() => result(host.querySelector('#tr-result')), 0);
    const sk = `dsugg|${rid}|${st.outlook}`;
    if (DCONF.measured) setTimeout(() => suggestions(host.querySelector('#tr-sugg')), data.memo.has(sk) ? 0 : 30);
  };

  const result = (box) => {
    if (!box) return;
    try {
      const g = DT.gradeDynasty(dctx, rid, st.other, [...st.send], [...st.get], { outlook: st.outlook });
      const { n, f } = DT.nowLater(dctx, g.sides[0]);
      const pp = (v) => `${v > 0 ? '+' : ''}${Math.round(100 * v)}%`;
      box.innerHTML = headline(g.sides[0].label, g.sides[0].prob, `Title odds: ${g.sides[0].now ? `${pp(n)} this season, ` : ''}${pp(f)} over the next ${dctx.D.H}`)
        + DV.sideHtml(dctx, g.sides[0], 'you') + DV.sideHtml(dctx, g.sides[1], 'them')
        + DV.playersTable(dctx, [...st.send, ...st.get]);
    } catch (err) {
      box.innerHTML = `<div class="warn-box">${esc(err.message)}</div>`;
    }
  };

  const suggestions = (box) => {
    if (!box) return;
    const { list, stats } = memo(data, `dsugg|${rid}|${st.outlook}`, () => {
      const s = {};
      return { list: DT.suggestDynasty(dctx, rid, { outlook: st.outlook, stats: s }), stats: s };
    });
    box.innerHTML = DV.suggHtml(dctx, list, stats);
    box.querySelectorAll('[data-sugg]').forEach((el) => el.addEventListener('click', () => {
      const c = list[Number(el.dataset.sugg)];
      Object.assign(st, { other: c.with, send: new Set(c.sendA), get: new Set(c.sendB) });
      draw();
      host.querySelector('#tr-calc').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  };

  draw();
}

/** The Trades sub-tab: calculator, team needs, suggested trades. */
export function renderTrades(host, ctx, sl, rid, data) {
  const { L } = data;
  if (data.dctx) { renderDynasty(host, ctx, sl, rid, data); return; }
  if (!L.weeks.length) { host.innerHTML = empty('The fantasy season is over', 'Trades come back with next season\'s projections.', '🏁'); return; }
  const key = `${L.league.league_id}|${rid}`;
  if (st.key !== key) Object.assign(st, { key, other: null, send: new Set(), get: new Set() });
  const users = [...L.teams.values()].filter((t) => t.roster_id !== rid).sort((a, b) => a.name.localeCompare(b.name));
  if (!users.length) { host.innerHTML = empty('No one to trade with', 'This league has only one team.'); return; }
  if (!L.teams.has(st.other)) st.other = users[0].roster_id;
  const otherOpts = users.map((t) => [t.roster_id, t.name]);
  const me = L.teams.get(rid);
  const src = sl.league.source === 'espn' ? 'ESPN' : 'Sleeper';

  // Team needs and the suggestion search are computed once per team and data
  // version; taps in the calculator only re-grade the trade on screen.
  const needs = () => memo(data, `needs|${rid}`, () => T.teamNeeds(L, rid));

  const items = new Map();
  const itemsOf = (r) => {
    if (!items.has(r)) items.set(r, playerItems(L, L.teams.get(r)));
    return items.get(r);
  };

  const draw = () => {
    const chosen = (set, r) => itemsOf(r).filter((it) => set.has(it.id));
    host.innerHTML = `
      ${calcHtml({ otherOpts, other: st.other, send: chosen(st.send, rid), get: chosen(st.get, st.other),
        intro: 'Add players to each side. Graded over the rest of the season, in this league\'s scoring, on the lineups each team could actually set.',
        notes: `<p class="note">Make trades in ${src} — this app can only read your league.</p>` })}
      <div class="card"><h2>What your team needs</h2>
        <ul class="needs">${needs().lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>
      <div class="card" id="tr-sugg"><h2>Suggested trades</h2>${CONF.measured ? skeleton(3)
        : '<p class="note">Suggestions appear once the history test has calibrated the grades.</p>'}</div>
      ${idpNote(L)}`;
    onPick(host.querySelector('#tr-team'), otherOpts, (v) => { st.other = Number(v); st.get = new Set(); draw(); });
    wireCalc(host, ctx, { st, rid, teams: L.teams, itemsOf, draw });
    if (st.send.size || st.get.size) setTimeout(() => result(host.querySelector('#tr-result')), 0);
    if (CONF.measured) setTimeout(() => suggestions(host.querySelector('#tr-sugg')), data.memo.has(`sugg|${rid}`) ? 0 : 30);
  };

  const result = (box) => {
    if (!box) return;
    try {
      const g = T.gradeTrade(L, rid, st.other, [...st.send], [...st.get]);
      const before = baseOdds(data);
      const after = oddsWith(data, g.sides[0].sids, rid, g.sides[1].sids, st.other);
      const at = (o, r) => (o ? o.get(r) : null);
      // In a dynasty league this path is the fallback: say why.
      const note = data.dynNote || g.note;
      const v = T.verdict(g.sides[0].ppw.all);
      box.innerHTML = headline(v.label, v.prob, `${signed(g.sides[0].ppw.all)} points a week for the rest of the season`)
        + sideHtml(L, g.sides[0], 'you', at(before, rid), at(after, rid))
        + sideHtml(L, g.sides[1], 'them', at(before, st.other), at(after, st.other))
        + (note ? `<p class="note">${esc(note)}</p>` : '');
    } catch (err) {
      box.innerHTML = `<div class="warn-box">${esc(err.message)}</div>`;
    }
  };

  const search = () => memo(data, `sugg|${rid}`, () => {
    const k = oddsKey(L);
    // Compared with a baseline of the same size and seed, so a deal that
    // barely moves the odds doesn't pass or fail on simulation noise.
    if (baseOdds(data) && !data.base4k) data.base4k = S.seasonOdds(L, data.schedule, data.weekly, { nSims: SUGG_SIMS });
    const before = data.base4k;
    const odds = before ? (sa, sb, other) => {
      const taken = new Set();
      const a = T.rosterAfter(L, L.teams.get(rid), sa, sb, taken);
      const b = T.rosterAfter(L, L.teams.get(other), sb, sa, taken);
      const after = oddsWith(data, a.sids, rid, b.sids, other, SUGG_SIMS);
      return { me: after.get(rid)[k] - before.get(rid)[k], them: after.get(other)[k] - before.get(other)[k] };
    } : null;
    const stats = {};
    return { list: T.suggestTrades(L, rid, { odds, stats }), stats, withOdds: !!odds };
  });

  const suggestions = (box) => {
    if (!box) return;
    const { list, stats, withOdds } = search();
    box.innerHTML = `<h2>Suggested trades</h2>${list.length ? list.map((c, i) => `
      <div class="sugg" data-sugg="${i}">
        <div class="row" style="justify-content:space-between"><strong>With ${esc(c.team)}</strong>
          ${c.odds ? `<span class="faint" style="font-size:12px">${hasPlayoffs(L) ? 'Title odds' : 'Best record'} ${signed(100 * c.odds.me, 0)}% you · ${signed(100 * c.odds.them, 0)}% them</span>` : ''}</div>
        <div class="pline">You send <strong>${names(c.grade.sides[0].sends)}</strong> · you get <strong>${names(c.grade.sides[0].gets)}</strong></div>
        <div class="pline">${signed(c.grade.sides[0].ppw.all)} pts/wk you · ${signed(c.grade.sides[1].ppw.all)} pts/wk them</div>
        <p class="note" style="margin-top:4px">${esc(c.reason)}</p>
      </div>`).join('') : '<p class="note">No trade found that clearly helps both sides right now.</p>'}
      <p class="note">Only deals where both teams' lineups${withOdds ? ` and ${hasPlayoffs(L) ? 'title' : 'best-record'} odds` : ''} go up, without counting any free-agent pickup. Tap one to open it in the calculator.${stats.searched < stats.of ? ` Searched ${stats.searched} of ${stats.of} teams in the time allowed.` : ''}</p>`;
    box.querySelectorAll('[data-sugg]').forEach((el) => el.addEventListener('click', () => {
      const c = list[Number(el.dataset.sugg)];
      Object.assign(st, { other: c.with, send: new Set(c.sendA), get: new Set(c.sendB) });
      draw();
      host.querySelector('#tr-calc').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  };

  draw();
}

/** The season odds map (rosterId -> {playoff, title, ...}), or null. */
export function playoffOdds(data) {
  return data.L.weeks.length ? baseOdds(data) : null;
}

/** Playoff odds and power rankings, for the League sub-tab. */
/** Dynasty strength: carryover-weighted points a week over the next seasons. */
function dynastyPowerCard(rid, data) {
  const { L, dctx } = data;
  const dp = DT.dynastyPower(dctx);
  // Outlook: this season's odds while it lasts, next season's after (spec 5.5).
  const fo = DT.nowOddsOf(dctx) || DT.futureBase(dctx, 'exp', 2000)[0].odds;
  const rows = [...L.teams.values()].map((t) => ({ t, v: dp.get(t.roster_id) })).sort((a, b) => b.v - a.v);
  return `<div class="card flush"><h2>Dynasty strength</h2><table class="tbl">
      <thead><tr><th>#</th><th>Team</th><th class="r">Next ${dctx.D.H} yrs</th><th class="r">Outlook</th></tr></thead>
      ${foldedTable(rows.map(({ t, v }, i) => { const tag = DT.outlookTag(fo.get(t.roster_id), L.teams.size);
        return `<tr class="${t.roster_id === rid ? 'me' : ''}"><td class="faint">${i + 1}</td><td>${esc(t.team || t.name)}</td>
        <td class="r">${num(v)}</td><td class="r faint">${tag ? esc(tag.key[0].toUpperCase() + tag.key.slice(1)) : ''}</td></tr>`; }), rows.findIndex(({ t }) => t.roster_id === rid))}</table>
      <p class="note" style="padding:0 14px 14px">Each team's best lineup in each of the next ${dctx.D.H} seasons, players aged and picks turned into rookies, weighted by how much of a roster usually lasts. Outlook from this season's playoff and title odds (next season's once it's over).</p></div>`;
}

export function leagueCards(rid, data) {
  const { L } = data;
  if (!L.weeks.length) return data.dctx ? `${dynastyPowerCard(rid, data)}<p class="note">This season is over; the table is next season and the two after.</p>` : '';
  const odds = baseOdds(data);
  const power = S.powerRankings(L, data.weekly);
  const powerCard = `<div class="card flush"><h2>Power rankings</h2><table class="tbl">
      <thead><tr><th>#</th><th>Team</th><th class="r">Pts/wk</th><th class="r">W-L</th></tr></thead>
      ${foldedTable(power.map((r, i) => `<tr class="${r.roster_id === rid ? 'me' : ''}"><td class="faint">${i + 1}</td><td>${esc(r.team)}</td>
        <td class="r">${num(r.ppw)}</td><td class="r">${r.record.wins}-${r.record.losses}${r.record.ties ? `-${r.record.ties}` : ''}</td></tr>`), power.findIndex((r) => r.roster_id === rid))}</table>
      <p class="note" style="padding:0 14px 14px">By projected points a week from each team's best lineup for the rest of the season — who is good, not who has been lucky.</p></div>
    ${data.dctx ? dynastyPowerCard(rid, data) : ''}`;
  if (!odds) {
    const why = data.scheduleOk ? 'The fantasy playoffs are under way — the bracket decides it now.'
      : 'Couldn\'t load this league\'s schedule, so there are no playoff odds right now. They come back the next time the league loads.';
    return `<div class="card"><h2>Playoff odds</h2><p class="note" style="margin:0">${why}</p></div>${powerCard}`;
  }
  const rows = [...L.teams.values()].map((t) => ({ t, o: odds.get(t.roster_id) }));
  const po = hasPlayoffs(L);
  rows.sort((a, b) => (po ? (b.o.title - a.o.title) || (b.o.playoff - a.o.playoff) : b.o.best_record - a.o.best_record) || (b.o.wins - a.o.wins));
  return `<div class="card flush"><h2>${po ? 'Playoff odds' : 'Season outlook'}</h2><div class="scroll-x"><table class="tbl">
      <thead><tr><th>#</th><th>Team</th><th class="r">Proj W</th>${po ? '<th class="r">Playoffs</th><th class="r">Title</th>' : '<th class="r">Best record</th>'}</tr></thead>
      ${foldedTable(rows.map(({ t, o }, i) => `<tr class="${t.roster_id === rid ? 'me' : ''}"><td class="faint">${i + 1}</td><td>${esc(t.name)}</td><td class="r">${num(o.wins, 1)}</td>
        ${po ? `<td class="r">${pct(o.playoff)}</td><td class="r">${pct(o.title)}</td>` : `<td class="r">${pct(o.best_record)}</td>`}</tr>`), rows.findIndex(({ t }) => t.roster_id === rid))}</table></div>
      <p class="note" style="padding:0 14px 14px">The rest of the season played 10,000 times on each team's best lineups and this league's schedule.</p></div>
    ${powerCard}`;
}

/** Best free agents for the rest of the season under this league's scoring. */
/** Dynasty leagues: unrostered players with the most future value. */
export const stashHtml = (data, pos) => (data && data.dctx ? DV.stashHtml(data.dctx, pos) : '');

/** The player card's dynasty row, from the open league (model id -> its Sleeper id). */
export function dynastyRowHtml(dctx, modelId) {
  return dctx ? DV.playerRowHtml(dctx, dctx.L.sidFor(modelId)) : '';
}

export function rosWaiversHtml(data, pos) {
  const { L } = data;
  const list = L.freeAgents(120).map(L.player).filter((p) => pos === 'ALL' || p.pos === pos).slice(0, 25);
  return `<div class="card flush"><h2>Best available — rest of season</h2><div class="list">
    ${list.map((p) => `<div class="prow" ${p.mid && ['QB', 'RB', 'WR', 'TE'].includes(p.pos) ? `data-player="${esc(p.mid)}"` : ''}>
      <div class="pmain"><div class="pname">${posPill(p.pos)}<span class="n">${esc(p.name)}</span></div>
      <div class="pline">${esc(p.team || '')}${p.opp.slice(0, 3).some(Boolean) ? ` · next: ${p.opp.slice(0, 3).map((o) => esc(o || 'bye')).join(', ')}` : ''}</div></div>
      <div class="pright"><div class="pts">${num(p.ppg)}<small>pts/game</small></div></div></div>`).join('')
      || '<p class="muted" style="padding:12px;margin:0">Nobody projected at this position is available.</p>'}
    </div></div><p class="note">Unrostered, ranked by projected points for the rest of the season under this league's scoring (missed games and byes included), shown per game left.</p>`;
}

/** Next four games rated easy/average/hard, and the playoff weeks' total. */
export function scheduleAheadHtml(ros, id, settings, playoffStart) {
  const e = scoreOne(ros, id, settings);
  if (!e) return '';
  const weeks = activeWeeks(ros);
  // Matchups are rated on "if he plays" points, so the slow build-up of
  // missed-game risk later in the season does not make early weeks look easy.
  const rows = weeks.map((w) => ({ w, j: ros.weeks.indexOf(w) })).map(({ w, j }) => ({
    w, opp: e.opp[j], pts: Number.isFinite(e.pts[j]) ? e.pts[j] : null,
    exp: Number.isFinite(e.pts[j]) ? e.pts[j] * e.avail[j] : null }));
  const played = rows.filter((r) => r.pts != null);
  if (!played.length) return '';
  const avgIf = played.reduce((a, r) => a + r.pts, 0) / played.length;
  const avg = played.reduce((a, r) => a + r.exp, 0) / played.length;
  const start = playoffStart > 0 ? playoffStart : 15;
  const po = rows.filter((r) => r.w >= start && r.w <= LAST_WEEK && r.exp != null).reduce((a, r) => a + r.exp, 0);
  const rate = (p) => (p == null ? 'bye' : p >= 1.08 * avgIf ? 'easy' : p <= 0.92 * avgIf ? 'hard' : 'average');
  return `<div class="section-title">Schedule ahead</div>
    <div class="ahead">${rows.slice(0, 4).map((r) => `<div class="wk ${rate(r.pts)}"><div class="faint">Wk ${r.w}</div>
      <strong>${esc(r.opp || 'Bye')}</strong><div class="faint">${r.pts == null ? '—' : num(r.pts)}</div></div>`).join('')}</div>
    <p class="note">Each week: points if he plays. ${num(avg)} a game for the rest of the season with missed games counted; ${num(po)} across weeks ${start}-${LAST_WEEK} (fantasy playoffs). Green is an easier matchup than his average, red a harder one.</p>`;
}

export { PPR_SETTINGS };
