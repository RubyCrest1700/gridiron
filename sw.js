// Offline support. nflpred/publish.py stamps BUILD with a hash of the app's
// files, so each publish installs a fresh copy of the app shell.
const BUILD = 'c81ff35da0fc';
const SHELL = `shell-${BUILD}`;
const DATA = 'data-v1';
const IMG = 'img-v1';
const SHELL_FILES = ['./', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/main.js', 'js/ui.js', 'js/data.js', 'js/engine.js', 'js/sleeper.js', 'js/espn.js',
  'js/ros.js', 'js/valuer.js', 'js/trade.js', 'js/season.js', 'js/confidence.js', 'js/picks.js', 'js/dynasty.js', 'js/dyntrade.js', 'js/confidence_dynasty.js',
  'js/views/week.js', 'js/views/leagues.js', 'js/views/trades.js', 'js/views/dyntrades.js', 'js/views/compare.js', 'js/views/edges.js',
  'js/views/favorites.js', 'js/views/settings.js', 'js/views/player.js', 'js/views/news.js', 'js/views/game.js', 'js/charts.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache (GitHub Pages allows 10
  // minutes), so a new version never installs a stale copy of a file.
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    }
    // Data files are versioned by URL; keep the cache from growing without bound.
    const data = await caches.open(DATA);
    const keys = await data.keys();
    if (keys.length > 120) for (const r of keys.slice(0, keys.length - 120)) await data.delete(r);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Headshots and logos: from cache when we have them.
  if (url.hostname.endsWith('espncdn.com') || url.hostname.endsWith('nfl.com') || url.hostname.endsWith('sleepercdn.com')) {
    e.respondWith(caches.open(IMG).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; } catch (_) { return Response.error(); }
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;     // Sleeper, ESPN odds: straight to the network

  if (url.pathname.endsWith('/data/meta.json')) {
    // Always try for the newest projections; fall back to the last copy.
    e.respondWith(fetch(req).then((r) => {
      const copy = r.clone(); caches.open(DATA).then((c) => c.put(req.url.split('?')[0], copy)); return r;
    }).catch(() => caches.match(req.url.split('?')[0])));
    return;
  }
  if (url.pathname.includes('/data/')) {
    // Versioned (?v=hash): a given URL never changes, so cache first.
    e.respondWith(caches.open(DATA).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    }));
    return;
  }
  // App shell: cache first, network fallback.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
