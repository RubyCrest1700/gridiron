// The league engine: league scoring, lineups, win chances, waivers, recaps.
//
// A line-for-line port of nflpred/fantasy.py, so a league looks the same on
// the phone as on the desktop app. mobile/tests/engine.html checks the two
// against each other on real leagues; change one, change the other.
//
// Nothing in this file touches the network. It is handed data (the week's
// bundle and whatever Sleeper returned) and computes from it.

export const SKILL = ['QB', 'RB', 'WR', 'TE'];
export const IDP_POS = ['DL', 'LB', 'DB'];
export const MODELLED_POS = [...SKILL, 'K', 'DEF', ...IDP_POS];
export const IDP_GROUP = {
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', EDGE: 'DL',
  LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB',
  CB: 'DB', S: 'DB', SAF: 'DB', FS: 'DB', SS: 'DB', DB: 'DB',
};

const set = (...a) => new Set(a);
export const SLOT_ELIGIBLE = {
  QB: set('QB'), RB: set('RB'), WR: set('WR'), TE: set('TE'), K: set('K'), DEF: set('DEF'),
  DL: set('DL'), LB: set('LB'), DB: set('DB'),
  WRRB_FLEX: set('RB', 'WR'), REC_FLEX: set('WR', 'TE'),
  FLEX: set('RB', 'WR', 'TE'), SUPER_FLEX: set('QB', 'RB', 'WR', 'TE'),
  IDP_FLEX: set('DL', 'LB', 'DB'),
};
export const SLOT_FILL_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB',
  'WRRB_FLEX', 'REC_FLEX', 'FLEX', 'SUPER_FLEX', 'IDP_FLEX'];
export const NOT_IN_LINEUP = set('BN', 'IR', 'TAXI');
export const SLOT_LABEL = { SUPER_FLEX: 'SF', WRRB_FLEX: 'W/R', REC_FLEX: 'W/T', IDP_FLEX: 'IDP' };
export const FORMAT = { 0: 'Redraft', 1: 'Keeper', 2: 'Dynasty' };
export const STICKINESS = 0.15;

const TEAM_ALIASES = {
  ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', JAC: 'JAX', JAG: 'JAX',
  LA: 'LAR', STL: 'LAR', RAM: 'LAR', SD: 'LAC', SDG: 'LAC', CHR: 'LAC',
  OAK: 'LV', LVR: 'LV', RAI: 'LV', WSH: 'WAS', WFT: 'WAS', OTI: 'TEN', TAM: 'TB',
  GNB: 'GB', KAN: 'KC', NOR: 'NO', NWE: 'NE', SFO: 'SF', CRD: 'ARI', RAV: 'BAL',
};
export function normTeam(abbr) {
  if (abbr == null) return null;
  const s = String(abbr).trim().toUpperCase();
  if (!s || ['NAN', 'NONE', 'FA', 'NA'].includes(s)) return null;
  return TEAM_ALIASES[s] || s;
}
const isAlpha = (s) => /^[A-Za-z]+$/.test(s);

// ------------------------------------------------------------------ scoring
const LINEAR_KEYS = {
  pass_yd: 'passing_yards', pass_td: 'passing_tds', pass_int: 'passing_interceptions',
  pass_att: 'attempts', pass_cmp: 'completions',
  rush_yd: 'rushing_yards', rush_td: 'rushing_tds', rush_att: 'carries',
  rec: 'receptions', rec_yd: 'receiving_yards', rec_td: 'receiving_tds',
  rec_tgt: 'targets', fum_lost: 'fumbles_lost',
};
const TWO_PT_KEYS = ['pass_2pt', 'rush_2pt', 'rec_2pt'];
const TD_50_SHARE = {
  pass_td_50p: ['passing_tds', 0.0701], rec_td_50p: ['receiving_tds', 0.0701],
  rush_td_50p: ['rushing_tds', 0.0394],
};
const POS_REC_BONUS = { bonus_rec_te: 'TE', bonus_rec_rb: 'RB', bonus_rec_wr: 'WR' };
const THRESHOLD = /^bonus_(pass|rush|rec)_yd_(\d+)$/;
const THRESHOLD_STAT = { pass: 'passing_yards', rush: 'rushing_yards', rec: 'receiving_yards' };
const KICK_KEYS = {
  fgm_0_19: ['fgm_0_19'], fgm_20_29: ['fgm_20_29'], fgm_30_39: ['fgm_30_39'],
  fgm_40_49: ['fgm_40_49'], fgm_50_59: ['fgm_50_59'], fgm_60p: ['fgm_60_'],
  fgm_50p: ['fgm_50_59', 'fgm_60_'], fgm: ['fg_made'], fgmiss: ['fg_miss'],
  xpm: ['xp_made'], xpmiss: ['xp_miss'], fgm_yds_over_30: ['fg_yds_over_30'],
  fgm_yds: ['fg_made_yds'], fga: ['fg_made', 'fg_miss'],
};
export const FG_AVG_DIST = {
  fgm_0_19: 18.5, fgm_20_29: 25.0, fgm_30_39: 34.6,
  fgm_40_49: 44.6, fgm_50_59: 53.4, fgm_60_: 61.5,
};
const DEF_KEYS = {
  sack: 'sacks', int: 'ints', fum_rec: 'fum_rec', ff: 'ff',
  def_td: 'def_td', def_st_td: 'st_td', safe: 'safety', blk_kick: 'blk_kick',
  def_st_fum_rec: 'st_fum_rec', def_st_ff: 'st_ff',
};
const ST_FALLBACK = {
  st_td: ['def_st_td', 'st_td'], st_fum_rec: ['def_st_fum_rec', 'st_fum_rec'],
  st_ff: ['def_st_ff', 'st_ff'],
};
const PTS_TIER = /^pts_allow_(\d+)(?:_(\d+)|p)?$/;
const YDS_TIER = /^yds_allow_(\d+)(?:_(\d+)|p)?$/;
const IDP_KEYS = {
  idp_tkl_solo: ['tkl_solo'], idp_tkl_ast: ['tkl_ast'],
  idp_tkl: ['tkl_solo', 'tkl_ast'], idp_tkl_loss: ['tkl_loss'],
  idp_sack: ['sack'], idp_qb_hit: ['qb_hit'], idp_int: ['int'],
  idp_pass_def: ['pass_def'], idp_ff: ['ff'], idp_fum_rec: ['fum_rec'],
  idp_def_td: ['def_td'], idp_safe: ['safe'], idp_blk_kick: ['blk_kick'],
};
const KICK_PREFIX = ['fg', 'xp'];
const DEF_PREFIX = ['pts_allow', 'yds_allow', 'def_', 'st_', 'sack', 'int', 'fum_rec', 'ff',
  'safe', 'blk_kick', 'bonus_def', 'fum_ret', 'fum_rec_td', 'tkl', 'qb_hit',
  'pass_def', 'kr_', 'pr_'];
const IDP_PREFIX = ['idp_'];
const startsAny = (k, prefixes) => prefixes.some((p) => k.startsWith(p));

function tier(key, m, val) {
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : (key.endsWith(`_${lo}`) ? lo : 1e6);
  return [lo, hi, val];
}

export function compileScoring(settings) {
  const linear = {}, td50 = {}, posRec = {}, thresholds = [];
  const kick = {}, dfn = {}, idp = {}, ptsTiers = [], ydsTiers = [], unmodelled = {};
  const st = { ...(settings || {}) };
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  const two = TWO_PT_KEYS.filter((k) => st[k]).map((k) => Number(st[k]));
  if (two.length) linear.two_pt_conversions = Math.max(...two);
  for (const [key, raw] of Object.entries(st)) {
    const val = Number(raw);
    if (raw === null || raw === '' || typeof raw === 'boolean' || !Number.isFinite(val)) continue;
    if (val === 0 || TWO_PT_KEYS.includes(key)) continue;
    let m;
    if (key in LINEAR_KEYS) linear[LINEAR_KEYS[key]] = val;
    else if (key === 'pass_inc') { add(linear, 'attempts', val); add(linear, 'completions', -val); }
    else if (key in TD_50_SHARE) { const [s, share] = TD_50_SHARE[key]; add(td50, s, val * share); }
    else if (key in POS_REC_BONUS) posRec[POS_REC_BONUS[key]] = val;
    else if ((m = THRESHOLD.exec(key))) thresholds.push([THRESHOLD_STAT[m[1]], Number(m[2]), val]);
    else if (key in KICK_KEYS) KICK_KEYS[key].forEach((s) => add(kick, s, val));
    else if (key in DEF_KEYS) add(dfn, DEF_KEYS[key], val);
    else if (key in ST_FALLBACK) {
      const [primary, stat] = ST_FALLBACK[key];
      if (!st[primary]) add(dfn, stat, val);
    } else if ((m = PTS_TIER.exec(key))) ptsTiers.push(tier(key, m, val));
    else if ((m = YDS_TIER.exec(key))) {
      const lo = parseInt(m[1], 10);
      const hi = m[2] ? parseInt(m[2], 10) - (lo === 0 ? 1 : 0) : 1e6;
      ydsTiers.push([lo, hi, val]);
    } else if (key in IDP_KEYS) IDP_KEYS[key].forEach((s) => add(idp, s, val));
    else if (key === 'fum_rec_td') continue;   // a returned recovery is already a def_td
    else unmodelled[key] = val;
  }
  return { linear, td50, posRec, thresholds, kick, def: dfn, ptsTiers, ydsTiers, idp, unmodelled };
}

// ---------------------------------------------------- distribution helpers
export const QUANTILE_GRID = [0.01, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45,
  0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99];

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t) * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** P(stat > line) from a stored summary (port of simulate.prob_over). */
export function probOver(summary, line) {
  if (!summary) return null;
  const pmf = summary.pmf;
  if (pmf && pmf.length) {
    let p = 0;
    for (let k = 0; k < pmf.length; k++) if (k > line) p += pmf[k];
    return Math.min(1, Math.max(0, p));
  }
  const qs = summary.q;
  if (!qs || !qs.length) {
    // Rest-of-season summaries carry a mean and SD only (see ros.js); the
    // weekly bundle always has quantiles, so this never runs for it.
    if (summary.sd > 0) return 1 - normCdf((line - summary.mean) / summary.sd);
    return summary.mean != null ? (summary.mean > line ? 1 : 0) : null;
  }
  const grid = QUANTILE_GRID;
  if (line < qs[0]) return 1.0;
  if (line >= qs[qs.length - 1]) return 1.0 - grid[grid.length - 1];
  let i = -1;
  for (let j = 0; j < qs.length; j++) if (qs[j] <= line) i = j;   // searchsorted right - 1
  i = Math.max(0, Math.min(i, qs.length - 1));
  const discrete = qs.every((v) => Math.abs(v - Math.round(v)) <= 1e-8 + 1e-5 * Math.abs(Math.round(v)));
  let cdf;
  if (discrete || qs[i] === line || i + 1 >= qs.length || qs[i + 1] === qs[i]) cdf = grid[i];
  else {
    const frac = (line - qs[i]) / (qs[i + 1] - qs[i]);
    cdf = grid[i] + frac * (grid[i + 1] - grid[i]);
  }
  return Math.min(1, Math.max(0, 1.0 - cdf));
}

/** numpy.quantile with linear interpolation. */
export function quantile(arr, q) {
  const s = Float64Array.from(arr).sort();
  if (!s.length) return NaN;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const round = (x, nd) => { const f = 10 ** nd; return Math.round(x * f) / f; };
const mean = (a) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return a.length ? t / a.length : 0; };

/** Expected league points for a skill player from projected means (the
 *  fallback for weeks with no stored simulations). */
export function leaguePoints(stats, position, scoring) {
  const m = (s) => Number(((stats || {})[s] || {}).mean || 0);
  let pts = 0;
  for (const [s, w] of Object.entries(scoring.linear)) pts += w * m(s);
  for (const [s, w] of Object.entries(scoring.td50)) pts += w * m(s);
  if (position in scoring.posRec) pts += scoring.posRec[position] * m('receptions');
  for (const [stat, t, val] of scoring.thresholds) {
    const summary = (stats || {})[stat];
    if (summary) pts += val * (probOver(summary, t - 0.5) || 0);
  }
  return pts;
}

// --------------------------------------------------------- simulated games
/** League points in each simulated game for one entity. ``sims`` is a
 *  decoded week (see data.js): sims.groups[group] = {ids, index, nSims, stats}. */
export function scoreEntity(sims, group, row, scoring, position) {
  const g = sims.groups[group];
  const n = g.nSims;
  const pts = new Float64Array(n);
  const arr = (s) => {
    const st = g.stats[s];
    if (!st) return null;
    const base = row * n;
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = st.data[base + k] / st.scale;
    return out;
  };
  const addW = (w, a) => { if (a) for (let k = 0; k < n; k++) pts[k] += w * a[k]; };
  const tiers = (a, ts) => {
    if (!a) {   // a missing stat reads as zeros, as in numpy's scalar fallback
      for (const [lo, hi, v] of ts) if (0 >= lo && 0 <= hi) for (let k = 0; k < n; k++) pts[k] += v;
      return;
    }
    for (const [lo, hi, v] of ts) for (let k = 0; k < n; k++) if (a[k] >= lo && a[k] <= hi) pts[k] += v;
  };
  if (group === 'skill') {
    for (const [s, w] of Object.entries(scoring.linear)) addW(w, arr(s));
    for (const [s, w] of Object.entries(scoring.td50)) addW(w, arr(s));
    if (position && position in scoring.posRec) addW(scoring.posRec[position], arr('receptions'));
    for (const [s, t, v] of scoring.thresholds) {
      const a = arr(s);
      if (a) for (let k = 0; k < n; k++) if (a[k] >= t) pts[k] += v;
    }
  } else if (group === 'K') {
    for (const [s, w] of Object.entries(scoring.kick)) {
      if (s === 'fg_made_yds') {
        for (const [b, d] of Object.entries(FG_AVG_DIST)) addW(w * d, arr(b));
      } else addW(w, arr(s));
    }
  } else if (group === 'DEF') {
    for (const [s, w] of Object.entries(scoring.def)) addW(w, arr(s));
    if (scoring.ptsTiers.length) tiers(arr('pts_allowed'), scoring.ptsTiers);
    if (scoring.ydsTiers.length) tiers(arr('yds_allowed'), scoring.ydsTiers);
  } else if (group === 'IDP') {
    for (const [s, w] of Object.entries(scoring.idp)) addW(w, arr(s));
  }
  return pts;
}

/** Scored simulations for one league and one week, computed on demand. */
export class WeekScores {
  constructor(sims, scoring, positionOf) {
    this.sims = sims;
    this.scoring = scoring;
    this.positionOf = positionOf;    // model id -> position, for per-position bonuses
    this.cache = new Map();
  }
  get available() { return !!(this.sims && Object.keys(this.sims.groups).length); }
  get(group, entity) {
    if (!entity || !this.sims || !this.sims.groups[group]) return null;
    const key = `${group}|${entity}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const row = this.sims.groups[group].index.get(String(entity));
    const out = row === undefined ? null
      : scoreEntity(this.sims, group, row, this.scoring,
        group === 'skill' ? this.positionOf(String(entity)) : null);
    this.cache.set(key, out);
    return out;
  }
  *entities() {
    if (!this.sims) return;
    for (const [group, g] of Object.entries(this.sims.groups)) {
      for (const id of g.ids) yield [group, id];
    }
  }
}

export function describeScoring(settings, scoring) {
  const s = {};
  for (const [k, v] of Object.entries(settings || {})) if (typeof v === 'number') s[k] = v;
  const out = [];
  const rec = s.rec || 0;
  out.push(rec === 1 ? 'Full PPR' : rec === 0.5 ? 'Half PPR' : rec === 0 ? 'Standard (no PPR)' : `${g(rec)} per catch`);
  if (s.pass_td) out.push(`${g(s.pass_td)}-pt pass TD`);
  if (s.pass_int) out.push(`INT ${g(s.pass_int)}`);
  for (const [pos, v] of Object.entries(scoring.posRec)) out.push(`${pos} premium +${g(v)}/catch`);
  if (Object.keys(scoring.td50).length) out.push('+1 for 50+ yd TDs');
  for (const [stat, t, val] of scoring.thresholds) out.push(`+${g(val)} at ${g(t)} ${stat.split('_')[0]} yds`);
  if (s.fum_lost) out.push(`Fumble ${g(s.fum_lost)}`);
  return out;
}
function g(x) { return String(Number(x.toPrecision(6))); }

export function unmodelledFor(slots, unmodelled) {
  const famK = slots.includes('K');
  const famD = slots.includes('DEF');
  const famI = ['DL', 'LB', 'DB', 'IDP_FLEX'].some((s) => slots.includes(s));
  const keep = [];
  for (const k of Object.keys(unmodelled)) {
    if (startsAny(k, IDP_PREFIX)) { if (famI) keep.push(k); }
    else if (startsAny(k, KICK_PREFIX)) { if (famK) keep.push(k); }
    else if (startsAny(k, DEF_PREFIX)) { if (famD) keep.push(k); }
    else keep.push(k);
  }
  return keep.sort();
}

export function fantasyPos(pos) {
  if (SKILL.includes(pos) || pos === 'K' || pos === 'DEF') return pos;
  return IDP_GROUP[pos] || pos;
}
const groupOf = (pos) => (SKILL.includes(pos) ? 'skill' : pos === 'K' ? 'K' : pos === 'DEF' ? 'DEF'
  : IDP_POS.includes(pos) ? 'IDP' : null);

// ------------------------------------------------------------------ lineups
export function optimiseLineup(current, players, unavailable, stickiness = STICKINESS) {
  const out = current.map((x) => ({ ...x }));
  const used = new Set();
  for (const x of out) {
    const p = x.player;
    if (p && (p.locked || !x.modelled)) used.add(p.sleeper_id);
  }
  const pool = players.filter((p) => p.modelled && !p.locked
    && !unavailable.has(p.sleeper_id) && !used.has(p.sleeper_id));
  const starting = new Set(current.map((x) => (x.player || {}).sleeper_id));
  const key = (p) => (p.proj || 0) + (starting.has(p.sleeper_id) ? stickiness : 0);
  pool.sort((a, b) => key(b) - key(a));
  const openIdx = out.map((x, i) => i).filter((i) => out[i].modelled && !(out[i].player && out[i].player.locked));
  const best = out.map((x) => ({ ...x }));
  for (const slotType of SLOT_FILL_ORDER) {
    for (const i of openIdx.filter((j) => best[j].slot === slotType)) {
      const k = pool.findIndex((p) => SLOT_ELIGIBLE[slotType].has(p.position));
      const pick = k >= 0 ? pool[k] : null;
      best[i] = { ...best[i], player: pick };
      if (k >= 0) pool.splice(k, 1);
    }
  }
  return keepArrangement(out, best, openIdx);
}

function keepArrangement(current, best, openIdx) {
  const sid = (x) => (x.player || {}).sleeper_id;
  const want = new Set(openIdx.map((i) => sid(best[i])).filter((s) => s !== undefined));
  const out = current.map((x) => ({ ...x }));
  const free = openIdx.filter((i) => !want.has(sid(out[i])));
  const curOpen = new Set(openIdx.map((j) => sid(out[j])));
  const incoming = openIdx.map((i) => best[i])
    .filter((b) => b.player && !curOpen.has(sid(b)))
    .map((b) => b.player)
    .sort((a, b) => (b.proj || 0) - (a.proj || 0));
  for (const i of free) out[i] = { ...out[i], player: null };
  for (const p of incoming) {
    const slot = free.find((i) => out[i].player === null && SLOT_ELIGIBLE[out[i].slot].has(p.position));
    if (slot === undefined) return best;
    out[slot] = { ...out[slot], player: p };
  }
  return out;
}

export function expectedTotal(lineup) {
  let t = 0;
  for (const x of lineup) {
    const p = x.player;
    if (!p) continue;
    t += p.locked ? Number(p.actual || 0) : Number(p.proj || 0);
  }
  return round(t, 1);
}

export function simTotal(lineup, nSims) {
  const total = new Float64Array(nSims);
  for (const x of lineup) {
    const p = x.player;
    if (!p) continue;
    if (p.locked) { const a = Number(p.actual || 0); for (let k = 0; k < nSims; k++) total[k] += a; }
    else if (p.samples) { for (let k = 0; k < nSims; k++) total[k] += p.samples[k]; }
    else { const v = Number(p.proj || 0); for (let k = 0; k < nSims; k++) total[k] += v; }
  }
  return total;
}

export function winProb(a, b) {
  let w = 0, t = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] > b[k]) w++; else if (a[k] === b[k]) t++; }
  return round((w + 0.5 * t) / a.length, 3);
}

export const band = (x) => ({ p10: round(quantile(x, 0.1), 1), p90: round(quantile(x, 0.9), 1) });

export function record(r) {
  const s = r.settings || {};
  const pf = (s.fpts || 0) + (s.fpts_decimal || 0) / 100;
  return { wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0, points_for: round(pf, 1) };
}

export function teamName(roster, users) {
  const u = users[roster.owner_id] || {};
  return (u.metadata || {}).team_name || u.display_name || `Team ${roster.roster_id}`;
}

export const owns = (roster, userId) => !!userId
  && (roster.owner_id === userId || (roster.co_owners || []).includes(userId));

const publicPlayer = (p) => { if (!p) return null; const { samples, ...rest } = p; return rest; };

// -------------------------------------------------------------- the league
/**
 * One league, seen from one team.
 *
 * week:    the decoded week bundle (players, stats, extra, sims, sleeper, kickoffs)
 * league:  { league, users, rosters, matchups } exactly as Sleeper returned them
 * rosterId: whose team to analyse
 * now:     Date (injectable for tests)
 */
export function leagueView(week, sl, rosterId, now = new Date()) {
  const lg = sl.league;
  const users = Object.fromEntries((sl.users || []).map((u) => [u.user_id, u]));
  const rosters = sl.rosters || [];
  const matchups = sl.matchups || [];
  const scoring = compileScoring(lg.scoring_settings);
  const scores = new WeekScores(week.sims, scoring, (id) => (week.players.get(id) || {}).pos);
  const nSims = week.sims ? week.sims.nSims : 1000;

  const livePts = {};
  for (const m of matchups) for (const [pid, pts] of Object.entries(m.players_points || {})) livePts[String(pid)] = pts;

  const player = (sidIn) => {
    const sid = String(sidIn);
    const base = week.sleeper[sid] || [];
    const [gidRaw, bName, bPos, bTeam, bInj] = base;
    const gid = gidRaw || null;
    const p = gid ? week.players.get(gid) : null;
    const pos = fantasyPos((p && p.pos) || bPos || (isAlpha(sid) ? 'DEF' : null));
    const team = normTeam((p && p.team) || bTeam || (isAlpha(sid) ? sid : null));
    const ko = team && week.kickoffs[team] ? week.kickoffs[team] : null;
    const koTime = ko && ko.kickoff ? new Date(ko.kickoff) : null;
    const locked = !!(koTime && now >= koTime);
    const group = groupOf(pos);
    const ex = group && group !== 'skill' ? (week.extra.get(`${group}|${gid || ''}`) || {}) : {};
    const row = {
      sleeper_id: sid, player_id: ['skill', 'K', 'IDP'].includes(group) ? gid : null,
      name: (p && p.name) || bName || (isAlpha(sid) ? `${sid} D/ST` : sid),
      position: pos, team,
      opponent: (p && p.opp) || ex.opp || (ko ? ko.opp : null),
      kickoff: ko ? ko.kickoff : null,
      status: (p && p.status) || bInj || null,
      play_prob: (p && p.play) || ex.play || null,
      img: (p && p.img) || ex.img || null,
      modelled: MODELLED_POS.includes(pos), locked,
      actual: locked ? (livePts[sid] ?? null) : null,
      proj: null, range: null, samples: null,
    };
    const smp = group ? scores.get(group, gid) : null;
    if (smp) {
      row.samples = smp;
      row.proj = round(mean(smp), 2);
      row.range = { p10: round(quantile(smp, 0.1), 1), p90: round(quantile(smp, 0.9), 1) };
    } else if (group === 'skill' && p && !scores.available) {
      row.proj = round(leaguePoints(week.stats[gid] || {}, pos, scoring), 2);
    } else if (MODELLED_POS.includes(pos)) {
      row.proj = 0.0;
    }
    return row;
  };

  const lineupSlots = (lg.roster_positions || []).filter((s) => !NOT_IN_LINEUP.has(s));
  const lineupFor = (r) => {
    const starters = (r.starters || []).map(String);
    return lineupSlots.map((slot, i) => {
      const sid = i < starters.length ? starters[i] : '0';
      return { slot, label: SLOT_LABEL[slot] || slot, modelled: slot in SLOT_ELIGIBLE,
        player: [null, 'null', '0', ''].includes(sid) ? null : player(sid) };
    });
  };

  const mine = rosters.find((r) => r.roster_id === rosterId);
  if (!mine) throw new Error('That team is not in this league.');

  const current = lineupFor(mine);
  const reserve = new Set((mine.reserve || []).map(String));
  const taxi = new Set((mine.taxi || []).map(String));
  const allPlayers = (mine.players || []).map((s) => player(s));
  const bySid = Object.fromEntries(allPlayers.map((p) => [p.sleeper_id, p]));
  for (const x of current) if (x.player && bySid[x.player.sleeper_id]) x.player = bySid[x.player.sleeper_id];
  const recommended = optimiseLineup(current, allPlayers, new Set([...reserve, ...taxi]));

  const startersNow = new Set(current.filter((x) => x.player).map((x) => x.player.sleeper_id));
  const bench = allPlayers.filter((p) => !startersNow.has(p.sleeper_id))
    .sort((a, b) => (b.proj ?? -1) - (a.proj ?? -1));
  for (const p of bench) p.where = reserve.has(p.sleeper_id) ? 'IR' : taxi.has(p.sleeper_id) ? 'Taxi' : 'Bench';

  const changes = [];
  current.forEach((cur, i) => {
    const rec = recommended[i];
    const a = cur.player, b = rec.player;
    if (rec.modelled && (a || {}).sleeper_id !== (b || {}).sleeper_id && b) {
      changes.push({ slot: rec.label, start: publicPlayer(b), bench: publicPlayer(a),
        gain: round((b.proj || 0) - ((a || {}).proj || 0), 2) });
    }
  });
  const before = new Map(current.filter((x) => x.player).map((x) => [x.player.sleeper_id, x.player]));
  const after = new Map(recommended.filter((x) => x.player).map((x) => [x.player.sleeper_id, x.player]));
  const moves = {
    start: [...after].filter(([s]) => !before.has(s)).map(([, p]) => publicPlayer(p)),
    sit: [...before].filter(([s]) => !after.has(s)).map(([, p]) => publicPlayer(p)),
    gain: round(expectedTotal(recommended) - expectedTotal(current), 1),
  };

  // ---- matchup
  let matchup = null;
  const myM = matchups.find((m) => m.roster_id === mine.roster_id);
  if (myM && myM.matchup_id != null) {
    const oppM = matchups.find((m) => m.matchup_id === myM.matchup_id && m.roster_id !== mine.roster_id);
    const oppR = oppM ? rosters.find((r) => r.roster_id === oppM.roster_id) : null;
    if (oppR) {
      const oppLineup = lineupFor(oppR);
      const myCur = simTotal(current, nSims), myBest = simTotal(recommended, nSims);
      const oppTot = simTotal(oppLineup, nSims);
      matchup = {
        team: teamName(oppR, users), roster_id: oppR.roster_id, record: record(oppR),
        lineup: oppLineup, proj_total: expectedTotal(oppLineup),
        me_current_total: expectedTotal(current), me_best_total: expectedTotal(recommended),
        win_prob_current: winProb(myCur, oppTot), win_prob_best: winProb(myBest, oppTot),
        range_current: band(myCur), range_opp: band(oppTot),
        points_so_far: { me: myM.points, opp: oppM.points },
      };
    }
  }

  // ---- waivers
  const rostered = new Set();
  for (const r of rosters) for (const k of ['players', 'reserve', 'taxi']) for (const s of r[k] || []) rostered.add(String(s));
  const rosteredIds = new Set([...rostered].map((s) => (week.sleeper[s] || [])[0]).filter(Boolean));
  const wanted = new Set();
  for (const s of new Set(lineupSlots)) for (const pos of SLOT_ELIGIBLE[s] || []) wanted.add(pos);
  let fa = [];
  for (const [group, ent] of scores.entities()) {
    if (rosteredIds.has(ent)) continue;
    let pos, name, team, opp, status, play;
    if (group === 'skill') {
      const p = week.players.get(ent) || {};
      ({ pos, name, team, opp, status, play } = p);
    } else {
      const meta = week.extra.get(`${group}|${ent}`) || {};
      pos = group !== 'IDP' ? group : meta.grp;
      ({ name, team, opp } = meta);
      status = null; play = meta.play;
      if (group === 'K' && String(ent).startsWith('K_')) continue;
    }
    if (!wanted.has(pos)) continue;
    const pts = mean(scores.get(group, ent));
    if (pts < 1.0) continue;
    fa.push({ player_id: group !== 'DEF' ? ent : null, name, position: pos, team, opponent: opp,
      status, proj: round(pts, 2), play_prob: play,
      img: group === 'skill' ? (week.players.get(ent) || {}).img : (week.extra.get(`${group}|${ent}`) || {}).img || null });
  }
  fa.sort((a, b) => b.proj - a.proj);
  const perPos = {};
  fa = fa.filter((f) => { perPos[f.position] = (perPos[f.position] || 0) + 1; return perPos[f.position] <= 15; });

  const standings = rosters.map((r) => ({ team: teamName(r, users), roster_id: r.roster_id,
    mine: r.roster_id === mine.roster_id, ...record(r) }))
    .sort((a, b) => (b.wins - a.wins) || (b.points_for - a.points_for));

  const st = lg.settings || {};
  return {
    league: {
      league_id: lg.league_id, name: lg.name, teams: lg.total_rosters,
      format: FORMAT[st.type] || 'League', season: lg.season,
      slots: lineupSlots.map((s) => SLOT_LABEL[s] || s),
      bench_size: (lg.roster_positions || []).filter((s) => s === 'BN').length,
      scoring: describeScoring(lg.scoring_settings, scoring),
      unmodelled_scoring: unmodelledFor(lineupSlots, scoring.unmodelled),
      simulated: scores.available,
    },
    me: { team: teamName(mine, users), roster_id: mine.roster_id, ...record(mine) },
    lineup: current, recommended, changes, moves, bench, matchup, waivers: fa, standings,
  };
}

/** Every matchup in the league this week, with win chances from the joint
 *  simulation (each side's lineup as set). */
export function leagueMatchups(week, sl, now = new Date()) {
  const rosters = sl.rosters || [];
  const out = [];
  const seen = new Set();
  for (const m of sl.matchups || []) {
    if (m.matchup_id == null || seen.has(m.matchup_id)) continue;
    seen.add(m.matchup_id);
    const pair = (sl.matchups || []).filter((x) => x.matchup_id === m.matchup_id);
    if (pair.length !== 2) continue;
    const [a, b] = pair.map((x) => leagueView(week, { ...sl, rosters }, x.roster_id, now));
    const nSims = week.sims ? week.sims.nSims : 1000;
    const ta = simTotal(a.lineup, nSims), tb = simTotal(b.lineup, nSims);
    out.push({
      home: { team: a.me.team, roster_id: a.me.roster_id, proj: expectedTotal(a.lineup), points: pair[0].points },
      away: { team: b.me.team, roster_id: b.me.roster_id, proj: expectedTotal(b.lineup), points: pair[1].points },
      p_home: winProb(ta, tb),
    });
  }
  return out;
}

// ------------------------------------------------------------------- recaps
/** player(sid, actual) for a finished week, graded on the projection frozen at
 *  kickoff (port of fantasy._week_players). */
function weekPlayers(wk, scoring) {
  const scores = new WeekScores(wk.sims, scoring, (id) => (wk.players.get(id) || {}).pos);
  return (sidIn, actual) => {
    const sid = String(sidIn);
    const [gidRaw, bName, bPos, bTeam] = wk.sleeper[sid] || [];
    const gid = gidRaw || null;
    const p = gid ? wk.players.get(gid) : null;
    const pos = fantasyPos((p && p.pos) || bPos || (isAlpha(sid) ? 'DEF' : null));
    const team = normTeam((p && p.team) || bTeam || (isAlpha(sid) ? sid : null));
    const group = groupOf(pos);
    const ex = group && group !== 'skill' ? (wk.extra.get(`${group}|${gid || ''}`) || {}) : {};
    const smp = group ? scores.get(group, gid) : null;
    let pr;
    if (smp) pr = round(mean(smp), 2);
    else if (group === 'skill' && p) pr = round(leaguePoints(wk.stats[gid] || {}, pos, scoring), 2);
    else if (group === 'skill') pr = 0.0;
    else pr = null;
    return { sleeper_id: sid, player_id: ['skill', 'K', 'IDP'].includes(group) ? gid : null,
      name: (p && p.name) || bName || (isAlpha(sid) ? `${sid} D/ST` : sid),
      position: pos, team, opponent: (p && p.opp) || ex.opp || null,
      img: (p && p.img) || ex.img || null,
      proj: pr, actual: actual == null ? null : round(Number(actual), 2),
      modelled: pr !== null, locked: false };
  };
}

const lineupActual = (lineup) => round(lineup.reduce((t, x) => t + Number((x.player || {}).actual || 0), 0), 2);

/** One finished week for one team (port of fantasy._recap_week). */
export function recapWeek(wk, sl, weekMatchups, rosterId) {
  const lg = sl.league;
  const users = Object.fromEntries((sl.users || []).map((u) => [u.user_id, u]));
  const mineM = weekMatchups.find((m) => m.roster_id === rosterId);
  if (!mineM || !(mineM.starters || []).length) return null;
  const opp = weekMatchups.find((m) => mineM.matchup_id != null && m.matchup_id === mineM.matchup_id
    && m.roster_id !== rosterId);
  const pts = Object.fromEntries(Object.entries(mineM.players_points || {}).map(([k, v]) => [String(k), v]));
  const scoring = compileScoring(lg.scoring_settings);
  const player = weekPlayers(wk, scoring);
  const slots = (lg.roster_positions || []).filter((s) => !NOT_IN_LINEUP.has(s));
  const starters = (mineM.starters || []).map(String);
  const roster = (mineM.players || []).map(String);
  const bySid = {};
  for (const sid of new Set([...roster, ...starters])) {
    if (['0', '', 'None', 'null'].includes(sid)) continue;
    bySid[sid] = player(sid, pts[sid] ?? 0.0);
  }
  const played = slots.map((slot, i) => {
    const sid = i < starters.length ? starters[i] : '0';
    const p = bySid[sid] || null;
    return { slot, label: SLOT_LABEL[slot] || slot,
      modelled: slot in SLOT_ELIGIBLE && (p === null || p.modelled), player: p };
  });
  const everyone = Object.values(bySid);
  const model = optimiseLineup(played, everyone, new Set());
  const hindPlayers = everyone.map((p) => ({ ...p, proj: p.actual || 0.0, modelled: true }));
  const hindBy = Object.fromEntries(hindPlayers.map((p) => [p.sleeper_id, p]));
  const hindCur = played.map((x) => ({ ...x, modelled: x.slot in SLOT_ELIGIBLE,
    player: hindBy[(x.player || {}).sleeper_id] || null }));
  const best = optimiseLineup(hindCur, hindPlayers, new Set(), 0.0);

  const swaps = [];
  played.forEach((cur, i) => {
    const a = cur.player, b = model[i].player;
    if (b && (a || {}).sleeper_id !== b.sleeper_id) {
      swaps.push({ slot: model[i].label, start: b, bench: a,
        net: round((b.actual || 0) - ((a || {}).actual || 0), 2) });
    }
  });
  const starting = new Set(played.map((x) => (x.player || {}).sleeper_id));
  const bench = everyone.filter((p) => !starting.has(p.sleeper_id)).sort((a, b) => (b.actual || 0) - (a.actual || 0));
  const projTotal = round(played.reduce((t, x) => t + Number((x.player || {}).proj || 0), 0), 2);
  const partial = played.some((x) => x.player && !x.player.modelled);
  const myPts = mineM.points, oppPts = opp ? opp.points : null;
  const oppRoster = opp ? (sl.rosters || []).find((r) => r.roster_id === opp.roster_id) : null;
  return {
    opponent: oppRoster ? teamName(oppRoster, users) : null,
    points: myPts, opp_points: oppPts,
    result: oppPts == null || myPts == null ? null : myPts > oppPts ? 'W' : myPts < oppPts ? 'L' : 'T',
    projected: projTotal, projected_partial: partial,
    optimal: lineupActual(best), model: lineupActual(model),
    lineup: played, swaps, bench,
  };
}

// --------------------------------------------------------------- start/sit
export const PPR_SCORING = {
  passing_yards: 0.04, passing_tds: 4.0, passing_interceptions: -2.0,
  rushing_yards: 0.1, rushing_tds: 6.0, receiving_yards: 0.1, receiving_tds: 6.0,
  receptions: 1.0, fumbles_lost: -2.0, two_pt_conversions: 2.0,
};

/** Joint start/sit odds from the stored simulations (port of /api/compare),
 *  in PPR or, given a compiled league scoring, in that league's points. */
export function compare(sims, ids, scoring = null, positionOf = () => null) {
  const g = sims && sims.groups.skill;
  if (!g || ids.length < 2) return { available: false };
  const rows = ids.map((i) => g.index.get(String(i)));
  if (rows.some((r) => r === undefined)) return { available: false };
  const n = g.nSims;
  const sc = scoring || { linear: PPR_SCORING, td50: {}, posRec: {}, thresholds: [] };
  const pts = rows.map((r, k) => scoreEntity(sims, 'skill', r, sc, positionOf(ids[k])));
  const wins = new Float64Array(ids.length);
  for (let s = 0; s < n; s++) {
    let mx = -Infinity;
    for (const p of pts) if (p[s] > mx) mx = p[s];
    const top = pts.map((p, k) => (p[s] === mx ? k : -1)).filter((k) => k >= 0);
    for (const k of top) wins[k] += 1 / (top.length > 1 ? ids.length : 1);
  }
  let corr = null;
  if (ids.length === 2) {
    const [a, b] = pts; const ma = mean(a), mb = mean(b);
    let sab = 0, saa = 0, sbb = 0;
    for (let s = 0; s < n; s++) { sab += (a[s] - ma) * (b[s] - mb); saa += (a[s] - ma) ** 2; sbb += (b[s] - mb) ** 2; }
    corr = saa && sbb ? round(sab / Math.sqrt(saa * sbb), 3) : null;
  }
  return { available: true, ids, p_best: [...wins].map((w) => round(w / n, 4)), n, corr,
    mean: pts.map((p) => round(mean(p), 2)),
    range: pts.map((p) => ({ p10: round(quantile(p, 0.1), 1), p90: round(quantile(p, 0.9), 1) })),
    samples: pts };
}

/** One player's points in each simulated game (PPR unless a league scoring is
 *  given), or null when he is not in the week's simulations. */
export function playerSamples(sims, id, scoring = null, position = null) {
  const g = sims && sims.groups.skill;
  const row = g ? g.index.get(String(id)) : undefined;
  if (row === undefined) return null;
  const sc = scoring || { linear: PPR_SCORING, td50: {}, posRec: {}, thresholds: [] };
  return scoreEntity(sims, 'skill', row, sc, position);
}
