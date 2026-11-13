// The only door to ESPN fantasy leagues, and it only reads.
//
// Public ESPN leagues ("Make League Viewable to Public" in the league's basic
// settings) can be read by anyone with the league ID, so this needs no login,
// sends no cookies (credentials: 'omit'), and makes GET requests to one host on
// one path, with a whitelist of query parameters. Nothing here -- or anywhere in
// this app -- can change a league. tests/test_mobile_readonly.py pins all of it.
//
// ESPN leagues are translated into the shape Sleeper returns (league, users,
// rosters, matchups), so the engine and every screen work on them unchanged.
// Players are matched to the app's Sleeper-keyed player list by name, position
// and team; D/ST by team.

const HOST = 'https://lm-api-reads.fantasy.espn.com';
const PATH = /^\/apis\/v3\/games\/ffl\/seasons\/\d{4}\/segments\/0\/leagues\/\d{1,12}$/;
const VIEWS = new Set(['mSettings', 'mTeam', 'mRoster', 'mMatchup', 'mMatchupScore']);

export const PREFIX = 'espn:';
export const isEspn = (id) => String(id || '').startsWith(PREFIX);
const bare = (id) => String(id).slice(PREFIX.length);

// Seconds, as for Sleeper: settings barely change; a week's rosters and live
// points do; a finished week never does.
const TTL = { settings: 3600, week: 120, pastWeek: 86400 * 30 };

export class ReadOnlyViolation extends Error {}
export class PrivateLeague extends Error {}

/** Is this exact URL one the app may read? */
export function allowed(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.origin !== HOST || !PATH.test(u.pathname)) return false;
  for (const [k, v] of u.searchParams) {
    if (k === 'view' && VIEWS.has(v)) continue;
    if (k === 'scoringPeriodId' && /^\d{1,2}$/.test(v)) continue;
    return false;
  }
  return true;
}

const memo = new Map();
function stored(key) {
  try {
    const v = JSON.parse(localStorage.getItem(`es:${key}`) || 'null');
    return v && typeof v.at === 'number' ? v : null;
  } catch (_) { return null; }
}
function keep(key, data) {
  try { localStorage.setItem(`es:${key}`, JSON.stringify({ at: Date.now(), data })); } catch (_) { /* full or blocked */ }
}

async function get(url, ttl, { force = false } = {}) {
  if (!allowed(url)) throw new ReadOnlyViolation(`not an allowed read: ${url}`);
  const now = Date.now();
  const m = memo.get(url);
  if (!force && m && now - m.at < ttl * 1000) return m.data;
  const s = stored(url);
  if (!force && s && now - s.at < ttl * 1000) { memo.set(url, s); return s.data; }
  try {
    const r = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store' });
    if (r.status === 401 || r.status === 403) {
      throw new PrivateLeague('This ESPN league is private. Its commissioner can open it to the app: on espn.com, '
        + 'LM Tools → League Settings → Basic Settings → “Make League Viewable to Public” → Yes. '
        + 'That only lets people look; nobody can change anything.');
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`ESPN returned ${r.status}`);
    const data = await r.json();
    memo.set(url, { at: now, data });
    keep(url, data);
    return data;
  } catch (err) {
    if (s && !(err instanceof PrivateLeague)) return s.data;
    throw err;
  }
}

function leagueUrl(id, season, views, week) {
  const q = new URLSearchParams();
  if (week) q.append('scoringPeriodId', String(Number(week)));
  for (const v of views) q.append('view', v);
  return `${HOST}/apis/v3/games/ffl/seasons/${Number(season)}/segments/0/leagues/${bare(id)}?${q}`;
}

/** An ESPN league ID from whatever was pasted: a fantasy.espn.com link, or a
 *  short number (ESPN IDs are up to ~10 digits; Sleeper's are 18-19). */
export function parseLeagueId(text) {
  const s = String(text || '').trim();
  const link = s.match(/espn\.com\S*[?&]leagueId=(\d{1,12})/i);
  if (link) return PREFIX + link[1];
  const plain = s.match(/^(?:espn[\s:#-]*)?(\d{4,12})$/i);
  return plain ? PREFIX + plain[1] : null;
}

// ------------------------------------------------------------- translation
const PRO_TEAM = { 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB',
  10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG',
  20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU' };
// A player's own position (defaultPositionId), as the app's fantasy positions.
const PLAYER_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 7: 'P', 9: 'DL', 10: 'DL', 11: 'LB',
  12: 'DB', 13: 'DB', 16: 'DEF' };
// Lineup slots, as Sleeper names them, in the order a lineup is laid out.
const SLOT = { 0: 'QB', 1: 'QB', 2: 'RB', 3: 'WRRB_FLEX', 4: 'WR', 5: 'REC_FLEX', 6: 'TE', 7: 'SUPER_FLEX',
  8: 'DL', 9: 'DL', 10: 'LB', 11: 'DL', 12: 'DB', 13: 'DB', 14: 'DB', 15: 'IDP_FLEX', 16: 'DEF', 17: 'K',
  18: 'P', 19: 'HC', 20: 'BN', 21: 'IR', 23: 'FLEX', 24: 'ER', 25: 'ROOKIE' };
const SLOT_ORDER = [0, 1, 2, 4, 6, 3, 5, 23, 7, 16, 17, 8, 9, 11, 10, 12, 13, 14, 15, 18, 19, 24, 25, 20, 21];
const BENCH = new Set([20, 21]);
const DST_SLOT = '16';

// ESPN stat ID -> Sleeper scoring key. Where two ESPN stats score the same
// thing (receptions 41/53; the defensive TD kinds), the larger value is kept
// rather than summed, so a touchdown is never counted twice.
const PLAYER_STAT = {
  0: 'pass_att', 1: 'pass_cmp', 2: 'pass_inc', 3: 'pass_yd', 4: 'pass_td', 16: 'pass_td_50p',
  19: 'pass_2pt', 20: 'pass_int', 23: 'rush_att', 24: 'rush_yd', 25: 'rush_td', 26: 'rush_2pt',
  36: 'rush_td_50p', 41: 'rec', 53: 'rec', 42: 'rec_yd', 43: 'rec_td', 44: 'rec_2pt', 46: 'rec_td_50p',
  58: 'rec_tgt', 72: 'fum_lost',
  74: 'fgm_50p', 77: 'fgm_40_49', 80: ['fgm_0_19', 'fgm_20_29', 'fgm_30_39'], 83: 'fgm', 85: 'fgmiss',
  86: 'xpm', 88: 'xpmiss', 198: 'fgm_50_59', 201: 'fgm_60p',
  // individual defenders
  107: 'idp_tkl_ast', 108: 'idp_tkl_solo', 109: 'idp_tkl', 113: 'idp_pass_def', 106: 'idp_ff',
  99: 'idp_sack', 95: 'idp_int', 96: 'idp_fum_rec', 97: 'idp_blk_kick', 98: 'idp_safe',
  94: 'idp_def_td', 103: 'idp_def_td', 104: 'idp_def_td',
};
// Yardage bonuses: ESPN pays a band (300-399, then 400+); Sleeper pays every
// threshold reached, so the upper bonus becomes the difference.
const BANDS = [[17, 18, 'bonus_pass_yd_300', 'bonus_pass_yd_400'],
  [37, 38, 'bonus_rush_yd_100', 'bonus_rush_yd_200'],
  [56, 57, 'bonus_rec_yd_100', 'bonus_rec_yd_200']];
const DST_STAT = {
  99: 'sack', 95: 'int', 96: 'fum_rec', 97: 'blk_kick', 98: 'safe', 106: 'ff',
  93: 'def_td', 94: 'def_td', 103: 'def_td', 104: 'def_td', 105: 'def_td', 101: 'def_st_td', 102: 'def_st_td',
  89: 'pts_allow_0', 90: 'pts_allow_1_6', 91: 'pts_allow_7_13', 92: 'pts_allow_14_17', 121: 'pts_allow_18_21',
  122: 'pts_allow_22_27', 123: 'pts_allow_28_34', 124: 'pts_allow_35_45', 125: 'pts_allow_46p',
  128: 'yds_allow_0_100', 129: 'yds_allow_100_199', 130: 'yds_allow_200_299', 131: 'yds_allow_300_349',
  132: 'yds_allow_350_399', 133: 'yds_allow_400_449', 134: 'yds_allow_450_499', 135: 'yds_allow_500_549',
  136: 'yds_allow_550p',
};
const REC_PREMIUM_SLOT = { 2: 'bonus_rec_rb', 4: 'bonus_rec_wr', 6: 'bonus_rec_te' };
// Stats with no counterpart here, named so the league screen can list them.
const OTHER = { 15: 'pass_td_40p', 35: 'rush_td_40p', 45: 'rec_td_40p', 62: 'two_pt', 63: 'fum_rec_td_offense',
  68: 'fum', 64: 'sacked', 120: 'pts_allowed_each', 127: 'yds_allowed_each', 114: 'kr_yd', 115: 'pr_yd',
  205: 'def_2pt_return', 206: 'def_2pt_return' };

/** ESPN scoringItems -> a Sleeper-style scoring_settings object. */
export function scoringSettings(items) {
  const out = {};
  const put = (k, v) => { if (v && Number.isFinite(v)) out[k] = Math.abs(v) > Math.abs(out[k] || 0) ? v : out[k]; };
  const byId = new Map((items || []).map((i) => [Number(i.statId), i]));
  for (const it of items || []) {
    const id = Number(it.statId);
    const base = Number(it.points || 0);
    const ov = it.pointsOverrides || {};
    if (id in DST_STAT) put(DST_STAT[id], DST_SLOT in ov ? Number(ov[DST_SLOT]) : base);
    if (id in PLAYER_STAT) {
      const k = PLAYER_STAT[id];
      for (const key of Array.isArray(k) ? k : [k]) put(key, base);
      if (id === 53 || id === 41) {
        for (const [slot, key] of Object.entries(REC_PREMIUM_SLOT)) if (slot in ov) put(key, Number(ov[slot]) - base);
      }
    } else if (!(id in DST_STAT) && !BANDS.some((b) => b[0] === id || b[1] === id) && base) {
      out[OTHER[id] || `espn_stat_${id}`] = base;
    }
  }
  for (const [lo, hi, kLo, kHi] of BANDS) {
    const a = byId.has(lo) ? Number(byId.get(lo).points || 0) : 0;
    const b = byId.has(hi) ? Number(byId.get(hi).points || 0) : 0;
    if (a) out[kLo] = a;
    if (b - a) out[kHi] = b - a;
  }
  return out;
}

/** Lineup slots as a Sleeper roster_positions list, plus the ESPN slot id of each. */
function rosterPositions(counts) {
  const names = [], ids = [];
  for (const id of SLOT_ORDER) {
    for (let k = 0; k < Number((counts || {})[id] || 0); k++) { names.push(SLOT[id]); ids.push(id); }
  }
  return { names, ids };
}

// ------------------------------------------------------------ player match
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
export function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[.'’`]/g, '').replace(/-/g, ' ').split(/\s+/).filter((w) => w && !SUFFIX.has(w)).join(' ');
}

const indexCache = new WeakMap();
function nameIndex(sleeperMap) {
  if (indexCache.has(sleeperMap)) return indexCache.get(sleeperMap);
  const idx = new Map();
  for (const [sid, v] of Object.entries(sleeperMap || {})) {
    const [, name, pos, team] = v;
    if (!name || pos === 'DEF') continue;
    const key = `${normName(name)}|${pos}`;
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push([sid, team]);
  }
  indexCache.set(sleeperMap, idx);
  return idx;
}

// Players with no match get a stand-in id, named so the screens still show them.
const extra = {};

/** The Sleeper id for an ESPN player (or a stand-in). */
export function sleeperId(p, sleeperMap) {
  const pos = PLAYER_POS[p.defaultPositionId] || null;
  const team = PRO_TEAM[p.proTeamId] || null;
  if (pos === 'DEF' || Number(p.id) < 0) return team || `${PREFIX}${p.id}`;
  const hits = nameIndex(sleeperMap).get(`${normName(p.fullName)}|${pos}`) || [];
  const pick = hits.find(([, t]) => t && t === team) || (hits.length === 1 ? hits[0] : null);
  if (pick) return pick[0];
  const sid = `${PREFIX}${p.id}`;
  extra[sid] = [null, p.fullName || sid, pos, team, injury(p.injuryStatus)];
  return sid;
}
const injury = (s) => (!s || s === 'ACTIVE' || s === 'NORMAL' ? null
  : ({ QUESTIONABLE: 'Questionable', DOUBTFUL: 'Doubtful', OUT: 'Out', INJURY_RESERVE: 'IR', SUSPENSION: 'Sus' }[s] || s));

/** A week bundle whose player list also knows the ESPN stand-ins. */
const augmented = new WeakMap();
export function withPlayers(week) {
  if (!Object.keys(extra).length) return week;
  const cached = augmented.get(week);
  if (cached && cached.n === Object.keys(extra).length) return cached.week;
  const w = { ...week, sleeper: { ...week.sleeper, ...extra } };
  augmented.set(week, { n: Object.keys(extra).length, week: w });
  return w;
}

// ------------------------------------------------------------ the league
function teamName(t) {
  return t.name || [t.location, t.nickname].filter(Boolean).join(' ') || t.abbrev || `Team ${t.id}`;
}

function toLeague(d, id) {
  const s = d.settings || {};
  const { names } = rosterPositions((s.rosterSettings || {}).lineupSlotCounts);
  // Playoffs start the week after the last regular-season matchup period.
  const ss = s.scheduleSettings || {};
  const lastReg = Number(ss.matchupPeriodCount || 0);
  const regWeeks = Object.entries(ss.matchupPeriods || {})
    .filter(([p]) => Number(p) <= lastReg).flatMap(([, w]) => (w || []).map(Number));
  return {
    league_id: id, source: 'espn', name: s.name || `ESPN league ${bare(id)}`,
    total_rosters: s.size || (d.teams || []).length, season: String(d.seasonId || ''),
    roster_positions: names,
    scoring_settings: scoringSettings((s.scoringSettings || {}).scoringItems),
    settings: { type: ((s.draftSettings || {}).keeperCount || 0) > 0 ? 1 : 0, start_week: 1,
      playoff_week_start: regWeeks.length ? Math.max(...regWeeks) + 1 : 0,
      playoff_teams: Number(ss.playoffTeamCount || 0) },
  };
}

/** Who plays whom in the regular season: {week: [[teamId, teamId], ...]}. */
function scheduleOf(d) {
  const ss = (d.settings || {}).scheduleSettings || {};
  const lastReg = Number(ss.matchupPeriodCount || 0);
  const periods = ss.matchupPeriods || {};
  const out = {};
  for (const m of d.schedule || []) {
    const p = Number(m.matchupPeriodId);
    if (lastReg && p > lastReg) continue;
    if (!m.home || !m.away || m.home.teamId == null || m.away.teamId == null) continue;
    const wk = String((periods[String(p)] || [p])[0]);
    (out[wk] = out[wk] || []).push([m.home.teamId, m.away.teamId]);
  }
  return out;
}

/** Starters laid out on the league's slots, from ESPN lineup entries. */
function layout(entries, slotIds, sleeperMap) {
  const starters = slotIds.map(() => '0');
  const players = [], reserve = [];
  for (const e of entries || []) {
    const p = ((e.playerPoolEntry || {}).player) || null;
    if (!p) continue;
    const sid = sleeperId(p, sleeperMap);
    players.push(sid);
    if (Number(e.lineupSlotId) === 21) reserve.push(sid);
    if (BENCH.has(Number(e.lineupSlotId))) continue;
    const i = slotIds.findIndex((s, k) => s === Number(e.lineupSlotId) && starters[k] === '0');
    const j = i >= 0 ? i : slotIds.findIndex((s, k) => SLOT[s] === SLOT[e.lineupSlotId] && starters[k] === '0');
    if (j >= 0) starters[j] = sid;
  }
  // Sleeper's starters cover the lineup slots only; bench and IR come last.
  return { starters: starters.slice(0, slotIds.filter((s) => !BENCH.has(s)).length), players, reserve };
}

function pointsOf(entries, sleeperMap) {
  const out = {};
  for (const e of entries || []) {
    const pe = e.playerPoolEntry || {};
    if (pe.player && pe.appliedStatTotal != null) out[sleeperId(pe.player, sleeperMap)] = Number(pe.appliedStatTotal);
  }
  return out;
}

function periodFor(d, week) {
  const mp = ((d.settings || {}).scheduleSettings || {}).matchupPeriods || {};
  for (const [p, wks] of Object.entries(mp)) if ((wks || []).map(Number).includes(Number(week))) return Number(p);
  return Number(week);
}

function matchupsFor(d, week, slotIds, sleeperMap) {
  const p = periodFor(d, week);
  const out = [];
  for (const m of d.schedule || []) {
    if (Number(m.matchupPeriodId) !== p) continue;
    for (const side of [m.home, m.away]) {
      if (!side || side.teamId == null) continue;
      const roster = side.rosterForCurrentScoringPeriod || side.rosterForMatchupPeriod || {};
      const lay = layout(roster.entries, slotIds, sleeperMap);
      const pts = side.totalPoints ?? (side.pointsByScoringPeriod || {})[week] ?? null;
      out.push({ roster_id: side.teamId, matchup_id: m.id, starters: lay.starters, players: lay.players,
        points: pts == null ? null : Number(pts), players_points: pointsOf(roster.entries, sleeperMap) });
    }
  }
  return out;
}

/** Everything the engine needs for one league and week, in Sleeper's shape. */
function translate(d, id, week, sleeperMap) {
  const league = toLeague(d, id);
  const { ids: slotIds } = rosterPositions(((d.settings || {}).rosterSettings || {}).lineupSlotCounts);
  const members = Object.fromEntries((d.members || []).map((m) => [m.id, m]));
  const users = [], rosters = [];
  for (const t of d.teams || []) {
    const owner = members[t.primaryOwner] || members[(t.owners || [])[0]] || {};
    users.push({ user_id: `t${t.id}`, display_name: owner.displayName || teamName(t),
      metadata: { team_name: teamName(t) } });
    const rec = (t.record || {}).overall || {};
    const pf = Number(rec.pointsFor || 0);
    const lay = layout((t.roster || {}).entries, slotIds, sleeperMap);
    rosters.push({ roster_id: t.id, owner_id: `t${t.id}`, players: lay.players, starters: lay.starters,
      reserve: lay.reserve,
      settings: { wins: rec.wins || 0, losses: rec.losses || 0, ties: rec.ties || 0,
        fpts: Math.floor(pf), fpts_decimal: Math.round((pf - Math.floor(pf)) * 100) } });
  }
  return { league, users, rosters, matchups: matchupsFor(d, week, slotIds, sleeperMap), schedule: scheduleOf(d) };
}
export const translateForTest = translate;

// --------------------------------------------------------------- the API
// Same calls as sleeper.js, so the league screen can use either.

/** Settings only: enough to list the league. */
export async function league(id, season, o) {
  const d = await get(leagueUrl(id, season, ['mSettings']), TTL.settings, o);
  return d ? toLeague(d, id) : null;
}

const WEEK_VIEWS = ['mSettings', 'mTeam', 'mRoster', 'mMatchup', 'mMatchupScore'];

export async function leagueBundle(id, season, week, sleeperMap, o) {
  const d = await get(leagueUrl(id, season, WEEK_VIEWS, week), TTL.week, o);
  if (!d) throw new Error('ESPN has no league with that ID.');
  return translate(d, id, week, sleeperMap);
}

/** A finished week's matchups (lineups as set that week, ESPN's points). */
export async function pastMatchups(id, season, week, sleeperMap, o) {
  const d = await get(leagueUrl(id, season, WEEK_VIEWS, week), TTL.pastWeek, o);
  if (!d) return [];
  const { ids } = rosterPositions(((d.settings || {}).rosterSettings || {}).lineupSlotCounts);
  return matchupsFor(d, week, ids, sleeperMap);
}
