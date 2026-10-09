// My teams: one card per league, and every player across them. Pure -- the
// screens are views/myteams.js and the player card.
//
// A "team" here is what views/leagues.js myTeams() returns:
// {id, league, sl: {users, rosters, matchups}, rid, map} where `map` is that
// league's player-id -> [modelId, name, position, nflTeam] table.

import { teamName } from './engine.js';
import { lastName } from './ui.js';

const CANT_PLAY = new Set(['Out', 'IR', 'Inactive', 'PUP', 'Sus', 'NFI', 'Doubtful']);
const EMPTY = new Set(['0', '', 'null', 'undefined']);
const isDef = (sid) => /^[A-Z]{2,3}$/.test(sid);

const rec = (r) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`;

/** Starters in the current lineup who can't score this week:
 *  [{slot, name (last name, or null for an empty slot), why}], why being
 *  'bye', 'empty' or his injury status. */
export function lineupAlerts(view) {
  const out = [];
  for (const x of view.lineup || []) {
    if (!x.modelled) continue;
    const p = x.player;
    if (!p) { out.push({ slot: x.label, name: null, why: 'empty' }); continue; }
    if (p.locked || !p.modelled) continue;
    if (CANT_PLAY.has(p.status)) out.push({ slot: x.label, name: lastName(p.name), why: p.status });
    else if (!p.opponent) out.push({ slot: x.label, name: lastName(p.name), why: 'bye' });
  }
  return out;
}

/** One league in a line, from engine.leagueView(). */
export function teamCard(view) {
  const m = view.matchup;
  return {
    id: view.league.league_id, league: view.league.name, team: view.me.team, record: rec(view.me),
    opp: m ? m.team : null, oppRecord: m ? rec(m.record) : null,
    me: m ? m.me_current_total : null, them: m ? m.proj_total : null,
    win: m ? m.win_prob_current : null, winBest: m ? m.win_prob_best : null,
    changes: (view.changes || []).length, gain: (view.moves || {}).gain || 0,
    alerts: lineupAlerts(view),
  };
}

export function summary(cards) {
  const playing = cards.filter((c) => c.win != null);
  return { teams: cards.length, favored: playing.filter((c) => c.win > 0.5).length, playing: playing.length,
    toFix: cards.filter((c) => c.changes > 0 || c.alerts.length).length };
}

function info(t, sid) {
  const b = (t.map || {})[sid] || [];
  if (!b[1] && !isDef(sid)) return null;
  return { id: b[0] || null, sid, name: b[1] || `${sid} D/ST`, pos: b[2] || 'DEF', team: b[3] || (isDef(sid) ? sid : null) };
}

function sides(t) {
  const rosters = t.sl.rosters || [];
  const mine = rosters.find((r) => r.roster_id === t.rid) || null;
  const myM = (t.sl.matchups || []).find((m) => m.roster_id === t.rid);
  const oppM = myM && myM.matchup_id != null
    ? (t.sl.matchups || []).find((m) => m.matchup_id === myM.matchup_id && m.roster_id !== t.rid) : null;
  return { rosters, mine, opp: oppM ? rosters.find((r) => r.roster_id === oppM.roster_id) || null : null };
}

const ids = (xs) => (xs || []).map(String).filter((s) => !EMPTY.has(s));

function whereOn(r, sid) {
  if (ids(r.starters).includes(sid)) return 'start';
  if (ids(r.reserve).includes(sid)) return 'ir';
  if (ids(r.taxi).includes(sid)) return 'taxi';
  return 'bench';
}

/** Every player on your teams, and every player starting against you:
 *  {mine: [{id, sid, name, pos, team, leagues: [{id, name, where}], starts}],
 *   against: [{..., leagues: [{id, name}], mine: [league names you start him in]}]}.
 *  Most leagues first. `id` is the model's id, null when it has none for him. */
export function exposure(teams) {
  const mine = new Map(), against = new Map();
  const key = (p) => p.id || `${p.pos}|${p.name}`;
  for (const t of teams) {
    const s = sides(t);
    if (!s.mine) continue;
    for (const sid of new Set([...ids(s.mine.players), ...ids(s.mine.reserve), ...ids(s.mine.taxi)])) {
      const p = info(t, sid);
      if (!p) continue;
      const e = mine.get(key(p)) || { ...p, leagues: [], starts: 0 };
      const where = whereOn(s.mine, sid);
      e.leagues.push({ id: t.id, name: t.league.name, where });
      if (where === 'start') e.starts += 1;
      mine.set(key(p), e);
    }
    for (const sid of s.opp ? ids(s.opp.starters) : []) {
      const p = info(t, sid);
      if (!p) continue;
      const e = against.get(key(p)) || { ...p, leagues: [], mine: [] };
      e.leagues.push({ id: t.id, name: t.league.name });
      against.set(key(p), e);
    }
  }
  for (const [k, e] of against) {
    e.mine = ((mine.get(k) || {}).leagues || []).filter((g) => g.where === 'start').map((g) => g.name);
  }
  const order = (a, b) => (b.leagues.length - a.leagues.length) || ((b.starts || 0) - (a.starts || 0)) || a.name.localeCompare(b.name);
  return { mine: [...mine.values()].sort(order), against: [...against.values()].sort(order) };
}

/** Where one player stands in each of your leagues: [{id, league, status,
 *  team}], status being 'start' | 'bench' | 'ir' | 'taxi' (yours), 'opp'
 *  (this week's opponent has him), 'other' (another team; `team` names it) or
 *  'free'. A league whose player table doesn't include him is left out. */
export function playerInLeagues(teams, modelId) {
  const out = [];
  for (const t of teams) {
    const sids = new Set(Object.keys(t.map || {}).filter((s) => (t.map[s] || [])[0] === modelId));
    if (!sids.size) continue;
    const s = sides(t);
    const users = Object.fromEntries((t.sl.users || []).map((u) => [u.user_id, u]));
    const row = { id: t.id, league: t.league.name, status: 'free', team: null };
    for (const r of s.rosters) {
      const sid = [...ids(r.players), ...ids(r.reserve), ...ids(r.taxi)].find((x) => sids.has(x));
      if (!sid) continue;
      if (s.mine && r.roster_id === s.mine.roster_id) row.status = whereOn(r, sid);
      else { row.status = s.opp && r.roster_id === s.opp.roster_id ? 'opp' : 'other'; row.team = teamName(r, users); }
      break;
    }
    out.push(row);
  }
  return out;
}
