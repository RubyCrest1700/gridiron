// Favorites: the players you follow, this week, with a search to add more.

import { esc, playerRow, rangeBar, empty, toast } from '../ui.js';
import { playerLine, right } from './week.js';
import { myTeams, rosterModelIds } from './leagues.js';

const st = { q: '' };
const STAR = (on) => `<button class="star ${on ? 'on' : ''}" data-star aria-label="${on ? 'Remove from' : 'Add to'} favorites">${on ? '★' : '☆'}</button>`;

export async function render(host, ctx) {
  host.innerHTML = `
    <input type="search" id="fv-q" placeholder="Add a player: search by name" value="${esc(st.q)}" autocomplete="off" autocorrect="off" spellcheck="false">
    <button class="btn block" id="fv-mine" style="margin-top:10px">☆ Follow everyone on my rosters</button>
    <div id="fv-body" style="margin-top:12px"></div>`;
  const body = host.querySelector('#fv-body');

  const draw = () => {
    const q = st.q.trim().toLowerCase();
    if (q) {
      const hits = ctx.week.order.filter((p) => p.name.toLowerCase().includes(q) || (p.team || '').toLowerCase() === q).slice(0, 25);
      body.innerHTML = hits.length
        ? `<div class="card flush list">${hits.map((p) => playerRow({ ...p, position: p.pos }, {
          attrs: `data-player="${esc(p.id)}"`, sub: playerLine(p), right: STAR(ctx.favorites.has(p.id)) })).join('')}</div>`
        : empty('No players match', 'Try a last name or a team, like “DET”.', '🔎');
      return;
    }
    const ids = [...ctx.favorites];
    const favs = ids.map((id) => ctx.week.players.get(id)).filter(Boolean)
      .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || b.ppr - a.ppr);
    const away = ids.length - favs.length;
    if (!favs.length) {
      body.innerHTML = empty(away ? 'None of your favorites play this week' : 'No favorites yet',
        'Tap the button above to follow everyone on your rosters, search for a player, or tap ☆ Favorite on any player card.', '⭐');
      return;
    }
    const total = favs.reduce((s, p) => s + (p.ppr || 0), 0);
    body.innerHTML = `
      <div class="meta-chips" style="margin:0 0 10px"><span>${favs.length} playing this week</span>${away ? `<span>${away} on bye or not projected</span>` : ''}<span>${total.toFixed(1)} projected pts</span></div>
      <div class="card flush list">${favs.map((p) => playerRow({ ...p, position: p.pos }, {
        attrs: `data-player="${esc(p.id)}"`, sub: `${playerLine(p)}${rangeBar(p.range, p.ppr, p.team)}`, right: right(ctx, p) })).join('')}</div>
      <p class="note">Sorted by kickoff. Open a player to remove him, or to send him to Start/Sit.</p>`;
  };

  host.querySelector('#fv-q').addEventListener('input', (e) => { st.q = e.target.value; draw(); });
  host.querySelector('#fv-mine').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Reading your leagues…';
    let teams = [];
    try { teams = await myTeams(ctx); } catch (_) { teams = []; }
    const ids = rosterModelIds(teams, ctx.week.sleeper || {}, new Set(ctx.week.players.keys()));
    let added = 0;
    for (const id of ids) if (!ctx.favorites.has(id)) { ctx.toggleFavorite(id); added += 1; }
    b.disabled = false; b.textContent = '☆ Follow everyone on my rosters';
    toast(!teams.length ? 'Connect a league first, on the Leagues tab.'
      : added ? `Following ${added} more player${added === 1 ? '' : 's'} from ${teams.length} league${teams.length === 1 ? '' : 's'}.`
        : 'You already follow everyone on your rosters.');
    draw();
  });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-star]');
    if (!b) return;
    e.stopPropagation();
    const id = b.closest('[data-player]').dataset.player;
    ctx.toggleFavorite(id);
    b.outerHTML = STAR(ctx.favorites.has(id));
  });
  draw();
}
