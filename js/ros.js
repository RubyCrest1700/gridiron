// Rest of season: the published per-week projections (data/ros.json, written
// by nflpred/model/ros.py) scored under one league's rules. No network.
//
// Each week's numbers are "if he plays"; `avail` is the chance he does.

import { compileScoring, leaguePoints, normCdf, FG_AVG_DIST } from './engine.js';

export const LAST_WEEK = 17;

/** Sleeper's default full-PPR settings, for screens with no league. */
export const PPR_SETTINGS = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2, rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
};

/** The weeks still to play: this week only until its first kickoff. */
export function activeWeeks(ros, now = new Date()) {
  const started = ros.first_kickoff && now >= new Date(ros.first_kickoff);
  return ros.weeks.filter((w) => w <= LAST_WEEK && !(w === ros.week && started));
}

function kickPoints(m, scoring) {
  let p = 0;
  for (const [s, w] of Object.entries(scoring.kick)) {
    if (s === 'fg_made_yds') for (const [b, d] of Object.entries(FG_AVG_DIST)) p += w * d * (m[b] || 0);
    else p += w * (m[s] || 0);
  }
  return p;
}

// Points-allowed and yards-allowed tiers, from a normal around the mean.
function tierPoints(mean, sd, tiers) {
  let p = 0;
  for (const [lo, hi, v] of tiers) {
    const prob = sd > 0 ? normCdf((hi + 0.5 - mean) / sd) - normCdf((lo - 0.5 - mean) / sd)
      : (mean >= lo && mean <= hi ? 1 : 0);
    p += v * prob;
  }
  return p;
}

function defPoints(m, sd, scoring) {
  let p = 0;
  for (const [s, w] of Object.entries(scoring.def)) p += w * (m[s] || 0);
  if (scoring.ptsTiers.length) p += tierPoints(m.pts_allowed || 0, (sd || {}).pts_allowed || 0, scoring.ptsTiers);
  if (scoring.ydsTiers.length) p += tierPoints(m.yds_allowed || 0, (sd || {}).yds_allowed || 0, scoring.ydsTiers);
  return p;
}

function scoreEntry(ros, group, e, scoring, sdIdx) {
  const n = ros.weeks.length;
  const pts = new Float64Array(n).fill(NaN);
  const avail = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const m = e.m[j];
    if (!m) continue;
    avail[j] = Number((e.a || [])[j] ?? 1);
    if (group === 'skill') {
      const summ = {};
      ros.skill_stats.forEach((s, i) => { summ[s] = { mean: m[i] }; });
      const sd = (e.sd || [])[j];
      if (sd) for (const s of Object.keys(sdIdx)) if (summ[s]) summ[s].sd = sd[sdIdx[s]];
      pts[j] = leaguePoints(summ, e.pos, scoring);
    } else if (group === 'K') {
      pts[j] = kickPoints(m, scoring);
    } else {
      pts[j] = defPoints(m, (e.sd || [])[j], scoring);
    }
  }
  return { pos: group === 'skill' ? e.pos : group, team: e.team, status: e.status || null, opp: e.opp, pts, avail };
}

const sdIndex = (ros) => Object.fromEntries((ros.sd_stats || []).map((s, i) => [s, i]));

/** {skill, K, DEF}: Map(id -> {pos, team, status, opp, pts, avail}) over
 *  ros.weeks. `pts` is NaN on a bye. */
export function scoreRos(ros, settings) {
  const scoring = compileScoring(settings);
  const sdIdx = sdIndex(ros);
  const out = { skill: new Map(), K: new Map(), DEF: new Map() };
  for (const group of ['skill', 'K', 'DEF']) {
    for (const [id, e] of Object.entries(ros[group] || {})) out[group].set(String(id), scoreEntry(ros, group, e, scoring, sdIdx));
  }
  return out;
}

/** One skill player only (player cards), or null if he isn't in the file. */
export function scoreOne(ros, id, settings) {
  const e = (ros.skill || {})[String(id)];
  return e ? scoreEntry(ros, 'skill', e, compileScoring(settings), sdIndex(ros)) : null;
}
