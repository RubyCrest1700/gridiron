// Rest-of-season lineup value for any set of players in one league.
//
// A roster is worth what its best legal lineup scores, week by week. Averages
// hide injury risk -- a starter with a 10% chance of missing just looks 10%
// smaller and his backup earns nothing -- so 'scen' mode draws availability
// scenarios (the same draws for a player in every comparison) and builds the
// best lineup in each. 'exp' mode is the fast expected-value version used to
// screen thousands of candidate trades.

import { SLOT_ELIGIBLE, SLOT_FILL_ORDER, NOT_IN_LINEUP, FORMAT, fantasyPos, teamName, record } from './engine.js';
import { scoreRos, activeWeeks, LAST_WEEK } from './ros.js';

export const N_SCEN = 300;

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * league, rosters, users: the league in Sleeper's shape (espn.js translates ESPN).
 * ros: data/ros.json. sleeperMap: sleeper id -> [model id, name, pos, team, injury].
 */
export function makeLeague({ league, rosters, users, ros, sleeperMap, now = new Date(), nScen = N_SCEN }) {
  const weeks = activeWeeks(ros, now);
  const W = weeks.length;
  const col = weeks.map((w) => ros.weeks.indexOf(w));
  const scored = scoreRos(ros, league.scoring_settings);
  const slots = (league.roster_positions || []).filter((s) => !NOT_IN_LINEUP.has(s) && s in SLOT_ELIGIBLE);
  const fill = [];
  for (const t of SLOT_FILL_ORDER) slots.forEach((s, i) => { if (s === t) fill.push(i); });
  const st = league.settings || {};
  const pws = Number(st.playoff_week_start || 0);
  const regularEnd = pws > 0 ? pws - 1 : LAST_WEEK;
  const rosterLimit = (league.roster_positions || []).filter((s) => s !== 'IR' && s !== 'TAXI').length;
  const userBy = Object.fromEntries((users || []).map((u) => [u.user_id, u]));
  const wanted = new Set();
  for (const s of slots) for (const p of SLOT_ELIGIBLE[s]) wanted.add(p);

  const cache = new Map();
  function player(sidIn) {
    const sid = String(sidIn);
    if (cache.has(sid)) return cache.get(sid);
    const base = sleeperMap[sid] || [];
    const isDef = /^[A-Z]{2,3}$/.test(sid);
    const mid = base[0] || (isDef ? sid : null);
    const pos = fantasyPos(base[2] || (isDef ? 'DEF' : null));
    const group = pos === 'DEF' ? 'DEF' : pos === 'K' ? 'K' : 'skill';
    const e = mid ? scored[group].get(String(mid)) : null;
    const pts = new Float64Array(W), avail = new Float64Array(W);
    let season = 0, games = 0, raw = 0;
    weeks.forEach((w, j) => {
      const v = e ? e.pts[col[j]] : NaN;
      if (Number.isFinite(v)) { pts[j] = v; avail[j] = e.avail[col[j]]; season += v * avail[j]; raw += v; games += 1; }
    });
    // season: expected points left (missed games included); games: games left.
    // ppg has the missed games in it; play is a game he plays (what's shown).
    const p = { sid, mid, name: base[1] || (isDef ? sid : 'Unlisted player'), pos, team: (e && e.team) || base[3] || null,
      status: (e && e.status) || base[4] || null, modelled: !!e && wanted.has(pos),
      pts, avail, season, games, ppg: games ? season / games : 0, play: games ? raw / games : 0,
      opp: weeks.map((w, j) => (e ? e.opp[col[j]] : null)), scen: null };
    cache.set(sid, p);
    return p;
  }
  function draws(p) {
    if (p.scen) return p.scen;
    const out = new Uint8Array(W * nScen);
    for (let j = 0; j < W; j++) {
      const rnd = mulberry32(hash(`${p.sid}|${weeks[j]}`));
      for (let s = 0; s < nScen; s++) out[j * nScen + s] = rnd() < p.avail[j] ? 1 : 0;
    }
    p.scen = out;
    return out;
  }

  // Best lineup for one week: greedy over the fill order, as
  // engine.optimiseLineup does it. `ok(p)` says whether p can play.
  function best(list, valueOf, ok, slotOut, emptyOut) {
    const used = new Uint8Array(list.length);
    let total = 0;
    for (const i of fill) {
      const elig = SLOT_ELIGIBLE[slots[i]];
      let filled = false;
      for (let k = 0; k < list.length; k++) {
        if (used[k] || !elig.has(list[k].pos) || !ok(list[k])) continue;
        used[k] = 1;
        const v = valueOf(list[k]);
        total += v;
        filled = v > 0;                  // a player on bye fills nothing
        if (slotOut) slotOut[i] += v;
        break;
      }
      if (emptyOut && !filled) emptyOut.push(slots[i]);
    }
    return total;
  }

  // The best free agent at each position (by points left this season): a
  // manager whose lineup has a hole -- a traded-away kicker, a quarterback on
  // bye -- picks one up rather than leave the slot empty. Counted before and
  // after a trade alike, so a pickup the team could make anyway is no part of
  // a trade's value -- suggestions included: with the fill on both sides, a
  // gain that only came from filling a hole a pickup fills anyway is gone.
  // Off for team needs, which is there to show the holes.
  let faByPos = null;
  function waiverFill(have) {
    if (!faByPos) {
      faByPos = new Map();
      for (const sid of freeAgents(Infinity)) {
        const pos = player(sid).pos;
        if (!faByPos.has(pos)) faByPos.set(pos, []);
        faByPos.get(pos).push(sid);
      }
    }
    const out = [];
    for (const list of faByPos.values()) {
      const sid = list.find((x) => !have.has(x));
      if (sid) out.push(player(sid));
    }
    return out;
  }

  function value(sids, mode = 'scen', { waiver = true } = {}) {
    let cand = [...new Set(sids.map(String))].map(player).filter((p) => p.modelled);
    if (waiver) cand = cand.concat(waiverFill(new Set(cand.map((p) => p.sid))));
    const weekly = new Float64Array(W);
    const slotSum = mode === 'exp' ? new Float64Array(slots.length) : null;
    const empty = mode === 'exp' ? weeks.map(() => []) : null;   // slot types nobody can fill, per week
    for (let j = 0; j < W; j++) {
      if (mode === 'exp') {
        const list = cand.slice().sort((a, b) => b.pts[j] * b.avail[j] - a.pts[j] * a.avail[j]);
        weekly[j] = best(list, (p) => p.pts[j] * p.avail[j], () => true, slotSum, empty[j]);
      } else {
        const list = cand.slice().sort((a, b) => b.pts[j] - a.pts[j]);
        const d = list.map(draws);
        let idx = 0;
        const ok = (p) => d[p._k][idx] === 1;
        const val = (p) => p.pts[j];
        list.forEach((p, k) => { p._k = k; });   // O(1) lookup in the hot loop
        let t = 0;
        for (let s = 0; s < nScen; s++) {
          idx = j * nScen + s;
          t += best(list, val, ok, null);
        }
        weekly[j] = t / nScen;
      }
    }
    let reg = 0, po = 0, nReg = 0, nPo = 0;
    weeks.forEach((w, j) => { if (w <= regularEnd) { reg += weekly[j]; nReg++; } else { po += weekly[j]; nPo++; } });
    const out = { weekly, total: reg + po, reg, po, nReg, nPo };
    if (slotSum) { out.slotAvg = slotSum.map((x) => (W ? x / W : 0)); out.empty = empty; }
    return out;
  }

  const teams = new Map();
  for (const r of rosters || []) {
    const reserve = (r.reserve || []).map(String), taxi = (r.taxi || []).map(String);
    const off = new Set([...reserve, ...taxi]);
    teams.set(r.roster_id, { roster_id: r.roster_id, name: teamName(r, userBy),
      active: (r.players || []).map(String).filter((s) => !off.has(s)), reserve, taxi, record: record(r) });
  }
  const rostered = new Set();
  for (const t of teams.values()) for (const s of [...t.active, ...t.reserve, ...t.taxi]) rostered.add(s);
  const midToSid = new Map();
  for (const [sid, arr] of Object.entries(sleeperMap)) {
    if (arr && arr[0] && !midToSid.has(String(arr[0]))) midToSid.set(String(arr[0]), sid);
  }

  let faCache = null;
  function freeAgents(limit = 60) {
    if (!faCache) {
      const out = [];
      for (const group of ['skill', 'K', 'DEF']) {
        for (const mid of scored[group].keys()) {
          const sid = group === 'DEF' ? mid : midToSid.get(mid);
          if (!sid || rostered.has(sid)) continue;
          const p = player(sid);
          if (p.modelled && p.season > 0) out.push(p);
        }
      }
      faCache = out.sort((a, b) => b.season - a.season).map((p) => p.sid);
    }
    return faCache.slice(0, limit);
  }

  // One representative week from any candidates [{sid, pos, pts, avail}]:
  // how the dynasty layer values a future season. 'scen' draws availability
  // per candidate, keyed on `${sid}|${tag}`, so a player gets the same draws
  // in every comparison.
  const drawMemo = new Map();
  function drawsFor(key, p) {
    const k = `${key}|${p}`;
    let d = drawMemo.get(k);
    if (!d) {
      d = new Uint8Array(nScen);
      const rnd = mulberry32(hash(key));
      for (let s = 0; s < nScen; s++) d[s] = rnd() < p ? 1 : 0;
      drawMemo.set(k, d);
    }
    return d;
  }
  function weekValue(list, mode = 'exp', tag = 'w') {
    const cand = list.filter((c) => c.pts > 0 && wanted.has(c.pos));
    if (mode === 'exp') {
      const slotSum = new Float64Array(slots.length);
      const l = cand.slice().sort((a, b) => b.pts * b.avail - a.pts * a.avail);
      return { total: best(l, (c) => c.pts * c.avail, () => true, slotSum, null), slots: slotSum };
    }
    // Copies: the hot loop tags each with its index, and callers' objects
    // (memoized pick rookies) must stay untouched.
    const l = cand.map((c) => ({ ...c })).sort((a, b) => b.pts - a.pts);
    const d = l.map((c) => drawsFor(`${c.sid}|${tag}`, c.avail));
    l.forEach((c, k) => { c._k = k; });
    let idx = 0, t = 0;
    const ok = (c) => d[c._k][idx] === 1;
    for (let s = 0; s < nScen; s++) { idx = s; t += best(l, (c) => c.pts, ok, null); }
    return { total: t / nScen, slots: null };
  }

  return {
    weeks, slots, regularEnd, rosterLimit, teams, scoring: league.scoring_settings, league,
    format: FORMAT[st.type] || 'League', nScen, rosWeek: ros.week, wanted,
    player, value, freeAgents, weekValue,
    sidFor: (mid) => midToSid.get(String(mid)) || null,
    /** The free agents value() would fill in with for these players. */
    fillFor: (sids) => waiverFill(new Set(sids.map(String))),
    isRostered: (sid) => rostered.has(String(sid)),
    lineupSids: (t) => [...t.active, ...t.reserve],
    // Taxi players can't start, but they can be traded.
    tradeable: (t) => [...t.active, ...t.reserve, ...t.taxi],
    ppw: (v) => (W ? v.total / W : 0),
  };
}
