// News: two weeks of headlines from the free RSS feeds, tagged with the kind
// of news and the players it mentions. Searchable by player or any word, with
// the matches highlighted; tapping a headline opens the story at its source.

import { esc, timeAgo, store, empty, avatar, posPill, statusTag, num } from '../ui.js';

const IMPACTS = [['all', 'All'], ['injury', 'Injury'], ['transaction', 'Moves'], ['usage', 'Usage']];
const st = { impact: store.get('news.impact', 'all'), favOnly: false, q: '', player: null };
let newsPromise = null;
let newsVersion = null;

export async function loadNews(ctx) {
  const v = (ctx.meta.files || {})['news.json'];
  if (!newsPromise || newsVersion !== v) {
    newsVersion = v;
    newsPromise = ctx.loadFile('news.json').catch(() => []);
  }
  return newsPromise;
}

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Escape text for HTML, wrapping every occurrence of any term in <mark>. */
function highlight(text, terms) {
  const t = String(text ?? '');
  const words = (terms || []).filter((w) => w && w.length >= 2);
  if (!words.length) return esc(t);
  const re = new RegExp(`(${words.map(reEscape).join('|')})`, 'gi');
  return t.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

/** What a search matches: the words themselves, plus -- when it names a
 *  projected player -- that player, so his tagged articles count too. */
function interpret(ctx, q) {
  const text = q.trim().toLowerCase();
  if (!text) return { terms: [], players: [] };
  const players = ctx.week.order.filter((p) => p.name.toLowerCase().includes(text)).slice(0, 5);
  const terms = [text];
  // A full-name search also highlights his surname on its own ("Metcalf").
  for (const p of players) {
    if (p.name.toLowerCase() === text) terms.push(p.name.split(' ').slice(-1)[0]);
  }
  return { terms, players };
}

function matches(n, text, playerIds) {
  if (!text) return true;
  if ((n.players || []).some((id) => playerIds.has(id))) return true;
  return `${n.title} ${n.summary || ''} ${n.source}`.toLowerCase().includes(text);
}

export function newsItem(ctx, n, terms = []) {
  const tags = (n.players || []).map((id) => ctx.week.players.get(id)).filter(Boolean)
    .map((p) => `<span class="ptag" data-player="${esc(p.id)}">${highlight(p.name, terms)}</span>`).join('');
  const safe = /^https?:\/\//i.test(n.link || '') ? n.link : null;
  return `<a class="news-item" ${safe ? `href="${esc(safe)}" target="_blank" rel="noopener noreferrer"` : ''}>
    <div class="h">${highlight(n.title, terms)}</div>
    ${n.summary ? `<div class="s">${highlight(n.summary, terms)}</div>` : ''}
    <div class="m"><span class="imp imp-${esc(n.impact || 'general')}">${esc(n.impact === 'transaction' ? 'move' : n.impact || 'news')}</span>
      <span>${esc(n.source)} · ${esc(timeAgo(n.t))}</span>${tags}</div></a>`;
}

/** A player's articles: tagged with him, or naming him in the headline or teaser. */
export async function articlesFor(ctx, id) {
  const all = await loadNews(ctx);
  const p = ctx.week.players.get(id);
  const name = p ? p.name.toLowerCase() : null;
  return all.filter((n) => (n.players || []).includes(id)
    || (name && `${n.title} ${n.summary || ''}`.toLowerCase().includes(name)));
}

/** The latest few headlines for his card, and a way to see them all. */
export async function newsFor(ctx, id, limit = 3) {
  const mine = await articlesFor(ctx, id);
  if (!mine.length) return '';
  return `<div class="section-title">News <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:600">· ${mine.length} article${mine.length > 1 ? 's' : ''} in the last two weeks</span></div>
    <div class="card flush"><div class="list">${mine.slice(0, limit).map((n) => newsItem(ctx, n)).join('')}</div></div>
    ${mine.length > limit ? `<button class="btn block" data-all-news="${esc(id)}">See all ${mine.length} articles</button>` : ''}`;
}

/** Open the News tab filtered to one player. */
export function showPlayer(ctx, id) {
  const p = ctx.week.players.get(id);
  st.q = p ? p.name : '';
  st.impact = 'all';
  st.favOnly = false;
  ctx.go('news');
}

export async function render(host, ctx) {
  const all = await loadNews(ctx);
  host.innerHTML = `
    <input type="search" id="nw-q" placeholder="Search a player, team or word" value="${esc(st.q)}" autocomplete="off" autocorrect="off" spellcheck="false">
    <div class="chips" style="margin-top:10px">${IMPACTS.map(([k, l]) => `<button class="chip ${k === st.impact ? 'active' : ''}" data-imp="${k}">${l}</button>`).join('')}
      <button class="chip ${st.favOnly ? 'active' : ''}" data-fav>★ Favorites</button></div>
    <div id="nw-list"></div>`;
  const list = host.querySelector('#nw-list');

  const draw = () => {
    const text = st.q.trim().toLowerCase();
    const { terms, players } = interpret(ctx, st.q);
    const ids = new Set(players.map((p) => p.id));
    const rows = all.filter((n) => (st.impact === 'all' || n.impact === st.impact)
      && (!st.favOnly || (n.players || []).some((id) => ctx.favorites.has(id)))
      && matches(n, text, ids));
    // When the search names one player, show him at the top.
    const who = players.length === 1 ? players[0] : null;
    list.innerHTML = `
      ${who ? `<div class="card flush"><div class="prow" data-player="${esc(who.id)}">${avatar({ ...who, position: who.pos })}
        <div class="pmain"><div class="pname">${posPill(who.pos)}<span class="n">${esc(who.name)}</span>${statusTag(who.status, who.injury)}</div>
        <div class="pline">${esc(who.team)}${who.opp ? ` vs ${esc(who.opp)}` : ''} · ${rows.length} article${rows.length === 1 ? '' : 's'}</div></div>
        <div class="pright"><div class="pts">${num(who.ppr)}<small>proj</small></div></div></div></div>`
        : text ? `<p class="faint" style="margin:0 4px 8px;font-size:13px">${rows.length} article${rows.length === 1 ? '' : 's'}</p>` : ''}
      ${rows.length ? `<div class="card flush"><div class="list">${rows.slice(0, 150).map((n) => newsItem(ctx, n, terms)).join('')}</div></div>
        <p class="note">Headlines from ESPN, CBS Sports, Yahoo, ProFootballTalk and Rotowire over the last two weeks. Tap one to read it at the source.</p>`
        : empty(text ? `Nothing on “${st.q.trim()}”` : st.favOnly ? 'No news on your favorites' : 'No news yet',
          text ? 'Try a last name, a team, or fewer words.' : st.favOnly ? 'Star players on their cards to follow them here.' : '', '📰')}`;
    list.querySelectorAll('.ptag[data-player]').forEach((t) => t.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); ctx.openPlayer(t.dataset.player);
    }));
  };
  draw();

  const q = host.querySelector('#nw-q');
  q.addEventListener('input', () => { st.q = q.value; draw(); });
  host.querySelectorAll('[data-imp]').forEach((b) => b.addEventListener('click', () => {
    st.impact = b.dataset.imp; store.set('news.impact', st.impact); render(host, ctx);
  }));
  host.querySelector('[data-fav]').addEventListener('click', () => { st.favOnly = !st.favOnly; render(host, ctx); });
}
