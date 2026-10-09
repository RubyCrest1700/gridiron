// Small rendering helpers shared by every screen (carried over from web/app.js).

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TEAMS = {
  ARI: ['Cardinals', '#c8324f'], ATL: ['Falcons', '#d0283f'], BAL: ['Ravens', '#7a5cd6'],
  BUF: ['Bills', '#2f6fe0'], CAR: ['Panthers', '#1a9ad6'], CHI: ['Bears', '#e0612a'],
  CIN: ['Bengals', '#fb5a1e'], CLE: ['Browns', '#ff5a1f'], DAL: ['Cowboys', '#3d74d6'],
  DEN: ['Broncos', '#fb5a1e'], DET: ['Lions', '#1c8ad0'], GB: ['Packers', '#3a8f63'],
  HOU: ['Texans', '#c8283f'], IND: ['Colts', '#3a6fc0'], JAX: ['Jaguars', '#0f9aa8'],
  KC: ['Chiefs', '#e8303f'], LA: ['Rams', '#3a72e0'], LAR: ['Rams', '#3a72e0'], LAC: ['Chargers', '#1a95dc'],
  LV: ['Raiders', '#a9b1b6'], MIA: ['Dolphins', '#10a3ad'], MIN: ['Vikings', '#8a5cd0'],
  NE: ['Patriots', '#3d62b0'], NO: ['Saints', '#d3bc8d'], NYG: ['Giants', '#3a62c8'],
  NYJ: ['Jets', '#239468'], PHI: ['Eagles', '#16808a'], PIT: ['Steelers', '#ffb612'],
  SEA: ['Seahawks', '#69be28'], SF: ['49ers', '#d02a2a'], TB: ['Buccaneers', '#e0301e'],
  TEN: ['Titans', '#4b92db'], WAS: ['Commanders', '#b33a3a'],
};
const ESPN_ABBR = { LA: 'lar', WAS: 'wsh' };
export const teamColor = (t) => (TEAMS[t] || [])[1] || '#4f8ef7';
export const teamName = (t) => (TEAMS[t] || [])[0] || t || '';
const logoUrl = (t) => (t ? `https://a.espncdn.com/i/teamlogos/nfl/500/${ESPN_ABBR[t] || String(t).toLowerCase()}.png` : '');

export function logo(t, cls = '') {
  if (!t) return '';
  return `<img class="logo ${cls}" src="${logoUrl(t)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}

const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('');

/** NFL.com headshots are served full size (about 4 MB each); ask their image
 *  host for a face-cropped thumbnail instead (about 6 KB). */
export function thumb(url, px = 120) {
  if (!url) return url;
  return String(url).replace('/image/upload/f_auto,q_auto/', `/image/upload/c_fill,g_face,w_${px},h_${px},f_auto,q_auto/`);
}

/** Headshot in a ring of the team colour; team logo for defences; initials
 *  when there is no photo. */
export function avatar(p, size = '') {
  const ring = `--ring:${teamColor(p.team)}`;
  if (p.position === 'DEF' || p.pos === 'DEF') {
    return `<span class="avatar ${size} def" style="${ring}">${logo(p.team)}</span>`;
  }
  const sid = p.sleeper_id && /^\d+$/.test(String(p.sleeper_id)) ? p.sleeper_id : null;
  const url = thumb(p.img, size === 'lg' ? 192 : 120)
    || (sid ? `https://sleepercdn.com/content/nfl/players/thumb/${sid}.jpg` : null);
  const ini = esc(initials(p.name));
  return url
    ? `<span class="avatar ${size}" style="${ring}"><img src="${esc(url)}" alt="" loading="lazy"
         onerror="this.nextElementSibling.hidden=false;this.remove()"><span hidden>${ini}</span></span>`
    : `<span class="avatar ${size}" style="${ring}"><span>${ini}</span></span>`;
}

/** The last name as printed in tight spots: "Luther Burden III" is Burden. */
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
export function lastName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  while (parts.length > 1 && SUFFIX.test(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1] || '';
}

// This week's games, set once the schedule is loaded: who is at home, and who
// has no game at all (a bye). Until then nothing is called a bye.
let homeTeams = null, playing = null;
export function setWeekGames(games) {
  homeTeams = new Set(); playing = new Set();
  for (const g of games || []) { homeTeams.add(g.home); playing.add(g.home); playing.add(g.away); }
}
/** "vs DAL" at home, "@ DAL" away, "Bye" with no game this week. */
export function versus(team, opp) {
  if (opp) return `${homeTeams && team && !homeTeams.has(team) ? '@' : 'vs'} ${opp}`;
  return team && playing && playing.size && !playing.has(team) ? 'Bye' : '';
}

/** Table body for a long league table: the top `keep` rows, your own row
 *  always in view, the rest behind one button (main.js toggles `.fold`).
 *  `rows` are <tr> strings; `meIdx` is yours, or -1. Short tables come back whole. */
export function foldedTable(rows, meIdx = -1, keep = 8) {
  if (rows.length <= keep + 4) return `<tbody>${rows.join('')}</tbody>`;
  const mine = meIdx >= keep ? rows[meIdx].replace('<tr', '<tr data-dup').replace(/<tr data-dup( class="([^"]*)")?/, (m, _c, cls) => `<tr class="${cls ? `${cls} ` : ''}dup"`) : '';
  return `<tbody>${rows.slice(0, keep).join('')}${mine}</tbody><tbody class="more">${rows.slice(keep).join('')}</tbody>
    <tfoot><tr><td colspan="9"><button class="link-btn" data-fold>Show all ${rows.length}</button></td></tr></tfoot>`;
}

export const posPill = (pos) => (pos ? `<span class="pos pos-${esc(pos)}">${esc(pos)}</span>` : '');

export function statusTag(status, bodyPart) {
  if (!status || status === 'Active') return '';
  const label = bodyPart ? `${status} · ${bodyPart}` : status;
  const cls = String(status).toLowerCase().replace(/[^a-z]/g, '');
  return `<span class="tag tag-${cls}" title="${esc(label)}">${esc(status === 'Questionable' ? 'Q' : status === 'Doubtful' ? 'D' : status)}</span>`;
}

export function fmtKickoff(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  if (isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export const pct = (x) => `${Math.round(100 * (x ?? 0))}%`;
export const num = (x, d = 1) => (x == null || Number.isNaN(Number(x)) ? '—' : Number(x).toFixed(d));
export const signed = (x, d = 1) => {
  const v = Number(x || 0);
  const cls = v > 0.05 ? 'good' : v < -0.05 ? 'bad' : 'muted';
  return `<span class="delta ${cls}">${v > 0 ? '+' : ''}${v.toFixed(d)}</span>`;
};

/** Floor-to-ceiling bar on a fixed 0-40 point scale, so bars compare across rows. */
const RANGE_MAX = 40;
export function rangeBar(range, mid, team) {
  if (!range) return '';
  const x = (v) => Math.max(0, Math.min(100, (v / RANGE_MAX) * 100));
  return `<div class="range"><span class="band" style="left:${x(range.p10)}%;width:${Math.max(2, x(range.p90) - x(range.p10))}%;background:${teamColor(team)}"></span>
    <span class="tick" style="left:calc(${x(mid ?? range.p50 ?? 0)}% - 1px)"></span></div>`;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export const skeleton = (n = 6) => `<div class="skel">${'<div class="skel-row"></div>'.repeat(n)}</div>`;

export function empty(title, body = '', icon = '🏈') {
  return `<div class="empty"><div class="icon">${icon}</div><h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ''}</div>`;
}

/** Local storage that never throws (private mode, full storage). */
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(`gm.${key}`); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`gm.${key}`, JSON.stringify(value)); } catch (_) { /* ignore */ }
  },
  del(key) { try { localStorage.removeItem(`gm.${key}`); } catch (_) { /* ignore */ } },
};

/** A player row, the unit most screens are built from. */
export function playerRow(p, { right = '', sub = '', attrs = '' } = {}) {
  return `<div class="prow" ${attrs}>
    ${avatar(p)}
    <div class="pmain">
      <div class="pname">${posPill(p.position || p.pos)}<span class="n">${esc(p.name)}</span>${statusTag(p.status, p.injury)}</div>
      <div class="pline">${sub}</div>
    </div>
    <div class="pright">${right}</div>
  </div>`;
}

// ------------------------------------------------------------- dropdowns
// A pill that opens a small menu in the app's own style, in place of the
// system picker wheel. options: [[value, label, note?]].
const CHEVRON = '<svg class="dd-chev" viewBox="0 0 20 20"><path d="M6 8l4 4 4-4"/></svg>';
const CHECK = '<svg class="dd-check" viewBox="0 0 20 20"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';

export function dropdown(id, options, value, { prefix = '', cls = '', placeholder = 'Choose…', label = '' } = {}) {
  const cur = options.find(([v]) => String(v) === String(value ?? ''));
  return `<button type="button" class="dd ${cls}" id="${esc(id)}" data-value="${esc(value ?? '')}" aria-haspopup="listbox"${label ? ` aria-label="${esc(label)}"` : ''}>
    <span class="dd-label">${prefix ? `<span class="dd-prefix">${esc(prefix)}</span>` : ''}${esc(cur ? cur[1] : placeholder)}</span>${CHEVRON}</button>`;
}

export function onPick(btn, options, onChange) {
  btn.addEventListener('click', () => openMenu(btn, options, btn.dataset.value, (v) => {
    if (String(v) === btn.dataset.value) return;
    btn.dataset.value = v;
    onChange(String(v));
  }));
}

function openMenu(anchor, options, value, pick) {
  const back = document.createElement('div');
  back.className = 'menu-backdrop';
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'listbox');
  menu.innerHTML = options.map(([v, l, note]) => {
    const on = String(v) === String(value);
    return `<button type="button" role="option" aria-selected="${on}" class="${on ? 'on' : ''}" data-v="${esc(v)}">
      <span class="menu-l">${esc(l)}</span>${note ? `<span class="menu-note">${esc(note)}</span>` : ''}${on ? CHECK : '<span class="dd-check"></span>'}</button>`;
  }).join('');
  document.body.append(back, menu);

  // Below the pill when there is room, otherwise above it.
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight, pad = 12;
  const width = Math.min(Math.max(r.width, 220), vw - 2 * pad);
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.min(Math.max(r.left, pad), vw - width - pad)}px`;
  const below = vh - r.bottom - 90, above = r.top - 70;
  if (below >= Math.min(menu.scrollHeight, 240) || below >= above) {
    menu.style.top = `${r.bottom + 6}px`; menu.style.maxHeight = `${Math.max(below, 140)}px`;
  } else {
    menu.style.bottom = `${vh - r.top + 6}px`; menu.style.maxHeight = `${above}px`; menu.classList.add('up');
  }
  const sel = menu.querySelector('.on');
  if (sel) sel.scrollIntoView({ block: 'nearest' });

  const close = () => { back.remove(); menu.remove(); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  back.addEventListener('click', close);
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    close();
    pick(b.dataset.v);
  });
}
