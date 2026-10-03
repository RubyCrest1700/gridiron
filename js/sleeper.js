// The only door to Sleeper, and it only reads.
//
// Mirrors nflpred/sources/sleeper_leagues.py: every request is a GET, to one
// host, on a path matching this whitelist. Nothing here -- or anywhere in this
// app -- can change a league. tests/test_mobile_readonly.py fails the build if
// any file in mobile/ sends anything but a GET to Sleeper.

const HOST = 'https://api.sleeper.app/v1';

const READ_PATHS = [
  /^\/state\/nfl$/,
  /^\/user\/[A-Za-z0-9_]{1,40}$/,
  /^\/user\/\d{1,25}\/leagues\/nfl\/\d{4}$/,
  /^\/league\/\d{1,25}$/,
  /^\/league\/\d{1,25}\/users$/,
  /^\/league\/\d{1,25}\/rosters$/,
  /^\/league\/\d{1,25}\/matchups\/\d{1,2}$/,
  /^\/league\/\d{1,25}\/traded_picks$/,
  /^\/league\/\d{1,25}\/drafts$/,
  /^\/draft\/\d{1,25}\/picks$/,
];

// Seconds. Settings barely change; rosters change on waiver days; matchups
// carry live points on game days.
const TTL = { state: 600, user: 86400, leagues: 3600, league: 3600, users: 3600,
  rosters: 600, matchups: 120, pastMatchups: 86400 * 30, schedule: 21600, picks: 600 };

export class ReadOnlyViolation extends Error {}

const memo = new Map();

function stored(path) {
  try {
    const v = JSON.parse(localStorage.getItem(`sl:${path}`) || 'null');
    return v && typeof v.at === 'number' ? v : null;
  } catch (_) { return null; }
}
function store(path, data) {
  try { localStorage.setItem(`sl:${path}`, JSON.stringify({ at: Date.now(), data })); } catch (_) { /* full or blocked */ }
}

export function allowed(path) {
  return typeof path === 'string' && READ_PATHS.some((re) => re.test(path));
}

/** GET a whitelisted path. Fresh within ttl seconds from cache; on a network
 *  failure, falls back to whatever was last seen (so the app works offline). */
export async function get(path, ttl, { force = false } = {}) {
  if (!allowed(path)) throw new ReadOnlyViolation(`not an allowed read: ${path}`);
  const now = Date.now();
  const m = memo.get(path);
  if (!force && m && now - m.at < ttl * 1000) return m.data;
  const s = stored(path);
  if (!force && s && now - s.at < ttl * 1000) { memo.set(path, s); return s.data; }
  try {
    const r = await fetch(HOST + path, { method: 'GET', credentials: 'omit', cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Sleeper returned ${r.status}`);
    const data = await r.json();
    const entry = { at: now, data };
    memo.set(path, entry);
    store(path, data);
    return data;
  } catch (err) {
    if (s) return s.data;
    throw err;
  }
}

export const state = (o) => get('/state/nfl', TTL.state, o);
export const user = (name, o) => get(`/user/${encodeURIComponent(String(name).trim())}`, TTL.user, o);
export const leagues = (userId, season, o) => get(`/user/${userId}/leagues/nfl/${season}`, TTL.leagues, o);
export const league = (id, o) => get(`/league/${id}`, TTL.league, o);
export const users = (id, o) => get(`/league/${id}/users`, TTL.users, o);
export const rosters = (id, o) => get(`/league/${id}/rosters`, TTL.rosters, o);
export const matchups = (id, week, o) => get(`/league/${id}/matchups/${Number(week)}`, TTL.matchups, o);
export const pastMatchups = (id, week, o) => get(`/league/${id}/matchups/${Number(week)}`, TTL.pastMatchups, o);
export const tradedPicks = (id, o) => get(`/league/${id}/traded_picks`, TTL.picks, o);
export const drafts = (id, o) => get(`/league/${id}/drafts`, TTL.picks, o);
export const draftPicks = (id, o) => get(`/draft/${id}/picks`, TTL.picks, o);

const scheduleWeek = (id, week, o) => get(`/league/${id}/matchups/${Number(week)}`, TTL.schedule, o);

/** Who plays whom, week by week: {week: [[rosterId, rosterId], ...]}. The same
 *  read as this week's matchups; future weeks just have no points yet. Fails
 *  if any week can't be read: a missing week would quietly drop its games
 *  from the playoff odds. */
export async function schedule(id, fromWeek, toWeek, o) {
  const weeks = [];
  for (let w = fromWeek; w <= toWeek; w++) weeks.push(w);
  const all = await Promise.all(weeks.map((w) => scheduleWeek(id, w, o)));
  const out = {};
  weeks.forEach((w, i) => {
    const pairs = {};
    for (const m of all[i] || []) {
      if (m.matchup_id != null) (pairs[m.matchup_id] = pairs[m.matchup_id] || []).push(m.roster_id);
    }
    out[String(w)] = Object.values(pairs).filter((p) => p.length === 2);
  });
  return out;
}

/** A league ID from whatever the user pasted: an ID, or a sleeper.com link. */
export function parseLeagueId(text) {
  const s = String(text || '').trim();
  const m = s.match(/(?:leagues?\/)?(\d{10,25})/);
  return m ? m[1] : null;
}

/** Everything the engine needs for one league this week. */
export async function leagueBundle(id, week, o) {
  const [lg, us, rs, ms] = await Promise.all([league(id, o), users(id, o), rosters(id, o), matchups(id, week, o)]);
  if (!lg) throw new Error('Sleeper has no league with that ID.');
  return { league: lg, users: us || [], rosters: rs || [], matchups: ms || [] };
}
