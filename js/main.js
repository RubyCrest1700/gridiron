// App shell: tabs, header, the sheets, and keeping the data current.

import * as D from './data.js';
import { $, $$, esc, toast, timeAgo, skeleton, empty, store, setWeekGames } from './ui.js';
import * as week from './views/week.js';
import * as leagues from './views/leagues.js';
import * as compare from './views/compare.js';
import * as edges from './views/edges.js';
import * as favorites from './views/favorites.js';
import * as news from './views/news.js';
import { renderPlayer } from './views/player.js';
import { openSettings } from './views/settings.js';

const VIEWS = { week, leagues, compare, favorites, news, edges };
const TITLES = { week: 'This Week', leagues: 'My Teams', compare: 'Start / Sit', favorites: 'Favorites', news: 'News', edges: 'Edges' };

export const ctx = {
  meta: null,
  week: null,          // decoded current week (see data.js)
  tab: 'leagues',
  favorites: new Set(store.get('favorites', [])),
  loadWeek: (w) => D.loadWeek(ctx.meta, w),
  loadFile: (name) => D.loadExtraFile(ctx.meta, name),
  go,
  rerender: () => render(),
  refresh,
  openPlayer,
  openSheet,
  closeSheet,
  toggleFavorite(id) {
    if (ctx.favorites.has(id)) ctx.favorites.delete(id); else ctx.favorites.add(id);
    store.set('favorites', [...ctx.favorites]);
    favsChanged = true;
  },
};

function go(tab) {
  if (!VIEWS[tab]) tab = 'leagues';
  if (tab === ctx.tab && VIEWS[tab].home) VIEWS[tab].home();   // tapping the tab again goes back to its top
  if (tab !== 'leagues') { ctx.leagueScoring = null; ctx.leagueDynasty = null; }   // player cards fall back to PPR
  ctx.tab = tab;
  store.set('tab', tab);
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#scroller').scrollTop = 0;
  render();
}

let renderSeq = 0;
let favsChanged = false;
async function render() {
  const host = $('#view');
  const seq = ++renderSeq;
  $('#title').textContent = TITLES[ctx.tab];
  if (!ctx.week) { host.innerHTML = skeleton(8); return; }
  try {
    await VIEWS[ctx.tab].render(host, ctx, () => seq !== renderSeq);
  } catch (err) {
    console.error(err);
    if (seq === renderSeq) host.innerHTML = empty('Something went wrong', esc(err.message), '⚠️');
  }
}

function subtitle() {
  const m = ctx.meta;
  if (!m) return;
  $('#subtitle').textContent = `Week ${m.week} · ${timeAgo(m.generated_at)}`;
}

// ----------------------------------------------------------------- sheet
let sheetOnClose = null;
function sheetClosed() {
  const f = sheetOnClose;
  sheetOnClose = null;
  if (f) f();
}
function openSheet(html, { onClose = null } = {}) {
  sheetClosed();                       // a sheet opened over another closes it
  sheetOnClose = onClose;
  $('#sheetBody').innerHTML = html;
  $('#sheet').scrollTop = 0;
  $('#backdrop').classList.add('open');
  $('#sheet').classList.add('open');
  document.body.style.overflow = 'hidden';
  return $('#sheetBody');
}
function closeSheet() {
  $('#backdrop').classList.remove('open');
  $('#sheet').classList.remove('open');
  document.body.style.overflow = '';
  sheetClosed();
  // Starred or unstarred someone from his card: keep the Favorites list current.
  if (favsChanged && ctx.tab === 'favorites') render();
  favsChanged = false;
}
async function openPlayer(id) {
  const body = openSheet(skeleton(4));
  await renderPlayer(body, ctx, id);
}

// "Show all" on a folded league table or list (ui.foldedTable).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fold]');
  if (!b) return;
  const box = b.closest('.tbl, .fold-list');
  if (!box) return;
  const open = box.classList.toggle('open');
  if (!b.dataset.label) b.dataset.label = b.textContent;
  b.textContent = open ? 'Show fewer' : b.dataset.label;
});

// ------------------------------------------------------------------ data
async function load({ quiet = false } = {}) {
  try {
    const meta = await D.loadMeta();
    const changed = !ctx.meta || meta.generated_at !== ctx.meta.generated_at;
    ctx.meta = meta;
    setWeekGames(meta.games);
    if (changed || !ctx.week) {
      ctx.week = await D.loadWeek(meta, meta.week);
      if (ctx.week && !quiet && changed) toast(`Projections updated ${timeAgo(meta.generated_at)}`);
    }
    subtitle();
    return changed;
  } catch (err) {
    console.error(err);
    if (!ctx.week) $('#view').innerHTML = empty('Could not load projections', `${esc(err.message)}<br>Check your connection and try again.`, '📡');
    else if (!quiet) toast('Offline — showing the last projections downloaded');
    return false;
  }
}

/** Look for a newer publish now; true when there was one. */
async function refresh() {
  const changed = await load();
  if (changed) render();
  return changed;
}

// ------------------------------------------------------------------ boot
async function boot() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  $('#settingsBtn').addEventListener('click', () => ctx.meta && openSettings(ctx));
  $('#backdrop').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);
  // Swipe the sheet down to close it.
  let startY = null;
  $('#sheet').addEventListener('touchstart', (e) => { startY = $('#sheet').scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  $('#sheet').addEventListener('touchend', (e) => {
    if (startY != null && e.changedTouches[0].clientY - startY > 90) closeSheet();
    startY = null;
  }, { passive: true });

  // Scrolling the list puts the keyboard away, as iOS's own apps do, and if
  // iOS nudged the page up for the keyboard, put it back once it closes.
  $('#scroller').addEventListener('touchmove', (e) => {
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT' && e.target !== a) a.blur();
  }, { passive: true });
  document.addEventListener('focusout', () => setTimeout(() => {
    if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
  }, 60));

  // Tapping a player anywhere opens his card.
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-player]');
    if (el && el.dataset.player) { e.preventDefault(); openPlayer(el.dataset.player); }
  });

  const hash = location.hash.replace('#', '');
  // A new install opens on your teams (or the prompt to connect them).
  ctx.tab = VIEWS[hash] ? hash : store.get('tab', 'leagues');
  if (!VIEWS[ctx.tab]) ctx.tab = 'leagues';     // e.g. the old More tab
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ctx.tab));
  render();
  await load({ quiet: true });
  render();

  // Coming back to the app: pick up a newer publish without a manual refresh.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    subtitle();
    // iOS resumes a home-screen app without reloading it, so also look for a
    // newer version of the app itself here, not only at launch.
    if ('serviceWorker' in navigator && !location.pathname.includes('/mobile/')) {
      navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
    }
    if (await load({ quiet: false })) render();
  });
  setInterval(subtitle, 60000);

  if ('serviceWorker' in navigator && !location.pathname.includes('/mobile/')) {
    // When a newly published version of the app takes over, reload once so the
    // new code is what runs (otherwise it would only appear on the next open).
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch((err) => console.warn('service worker', err));
  }
}

boot();
