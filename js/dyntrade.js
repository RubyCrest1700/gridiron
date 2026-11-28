// Dynasty trades. A trade is worth the change in each team's title odds:
// this season (season.js on the league's real schedule) plus each of the
// next three seasons (simulated on each team's future lineup), the future
// scaled by how much of a roster usually lasts that long. Each side is
// judged by its own situation, so one deal can help a contender and a
// rebuilder. Picks ('pk:...') never reach the this-season code.

import * as T from './trade.js';
import * as S from './season.js';
import * as DY from './dynasty.js';
import { CONF } from './confidence.js';
import { DCONF } from './confidence_dynasty.js';
import { isPick, pickState } from './picks.js';
import { normCdf } from './engine.js';

export const FALLBACK_NOTE = 'Dynasty values unavailable right now; this season only.';
export const PICKS_NOTE = 'Draft picks could not be loaded; graded on the players only.';

/** This season's odds for a valued league, cached on `data` (null once the
 *  playoffs start, in the offseason, or without a schedule). */
export function seasonOddsOf(data) {
  const L = data.L;
  if (!L.weeks.length || !data.scheduleOk) return null;
  if (!data.weekly) data.weekly = S.teamWeekly(L);
  if (data.odds === null || data.odds === undefined) data.odds = S.seasonOdds(L, data.schedule, data.weekly) || false;
  return data.odds || null;
}

/**
 * The dynasty context for one league -- the phone (views/trades.js) and the
 * PC (web/trades.js) both build it here, so they cannot drift apart.
 * picksRaw: {rosters, traded, drafts} as read from Sleeper, or null when the
 * read failed. Returns {dctx, note}: dctx null without dynasty values.
 */
export function dynastyContext(L, dyn, picksRaw, data) {
  if (!dyn) return { dctx: null, note: FALLBACK_NOTE };
  const ok = !!picksRaw && Array.isArray(picksRaw.traded) && Array.isArray(picksRaw.drafts);
  // Next draft's slots: this season's simulated finish (reverse standings),
  // or the final standings once this season's odds are gone.
  const slotFn = (orig) => {
    const o = seasonOddsOf(data);
    if (o && o.get(orig)) return o.get(orig).slot;
    const order = [...L.teams.values()].sort((a, b) => (a.record.wins - b.record.wins)
      || ((a.record.points_for || 0) - (b.record.points_for || 0)));
    return order.findIndex((t) => t.roster_id === orig) + 1 || null;
  };
  const picks = ok ? pickState(L, { rosters: picksRaw.rosters, traded: picksRaw.traded, drafts: picksRaw.drafts, slotFn }) : null;
  return { dctx: makeCtx(L, DY.makeDynasty(L, dyn, picks), data), note: ok ? null : PICKS_NOTE };
}

/** Under every table of future seasons. */
export const PLAYS_NOTE = "Points per game when he plays. The percentage is the share of that season's games "
  + "he's expected to play: injuries, losing the job and retirement all count.";

export const OUTLOOKS = { auto: { w0: 1, hs: null }, now: { w0: 1, hs: [0] }, rebuild: { w0: 0, hs: null } };
export const OUTLOOK_LABEL = { auto: 'Auto', now: 'Win now', rebuild: 'Rebuild' };
const SEED = 11;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const logit = (p) => { const q = Math.min(0.998, Math.max(0.002, p)); return Math.log(q / (1 - q)); };
export const keyOf = (L) => (Number((L.league.settings || {}).playoff_week_start || 0) > 0 ? 'title' : 'best_record');
const split = (xs) => [xs.map(String).filter((x) => !isPick(x)), xs.map(String).filter(isPick)];
export const swap = (xs, out, inn) => xs.map(String).filter((x) => !out.includes(x)).concat(inn);

/** Title odds per point a week, per team, from a logistic fit across the league. */
export function slopes(strength, odds, key) {
  const rids = [...strength.keys()];
  const xs = rids.map((r) => strength.get(r)), ys = rids.map((r) => logit(odds.get(r)[key] || 0));
  const mx = avg(xs), my = avg(ys);
  let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; });
  const b = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
  return new Map(rids.map((r) => { const o = odds.get(r)[key] || 0; return [r, b * o * (1 - o)]; }));
}

export function makeCtx(L, D, data) { return { L, D, data, base: new Map(), now: new Map() }; }
export const rosterOf = (ctx, rid) => ctx.L.tradeable(ctx.L.teams.get(rid));
export const picksOf = (ctx, rid) => (ctx.D.picks ? ctx.D.picks.owned(rid) : []);
const spreadAt = (ctx, h) => (ctx.D.err[h] || 0) / Math.sqrt(Math.max(1, ctx.L.slots.length));

/** Every team's strength, odds and odds-per-point in each season ahead. */
export function futureBase(ctx, mode = 'scen', nSims = 4000, fill = 'all') {
  const k = `${mode}|${nSims}|${fill}`;
  if (!ctx.base.has(k)) {
    const { L, D } = ctx;
    // Strengths depend on the mode and fill only, not on how many seasons are simulated.
    const sk = `strength|${mode}|${fill}`;
    if (!ctx.base.has(sk)) {
      ctx.base.set(sk, Array.from({ length: D.H }, (_, h) =>
        new Map([...L.teams.keys()].map((r) => [r, D.strength(rosterOf(ctx, r), picksOf(ctx, r), h, mode, fill)]))));
    }
    const out = [];
    for (let h = 0; h < D.H; h++) {
      const strength = ctx.base.get(sk)[h];
      const odds = S.futureOdds(L, strength, { nSims, seed: SEED + h, spread: spreadAt(ctx, h) });
      out.push({ strength, odds, slope: slopes(strength, odds, keyOf(L)) });
    }
    ctx.base.set(k, out);
  }
  return ctx.base.get(k);
}

/** This season's odds (null in the offseason, without a schedule or once the playoffs start). */
export function nowBase(ctx, nSims = 4000) {
  const { L, data } = ctx;
  if (!L.weeks.length || !data || !data.scheduleOk) return null;
  const k = `now|${nSims}`;
  if (!ctx.now.has(k)) {
    if (!data.weekly) data.weekly = S.teamWeekly(L);
    const odds = S.seasonOdds(L, data.schedule, data.weekly, { nSims });
    const strength = new Map([...data.weekly].map(([r, w]) => [r, avg(Array.from(w))]));
    ctx.now.set(k, odds ? { odds, slope: slopes(strength, odds, keyOf(L)) } : null);
  }
  return ctx.now.get(k);
}
export const nowOddsOf = (ctx) => { const b = nowBase(ctx); return b ? b.odds : null; };

/** A team's players after a trade with its roster made legal again, as it
 *  must be in every season ahead: over the limit, the least valuable players
 *  are cut (a throw-in who just arrived included); under it, the best free agents come in
 *  (not with `noMoves` -- a suggestion must not lean on a pickup the team
 *  could make anyway). Value here is dynasty value, this season and later.
 *  Picks, injured reserve and taxi players take no roster spot. */
export function dynRosterAfter(ctx, rid, out, inn, taken = new Set(), { noMoves = false } = {}) {
  const { L, D } = ctx;
  const team = L.teams.get(rid);
  const outSet = new Set(out.map(String)), incoming = new Set(inn.map(String));
  const before = team.active.length;
  let active = team.active.filter((x) => !outSet.has(x)).concat([...incoming]);
  const rest = [...team.reserve, ...team.taxi].filter((x) => !outSet.has(x));
  const drops = [], adds = [];
  const cap = Math.max(L.rosterLimit, before);
  if (active.length > cap) {
    // Anyone may go, a throw-in who just arrived included.
    const order = active.slice().sort((a, b) => dynValue(ctx, a) - dynValue(ctx, b));
    while (active.length > cap && order.length) {
      const d = order.shift();
      active = active.filter((x) => x !== d);
      drops.push(d);
    }
  } else if (!noMoves && active.length < Math.min(before, L.rosterLimit)) {
    const pool = [...new Set([...L.freeAgents(60), ...D.stash(40).map((x) => x.sid)])]
      .filter((x) => !taken.has(x)).sort((a, b) => dynValue(ctx, b) - dynValue(ctx, a));
    for (const sid of pool) {
      if (active.length >= Math.min(before, L.rosterLimit)) break;
      active.push(sid); adds.push(sid); taken.add(sid);
    }
  }
  return { sids: [...active, ...rest], drops, adds };
}

export function gradeDynasty(ctx, ridA, ridB, sendA, sendB,
  { outlook = 'auto', nSims = 4000, mode = 'scen', noMoves = false } = {}) {
  const { L, D } = ctx;
  if (!L.teams.has(ridA) || !L.teams.has(ridB)) throw new Error('Pick two teams in this league.');
  const key = keyOf(L);
  const [pa, ka] = split(sendA), [pb, kb] = split(sendB);
  // noMoves (suggestions): this season as traded, no waiver pickup into the
  // spot a 2-for-1 opens -- a gain that needs the pickup was there anyway.
  const part1 = L.weeks.length ? T.gradeTrade(L, ridA, ridB, pa, pb, mode, { noMoves }) : null;
  const nb = part1 ? nowBase(ctx, nSims) : null;
  let nowAfter = null;
  if (nb) {
    const weekly = new Map(ctx.data.weekly);
    weekly.set(ridA, L.value(part1.sides[0].sids, 'scen').weekly);
    weekly.set(ridB, L.value(part1.sides[1].sids, 'scen').weekly);
    nowAfter = S.seasonOdds(L, ctx.data.schedule, weekly, { nSims });
  }
  const fill = 'all';
  const base = futureBase(ctx, mode, nSims, fill);
  const taken = new Set();
  const movesA = dynRosterAfter(ctx, ridA, pa, pb, taken, { noMoves });
  const movesB = dynRosterAfter(ctx, ridB, pb, pa, taken, { noMoves });
  const fut = base.map((b, h) => {
    const strength = new Map(b.strength);
    const sa = D.strength(movesA.sids, swap(picksOf(ctx, ridA), ka, kb), h, mode, fill);
    const sb = D.strength(movesB.sids, swap(picksOf(ctx, ridB), kb, ka), h, mode, fill);
    strength.set(ridA, sa); strength.set(ridB, sb);
    return { b, sa, sb, odds: S.futureOdds(L, strength, { nSims, seed: SEED + h, spread: spreadAt(ctx, h) }) };
  });
  // How uncertain the swing is: each moved player's (or pick's) expected
  // points that season times the measured error at that horizon.
  const moved = [...pa, ...pb];
  const sigmaFut = base.map((_, h) => Math.sqrt(
    moved.reduce((t, s) => { const f = D.future(s); return t + (D.err[h] * f.pts[h] * f.avail[h]) ** 2; }, 0)
    + [...ka, ...kb].reduce((t, id) => t + (D.err[h] * D.pickPpw(id, h)) ** 2, 0)));
  const sigmaNow = CONF.measured ? 1.702 / CONF.k : 0;
  const side = (rid, i, look) => {
    const w = OUTLOOKS[look] || OUTLOOKS.auto;
    const hs = w.hs || base.map((_, h) => h);
    const now = nb && nowAfter ? { before: nb.odds.get(rid)[key], after: nowAfter.get(rid)[key] } : null;
    const later = fut.map((f) => ({ before: f.b.odds.get(rid)[key], after: f.odds.get(rid)[key],
      ppw: (i === 0 ? f.sa : f.sb) - f.b.strength.get(rid) }));
    const V = w.w0 * (now ? now.after - now.before : 0)
      + hs.reduce((t, h) => t + D.carry[h] * (later[h].after - later[h].before), 0);
    // This season's spread only when players move this season (a pick swap
    // changes nothing until next year).
    let varV = now && moved.length ? (w.w0 * nb.slope.get(rid) * sigmaNow) ** 2 : 0;
    for (const h of hs) varV += (D.carry[h] * fut[h].b.slope.get(rid) * sigmaFut[h]) ** 2;
    const sd = Math.sqrt(varV) * (DCONF.sigma_scale || 1);
    const prob = sd > 0 ? normCdf(V / sd) : (V > 0 ? 1 : V < 0 ? 0 : 0.5);
    const label = !DCONF.measured ? null : prob >= 0.6 ? 'helps' : prob <= 0.4 ? 'hurts' : 'tossup';
    const mv = i === 0 ? movesA : movesB;
    return { roster_id: rid, team: L.teams.get(rid).name, outlook: look, now, later, V, prob, label,
      moves: { drops: mv.drops, adds: mv.adds }, part1: part1 ? part1.sides[i] : null };
  };
  return { sides: [side(ridA, 0, outlook), side(ridB, 1, 'auto')], key };
}

/** "Contending · 18% title", "Middle" or "Rebuilding" from a team's odds. */
export function outlookTag(o, nTeams) {
  if (!o) return null;
  const t = o.title ?? o.best_record ?? 0, p = o.playoff;
  if ((p != null && p >= 0.6) || t >= 1.5 / nTeams) return { key: 'contending', label: `Contending · ${Math.round(100 * t)}% title` };
  if (p != null && p <= 0.2) return { key: 'rebuilding', label: 'Rebuilding' };
  return { key: 'middle', label: 'Middle' };
}

// --------------------------------------------------------------- suggestions
const DCAND = 6, DPICKS = 2, DSHORT = 20;
const candCount = (nTeams) => (nTeams > 20 ? 4 : nTeams > 14 ? 5 : DCAND);

function dynValue(ctx, sid) {
  const f = ctx.D.future(sid);
  let v = ctx.L.weeks.length ? ctx.L.player(sid).ppg : 0;
  for (let h = 0; h < ctx.D.H; h++) v += ctx.D.carry[h] * f.pts[h] * f.avail[h];
  return v;
}
function pickValue(ctx, id) {
  let v = 0;
  for (let h = 0; h < ctx.D.H; h++) v += ctx.D.carry[h] * ctx.D.pickPpw(id, h);
  return v;
}
function candidatesOf(ctx, rid) {
  const { L } = ctx;
  const n = candCount(L.teams.size);
  const players = rosterOf(ctx, rid).filter((s) => { const p = L.player(s); return L.wanted.has(p.pos) && p.pos !== 'K' && p.pos !== 'DEF'; })
    .sort((a, b) => dynValue(ctx, b) - dynValue(ctx, a)).slice(0, n);
  const picks = picksOf(ctx, rid).sort((a, b) => pickValue(ctx, b) - pickValue(ctx, a)).slice(0, DPICKS);
  return players.concat(picks);
}
const pairs = (xs) => { const o = []; for (let i = 0; i < xs.length; i++) for (let k = i + 1; k < xs.length; k++) o.push([xs[i], xs[k]]); return o; };

/**
 * Up to `max` deals both sides gain from (each by its own outlook), one per
 * opponent, no player or pick twice. Screens 1-for-1, 2-for-1 and 1-for-2
 * with a linear estimate (odds per point a week x strength change), counts
 * this season with no roster moves (a gain that needs a waiver pickup
 * doesn't count), then grades the best with the full simulations.
 */
export function suggestDynasty(ctx, rid, { budgetMs = 4000, max = 3, outlook = 'auto', stats = null } = {}) {
  const { L } = ctx;
  if (!DCONF.measured) return [];
  const t0 = Date.now();
  const over = (share) => Date.now() - t0 > budgetMs * share;
  const pool = screenDeals(ctx, rid, { outlook, over, stats });
  const graded = [];
  for (const c of pool.slice(0, DSHORT)) {
    if (over(0.95)) break;
    const g = gradeDynasty(ctx, rid, c.with, c.sendA, c.sendB, { outlook, nSims: 2000, noMoves: true });
    if (twoWay(g)) graded.push({ ...c, grade: g, score: Math.min(g.sides[0].V, g.sides[1].V) });
  }
  graded.sort((a, b) => b.score - a.score);
  const out = [], usedTeams = new Set(), used = new Set();
  for (const c of graded) {
    if (usedTeams.has(c.with) || [...c.sendA, ...c.sendB].some((s) => used.has(s))) continue;
    usedTeams.add(c.with);
    [...c.sendA, ...c.sendB].forEach((s) => used.add(s));
    out.push({ ...c, team: L.teams.get(c.with).name, reason: reasonFor(ctx, c) });
    if (out.length >= max) break;
  }
  return out;
}

/** A suggestion's bar (the user's call, 2026-10-01): both sides gain on
 *  average and neither is more likely hurt than helped. "Clearly helps" both
 *  (60%+) was too rare three seasons out; the cards show both percentages. */
export const twoWay = (g) => g.sides.every((s) => s.V > 0 && s.prob >= 0.5);

/** The fast screen: every candidate deal both sides should gain from by the
 *  linear estimate, best first. */
export function screenDeals(ctx, rid, { outlook = 'auto', over = () => false, stats = null } = {}) {
  const { L, D } = ctx;
  const base = futureBase(ctx, 'exp', 2000);
  const nb = nowBase(ctx, 2000);
  const est = (r, dNow, dFut, look) => {
    const w = OUTLOOKS[look] || OUTLOOKS.auto;
    const hs = w.hs || base.map((_, h) => h);
    return w.w0 * (nb ? nb.slope.get(r) * dNow : 0) + hs.reduce((t, h) => t + D.carry[h] * base[h].slope.get(r) * dFut[h], 0);
  };
  const fut = (r, out, inn) => {
    const [po, ko] = split(out), [pi, ki] = split(inn);
    return base.map((b, h) => D.strength(swap(rosterOf(ctx, r), po, pi), swap(picksOf(ctx, r), ko, ki), h, 'exp') - b.strength.get(r));
  };
  const mine = candidatesOf(ctx, rid);
  const others = [...L.teams.keys()].filter((r) => r !== rid);
  const pool = [];
  let searched = 0;
  for (const o of others) {
    if (over(0.5)) break;
    searched += 1;
    const theirs = candidatesOf(ctx, o);
    const offers = [];
    for (const a of mine) for (const b of theirs) offers.push([[a], [b]]);
    for (const pa of pairs(mine.slice(0, 4))) for (const b of theirs) offers.push([pa, [b]]);
    for (const a of mine) for (const pb of pairs(theirs.slice(0, 4))) offers.push([[a], pb]);
    for (const [sa, sb] of offers) {
      const [pa] = split(sa), [pb] = split(sb);
      let dA = 0, dB = 0;
      if (L.weeks.length && (pa.length || pb.length)) {
        const g = T.gradeTrade(L, rid, o, pa, pb, 'exp', { noMoves: true });
        dA = g.sides[0].ppw.all; dB = g.sides[1].ppw.all;
      }
      const vA = est(rid, dA, fut(rid, sa, sb), outlook), vB = est(o, dB, fut(o, sb, sa), 'auto');
      if (vA > 0 && vB > 0) pool.push({ with: o, sendA: sa, sendB: sb, score: Math.min(vA, vB) });
    }
  }
  if (stats) Object.assign(stats, { searched, of: others.length, pool: pool.length });
  return pool.sort((a, b) => b.score - a.score);
}

export function itemName(ctx, id, short = true) {
  if (isPick(id)) return ctx.D.picks ? ctx.D.picks.label(id, short) : id;
  const p = ctx.L.player(id), age = ctx.D.future(id).age;
  return `${p.name}${age ? ` (${Math.floor(age)})` : ''}`;
}
const pctS = (v) => `${v > 0 ? '+' : ''}${Math.round(100 * v)}%`;
export function nowLater(ctx, s) {
  const n = s.now ? s.now.after - s.now.before : 0;
  const f = s.later.reduce((t, l, h) => t + ctx.D.carry[h] * (l.after - l.before), 0);
  return { n, f };
}
function reasonFor(ctx, c) {
  const [me, them] = c.grade.sides;
  const a = nowLater(ctx, me), b = nowLater(ctx, them);
  const y0 = ctx.D.season + 1, y1 = ctx.D.season + ctx.D.H;
  return `You get ${c.sendB.map((x) => itemName(ctx, x)).join(' + ')} for ${c.sendA.map((x) => itemName(ctx, x)).join(' + ')}: `
    + `${pctS(a.n)} title odds this season, ${pctS(a.f)} over ${y0}-${String(y1).slice(2)}. They get ${pctS(b.n)} now, ${pctS(b.f)} later.`;
}

// ---------------------------------------------------------------- team needs
export const AGE_WARN = { QB: 34, RB: 28, WR: 30, TE: 30 };

export function dynastyNeeds(ctx, rid, { odds = null } = {}) {
  const { L, D } = ctx;
  const lines = [];
  const src = odds || nowOddsOf(ctx) || futureBase(ctx, 'exp', 2000)[0].odds;
  const tag = outlookTag(src.get(rid), L.teams.size);
  if (tag) lines.push(`Outlook: ${tag.label}.`);
  const sids = rosterOf(ctx, rid);
  for (const [pos, lim] of Object.entries(AGE_WARN)) {
    const n = L.slots.filter((s) => s === pos).length + 1;
    const top = sids.filter((s) => L.player(s).pos === pos).sort((a, b) => dynValue(ctx, b) - dynValue(ctx, a)).slice(0, n);
    const old = top.filter((s) => (D.future(s).age || 0) >= lim);
    if (top.length >= 2 && old.length >= 2 && old.length * 2 >= top.length) {
      lines.push(`${old.length} of your top ${top.length} ${pos}s are ${lim}+ — the ${pos} room is getting old.`);
    }
  }
  if (D.picks && D.picks.rounds) {
    const own = picksOf(ctx, rid).map((id) => D.picks.info(id)).filter((p) => p.season === D.picks.next);
    const firsts = own.filter((p) => p.round === 1).length;
    lines.push(own.length
      ? `You own ${own.length} pick${own.length === 1 ? '' : 's'} in ${D.picks.next}${firsts ? `, including ${firsts === 1 ? 'a 1st' : `${firsts} 1sts`}` : ', no 1st'}.`
      : `You own no picks in ${D.picks.next}.`);
  }
  const teams = [...L.teams.keys()];
  for (let h = 0; h < Math.min(2, D.H); h++) {
    const all = new Map(teams.map((r) => [r, D.slotsAt(rosterOf(ctx, r), picksOf(ctx, r), h)]));
    const mine = all.get(rid);
    const third = Math.ceil(teams.length / 3);
    const seen = new Set();
    L.slots.forEach((s, i) => {
      if (seen.has(s)) return;
      const rank = 1 + teams.filter((r) => all.get(r)[i] > mine[i] + 1e-9).length;
      if (rank > teams.length - third) { seen.add(s); lines.push(`In ${D.season + 1 + h}, your ${s.replace('_', ' ')} spot projects ${rank} of ${teams.length}.`); }
    });
  }
  return lines.slice(0, 7);
}

/** Lineup strength over the next seasons, carryover-weighted (points a week). */
export function dynastyPower(ctx) {
  const base = futureBase(ctx, 'exp', 2000);
  const c = ctx.D.carry.slice(0, base.length);
  const cs = c.reduce((a, b) => a + b, 0) || 1;
  return new Map([...ctx.L.teams.keys()].map((r) => [r, base.reduce((t, b, h) => t + c[h] * b.strength.get(r), 0) / cs]));
}
