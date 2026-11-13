// Trades: grade one, find good ones, and say what a team needs. All for the
// rest of the season, on the lineups each team could actually set. Works on
// the league object from valuer.makeLeague.

import { CONF } from './confidence.js';
import { SLOT_LABEL } from './engine.js';

// Dynasty leagues normally grade with dyntrade.js; this note is the fallback
// when the dynasty values could not be loaded.
export const DYNASTY_NOTE = 'Dynasty values unavailable right now; this season only.';
export const KEEPER_NOTE = 'This season only: keeper value is not counted.';
export const SLOT_GROUP = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DEF',
  FLEX: 'FLEX', WRRB_FLEX: 'FLEX', REC_FLEX: 'FLEX', SUPER_FLEX: 'FLEX',
  DL: 'IDP', LB: 'IDP', DB: 'IDP', IDP_FLEX: 'IDP' };

const brief = (L, sid) => {
  const p = L.player(sid);
  const st = p.status && !['Active', 'Healthy'].includes(p.status) ? p.status : null;
  return { sid: p.sid, name: p.name, pos: p.pos, status: st };
};

/** A team's roster after a trade, legal size restored: drop the least
 *  valuable bodies (a throw-in who just arrived included), or add the best
 *  free agents.
 *  `noMoves` keeps the roster as traded (to see what the trade alone does).
 *  Taxi players can be sent; they never counted toward the lineup. */
export function rosterAfter(L, team, out, inn, taken = new Set(), { noMoves = false, mode = 'scen' } = {}) {
  const before = team.active.length;
  const outSet = new Set(out.map(String));
  let active = team.active.filter((s) => !outSet.has(s)).concat(inn.map(String));
  const reserve = team.reserve.filter((s) => !outSet.has(s));
  const drops = [], adds = [];
  if (noMoves) return { sids: [...active, ...reserve], drops, adds };
  const cap = Math.max(L.rosterLimit, before);
  if (active.length > cap) {
    // Never cut a player at a position the league starts but we can't value
    // yet (IDP): he reads as 0, but losing him is a real loss.
    const cuttable = (s) => { const p = L.player(s); return p.modelled || !L.wanted.has(p.pos); };
    // Cut whoever the lineup misses least -- a player who just arrived
    // included (a worthless throw-in goes, not a better player already here),
    // and not just the fewest points on paper (a second kicker scores more
    // than a bench receiver but almost never starts).
    // The three cheapest cuts by expected lineup points, then the injury and
    // bye scenarios choose among them (only they see a backup's worth) --
    // except in the fast 'exp' screen.
    while (active.length > cap) {
      const pool = active.filter((s) => cuttable(s));
      if (!pool.length) break;
      const without = (c) => active.filter((s) => s !== c).concat(reserve);
      const short = pool.map((c) => [c, L.value(without(c), 'exp').total])
        .sort((x, y) => y[1] - x[1] || L.player(x[0]).season - L.player(y[0]).season).slice(0, 3);
      let d = short[0][0], best = -Infinity;
      if (mode !== 'exp') {
        for (const [c] of short) {
          const v = L.value(without(c), 'scen').total;
          if (v > best + 1e-9) { best = v; d = c; }
        }
      }
      active = active.filter((s) => s !== d);
      drops.push(d);
    }
  } else if (active.length < Math.min(before, L.rosterLimit)) {
    for (const sid of L.freeAgents(200)) {
      if (active.length >= Math.min(before, L.rosterLimit)) break;
      if (taken.has(sid)) continue;
      active.push(sid); adds.push(sid); taken.add(sid);
    }
  }
  return { sids: [...active, ...reserve], drops, adds };
}

/** Positions the trade leaves with nobody, where the grade counts on the
 *  best free agent (valuer waiver fill) -- said, so the grade isn't a mystery. */
function waiverNeeded(L, before, after) {
  const has = (sids) => new Set(sids.map(L.player).filter((p) => p.modelled).map((p) => p.pos));
  const was = has(before), now = has(after);
  return L.fillFor(after).filter((p) => was.has(p.pos) && !now.has(p.pos)).map((p) => brief(L, p.sid));
}

function bySlot(L, before, after) {
  const out = {};
  L.slots.forEach((s, i) => {
    const g = SLOT_GROUP[s] || s;
    out[g] = (out[g] || 0) + (after.slotAvg[i] - before.slotAvg[i]);
  });
  return out;
}

/** Both sides of a trade: points per week gained or lost in the best lineup
 *  each team could set, over the regular season and the playoff weeks. */
export function gradeTrade(L, ridA, ridB, sendA, sendB, mode = 'scen', { noMoves = false } = {}) {
  const A = L.teams.get(ridA), B = L.teams.get(ridB);
  if (!A || !B) throw new Error('Pick two teams in this league.');
  const taken = new Set();
  const sides = [[A, sendA, sendB], [B, sendB, sendA]].map(([t, out, inn]) => {
    const now = L.lineupSids(t);
    const next = rosterAfter(L, t, out, inn, taken, { noMoves, mode });
    const before = L.value(now, mode), after = L.value(next.sids, mode);
    const bE = mode === 'exp' ? before : L.value(now, 'exp');
    const aE = mode === 'exp' ? after : L.value(next.sids, 'exp');
    const per = (x, n) => (n ? x / n : null);
    return {
      roster_id: t.roster_id, team: t.name,
      sends: out.map((s) => brief(L, s)), gets: inn.map((s) => brief(L, s)),
      drops: next.drops.map((s) => brief(L, s)), adds: next.adds.map((s) => brief(L, s)),
      fills: waiverNeeded(L, now, next.sids),
      before, after, sids: next.sids,
      ppw: { reg: per(after.reg - before.reg, before.nReg), po: per(after.po - before.po, before.nPo),
        all: per(after.total - before.total, L.weeks.length) || 0 },
      bySlot: bySlot(L, bE, aE),
    };
  });
  return { sides, note: L.format === 'Keeper' ? KEEPER_NOTE : L.format === 'Dynasty' ? DYNASTY_NOTE : null };
}

// ------------------------------------------------------------ verdicts
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** How likely a trade worth `ppwAll` points a week really helps, from the
 *  measured history test (confidence.js). Nothing is claimed before it ran. */
export function verdict(ppwAll) {
  if (!CONF.measured) return { label: null, prob: null };
  const prob = 1 / (1 + Math.exp(-CONF.k * ppwAll));
  return { label: prob >= 0.6 ? 'helps' : prob <= 0.4 ? 'hurts' : 'tossup', prob };
}

// ---------------------------------------------------------- team needs
const NO_FILL = { waiver: false };          // needs are there to show the holes
const rankOf = (vals, mine, higherIsBetter = true) =>
  1 + vals.filter((v) => (higherIsBetter ? v > mine + 1e-9 : v < mine - 1e-9)).length;

/** What the team at `rid` needs, compared with every other team in the league. */
export function teamNeeds(L, rid) {
  if (!L.weeks.length) {
    return { weak: [], depth: [], byes: [], surplus: [], lines: ['The fantasy season is over — nothing left to plan for.'] };
  }
  const teams = [...L.teams.values()];
  const n = teams.length;
  const base = new Map(teams.map((t) => [t.roster_id, L.value(L.lineupSids(t), 'exp', NO_FILL)]));
  const me = L.teams.get(rid);
  const mine = base.get(rid);
  const W = L.weeks.length || 1;
  const third = Math.ceil(n / 3);

  // Weak spots: starting slots in the league's bottom third, worst first.
  const weak = [];
  L.slots.forEach((s, i) => {
    const r = rankOf(teams.map((t) => base.get(t.roster_id).slotAvg[i]), mine.slotAvg[i]);
    if (r > n - third) weak.push({ slot: s, label: SLOT_GROUP[s] === 'FLEX' ? s.replace('_', ' ') : s, rank: r, of: n, ppw: mine.slotAvg[i] });
  });
  weak.sort((a, b) => b.rank - a.rank);
  const seen = new Set();
  const weakU = weak.filter((w) => (seen.has(w.label) ? false : seen.add(w.label)));

  // Depth: points a week lost if the top player at a position missed the rest
  // of the season. Skill positions only: nobody keeps a backup kicker or
  // defence, the waiver wire is the backup.
  const lossFor = (t) => {
    const out = {};
    const sids = L.lineupSids(t);
    const v0 = base.get(t.roster_id).total;
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      const top = sids.map(L.player).filter((p) => p.modelled && p.pos === pos).sort((a, b) => b.season - a.season)[0];
      if (top) out[pos] = (v0 - L.value(sids.filter((s) => s !== top.sid), 'exp', NO_FILL).total) / W;
    }
    return out;
  };
  const losses = new Map(teams.map((t) => [t.roster_id, lossFor(t)]));
  const depth = [];
  for (const [pos, loss] of Object.entries(losses.get(rid))) {
    const all = teams.map((t) => losses.get(t.roster_id)[pos]).filter((x) => x != null);
    const r = rankOf(all, loss, false);   // rank 1 = smallest loss
    if (r > all.length - Math.ceil(all.length / 3) && loss > 1) depth.push({ pos, loss, rank: r, of: all.length });
  }
  depth.sort((a, b) => b.loss - a.loss);

  // Bye-week (and injury) holes: a starting spot nobody on the roster can
  // fill that week, or a week well below the team's own average. (IDP spots
  // aren't valued yet, so they would always read as empty.)
  const IDP_SLOTS = new Set(['DL', 'LB', 'DB', 'IDP_FLEX']);
  const byes = [];
  const avg = mine.total / W;
  L.weeks.forEach((w, j) => {
    const empty = [...new Set((mine.empty[j] || []).filter((s) => !IDP_SLOTS.has(s)))];
    if (empty.length) byes.push({ week: w, drop: avg - mine.weekly[j], empty });
    else if (avg > 0 && mine.weekly[j] < 0.85 * avg) byes.push({ week: w, drop: avg - mine.weekly[j], empty: [] });
  });

  // Surplus: bench players who would start for at least half the league at
  // their position, i.e. beat that team's last starter there.
  const lastStarter = {};
  for (const pos of POS_ORDER) {
    const idx = L.slots.map((s, i) => [s, i]).filter(([s]) => s === pos).map(([, i]) => i);
    if (idx.length) lastStarter[pos] = teams.map((t) => base.get(t.roster_id).slotAvg[idx[idx.length - 1]]);
  }
  const sids = L.lineupSids(me);
  const starters = new Set(sids.filter((s) => mine.total - L.value(sids.filter((x) => x !== s), 'exp', NO_FILL).total > 0.5));
  const surplusBy = {};
  for (const s of sids) {
    const p = L.player(s);
    if (!p.modelled || starters.has(s) || !lastStarter[p.pos]) continue;
    const ppw = p.season / W;
    if (lastStarter[p.pos].filter((v) => v <= ppw).length >= n / 2) {
      (surplusBy[p.pos] = surplusBy[p.pos] || []).push({ sid: s, name: p.name, ppw });
    }
  }
  const surplus = Object.entries(surplusBy).map(([pos, players]) => ({ pos, players }));

  const lines = [];
  for (const w of weakU.slice(0, 2)) lines.push(`Your ${w.label} ranks ${w.rank} of ${w.of} — the spot to upgrade.`);
  for (const d of depth.slice(0, 2)) lines.push(`Losing your top ${d.pos} would cost ${d.loss.toFixed(1)} pts a week — thin behind him.`);
  for (const b of byes.slice(0, 2)) {
    lines.push(b.empty.length
      ? `Week ${b.week}: no one to start at ${b.empty.map((s) => SLOT_LABEL[s] || s).join(' and ')} — pick someone up or trade for cover.`
      : `Week ${b.week}: your lineup drops ${b.drop.toFixed(1)} pts below your average.`);
  }
  for (const s of surplus) lines.push(`Spare ${s.pos}: ${s.players.map((p) => p.name).join(', ')} would start for most teams — trade from here.`);
  if (!lines.length) lines.push('No glaring holes: every starting spot is in the top two-thirds of the league.');
  return { weak: weakU, depth, byes, surplus, lines };
}

// ----------------------------------------------------------- suggestions
const CAND = 8, PAIR_CAND = 5, SCREEN_MIN = 0.25, SHORTLIST = 40, FINAL = 12;

// Fewer candidates per team in big leagues, so every opponent gets screened
// inside the time budget rather than the last few silently skipped.
const candCount = (nTeams) => (nTeams > 20 ? 5 : nTeams > 14 ? 6 : CAND);

function candidates(L, t, n = CAND) {
  return L.lineupSids(t).map(L.player)
    .filter((p) => p.modelled && p.pos !== 'K' && p.pos !== 'DEF' && p.season > 0)
    .sort((a, b) => b.season - a.season).slice(0, n).map((p) => p.sid);
}
const pairs = (xs) => {
  const o = [];
  for (let i = 0; i < xs.length; i++) for (let k = i + 1; k < xs.length; k++) o.push([xs[i], xs[k]]);
  return o;
};

/**
 * Up to `max` trades that help both teams, one per opponent, no player twice.
 * Screens 1-for-1, 2-for-1 and 2-for-2 deals cheaply, re-grades the best with
 * availability scenarios, keeps those both sides would "likely" gain from,
 * and -- given `odds(sendA, sendB, otherRid) -> {me, them}` -- only those that
 * raise both teams' title odds.
 */
export function suggestTrades(L, rid, { budgetMs = 2500, max = 3, odds = null, stats = null } = {}) {
  if (!CONF.measured || !L.weeks.length) return [];
  const t0 = Date.now();
  const over = (share) => Date.now() - t0 > budgetMs * share;
  const nCand = candCount(L.teams.size);
  const nPair = Math.min(PAIR_CAND, nCand);
  const me = L.teams.get(rid);
  const mine = candidates(L, me, nCand);
  const pool = [];
  const others = [...L.teams.values()].filter((t) => t.roster_id !== rid);
  let searched = 0;
  for (const other of others) {
    if (over(0.5)) break;
    searched += 1;
    const theirs = candidates(L, other, nCand);
    const offers = [];
    for (const a of mine) for (const b of theirs) offers.push([[a], [b]]);
    for (const pa of pairs(mine.slice(0, nPair))) for (const b of theirs) offers.push([pa, [b]]);
    for (const a of mine) for (const pb of pairs(theirs.slice(0, nPair))) offers.push([[a], pb]);
    for (const pa of pairs(mine.slice(0, nPair))) for (const pb of pairs(theirs.slice(0, nPair))) offers.push([pa, pb]);
    for (const [sa, sb] of offers) {
      const g = gradeTrade(L, rid, other.roster_id, sa, sb, 'exp');
      const ga = g.sides[0].ppw.all, gb = g.sides[1].ppw.all;
      if (ga >= SCREEN_MIN && gb >= SCREEN_MIN) pool.push({ with: other.roster_id, sendA: sa, sendB: sb, score: Math.min(ga, gb) });
    }
  }
  if (stats) Object.assign(stats, { searched, of: others.length });
  pool.sort((a, b) => b.score - a.score);
  const graded = [];
  for (const c of pool.slice(0, SHORTLIST)) {
    if (over(0.75)) break;
    // Both sides must gain from the trade itself: a gain that only comes from
    // the free agent picked up into the opened roster spot was there anyway.
    // Graded with injury scenarios, so the bench depth a 2-for-1 gives up is
    // counted (the average-based grade misses it).
    const strict = gradeTrade(L, rid, c.with, c.sendA, c.sendB, 'scen', { noMoves: true });
    if (strict.sides[0].ppw.all <= 0 || strict.sides[1].ppw.all <= 0) continue;
    const g = gradeTrade(L, rid, c.with, c.sendA, c.sendB, 'scen');
    if (verdict(g.sides[0].ppw.all).label === 'helps' && verdict(g.sides[1].ppw.all).label === 'helps') {
      graded.push({ ...c, grade: g, score: Math.min(g.sides[0].ppw.all, g.sides[1].ppw.all) });
    }
  }
  graded.sort((a, b) => b.score - a.score);
  let final = graded.slice(0, FINAL);
  if (odds) {
    // The odds check is the slow part: stop when the budget is spent and keep
    // what has been checked.
    const checked = [];
    for (const c of final) {
      if (over(1.0)) break;
      checked.push({ ...c, odds: odds(c.sendA, c.sendB, c.with) });
    }
    final = checked.filter((c) => c.odds.me > 0 && c.odds.them > 0)
      .sort((a, b) => Math.min(b.odds.me, b.odds.them) - Math.min(a.odds.me, a.odds.them));
  }
  const out = [], usedTeams = new Set(), usedPlayers = new Set();
  for (const c of final) {
    if (usedTeams.has(c.with) || [...c.sendA, ...c.sendB].some((s) => usedPlayers.has(s))) continue;
    usedTeams.add(c.with);
    [...c.sendA, ...c.sendB].forEach((s) => usedPlayers.add(s));
    c.team = L.teams.get(c.with).name;
    c.reason = `${describe(c.grade.sides[0].bySlot, 'You')}; ${describe(c.grade.sides[1].bySlot, 'they')}.`;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** "You gain at WR (+3.1), give up RB (-1.2)" from a side's per-slot changes. */
function describe(bySlot, who) {
  const moves = Object.entries(bySlot).filter(([, v]) => Math.abs(v) >= 0.3).sort((a, b) => b[1] - a[1]);
  const fmt = ([g, v]) => `${g} (${v > 0 ? '+' : ''}${v.toFixed(1)})`;
  const up = moves.filter(([, v]) => v > 0).slice(0, 2).map(fmt);
  const down = moves.filter(([, v]) => v < 0).slice(-2).map(fmt);
  if (!up.length) return `${who} come out ahead across the lineup`;
  return `${who} gain at ${up.join(' and ')}${down.length ? `, give up ${down.join(' and ')}` : ''}`;
}
