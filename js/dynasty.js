// Dynasty: every player's next three seasons in one league, and what each
// team's lineup is worth in each of them. Players come from data/dynasty.json
// (nflpred/model/dynasty.py): a per-game line now, the measured change and
// still-playing odds for each season ahead and, for backups, the chance of
// taking over the starting job. A draft pick is the rookies past drafts
// produced at that slot. Season h = 0, 1, 2 is the season after this one, and
// the two after that. No network.

import { compileScoring, leaguePoints } from './engine.js';

const IDP = new Set(['DL', 'LB', 'DB']);

export function makeDynasty(L, dyn, picks = null) {
  const H = dyn.horizon;
  const C = Number(dyn.season);
  const T = L.teams.size;
  const scoring = compileScoring(L.scoring);
  const skillPts = (line, pos) => {
    const summ = {};
    dyn.stats.forEach((s, i) => { summ[s] = { mean: line[i] || 0 }; });
    return leaguePoints(summ, pos, scoring);
  };
  const idpPts = (line) => dyn.idp_stats.reduce((t, s, i) => t + (scoring.idp[s] || 0) * (line[i] || 0), 0);
  const ptsOf = (line, pos) => (IDP.has(pos) ? idpPts(line) : skillPts(line, pos));
  // K and DEF have no dynasty line: this season's per-game projection carries
  // forward (defences drift back toward average). Offseason: 0 for everyone.
  const nowPpg = (p) => {
    let t = 0, n = 0;
    for (const v of p.pts) if (Number.isFinite(v) && v > 0) { t += v; n += 1; }
    return n ? t / n : 0;
  };
  let defAvg = null;
  const defAverage = () => {
    if (defAvg === null) {
      const xs = (dyn.def_teams || []).map((t) => nowPpg(L.player(t))).filter((x) => x > 0);
      defAvg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    }
    return defAvg;
  };

  const cache = new Map();
  function future(sidIn) {
    const sid = String(sidIn);
    if (cache.has(sid)) return cache.get(sid);
    const p = L.player(sid);
    const e = p.mid ? (dyn.players || {})[p.mid] || null : null;
    const pts = new Float64Array(H), avail = new Float64Array(H);
    if (L.wanted.has(p.pos)) {
      for (let h = 0; h < H; h++) {
        if (p.pos === 'DEF') {
          const a = defAverage();
          pts[h] = a + dyn.def_shrink[h] * (nowPpg(p) - a); avail[h] = 1;
        } else if (p.pos === 'K') {
          pts[h] = nowPpg(p); avail[h] = dyn.k_default[h];
        } else if (e) {
          const q = e.p && e.t ? e.p[h] : 0;
          const line = e.l.map((v, i) => (1 - q) * e.f[h] * v + (q ? q * e.t[i] : 0));
          pts[h] = Math.max(0, ptsOf(line, p.pos)); avail[h] = e.s[h];
        }
      }
    }
    const out = { pts, avail, age: e ? e.age : null, start: e && e.p ? e.p.slice(0, H) : null };
    cache.set(sid, out);
    return out;
  }

  // Past rookie classes ranked for this league: by draft-day expected value
  // (the draft-capital prior) in this league's scoring, among the positions
  // it starts -- defenders compete in IDP leagues, QBs rise in superflex.
  // ranks[k][c] is the k-th rookie of class c (or null).
  const ranks = (() => {
    const cls = (dyn.picks || {}).classes || [];
    const pri = dyn.prior || {};
    const ev = (e) => {
      const p = (pri[e.pos] || {})[e.b];
      return p ? [0, 1, 2].reduce((t, y) => t + Math.max(0, ptsOf(p.line[y], e.pos)) * p.s[y], 0) : 0;
    };
    const per = cls.map((c) => c.filter((e) => L.wanted.has(e.pos)).map((e) => [ev(e), e])
      .sort((a, b) => (b[0] - a[0]) || ((a[1].pick ?? 999) - (b[1].pick ?? 999))).map(([, e]) => e));
    const n = per.reduce((m, c) => Math.max(m, c.length), 0);
    return Array.from({ length: n }, (_, k) => per.map((c) => c[k] || null));
  })();
  // A pick at rank k is valued on ranks k-2..k+2 of every past class: ten
  // classes are too few to value one rank alone, and value moves smoothly
  // with rank (nflpred/dynasty_backtest.py, PICK_WINDOW -- the measured gate).
  const PICK_WINDOW = 2;
  const nCls = ranks.length ? ranks[0].length : 0;
  // The rookies a set of picks brings into season h: every pooled past rookie
  // in turn ('scen'), or one averaged rookie per pick (the fast 'exp' screen).
  // The ranks a pick pools: 2 x PICK_WINDOW + 1 of them, the window shifted
  // (not shrunk) at either end -- nflpred/dynasty_backtest.py pool_bounds.
  const width = Math.min(2 * PICK_WINDOW + 1, ranks.length);
  const loOf = (k) => Math.min(Math.max(0, k - PICK_WINDOW), ranks.length - width);
  const rawPts = (e, y) => Math.max(0, ptsOf(e.l[y], e.pos));
  // A later pick is never worth more: per rookie season, each rank's pooled
  // value is made non-increasing (pool-adjacent-violators, as
  // dynasty_backtest.rank_values) and its rookies scaled to match.
  const scaleBy = [0, 1, 2].map((y) => {
    if (!ranks.length) return [];
    const v = ranks.map((_, k) => {
      let t = 0;
      for (const row of ranks.slice(loOf(k), loOf(k) + width)) for (const e of row) if (e) t += rawPts(e, y) * e.s[y];
      return t / (width * nCls);
    });
    const blocks = [];
    for (const x of v) {
      blocks.push([x, 1]);
      while (blocks.length > 1 && blocks[blocks.length - 2][0] / blocks[blocks.length - 2][1] < blocks[blocks.length - 1][0] / blocks[blocks.length - 1][1]) {
        const [s2, n2] = blocks.pop();
        blocks[blocks.length - 1][0] += s2; blocks[blocks.length - 1][1] += n2;
      }
    }
    const mono = blocks.flatMap(([s2, n2]) => Array(n2).fill(s2 / n2));
    return v.map((x, k) => (x > 0 ? mono[k] / x : 1));
  });
  function pickRow(id, h) {
    const pk = picks ? picks.info(id) : null;
    if (!pk || !ranks.length) return null;
    const y = C + 1 + h - pk.season;
    if (y < 0 || y > 2) return null;
    const k = (pk.round - 1) * T + (pk.slot || Math.ceil(T / 2)) - 1;
    if (k >= ranks.length) return null;
    // rows[o][c]: the rookie at the o-th pooled rank of class c, or null --
    // a class with no rookie there counts zero, as in the measured check.
    return { y, rows: ranks.slice(loOf(k), loOf(k) + width), scale: scaleBy[y][k] };
  }
  const entryCand = (sid, e, y, scale = 1) => ({ sid, pos: e.pos, pts: rawPts(e, y) * scale, avail: e.s[y] });
  function pickPpw(id, h) {
    const r = pickRow(id, h);
    if (!r) return 0;
    let t = 0;
    for (const row of r.rows) for (const e of row) if (e) { const c = entryCand(id, e, r.y, r.scale); t += c.pts * c.avail; }
    return t / (r.rows.length * nCls);
  }
  // A pick's rookies don't depend on the roster around them: scored once per
  // pick, season and mode (suggestions value thousands of candidate deals).
  const rookieMemo = new Map();
  function pickRookies(id, h, mode) {
    const key = `${mode}|${id}|${h}`;
    if (rookieMemo.has(key)) return rookieMemo.get(key);
    const r = pickRow(id, h);
    let out = null;
    if (r && mode === 'exp') {
      // One averaged rookie per position in the pool, each weighted by its
      // share, so a linebacker's value lands in an LB slot and a WR's in a WR slot.
      const byPos = new Map();
      for (const row of r.rows) for (const e of row) {
        if (!e) continue;
        const c = entryCand(id, e, r.y, r.scale);
        byPos.set(e.pos, (byPos.get(e.pos) || 0) + c.pts * c.avail);
      }
      const n = r.rows.length * nCls;
      out = [...byPos].map(([pos, t]) => ({ sid: `${id}|${pos}`, pos, pts: t / n, avail: 1 }));
    } else if (r) {
      // Scenario s = (pooled rank o, class c): every pair once, so each pooled
      // rookie weighs the same; null where the class had nobody there.
      out = [];
      r.rows.forEach((row, o) => row.forEach((e, c) => { out[o * nCls + c] = e ? entryCand(`${id}|${o}|${c}`, e, r.y, r.scale) : null; }));
    }
    rookieMemo.set(key, out);
    return out;
  }
  function rookies(pickIds, h, mode) {
    const per = pickIds.map((id) => pickRookies(id, h, mode)).filter(Boolean);
    if (!per.length) return null;
    if (mode === 'exp') return [per.flat()];
    // Every pick pools the same number of ranks, so scenario s lines up
    // across picks: the same past class (and pooled rank) for each of them.
    const n = per[0].length;
    return Array.from({ length: n }, (_, s) => per.map((r) => r[s]).filter(Boolean));
  }
  // Every season ahead, a hole in the lineup (a traded-away tight end, a
  // kicker, a week someone misses) fills at the level of the best player at
  // that position nobody rosters, so a player is worth his edge over that.
  // Counted before and after a trade alike (fill 'kdef' limits it to kickers
  // and defences). Offseason: kickers and defences have no line yet, so they
  // have no edge.
  let pool = null;                       // pos -> per season ahead, [{sid, v: Float64Array(H)}] best first
  const waiverPool = () => {
    if (!pool) {
      pool = new Map();
      const seen = new Set();
      const add = (sid) => {
        if (!sid || seen.has(sid) || L.isRostered(sid)) return;
        seen.add(sid);
        const pos = L.player(sid).pos;
        if (!L.wanted.has(pos)) return;
        const f = future(sid);
        const v = Float64Array.from(f.pts, (x, k) => x * f.avail[k]);
        if (!v.some((x) => x > 0)) return;
        if (!pool.has(pos)) pool.set(pos, []);
        pool.get(pos).push({ sid, v });
      };
      for (const sid of L.freeAgents(Infinity)) add(sid);
      for (const mid of Object.keys(dyn.players || {})) add(L.sidFor(mid));
      // Best first in each season ahead: the fill is the first one not on
      // the roster being valued (suggestions value thousands of rosters).
      for (const [pos, list] of pool) pool.set(pos, Array.from({ length: H }, (_, h) => list.slice().sort((a, b) => b.v[h] - a.v[h])));
    }
    return pool;
  };
  const waiverFill = (h, have, fill) => {
    const out = [];
    for (const [pos, byH] of waiverPool()) {
      if (fill === 'kdef' && pos !== 'K' && pos !== 'DEF') continue;
      const bestE = byH[h].find((e) => !have.has(e.sid));
      if (bestE && bestE.v[h] > 0) out.push({ sid: `waiver:${pos}`, pos, pts: bestE.v[h], avail: 1 });
    }
    return out;
  };
  const cands = (sids, h, fill = 'all') => {
    const own = sids.map(String);
    return own.map((s) => {
      const f = future(s);
      return { sid: s, pos: L.player(s).pos, pts: f.pts[h], avail: f.avail[h] };
    }).concat(waiverFill(h, new Set(own), fill));
  };

  /** Points a week season h's best lineup scores with these players and picks. */
  function strength(sids, pickIds, h, mode = 'exp', fill = 'all') {
    const base = cands(sids, h, fill);
    const cls = rookies(pickIds || [], h, mode);
    if (!cls) return L.weekValue(base, mode, `f${h}`).total;
    let t = 0;
    for (const extra of cls) t += L.weekValue(base.concat(extra), mode, `f${h}`).total;
    return t / cls.length;
  }
  function slotsAt(sids, pickIds, h) {
    const cls = rookies(pickIds || [], h, 'exp');
    return L.weekValue(cls ? cands(sids, h).concat(cls[0]) : cands(sids, h), 'exp').slots;
  }
  /** Each season ahead: points a game when he plays (`play`), the share of
   *  games he is expected to play (`games`), and the two multiplied (`ppg`). */
  function card(sid) {
    const f = future(sid);
    return { age: f.age, play: Array.from(f.pts), games: Array.from(f.avail),
      ppg: Array.from(f.pts, (v, h) => v * f.avail[h]), start: f.start };
  }
  /** Unrostered players with the most future value (this season excluded). */
  function stash(n = 20) {
    const out = [];
    for (const mid of Object.keys(dyn.players || {})) {
      const sid = L.sidFor(mid);
      if (!sid || L.isRostered(sid)) continue;
      const p = L.player(sid);
      if (!L.wanted.has(p.pos)) continue;
      const c = card(sid);
      const value = c.ppg.reduce((t, v, h) => t + dyn.carry[h] * v, 0);
      if (value > 0) out.push({ sid, name: p.name, pos: p.pos, age: c.age, value, ppg: c.ppg, start: c.start });
    }
    return out.sort((a, b) => b.value - a.value).slice(0, n);
  }
  return { H, season: C, carry: dyn.carry, err: dyn.err_ratio, carryMeasured: !!dyn.carry_measured,
    picks, future, strength, slotsAt, pickPpw, card, stash };
}
