// The rest of the season, played 10,000 times: playoff, bye and title odds
// from each team's best lineups and the league's real schedule.

import { CONF } from './confidence.js';

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** Each team's expected best-lineup score per remaining week. `overrides`
 *  swaps in a roster (e.g. after a trade): Map(rosterId -> sleeper ids). */
export function teamWeekly(L, overrides = new Map()) {
  const out = new Map();
  for (const [rid, t] of L.teams) out.set(rid, L.value(overrides.get(rid) || L.lineupSids(t), 'scen').weekly);
  return out;
}

export function powerRankings(L, weekly) {
  return [...L.teams.values()].map((t) => {
    const w = weekly.get(t.roster_id);
    const ppw = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
    return { roster_id: t.roster_id, team: t.name, ppw, record: t.record };
  }).sort((a, b) => b.ppw - a.ppw);
}

/**
 * Single-elimination playoffs over `seeds` (best first). Top seeds get byes
 * when the field isn't a power of two. Fixed bracket: slot k meets slot
 * size-1-k and winners keep their slot; with `reseed`, survivors are re-sorted
 * by seed each round so the best left meets the worst left.
 * play(a, b, round) -> winner. Returns {champion, rounds: [[a, b], ...] per round}.
 */
export function playBracket(seeds, reseed, play) {
  const n = seeds.length;
  const nRounds = n > 1 ? Math.ceil(Math.log2(n)) : 0;
  const size = 2 ** nRounds;
  const rank = new Map(seeds.map((s, k) => [s, k]));
  let alive = Array.from({ length: size }, (_, k) => (k < n ? seeds[k] : null));
  const rounds = [];
  for (let r = 0; r < nRounds; r++) {
    if (reseed && r > 0) alive = alive.filter((x) => x !== null).sort((a, b) => rank.get(a) - rank.get(b));
    const games = [], next = [];
    for (let k = 0; k < alive.length / 2; k++) {
      const a = alive[k], b = alive[alive.length - 1 - k];
      if (a === null) { next.push(b); continue; }
      if (b === null) { next.push(a); continue; }
      games.push([a, b]);
      next.push(play(a, b, r));
    }
    rounds.push(games);
    alive = next;
  }
  return { champion: n ? alive[0] : null, rounds };
}

/** Regular-season weeks still to be decided. The week in progress counts
 *  even after its first kickoff: records only include it once it is final. */
function regularWeeksLeft(L, schedule = null) {
  const ws = L.weeks.filter((w) => w <= L.regularEnd);
  const cur = L.rosWeek;
  if (cur && cur <= L.regularEnd && !ws.includes(cur)) ws.unshift(cur);
  return schedule ? ws.filter((w) => (schedule[String(w)] || []).length) : ws;
}

/** True once a league's fantasy playoffs are under way (no regular season left). */
export function playoffsStarted(L) {
  const pws = Number((L.league.settings || {}).playoff_week_start || 0);
  return pws > 0 && !regularWeeksLeft(L).length;
}

/**
 * Map(rosterId -> {wins, playoff, bye, title, best_record}): expected final
 * wins and probabilities. Leagues without playoffs report best_record only.
 * schedule: {week: [[rid, rid], ...]} for the remaining regular season.
 * Null once the playoffs have started: the bracket is real by then, and
 * re-seeding it from standings would invent odds for teams already out.
 */
export function seasonOdds(L, schedule, weekly, { nSims = 10000, seed = 7, sdRatio = CONF.sd_ratio } = {}) {
  if (playoffsStarted(L)) return null;
  const st = L.league.settings || {};
  const pws = Number(st.playoff_week_start || 0);
  const rids = [...L.teams.keys()];
  const T = rids.length;
  const nPlay = pws > 0 ? Math.min(Number(st.playoff_teams || 6), T) : 0;
  const median = Number(st.league_average_match || 0) === 1;
  const ix = new Map(rids.map((r, i) => [r, i]));
  const regWeeks = regularWeeksLeft(L, schedule);
  const colOf = new Map(L.weeks.map((w, j) => [w, j]));
  const mean = rids.map((r) => weekly.get(r));
  const avg = mean.map((w) => (w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0));
  const rounds = nPlay > 1 ? Math.ceil(Math.log2(nPlay)) : 0;
  const size = 2 ** rounds;
  const byes = nPlay ? size - nPlay : 0;
  // Sleeper: playoff_round_type 1 = two-week championship, 2 = every round
  // two weeks (a round is decided on the total); playoff_seed_type 1 = re-seed.
  const rtype = Number(st.playoff_round_type || 0);
  const reseed = Number(st.playoff_seed_type || 0) === 1;
  const roundWeeks = [];
  for (let r = 0, w = pws; r < rounds; r++) {
    const len = rtype === 2 || (rtype === 1 && r === rounds - 1) ? 2 : 1;
    roundWeeks.push(Array.from({ length: len }, (_, i) => w + i));
    w += len;
  }
  const acc = rids.map(() => ({ wins: 0, playoff: 0, bye: 0, title: 0, best_record: 0, slots: new Float64Array(T) }));
  const rnd = mulberry32(seed);
  const score = (i, w) => {
    const j = colOf.get(w);
    const m = j === undefined ? avg[i] : mean[i][j];
    return m + sdRatio * m * normal(rnd);
  };

  for (let s = 0; s < nSims; s++) {
    const wins = rids.map((r) => { const rec = L.teams.get(r).record; return rec.wins + 0.5 * (rec.ties || 0); });
    const pf = rids.map((r) => L.teams.get(r).record.points_for || 0);
    for (const w of regWeeks) {
      const sc = rids.map((_, i) => score(i, w));
      for (const [a, b] of schedule[String(w)]) {
        const i = ix.get(a), k = ix.get(b);
        if (i === undefined || k === undefined) continue;
        if (sc[i] > sc[k]) wins[i] += 1;
        else if (sc[k] > sc[i]) wins[k] += 1;
        else { wins[i] += 0.5; wins[k] += 0.5; }
      }
      if (median) {
        const sorted = sc.slice().sort((x, y) => x - y);
        const med = T % 2 ? sorted[(T - 1) / 2] : (sorted[T / 2 - 1] + sorted[T / 2]) / 2;
        sc.forEach((v, i) => { if (v > med) wins[i] += 1; });
      }
      sc.forEach((v, i) => { pf[i] += v; });
    }
    const order = rids.map((_, i) => i).sort((x, y) => (wins[y] - wins[x]) || (pf[y] - pf[x]));
    order.forEach((i, k) => { acc[i].wins += wins[i]; acc[i].slots[T - 1 - k] += 1; });
    acc[order[0]].best_record += 1;
    if (!nPlay) continue;
    const seeds = order.slice(0, Math.min(nPlay, T));
    seeds.forEach((i, k) => { acc[i].playoff += 1; if (k < byes) acc[i].bye += 1; });
    const total = (i, ws) => ws.reduce((t, w) => t + score(i, w), 0);
    const { champion } = playBracket(seeds, reseed,
      (a, b, r) => (total(a, roundWeeks[r]) >= total(b, roundWeeks[r]) ? a : b));
    if (champion != null) acc[champion].title += 1;
  }
  const out = new Map();
  rids.forEach((r, i) => {
    out.set(r, { wins: acc[i].wins / nSims,
      playoff: nPlay ? acc[i].playoff / nSims : null, bye: nPlay ? acc[i].bye / nSims : null,
      title: nPlay ? acc[i].title / nSims : null, best_record: acc[i].best_record / nSims,
      slot: medianSlot(acc[i].slots, nSims) });
  });
  return out;
}

// The median of a histogram of rookie-draft slots (1 = picks first).
const medianSlot = (hist, n) => {
  let c = 0;
  for (let k = 0; k < hist.length; k++) { c += hist[k]; if (c >= n / 2) return k + 1; }
  return hist.length;
};

/**
 * A whole future season from each team's expected points a week: a random
 * schedule each time, the league's own playoff format, and one shock per
 * team per season of sd `spread` (how far off a projection that far ahead
 * usually is). Same seed, same draws: compare before/after a trade with it.
 */
export function futureOdds(L, strength, { nSims = 4000, seed = 11, sdRatio = CONF.sd_ratio, spread = 0 } = {}) {
  const st = L.league.settings || {};
  const rids = [...L.teams.keys()];
  const T = rids.length;
  const pws = Number(st.playoff_week_start || 0);
  const startWeek = Number(st.start_week || 1);
  const nReg = pws > 0 ? Math.max(1, pws - startWeek) : 18 - startWeek;
  const nPlay = pws > 0 ? Math.min(Number(st.playoff_teams || 6), T) : 0;
  const median = Number(st.league_average_match || 0) === 1;
  const rounds = nPlay > 1 ? Math.ceil(Math.log2(nPlay)) : 0;
  const rtype = Number(st.playoff_round_type || 0);
  const reseed = Number(st.playoff_seed_type || 0) === 1;
  const lens = Array.from({ length: rounds }, (_, r) => (rtype === 2 || (rtype === 1 && r === rounds - 1) ? 2 : 1));
  const m = rids.map((r) => Number(strength.get(r) || 0));
  const acc = rids.map(() => ({ wins: 0, playoff: 0, title: 0, best_record: 0 }));
  const rnd = mulberry32(seed);
  const idx = rids.map((_, i) => i);
  for (let s = 0; s < nSims; s++) {
    const lvl = m.map((x) => Math.max(0, x * (1 + spread * normal(rnd))));
    const score = (i) => lvl[i] + sdRatio * lvl[i] * normal(rnd);
    const wins = new Float64Array(T), pf = new Float64Array(T);
    for (let w = 0; w < nReg; w++) {
      for (let i = T - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      const sc = rids.map((_, i) => score(i));
      for (let k = 0; k + 1 < T; k += 2) {
        const a = idx[k], b = idx[k + 1];
        if (sc[a] > sc[b]) wins[a] += 1; else if (sc[b] > sc[a]) wins[b] += 1; else { wins[a] += 0.5; wins[b] += 0.5; }
      }
      if (median) {
        const sorted = sc.slice().sort((x, y) => x - y);
        const med = T % 2 ? sorted[(T - 1) / 2] : (sorted[T / 2 - 1] + sorted[T / 2]) / 2;
        sc.forEach((v, i) => { if (v > med) wins[i] += 1; });
      }
      sc.forEach((v, i) => { pf[i] += v; });
    }
    const order = rids.map((_, i) => i).sort((x, y) => (wins[y] - wins[x]) || (pf[y] - pf[x]));
    order.forEach((i) => { acc[i].wins += wins[i]; });
    acc[order[0]].best_record += 1;
    if (!nPlay) continue;
    const seeds = order.slice(0, nPlay);
    seeds.forEach((i) => { acc[i].playoff += 1; });
    const total = (i, len) => { let t = 0; for (let k = 0; k < len; k++) t += score(i); return t; };
    const { champion } = playBracket(seeds, reseed, (a, b, r) => (total(a, lens[r]) >= total(b, lens[r]) ? a : b));
    if (champion != null) acc[champion].title += 1;
  }
  const out = new Map();
  rids.forEach((r, i) => out.set(r, { wins: acc[i].wins / nSims, playoff: nPlay ? acc[i].playoff / nSims : null,
    title: nPlay ? acc[i].title / nSims : null, best_record: acc[i].best_record / nSims }));
  return out;
}
