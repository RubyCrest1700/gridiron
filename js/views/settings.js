// Settings & info: opened from the gear in the header. How the model is
// doing, install help, and the data this phone keeps.

import { esc, num, pct, store, toast, skeleton } from '../ui.js';

let accPromise = null;

export async function openSettings(ctx) {
  const host = ctx.openSheet(skeleton(4));
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (!accPromise) accPromise = ctx.loadFile('accuracy.json').catch(() => null);
  const acc = await accPromise;
  const weeks = (acc && acc.weeks) || [];
  const tot = weeks.reduce((a, w) => ({ props: a.props + (w.props || 0), m: a.m + (w.model_mae || 0) * (w.props || 0),
    l: a.l + (w.line_mae || 0) * (w.props || 0) }), { props: 0, m: 0, l: 0 });
  const m = ctx.meta;

  host.innerHTML = `
    <div class="ph"><h3>Settings &amp; info</h3></div>

    ${standalone ? '' : `<div class="card"><h2>Add to your home screen</h2>
      <ol class="install-steps"><li>Open this page in <strong>Safari</strong>.</li>
      <li>Tap the <strong>Share</strong> button (the square with an arrow).</li>
      <li>Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li></ol>
      <p class="note">It then opens full screen like any app, and keeps the last projections for when you're offline.</p></div>`}

    <div class="card">
      <h2>Projections</h2>
      <div class="kv"><span class="muted">Week</span><span>Week ${esc(m.week)}, ${esc(m.season)}</span></div>
      <div class="kv"><span class="muted">Last updated</span><span>${esc(new Date(m.generated_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span></div>
      <p class="note">The model re-runs on its own as injury news and lines move, most often on game days, and your phone picks up the new numbers whenever you open the app.</p>
      <button class="btn block" id="st-check" style="margin-top:10px">Check for new projections</button>
    </div>

    <div class="card flush">
      <h2>How the model is doing</h2>
      ${weeks.length ? `<table class="tbl"><thead><tr><th>Week</th><th class="r">Avg miss</th><th class="r">In range</th><th class="r">vs line</th></tr></thead>
        <tbody>${weeks.map((w) => `<tr><td>${w.week}</td><td class="r">${num(w.mae)} pts</td><td class="r">${pct(w.in_range)}</td>
          <td class="r">${w.model_mae != null ? `${num(w.model_mae)} / ${num(w.line_mae)}` : '—'}</td></tr>`).join('')}</tbody></table>
        <p class="note" style="padding:0 14px 14px">“Avg miss” is the fantasy-points error on players projected 3+ who played; “in range” is how often the result landed inside the projected 80% range (target 80%).
        “vs line” is the average miss on prop stats, model / sportsbook${tot.props ? ` — ${tot.props} props this season, ${num(tot.m / tot.props)} vs ${num(tot.l / tot.props)}` : ''}. Lower is better.</p>`
        : '<p class="muted" style="padding:0 14px 14px;margin:0">Graded weeks appear here once games are played.</p>'}
    </div>

    <div class="card">
      <h2>On this phone</h2>
      <div class="kv"><span class="muted">Sleeper username</span><span>${esc(store.get('username', '') || '—')}</span></div>
      <div class="kv"><span class="muted">Favorites</span><span>${ctx.favorites.size}</span></div>
      <button class="btn block" id="st-clear" style="margin-top:10px">Clear saved data on this phone</button>
    </div>

    <div class="card">
      <h2>About</h2>
      <p class="note" style="margin:0">Every player is simulated 1,000 times from free public data (nflverse) and the betting market's game lines.
        Leagues are read from Sleeper on your phone and can never be changed from this app. For fun and fantasy research — not betting advice.</p>
    </div>`;

  host.querySelector('#st-check').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Checking…';
    const changed = await ctx.refresh();
    if (!changed) toast('You have the latest projections');
    b.disabled = false; b.textContent = 'Check for new projections';
  });
  host.querySelector('#st-clear').addEventListener('click', async () => {
    if (!window.confirm('Forget your username, leagues, favorites and cached data on this phone?')) return;
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('gm.') || k.startsWith('sl:')).forEach((k) => localStorage.removeItem(k));
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    } catch (_) { /* ignore */ }
    toast('Cleared');
    setTimeout(() => location.reload(), 600);
  });
}
