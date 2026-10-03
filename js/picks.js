// Draft picks in a Sleeper dynasty league: who owns which, and where the next
// draft's picks will land. Built from Sleeper's traded-picks and drafts lists
// (read by sleeper.js); nothing here touches the network.

export const isPick = (id) => String(id).startsWith('pk:');
const UNDER_WAY = new Set(['drafting', 'paused']);

/** Copies of `drafts`, each one under way given the picks made so far
 *  (`fetchPicks(draftId)` -> list, or null when Sleeper didn't answer). */
export async function withDraftPicks(drafts, fetchPicks) {
  return Promise.all((drafts || []).map(async (d) => {
    if (!UNDER_WAY.has(d.status) || !d.draft_id) return d;
    let made = null;
    try { made = await fetchPicks(String(d.draft_id)); } catch (_) { made = null; }
    return Array.isArray(made) ? { ...d, picks: made } : d;
  }));
}
const two = (n) => String(n).padStart(2, '0');

/**
 * Every pick for the next three drafts. A draft already complete has no
 * picks left (its rookies are on rosters). `slotFn(originalRosterId)` gives
 * the projected slot in the next draft when Sleeper has no order set yet.
 */
export function pickState(L, { rosters = [], traded = [], drafts = [], slotFn = null } = {}) {
  const rounds = Number((L.league.settings || {}).draft_rounds || 0);
  const C = Number(L.league.season);
  // A draft yet to start has all its picks. One under way (a slow draft runs
  // for days) has the picks not yet made: the rookies taken are on rosters
  // already. Its picks made so far come from withDraftPicks; unread, the
  // season drops out rather than count those rookies twice.
  const live = (drafts || []).find((d) => Number(d.season) === C && UNDER_WAY.has(d.status) && Array.isArray(d.picks));
  const pending = !!live || (drafts || []).some((d) => Number(d.season) === C && d.status === 'pre_draft');
  const next = pending ? C : C + 1;
  const ownerOf = new Map();
  for (const t of traded || []) ownerOf.set(`${Number(t.season)}:${Number(t.round)}:${Number(t.roster_id)}`, Number(t.owner_id));
  // A made pick keeps its original column (draft_slot) even when traded.
  const made = new Set();
  if (live) {
    const s2r = live.slot_to_roster_id || {};
    for (const m of live.picks) {
      const orig = Number(s2r[String(m.draft_slot)]);
      if (Number.isFinite(orig)) made.add(`${C}:${Number(m.round)}:${orig}`);
    }
  }
  const list = [];
  if (rounds > 0 && Number.isFinite(C)) {
    for (let s = next; s <= C + 3; s++) {
      for (let r = 1; r <= rounds; r++) {
        for (const orig of L.teams.keys()) {
          const k = `${s}:${r}:${orig}`;
          if (made.has(k)) continue;
          list.push({ id: `pk:${k}`, season: s, round: r, orig, owner: ownerOf.has(k) ? ownerOf.get(k) : orig, slot: null });
        }
      }
    }
  }
  const order = (() => {
    const d = (drafts || []).find((x) => Number(x.season) === next && x.draft_order);
    if (!d) return null;
    const rid = new Map((rosters || []).map((r) => [String(r.owner_id), r.roster_id]));
    const m = new Map();
    for (const [uid, slot] of Object.entries(d.draft_order)) if (rid.has(String(uid))) m.set(rid.get(String(uid)), Number(slot));
    return m;
  })();
  const byId = new Map(list.map((p) => [p.id, p]));
  const info = (id) => {
    const p = byId.get(String(id));
    if (!p) return null;
    if (p.season === next && p.slot === null) p.slot = (order && order.get(p.orig)) || (slotFn ? slotFn(p.orig) : null) || null;
    return p;
  };
  const label = (id, short = false) => {
    const p = info(id);
    if (!p) return String(id);
    const nm = (L.teams.get(p.orig) || {}).name || 'unknown team';
    if (short) return `${p.season} R${p.round}${p.slot ? ` (${p.round}.${two(p.slot)})` : ''}`;
    return `${p.season} Round ${p.round} (${nm})${p.slot ? ` · proj ${p.round}.${two(p.slot)}` : ''}`;
  };
  return { list, next, rounds, info, label, owned: (rid) => list.filter((p) => p.owner === rid).map((p) => p.id) };
}
