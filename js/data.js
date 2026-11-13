// The week's bundle: what nflpred/publish.py wrote, loaded onto the phone.
//
// meta.json is always fetched fresh; every other file is requested with its
// content hash (?v=...), so the service worker can keep it forever and a new
// version is a new URL.

const weekCache = new Map();     // players + decoded simulations, by week and their hashes
const smallFiles = new Map();    // file name -> { v: hash, p: its contents }
const builtWeeks = new Map();    // week number -> the last week object put together
let base = 'data/';

export function setBase(url) { base = url.endsWith('/') ? url : `${url}/`; }

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.json();
}

export async function loadMeta() {
  return getJSON(`${base}meta.json`, { cache: 'no-store' });
}

const ver = (meta, f) => `${base}${f}?v=${(meta.files || {})[f] || ''}`;

/** A gzipped file as an ArrayBuffer. Tolerates a server that already
 *  decompressed it (Content-Encoding: gzip) by checking the magic bytes. */
async function gunzip(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  const raw = await r.arrayBuffer();
  const head = new Uint8Array(raw, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return raw;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This phone needs iOS 16.4 or later to read the simulations.');
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function decodeSims(layout, buf) {
  const groups = {};
  let nSims = 0;
  for (const [group, g] of Object.entries(layout.groups || {})) {
    const n = g.n_sims;
    nSims = n;
    const stats = {};
    for (const s of g.stats) {
      stats[s.name] = { data: new Int16Array(buf, s.offset, g.ids.length * n), scale: s.scale };
    }
    groups[group] = { ids: g.ids, index: new Map(g.ids.map((id, i) => [String(id), i])), nSims: n, stats };
  }
  return { groups, nSims };
}

/**
 * One week, decoded. { week, players: Map(id -> card), stats: {id: dists},
 * extra: Map('K|id' -> meta), sims: {groups, nSims} | null,
 * sleeper: {sleeper_id: [model_id, name, pos, team, injury]}, kickoffs, actuals }
 */
export async function loadWeek(meta, w, { retry = false } = {}) {
  // Each part follows its own hash: a publish that only moves the live points
  // downloads only those, and the simulations are not fetched or decoded again.
  // `retry` (the loader's call) asks once more for a small file that failed.
  const small = smallNames(w);
  const got = await Promise.allSettled([
    heavyPart(meta, w),
    smallFile(meta, small[0], {}, retry),
    smallFile(meta, small[1], [], retry),
    smallFile(meta, small[2]),
    smallFile(meta, small[3], {}, retry),
  ]);
  const bad = got.find((r) => r.status === 'rejected');
  if (bad) {
    // The connection is down: a small file that failed with it is asked for
    // again by the next call, so trying again fetches the whole week, as it
    // always has. What it held before stays, in case that try fails too.
    for (const name of small) { const s = smallFiles.get(name); if (s && s.failed) s.again = true; }
    throw bad.reason;
  }
  const [heavy, stats, extra, sleeper, actuals] = got.map((r) => r.value);
  const kickoffs = w === meta.week ? meta.kickoffs || {} : {};
  const parts = [heavy, stats, extra, sleeper, actuals];
  const kick = JSON.stringify(kickoffs);
  // The same parts are the same week object, so whatever is remembered
  // against it (see espn.js withPlayers) holds until something changes.
  const built = builtWeeks.get(w);
  if (built && built.kick === kick && built.parts.every((x, i) => x === parts[i])) return built.week;
  const week = {
    week: w,
    players: heavy.players,
    order: heavy.order,
    stats,
    extra: new Map(extra.map((e) => [`${e.kind}|${e.id}`, e])),
    sims: heavy.sims,
    sleeper,
    kickoffs,
    actuals,
  };
  builtWeeks.set(w, { parts, kick, week });
  return week;
}

/** The players and their decoded simulations: megabytes, so kept for as long
 *  as their hashes hold. */
function heavyPart(meta, w) {
  const files = meta.files || {};
  const key = `${w}|${files[`players_${w}.json`]}|${files[`sims_${w}.bin.gz`]}|${files[`simsidx_${w}.json`] || ''}`;
  if (weekCache.has(key)) return weekCache.get(key);
  const p = (async () => {
    const hasSims = !!(meta.sims || {})[String(w)];
    const [players, layout, buf] = await Promise.all([
      getJSON(ver(meta, `players_${w}.json`)),
      hasSims ? getJSON(ver(meta, `simsidx_${w}.json`)) : null,
      hasSims ? gunzip(ver(meta, `sims_${w}.bin.gz`)) : null,
    ]);
    return {
      players: new Map(players.map((c) => [c.id, c])),
      order: players,
      sims: layout && buf ? decodeSims(layout, buf) : null,
    };
  })();
  weekCache.set(key, p);
  p.catch(() => weekCache.delete(key));
  return p;
}

const smallNames = (w) => [`stats_${w}.json`, `extra_${w}.json`, 'sleeper.json', `actuals_${w}.json`];

/** True while one of this week's small files (live points, stat ranges,
 *  kickers and defences) is standing in for a download that failed: the week
 *  is usable, and loadWeek with `retry` is worth calling again. */
export function incomplete(week) {
  return !!week && smallNames(week.week).some((name) => !!(smallFiles.get(name) || {}).failed);
}

/** One small file, by name. The same hash gives the same object back; a new
 *  hash replaces it (and lets go of the old one). With a `fallback` a failed
 *  download is what the file held before -- the same object, so the week is
 *  not rebuilt -- or `fallback` if it never arrived. That stand-in is kept, so
 *  the file is not asked for on every call: it is tried again when `retry` is
 *  set, after a failed week, and after the next publish. Without a `fallback`
 *  a failure is an error and the next call tries again. */
function smallFile(meta, name, fallback, retry = false) {
  const files = meta.files || {};
  const v = files[name];
  const have = smallFiles.get(name);
  const stale = have && have.failed && (retry || have.again || have.at !== meta.generated_at);
  if (have && have.v === v && !stale) return have.p;
  const slot = { v, at: meta.generated_at, failed: false, again: false, has: false, value: undefined, p: null };
  const keep = (value) => { slot.has = true; slot.value = value; return value; };
  // The site holds only the files meta.json lists (nflpred/publish.py), so an
  // optional file it does not list is not there to ask for.
  const ask = fallback !== undefined && !(name in files)
    ? Promise.resolve(fallback) : getJSON(ver(meta, name));
  slot.p = ask.then(keep, (err) => {
    if (fallback === undefined) {
      if (smallFiles.get(name) === slot) smallFiles.delete(name);
      throw err;
    }
    slot.failed = true;
    return keep(have && have.has ? have.value : fallback);
  });
  smallFiles.set(name, slot);
  return slot.p;
}

export async function loadExtraFile(meta, name) {
  return getJSON(ver(meta, name));
}
