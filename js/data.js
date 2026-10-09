// The week's bundle: what nflpred/publish.py wrote, loaded onto the phone.
//
// meta.json is always fetched fresh; every other file is requested with its
// content hash (?v=...), so the service worker can keep it forever and a new
// version is a new URL.

const weekCache = new Map();
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
export async function loadWeek(meta, w) {
  const key = `${w}|${(meta.files || {})[`players_${w}.json`]}|${(meta.files || {})[`sims_${w}.bin.gz`]}`;
  if (weekCache.has(key)) return weekCache.get(key);
  const p = (async () => {
    const hasSims = !!(meta.sims || {})[String(w)];
    const [players, stats, extra, sleeper, actuals, layout, buf] = await Promise.all([
      getJSON(ver(meta, `players_${w}.json`)),
      getJSON(ver(meta, `stats_${w}.json`)).catch(() => ({})),
      getJSON(ver(meta, `extra_${w}.json`)).catch(() => []),
      getJSON(ver(meta, 'sleeper.json')),
      getJSON(ver(meta, `actuals_${w}.json`)).catch(() => ({})),
      hasSims ? getJSON(ver(meta, `simsidx_${w}.json`)) : null,
      hasSims ? gunzip(ver(meta, `sims_${w}.bin.gz`)) : null,
    ]);
    return {
      week: w,
      players: new Map(players.map((c) => [c.id, c])),
      order: players,
      stats,
      extra: new Map(extra.map((e) => [`${e.kind}|${e.id}`, e])),
      sims: layout && buf ? decodeSims(layout, buf) : null,
      sleeper,
      kickoffs: w === meta.week ? meta.kickoffs || {} : {},
      actuals,
    };
  })();
  weekCache.set(key, p);
  p.catch(() => weekCache.delete(key));
  return p;
}

export async function loadExtraFile(meta, name) {
  return getJSON(ver(meta, name));
}
