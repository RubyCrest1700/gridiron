// The trade calculator's picker: each side of a trade is a row of chips, and
// "+ Add" opens a searchable list in the sheet. The long rosters live there,
// so the verdict stays on screen under the chips.
//
// An item is {id, name, pos, line, rid, owner}: a player or a draft pick, the
// team that has it, and one line of what it is worth.

import { esc, posPill, toast } from '../ui.js';

const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'PK'];
const POS_LABEL = { ALL: 'All', PK: 'Picks' };
const MAX_ROWS = 60;

/** Items of one position ('ALL' for any) whose name has every word typed. */
export function matchItems(items, q, pos = 'ALL') {
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => (pos === 'ALL' || it.pos === pos)
    && words.every((w) => it.name.toLowerCase().includes(w)));
}

const pill = (it) => (it.pos === 'PK' ? '<span class="pos pos-PK">PK</span>' : posPill(it.pos));

/** One side of the trade: what's on it as removable chips, then "+ Add". */
export function sideHtml(side, label, items, addLabel) {
  return `<div class="tside"><div class="tside-h">${esc(label)}</div><div class="tchips">
    ${items.map((it) => `<button class="tchip" data-rm="${side}" data-sid="${esc(it.id)}" aria-label="Remove ${esc(it.name)}">${pill(it)}<span class="n">${esc(it.name)}</span><span class="x">✕</span></button>`).join('')}
    <button class="tchip add" data-add="${side}">+ ${esc(addLabel)}</button></div></div>`;
}

/** Open the picker. o: {title, from (whose list this is), placeholder,
 *  items() -> the default list, wide() -> every item a search may reach (or
 *  null), chosen() -> Set of ids, toggle(item), onClose()}. */
export function openPicker(ctx, o) {
  const s = { q: '', pos: 'ALL' };
  const body = ctx.openSheet(`<div class="pk-head"><h3>${esc(o.title)}</h3>
      <input type="search" id="pk-q" placeholder="${esc(o.placeholder)}" autocomplete="off" autocorrect="off" spellcheck="false">
      <div class="chips" id="pk-pos"></div></div>
    <div id="pk-list"></div>
    <div class="pk-foot"><button class="btn primary block" id="pk-done">Done</button></div>`, { onClose: o.onClose });
  let wideItems = null;
  const paint = () => {
    const searching = !!(o.wide && s.q.trim());
    if (searching && !wideItems) wideItems = o.wide();
    const src = searching ? wideItems : o.items();
    const have = POS_ORDER.filter((p) => src.some((it) => it.pos === p));
    if (s.pos !== 'ALL' && !have.includes(s.pos)) s.pos = 'ALL';
    const hits = matchItems(src, s.q, s.pos);
    const chosen = o.chosen();
    body.querySelector('#pk-pos').innerHTML = ['ALL', ...have].map((p) =>
      `<button class="chip ${p === s.pos ? 'active' : ''}" data-pos="${p}">${POS_LABEL[p] || p}</button>`).join('');
    body.querySelector('#pk-list').innerHTML = `<div class="tside-h">${searching ? 'Whole league' : esc(o.from())}</div>
      <div class="card flush list pk-list">${hits.slice(0, MAX_ROWS).map((it) => `<div class="prow tr-row ${chosen.has(it.id) ? 'on' : ''}" data-id="${esc(it.id)}">
        <div class="pmain"><div class="pname">${pill(it)}<span class="n">${esc(it.name)}</span></div>
        <div class="pline">${it.line}${searching ? ` · <strong>${esc(it.owner)}</strong>` : ''}</div></div>
        <div class="pright">${chosen.has(it.id) ? '✓' : '+'}</div></div>`).join('')
        || '<p class="muted" style="padding:12px;margin:0">Nobody matches.</p>'}</div>
      ${hits.length > MAX_ROWS ? `<p class="note">Showing the first ${MAX_ROWS}. Type a name to narrow it down.</p>` : ''}`;
    const n = chosen.size;
    body.querySelector('#pk-done').textContent = n ? `Done · ${n} selected` : 'Done';
    body.querySelectorAll('[data-pos]').forEach((b) => b.addEventListener('click', () => { s.pos = b.dataset.pos; paint(); }));
    body.querySelectorAll('.tr-row').forEach((row) => row.addEventListener('click', () => {
      const it = src.find((x) => x.id === row.dataset.id);
      if (!it) return;
      const note = o.toggle(it);
      if (note) toast(note);
      paint();
    }));
  };
  body.querySelector('#pk-q').addEventListener('input', (e) => { s.q = e.target.value; paint(); });
  body.querySelector('#pk-done').addEventListener('click', () => ctx.closeSheet());
  paint();
}
