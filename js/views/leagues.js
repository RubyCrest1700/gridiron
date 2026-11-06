// Leagues: any Sleeper league or public ESPN league, seen from any team in it.
//
// Nothing is tied to one person. A Sleeper username (optional) brings in that
// person's leagues; any other league -- Sleeper or ESPN -- can be added by its
// ID or link; and in any league you can follow any team -- your own by default.
// Everything is read straight from Sleeper or ESPN on this phone, read-only,
// and remembered here.

import * as SL from '../sleeper.js';
import * as ES from '../espn.js';
import * as E from '../engine.js';
import * as TR from './trades.js';
import { renderOverview } from './myteams.js';
import { dropdown, onPick, esc, avatar, posPill, statusTag, fmtKickoff, num, pct, signed, rangeBar, playerRow,
  skeleton, empty, store, toast, versus, foldedTable, lastName } from '../ui.js';

const SUBTABS = [['matchup', 'Matchup'], ['lineup', 'Lineup'], ['waivers', 'Waivers'], ['trades', 'Trades'],
  ['league', 'League'], ['recap', 'Recap']];
// screen: 'all' is the My teams overview, 'league' is one league.
const st = { screen: store.get('lg.screen', 'all'), sub: store.get('lg.sub', 'matchup'), faPos: 'ALL', faMode: store.get('lg.faMode', 'week'), recapWeek: null };

// ------------------------------------------------------------ saved setup
const cfg = {
  get username() { return store.get('username', ''); },
  set username(v) { store.set('username', v || ''); },
  get added() { return store.get('leagues.added', []); },
  set added(v) { store.set('leagues.added', v); },
  get hidden() { return store.get('leagues.hidden', []); },
  set hidden(v) { store.set('leagues.hidden', v); },
  get current() { return store.get('leagues.current', null); },
  set current(v) { store.set('leagues.current', v); },
  team(id) { return store.get(`team.${id}`, null); },
  setTeam(id, rid) { store.set(`team.${id}`, rid); },
};

// One set of calls for either kind of league. ESPN leagues are translated into
// Sleeper's shape (see espn.js), so everything past this point is shared.
const sourceName = (id) => (ES.isEspn(id) ? 'ESPN' : 'Sleeper');
const leagueMeta = (id, ctx, o) => (ES.isEspn(id) ? ES.league(id, ctx.meta.season, o) : SL.league(id, o));
const leagueBundle = (id, ctx) => (ES.isEspn(id)
  ? ES.leagueBundle(id, ctx.meta.season, ctx.meta.week, ctx.week.sleeper)
  : SL.leagueBundle(id, ctx.meta.week));
const pastMatchups = (id, ctx, w, wk) => (ES.isEspn(id)
  ? ES.pastMatchups(id, ctx.meta.season, w, wk.sleeper) : SL.pastMatchups(id, w));
const weekFor = (id, wk) => (ES.isEspn(id) ? ES.withPlayers(wk) : wk);
// Who plays whom for the rest of the regular season (for playoff odds).
const scheduleFn = (id, ctx, sl) => () => (ES.isEspn(id) ? Promise.resolve(sl.schedule || {})
  : SL.schedule(id, ctx.meta.week, (Number((sl.league.settings || {}).playoff_week_start) || 18) - 1));

async function me() {
  const name = cfg.username.trim();
  if (!name) return null;
  const u = await SL.user(name);
  if (!u || !u.user_id) throw new Error(`Sleeper has no user named “${name}”.`);
  return u;
}

/** The leagues to show: the user's, plus any added by ID, minus any removed. */
async function leagueList(ctx) {
  const out = new Map();
  let user = null, userErr = null;
  try { user = await me(); } catch (err) { userErr = err; }
  if (user) {
    for (const lg of (await SL.leagues(user.user_id, ctx.meta.season)) || []) out.set(lg.league_id, lg);
  }
  for (const id of cfg.added) {
    if (out.has(id)) continue;
    try { const lg = await leagueMeta(id, ctx); if (lg) out.set(id, lg); } catch (_) { /* offline or private: skip */ }
  }
  const hidden = new Set(cfg.hidden);
  return { user, userErr, leagues: [...out.values()].filter((l) => !hidden.has(l.league_id)) };
}

/** Back to the overview (the tab was tapped again). */
export function home() { st.screen = 'all'; store.set('lg.screen', 'all'); }

/** Your team in every connected league: [{id, league, sl, rid, wk, map}],
 *  `map` being that league's player-id table. A league that can't be read,
 *  or where no team is yours or chosen, is left out. */
export async function myTeams(ctx, list = null) {
  const { user, leagues } = list || await leagueList(ctx);
  const out = [];
  await Promise.all(leagues.map(async (lg) => {
    try {
      const sl = await leagueBundle(lg.league_id, ctx);
      const rosters = sl.rosters || [];
      let rid = cfg.team(lg.league_id);
      if (!rosters.some((r) => r.roster_id === rid)) {
        const mine = user ? rosters.find((r) => E.owns(r, user.user_id)) : null;
        rid = mine ? mine.roster_id : null;
      }
      const wk = weekFor(lg.league_id, ctx.week);
      if (rid != null) out.push({ id: lg.league_id, league: sl.league, sl, rid, wk, map: wk.sleeper || {} });
    } catch (_) { /* offline or private: skip */ }
  }));
  const order = new Map(leagues.map((l, i) => [l.league_id, i]));
  return out.sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** Model ids of every player on those teams that the model projects. */
export function rosterModelIds(teams, sleeperMap, known) {
  const out = new Set();
  for (const t of teams) {
    const r = (t.sl.rosters || []).find((x) => x.roster_id === t.rid);
    if (!r) continue;
    for (const sid of [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]) {
      const mid = ((t.map || sleeperMap)[sid] || [])[0];
      if (mid && known.has(mid)) out.add(mid);
    }
  }
  return out;
}

// ----------------------------------------------------------------- render
export async function render(host, ctx, stale) {
  host.innerHTML = skeleton(6);
  const { user, userErr, leagues } = await leagueList(ctx);
  if (stale()) return;

  if (!leagues.length) {
    host.innerHTML = onboarding(userErr);
    wireSetup(host, ctx);
    return;
  }
  // More than one team: start from all of them on one screen.
  const openLeague = (v) => { cfg.current = v; st.screen = 'league'; store.set('lg.screen', 'league'); st.recapWeek = null; render(host, ctx, stale); };
  const teams = leagues.length > 1 ? await myTeams(ctx, { user, leagues }) : [];
  if (stale()) return;
  const overview = teams.length > 1;
  if (overview && st.screen === 'all') {
    ctx.leagueScoring = null; ctx.leagueDynasty = null;
    const have = new Set(teams.map((t) => t.id));
    await renderOverview(host, ctx, { teams, stale, open: openLeague,
      others: leagues.filter((l) => !have.has(l.league_id)).map((l) => ({ id: l.league_id, name: l.name })),
      manage: () => manage(ctx, () => render(host, ctx, stale)) });
    return;
  }
  let id = cfg.current;
  if (!leagues.some((l) => l.league_id === id)) id = leagues[0].league_id;
  cfg.current = id;

  const leagueOpts = leagues.map((l) => [l.league_id, l.name]);
  host.innerHTML = `
    <div class="league-head">
      ${overview ? '<button class="link-btn back" id="lg-all" aria-label="All my teams">‹ All</button>' : ''}
      ${dropdown('lg-pick', leagueOpts, id, { cls: 'title', label: 'League' })}
      <button class="link-btn" id="lg-manage" style="flex-shrink:0">Manage</button>
    </div>
    <div id="lg-body">${skeleton(6)}</div>`;
  onPick(host.querySelector('#lg-pick'), leagueOpts, (v) => { cfg.current = v; st.recapWeek = null; render(host, ctx, stale); });
  host.querySelector('#lg-manage').addEventListener('click', () => manage(ctx, () => render(host, ctx, stale)));
  if (overview) host.querySelector('#lg-all').addEventListener('click', () => { home(); render(host, ctx, stale); });

  const body = host.querySelector('#lg-body');
  let sl;
  try {
    sl = await leagueBundle(id, ctx);
  } catch (err) {
    body.innerHTML = empty(err instanceof ES.PrivateLeague ? 'This ESPN league is private' : `Could not reach ${sourceName(id)}`,
      esc(err.message), err instanceof ES.PrivateLeague ? '🔒' : '📡');
    return;
  }
  if (stale()) return;

  // Whose team: the saved choice, else yours, else ask.
  const rosters = sl.rosters || [];
  let rid = cfg.team(id);
  if (!rosters.some((r) => r.roster_id === rid)) {
    const mine = user ? rosters.find((r) => E.owns(r, user.user_id)) : null;
    rid = mine ? mine.roster_id : null;
  }
  const users = Object.fromEntries((sl.users || []).map((u) => [u.user_id, u]));
  const teamOpts = rosters.slice().sort((a, b) => E.teamName(a, users).localeCompare(E.teamName(b, users)))
    .map((r) => [r.roster_id, E.teamName(r, users), user && E.owns(r, user.user_id) ? 'You' : '']);

  if (rid == null) {
    body.innerHTML = `<div class="card"><h2>Which team?</h2>
      <p class="muted" style="margin:0 0 10px;font-size:14px">You're not in this league${user ? '' : ' (or no Sleeper username is set)'}. Pick any team to follow — you can change it any time.</p>
      ${dropdown('lg-team', teamOpts, null, { cls: 'block', placeholder: 'Choose a team…', label: 'Team' })}</div>
      ${standingsCard(rosters.map((r) => ({ team: E.teamName(r, users), roster_id: r.roster_id, mine: false, ...E.record(r) }))
        .sort((a, b) => (b.wins - a.wins) || (b.points_for - a.points_for)))}`;
    onPick(body.querySelector('#lg-team'), teamOpts, (v) => { cfg.setTeam(id, Number(v)); render(host, ctx, stale); });
    return;
  }

  let view;
  try {
    view = E.leagueView(weekFor(id, ctx.week), sl, rid);
  } catch (err) {
    body.innerHTML = empty('Could not analyse this league', esc(err.message), '⚠️');
    return;
  }
  const L = view.league;
  // Rest-of-season tools load in the background; the week's tabs don't wait.
  ctx.leagueScoring = { settings: sl.league.scoring_settings,
    playoffStart: Number((sl.league.settings || {}).playoff_week_start || 0) };
  ctx.leagueDynasty = null;
  const rosData = TR.loadLeague(ctx, sl, weekFor(id, ctx.week).sleeper, scheduleFn(id, ctx, sl))
    .then((d) => { ctx.leagueDynasty = (d && d.dctx) || null; return d; })
    .catch((err) => { console.error(err); return null; });
  const noRos = () => empty('Rest-of-season numbers are not published yet', 'They arrive with the next refresh.', '⏳');
  body.innerHTML = `
    <div class="team-pick">${dropdown('lg-team', teamOpts, rid, { prefix: 'Team', label: 'Team' })}</div>
    <div class="meta-chips" style="margin:-2px 0 12px">
      <span>${esc(L.format)} · ${L.teams} teams</span><span>${esc(view.me.wins)}-${esc(view.me.losses)}${view.me.ties ? `-${view.me.ties}` : ''}</span>
      ${L.scoring.map((s) => `<span>${esc(s)}</span>`).join('')}
    </div>
    <div class="seg">${SUBTABS.map(([k, l]) => `<button data-sub="${k}" class="${st.sub === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="lg-sub"></div>`;
  onPick(body.querySelector('#lg-team'), teamOpts, (v) => { cfg.setTeam(id, Number(v)); render(host, ctx, stale); });
  body.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => {
    st.sub = b.dataset.sub; store.set('lg.sub', st.sub);
    body.querySelectorAll('[data-sub]').forEach((x) => x.classList.toggle('active', x === b));
    showActiveSub();
    drawSub();
  }));
  // Six sub-tabs don't fit a phone: keep the selected one on screen.
  const showActiveSub = () => {
    const seg = body.querySelector('.seg'), a = seg && seg.querySelector('button.active');
    if (a) seg.scrollLeft = Math.max(0, a.offsetLeft - (seg.clientWidth - a.offsetWidth) / 2);
  };
  showActiveSub();
  const sub = body.querySelector('#lg-sub');
  const drawSub = () => {
    if (st.sub === 'matchup') sub.innerHTML = matchupHtml(view);
    else if (st.sub === 'lineup') sub.innerHTML = lineupHtml(view);
    else if (st.sub === 'waivers') waivers(sub, view, rosData);
    else if (st.sub === 'trades') {
      sub.innerHTML = skeleton(5);
      rosData.then((d) => {
        if (st.sub !== 'trades') return;
        if (!d) { sub.innerHTML = noRos(); return; }
        // Grading and the season simulation take a moment; paint first.
        setTimeout(() => TR.renderTrades(sub, ctx, sl, rid, d), 20);
      });
    } else if (st.sub === 'league') {
      leagueHtml(sub, ctx, sl, rid, rosData.then((d) => (d ? { html: TR.leagueCards(rid, d), odds: TR.playoffOdds(d) } : null)));
    } else if (st.sub === 'recap') recap(sub, ctx, sl, rid);
    if (L.unmodelled_scoring.length && ['matchup', 'lineup'].includes(st.sub)) {
      sub.insertAdjacentHTML('beforeend', `<p class="note">Not modelled in this league's scoring: ${esc(L.unmodelled_scoring.join(', '))}.</p>`);
    }
  };
  drawSub();
}

// ------------------------------------------------------------- pieces
const rec = (r) => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ''}`;

function pts(p) {
  if (!p) return '';
  if (p.locked && p.actual != null) return `<div class="pts">${num(p.actual)}<small>scored</small></div>`;
  if (!p.modelled) return '<div class="pts faint">—</div>';
  return `<div class="pts">${num(p.proj ?? 0)}<small>proj</small></div>`;
}

function sub(p) {
  if (!p) return '';
  const vs = versus(p.team, p.opponent);
  const when = p.locked ? '<span class="lock">🔒 started</span>' : p.kickoff ? esc(fmtKickoff(p.kickoff)) : (p.modelled && !vs ? 'no game' : '');
  return `${esc(p.team || '')}${vs ? ` ${esc(vs)}` : ''}${when ? ` · ${when}` : ''}${!p.locked && p.range ? rangeBar(p.range, p.proj, p.team) : ''}`;
}

function slotRow(x, extra = '') {
  const p = x.player;
  const attrs = p && p.player_id && p.position && ['QB', 'RB', 'WR', 'TE'].includes(p.position) ? `data-player="${esc(p.player_id)}"` : '';
  if (!p) return `<div class="prow"><span class="slot">${esc(x.label)}</span><div class="pmain muted">Empty</div></div>`;
  return `<div class="prow ${extra}" ${attrs}><span class="slot">${esc(x.label)}</span>${avatar(p)}
    <div class="pmain"><div class="pname">${posPill(p.position)}<span class="n">${esc(p.name)}</span>${statusTag(p.status)}</div>
    <div class="pline">${sub(p)}</div></div><div class="pright">${pts(p)}</div></div>`;
}

function movesHtml(view) {
  const mv = view.moves;
  if (!view.changes.length) return '<div class="ok-box">Your lineup is already the best the model can find.</div>';
  const names = (ps) => ps.map((p) => `<strong>${esc(p.name)}</strong> (${num(p.proj ?? 0)})`).join(', ');
  return `<div class="change"><span>Start ${names(mv.start) || 'nobody new'}${mv.sit.length ? `; sit ${names(mv.sit)}` : ''}</span>
      <span class="gain">${mv.gain >= 0 ? '+' : ''}${num(mv.gain)}</span></div>
    <div class="faint" style="font-size:12px;margin:8px 2px 6px">Slots to set in ${sourceName(view.league.league_id)}:</div>
    ${view.changes.map((c) => `<div class="change slotmove"><span class="slot">${esc(c.slot)}</span>
      <span>${esc(c.start.name)}${c.bench ? ` <span class="faint">(was ${esc(c.bench.name)})</span>` : ''}</span></div>`).join('')}`;
}

function matchupHtml(view) {
  const m = view.matchup;
  let h = '';
  if (m) {
    const wp = m.win_prob_current;
    const better = m.win_prob_best > wp + 0.004;
    h += `<div class="card">
      <div class="mu">
        <div class="side"><div class="t">${esc(view.me.team)}</div><div class="r">${rec(view.me)}</div><div class="big">${num(m.me_current_total)}</div></div>
        <div class="vs">vs</div>
        <div class="side opp"><div class="t">${esc(m.team)}</div><div class="r">${rec(m.record)}</div><div class="big">${num(m.proj_total)}</div></div>
      </div>
      <div class="winbar"><span class="me" style="width:${(wp * 100).toFixed(1)}%"></span><span class="op" style="flex:1"></span></div>
      <div class="winlab"><span>Win chance <strong style="color:var(--text)">${pct(wp)}</strong></span>
        ${better ? `<span>with changes <strong style="color:var(--good)">${pct(m.win_prob_best)}</strong></span>` : ''}</div>
      ${m.range_current ? `<div class="winlab" style="margin-top:4px"><span>Likely ${num(m.range_current.p10, 0)}–${num(m.range_current.p90, 0)}</span><span>${num(m.range_opp.p10, 0)}–${num(m.range_opp.p90, 0)}</span></div>` : ''}
      <p class="note">Both lineups are scored over the same 1,000 simulated games, so teammates, kickers and defences rise and fall together. Players whose games have started count what they've scored.</p>
    </div>`;
  } else {
    h += '<div class="ok-box" style="margin-bottom:12px">No matchup this week.</div>';
  }
  h += `<div class="card"><h2>Suggested changes</h2>${movesHtml(view)}
    <p class="note">Make changes in ${sourceName(view.league.league_id)} — this app can only read your league.</p></div>`;
  if (m) h += headToHead(view, m);
  return h;
}

/** Your starters and theirs, slot by slot -- the way Sleeper shows a matchup. */
function headToHead(view, m) {
  const sits = new Set(view.moves.sit.map((p) => p.sleeper_id));
  const shortName = (n) => {
    const parts = String(n || '').split(' ');
    return parts.length > 1 && !/D\/ST$/.test(n) ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : n;
  };
  const value = (p) => (p ? (p.locked && p.actual != null ? Number(p.actual) : (p.modelled ? Number(p.proj || 0) : null)) : null);
  const side = (p, mine, other) => {
    if (!p) return `<div class="h2h-side ${mine ? 'me' : 'op'} empty">Empty</div>`;
    const v = value(p), o = value(other);
    const lead = v != null && o != null && v > o + 0.05;
    const tap = p.player_id && ['QB', 'RB', 'WR', 'TE'].includes(p.position) ? `data-player="${esc(p.player_id)}"` : '';
    const pts = v == null ? '—' : num(v);
    const sub = p.locked ? (p.actual != null ? 'scored' : 'started') : `${esc(p.team || '')}${versus(p.team, p.opponent) ? ` ${esc(versus(p.team, p.opponent))}` : ''}`;
    return `<div class="h2h-side ${mine ? 'me' : 'op'}" ${tap}>
      ${avatar(p, 'sm')}
      <div class="h2h-txt"><div class="h2h-nm">${esc(shortName(p.name))}</div>
        <div class="h2h-sub">${mine && sits.has(p.sleeper_id) ? '<span class="sit">▼ sit</span> · ' : ''}${sub}${p.status && p.status !== 'Active' ? ` · <span class="tag tag-${esc(String(p.status).toLowerCase())}">${esc(p.status === 'Questionable' ? 'Q' : p.status)}</span>` : ''}</div></div>
      <div class="h2h-pts ${lead ? 'lead' : ''}">${pts}</div>
    </div>`;
  };
  const rows = view.lineup.map((x, i) => {
    const o = m.lineup[i] || { label: x.label, player: null };
    return `<div class="h2h-row">${side(x.player, true, o.player)}<div class="h2h-slot">${esc(x.label)}</div>${side(o.player, false, x.player)}</div>`;
  }).join('');
  return `<div class="card flush h2h">
    <div class="h2h-row h2h-head"><div class="h2h-team me">${esc(view.me.team)}</div><div class="h2h-slot"></div><div class="h2h-team op">${esc(m.team)}</div></div>
    ${rows}
    <div class="h2h-row h2h-total"><div class="h2h-side me"><span class="grow">Total</span><strong>${num(m.me_current_total)}</strong></div>
      <div class="h2h-slot"></div><div class="h2h-side op"><strong>${num(m.proj_total)}</strong><span class="grow" style="text-align:right">Total</span></div></div>
  </div>`;
}

function lineupHtml(view) {
  const recIds = new Set(view.recommended.map((x) => x.player && x.player.sleeper_id).filter(Boolean));
  return `<div class="card flush"><h2>Your lineup</h2><div class="list">
      ${view.lineup.map((x) => slotRow(x, x.player && x.modelled && !recIds.has(x.player.sleeper_id) ? 'swap-out' : '')).join('')}</div></div>
    <div class="card flush"><h2>Bench</h2><div class="list">
      ${view.bench.map((p) => playerRow(p, {
        attrs: p.player_id && ['QB', 'RB', 'WR', 'TE'].includes(p.position) ? `data-player="${esc(p.player_id)}"` : '',
        sub: `${sub(p)}${p.where && p.where !== 'Bench' ? ` · ${esc(p.where)}` : ''}`,
        right: `${pts(p)}${recIds.has(p.sleeper_id) ? '<span class="badge start">start</span>' : ''}`,
      })).join('') || '<p class="muted" style="padding:12px;margin:0">Nobody on the bench.</p>'}</div></div>`;
}

/** Waivers: this week's best available, or the rest of the season's. */
function waivers(host, view, rosData) {
  const draw = (d) => {
    const dyn = !!(d && d.dctx);
    if (st.faMode === 'stash' && d && !dyn) st.faMode = 'ros';
    const seg = `<div class="seg" style="margin-bottom:10px"><button data-fam="week" class="${st.faMode === 'week' ? 'active' : ''}">This week</button>
      <button data-fam="ros" class="${st.faMode === 'ros' ? 'active' : ''}">Rest of season</button>
      ${dyn ? `<button data-fam="stash" class="${st.faMode === 'stash' ? 'active' : ''}">Stash</button>` : ''}</div>`;
    if (st.faMode === 'stash' && dyn) host.innerHTML = seg + faChips(view) + TR.stashHtml(d, st.faPos);
    else if (st.faMode === 'stash') host.innerHTML = seg + skeleton(4);
    else if (st.faMode === 'ros' && d) host.innerHTML = seg + faChips(view) + TR.rosWaiversHtml(d, st.faPos);
    else if (st.faMode === 'ros') host.innerHTML = seg + empty('Rest-of-season numbers are not published yet', 'They arrive with the next refresh.', '⏳');
    else host.innerHTML = seg + waiversHtml(view);
    host.querySelectorAll('[data-fam]').forEach((b) => b.addEventListener('click', () => {
      st.faMode = b.dataset.fam; store.set('lg.faMode', st.faMode); draw(d);
    }));
    host.querySelectorAll('[data-fa]').forEach((b) => b.addEventListener('click', () => { st.faPos = b.dataset.fa; draw(d); }));
  };
  host.innerHTML = skeleton(4);
  if (st.faMode === 'week') draw(null);
  rosData.then((d) => { if (st.sub === 'waivers') draw(d); });
}

function upLine(view, p) {
  const u = waiverUpgrade(view, p);
  return u ? `<div class="upg">+${num(u.by)} over ${esc(u.over)}</div>` : '';
}

function faChips(view) {
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];
  const have = order.filter((x) => view.waivers.some((p) => p.position === x));
  if (st.faPos !== 'ALL' && !have.includes(st.faPos)) st.faPos = 'ALL';
  return `<div class="chips">${['ALL', ...have].map((x) => `<button class="chip ${x === st.faPos ? 'active' : ''}" data-fa="${x}">${x === 'ALL' ? 'All' : x}</button>`).join('')}</div>`;
}

/** How much a free agent would add over the weakest starter at his position
 *  in your best lineup this week: {over: last name, by: points}, or null when
 *  it is under half a point (or nobody of his position starts for you). */
export function waiverUpgrade(view, p) {
  const mine = (view.recommended || []).map((x) => x.player).filter((q) => q && q.position === p.position);
  if (!mine.length) return null;
  const worst = mine.reduce((a, b) => ((b.proj || 0) < (a.proj || 0) ? b : a));
  const by = (p.proj || 0) - (worst.proj || 0);
  return by >= 0.5 ? { over: lastName(worst.name), by } : null;
}

function waiversHtml(view) {
  const chips = faChips(view);
  const list = view.waivers.filter((p) => st.faPos === 'ALL' || p.position === st.faPos).slice(0, 25);
  return `${chips}
    <div class="card flush"><h2>Best available</h2><div class="list">
    ${list.map((p) => playerRow(p, {
      attrs: p.player_id && ['QB', 'RB', 'WR', 'TE'].includes(p.position) ? `data-player="${esc(p.player_id)}"` : '',
      sub: `${esc(p.team || '')}${versus(p.team, p.opponent) ? ` ${esc(versus(p.team, p.opponent))}` : ''}${upLine(view, p)}`,
      right: `<div class="pts">${num(p.proj)}<small>proj</small></div>`,
    })).join('') || '<p class="muted" style="padding:12px;margin:0">Nobody projected at this position is available.</p>'}
    </div></div><p class="note">Unrostered in this league, ranked by this week's projection under its scoring. The green line is what he'd add this week over the weakest starter at his position in your best lineup.</p>`;
}
/** Standings; with `odds` (Map rosterId -> {playoff}) a playoff % column. */
function standingsCard(rows, odds = null) {
  const po = odds && [...odds.values()].some((o) => o.playoff != null);
  return `<div class="card flush" id="lg-standings"><h2>Standings</h2><table class="tbl"><thead><tr><th>#</th><th>Team</th><th class="r">W-L</th><th class="r">PF</th>${po ? '<th class="r">Playoffs</th>' : ''}</tr></thead>
    ${foldedTable(rows.map((t, i) => `<tr class="${t.mine ? 'me' : ''}"><td class="faint">${i + 1}</td><td>${esc(t.team)}</td>
      <td class="r">${rec(t)}</td><td class="r">${num(t.points_for)}</td>${po ? `<td class="r">${pct((odds.get(t.roster_id) || {}).playoff)}</td>` : ''}</tr>`), rows.findIndex((t) => t.mine))}</table></div>`;
}

function leagueHtml(host, ctx, sl, mine, extra = Promise.resolve(null)) {
  host.innerHTML = skeleton(4);
  // Computing every matchup is the heaviest thing the app does; yield first so
  // the tab switch paints immediately.
  setTimeout(() => {
    let ms = [];
    try { ms = E.leagueMatchups(weekFor(sl.league.league_id, ctx.week), sl); } catch (err) { console.error(err); }
    const users = Object.fromEntries((sl.users || []).map((u) => [u.user_id, u]));
    const standings = (sl.rosters || []).map((r) => ({ team: E.teamName(r, users), roster_id: r.roster_id, ...E.record(r) }))
      .sort((a, b) => (b.wins - a.wins) || (b.points_for - a.points_for));
    // Your own matchup first; the rest of a big league's fold away.
    const isMine = (m) => [m.home.roster_id, m.away.roster_id].includes(mine);
    ms.sort((a, b) => (isMine(b) ? 1 : 0) - (isMine(a) ? 1 : 0));
    const KEEP_MS = 4, foldMs = ms.length > KEEP_MS + 2;
    host.innerHTML = `<div class="card flush fold-list"><h2>Week ${ctx.meta.week} matchups</h2>
      ${ms.map((m, k) => `<div class="prow${foldMs && k >= KEEP_MS ? ' more' : ''}" style="display:block">
        <div class="row" style="justify-content:space-between"><span class="${m.home.roster_id === mine ? '' : 'muted'}" style="font-weight:600">${esc(m.home.team)}</span><span class="tabular">${num(m.home.proj)}</span></div>
        <div class="winbar" style="margin:6px 0"><span class="me" style="width:${(m.p_home * 100).toFixed(1)}%"></span><span class="op" style="flex:1"></span></div>
        <div class="row" style="justify-content:space-between"><span class="${m.away.roster_id === mine ? '' : 'muted'}" style="font-weight:600">${esc(m.away.team)}</span><span class="tabular">${num(m.away.proj)}</span></div>
        <div class="faint" style="font-size:12px;margin-top:4px">${pct(m.p_home)} – ${pct(1 - m.p_home)}</div>
      </div>`).join('') || '<p class="muted" style="padding:12px;margin:0">No matchups this week.</p>'}
      ${foldMs ? `<div style="text-align:center"><button class="link-btn" data-fold>Show all ${ms.length}</button></div>` : ''}</div>
      ${standingsCard(standings.map((s) => ({ ...s, mine: s.roster_id === mine })))}`;
    // Playoff odds and power rankings (rest of season), on top once ready,
    // and a playoff % column in the standings.
    extra.then((x) => {
      if (!x || st.sub !== 'league' || !host.isConnected) return;
      if (x.odds) {
        const card = host.querySelector('#lg-standings');
        if (card) card.outerHTML = standingsCard(standings.map((s) => ({ ...s, mine: s.roster_id === mine })), x.odds);
      }
      if (x.html) host.insertAdjacentHTML('afterbegin', x.html);
    }).catch((err) => console.error(err));
  }, 30);
}

// --------------------------------------------------------------- recap
async function recap(host, ctx, sl, rid) {
  host.innerHTML = skeleton(4);
  const m = ctx.meta;
  const start = Number((sl.league.settings || {}).start_week || 1);
  let last = Number(m.last_completed_week || 0);
  if (m.games_remaining) last = Math.min(last, m.week - 1);
  const weeks = [];
  for (let w = start; w <= last; w++) weeks.push(w);
  if (!weeks.length) { host.innerHTML = '<div class="ok-box">No finished weeks yet. Each week appears here once all its games are final.</div>'; return; }

  const rows = [];
  for (const w of weeks) {
    try {
      const wk = await ctx.loadWeek(w);
      const mu = await pastMatchups(sl.league.league_id, ctx, w, wk);
      const r = E.recapWeek(weekFor(sl.league.league_id, wk), sl, mu || [], rid);
      if (r) rows.push({ week: w, ...r });
    } catch (err) { console.warn('recap', w, err); }
  }
  if (!rows.length) { host.innerHTML = '<div class="ok-box">No finished weeks for this team yet.</div>'; return; }
  if (!rows.some((r) => r.week === st.recapWeek)) st.recapWeek = rows[rows.length - 1].week;
  const draw = () => {
    const tot = rows.reduce((a, r) => ({ bench: a.bench + (r.optimal - r.points), model: a.model + (r.model - r.points) }), { bench: 0, model: 0 });
    const d = rows.find((r) => r.week === st.recapWeek);
    host.innerHTML = `<div class="card flush"><h2>Season so far</h2><div class="scroll-x"><table class="tbl fit">
      <thead><tr><th>Wk</th><th>Opponent</th><th class="r">Score</th><th class="r">Best</th><th class="r">Model</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-tap data-week="${r.week}" class="${r.week === st.recapWeek ? 'active' : ''}">
        <td class="faint">${r.week}</td>
        <td class="clip">${r.result ? `<span class="badge ${r.result.toLowerCase()}">${r.result}</span> ` : ''}${esc(r.opponent || '—')}</td>
        <td class="r"><strong>${num(r.points)}</strong><div class="faint" style="font-size:11.5px">${num(r.opp_points)}</div></td>
        <td class="r">${num(r.optimal)}</td><td class="r">${signed(r.model - r.points)}</td></tr>`).join('')}</tbody></table></div>
      <p class="note" style="padding:0 14px 14px">Left on the bench this season: <strong>${num(tot.bench)}</strong> pts. ${Math.abs(tot.model) < 0.05 ? "The model's lineups would have scored the same as yours" : `The model's lineups would have scored <strong>${num(Math.abs(tot.model))}</strong> ${tot.model > 0 ? 'more' : 'fewer'} than yours`}, using its projections from before each kickoff.${rows.some((r) => r.projected_partial) ? ' Kickers, defences and IDP were projected from week 3.' : ''}</p></div>
      ${d ? `<div class="card"><h2>Week ${d.week}${d.opponent ? ` vs ${esc(d.opponent)}` : ''}</h2>
        ${d.swaps.length ? d.swaps.map((c) => `<div class="change"><span class="slot">${esc(c.slot)}</span>
          <span>Model: <strong>${esc(c.start.name)}</strong> (${num(c.start.actual ?? 0)})${c.bench ? ` over ${esc(c.bench.name)} (${num(c.bench.actual ?? 0)})` : ''}</span>
          <span class="gain">${signed(c.net)}</span></div>`).join('') : '<div class="ok-box">You started the same lineup the model would have.</div>'}
      </div>
      <div class="card flush"><div class="list">${d.lineup.map((x) => {
        const p = x.player;
        if (!p) return `<div class="prow"><span class="slot">${esc(x.label)}</span><div class="pmain muted">Empty</div></div>`;
        const diff = p.proj != null ? (p.actual || 0) - p.proj : null;
        return `<div class="prow"><span class="slot">${esc(x.label)}</span>${avatar(p)}
          <div class="pmain"><div class="pname">${posPill(p.position)}<span class="n">${esc(p.name)}</span></div>
          <div class="pline">proj ${p.proj != null ? num(p.proj) : '—'}</div></div>
          <div class="pright"><div class="pts">${num(p.actual ?? 0)}</div>${diff != null ? signed(diff) : ''}</div></div>`;
      }).join('')}</div></div>
      ${d.bench.filter((p) => (p.actual || 0) > 0).length ? `<p class="note">Top of the bench: ${d.bench.filter((p) => (p.actual || 0) > 0).slice(0, 4).map((p) => `${esc(p.name)} <strong>${num(p.actual)}</strong>`).join(' · ')}</p>` : ''}` : ''}`;
    host.querySelectorAll('[data-week]').forEach((tr) => tr.addEventListener('click', () => { st.recapWeek = Number(tr.dataset.week); draw(); }));
  };
  draw();
}

// ------------------------------------------------------------- setup
function onboarding(userErr) {
  return `<div class="card">
      <h2>Connect your leagues</h2>
      <p class="muted" style="margin:0 0 12px;font-size:14px">Enter your Sleeper username to bring in all your leagues. No password — the app can only read.</p>
      ${userErr ? `<div class="warn-box" style="margin-bottom:12px">${esc(userErr.message)}</div>` : ''}
      <label class="field"><span>Sleeper username</span>
        <input type="text" id="su-name" value="${esc(cfg.username)}" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="e.g. your_sleeper_name"></label>
      <button class="btn primary block" id="su-save">Find my leagues</button>
    </div>
    <div class="card">
      <h2>Or add any league</h2>
      <p class="muted" style="margin:0 0 12px;font-size:14px">Paste a Sleeper or ESPN league ID or link — it doesn't have to be yours. ESPN leagues need to be viewable to the public.</p>
      <div class="row"><input class="grow" type="text" id="su-add" inputmode="url" autocapitalize="none" autocorrect="off" placeholder="League ID or link">
        <button class="btn" id="su-add-btn">Add</button></div>
    </div>`;
}

async function addLeague(text, ctx) {
  // ESPN: an espn.com league link, "espn 12345", or a short number (Sleeper
  // league IDs are 18-19 digits, ESPN's up to about 10).
  const id = ES.parseLeagueId(text) || SL.parseLeagueId(text);
  if (!id) throw new Error('That doesn’t look like a Sleeper or ESPN league ID or link.');
  const lg = await leagueMeta(id, ctx, { force: true });
  if (!lg) throw new Error(`${sourceName(id)} has no league with that ID.`);
  cfg.added = [...new Set([...cfg.added, id])];
  cfg.hidden = cfg.hidden.filter((h) => h !== id);
  cfg.current = id;
  return lg;
}

function wireSetup(host, ctx, done) {
  const rerender = done || (() => ctx.rerender());
  const save = host.querySelector('#su-save');
  if (save) save.addEventListener('click', async () => {
    const name = host.querySelector('#su-name').value.trim();
    save.disabled = true;
    try {
      if (name) {
        const u = await SL.user(name, { force: true });
        if (!u || !u.user_id) throw new Error(`Sleeper has no user named “${name}”.`);
      }
      cfg.username = name;
      toast(name ? `Connected as ${name}` : 'Username cleared');
      rerender();
    } catch (err) { toast(err.message, 3500); } finally { save.disabled = false; }
  });
  const add = host.querySelector('#su-add-btn');
  if (add) add.addEventListener('click', async () => {
    add.disabled = true;
    try { const lg = await addLeague(host.querySelector('#su-add').value, ctx); toast(`Added ${lg.name}`); rerender(); }
    catch (err) { toast(err.message, err instanceof ES.PrivateLeague ? 9000 : 3500); } finally { add.disabled = false; }
  });
}

async function manage(ctx, done) {
  const body = ctx.openSheet(skeleton(3));
  const { leagues } = await leagueList(ctx);
  const hiddenIds = cfg.hidden;
  body.innerHTML = `<h3 style="margin-bottom:14px">Your leagues</h3>
    <label class="field"><span>Sleeper username</span>
      <div class="row"><input class="grow" type="text" id="su-name" value="${esc(cfg.username)}" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="optional">
      <button class="btn" id="su-save">Save</button></div></label>
    <div class="card flush league-list"><div class="list">
      ${leagues.map((l) => `<div class="prow"><div class="pmain"><div class="pname"><span class="n">${esc(l.name)}</span></div>
        <div class="pline">${esc(sourceName(l.league_id))} · ${esc(E.FORMAT[(l.settings || {}).type] || 'League')} · ${l.total_rosters} teams${cfg.added.includes(l.league_id) && !ES.isEspn(l.league_id) ? ' · added by ID' : ''}</div></div>
        <button class="x" data-remove="${esc(l.league_id)}" aria-label="Remove ${esc(l.name)}">✕</button></div>`).join('') || '<p class="muted" style="padding:12px;margin:0">No leagues yet.</p>'}
    </div></div>
    ${hiddenIds.length ? `<button class="btn block" id="su-unhide" style="margin-bottom:12px">Show ${hiddenIds.length} removed league${hiddenIds.length > 1 ? 's' : ''} again</button>` : ''}
    <label class="field"><span>Add any Sleeper or ESPN league by ID or link</span>
      <div class="row"><input class="grow" type="text" id="su-add" inputmode="url" autocapitalize="none" autocorrect="off" placeholder="League ID, sleeper.com or espn.com link">
      <button class="btn" id="su-add-btn">Add</button></div></label>
    <p class="note">Read-only: this app can look at a league but can never change anything in it. Your username and leagues are saved on this phone only. ESPN leagues must be viewable to the public (League Settings → Basic Settings); the app never asks for an ESPN login.</p>`;
  const finish = () => { ctx.closeSheet(); done(); };
  wireSetup(body, ctx, finish);
  body.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.remove;
    cfg.added = cfg.added.filter((x) => x !== id);
    cfg.hidden = [...new Set([...cfg.hidden, id])];
    b.closest('.prow').remove();
    toast('League removed');
    done();
  }));
  const unhide = body.querySelector('#su-unhide');
  if (unhide) unhide.addEventListener('click', () => { cfg.hidden = []; finish(); });
}
