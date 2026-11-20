// Keeping the projections current: the published meta and the week it names
// are taken up together, or not at all.
//
// The week is a large download and can fail on its own. Adopting the new meta
// first would show last week's players under this week's number, games and
// byes -- and nothing would ever fetch the week again. So the pair on screen
// only changes once the week has arrived; until then the last pair stays, and
// the next load() tries again. No DOM in here (main.js does the screen).

//
// `incomplete(week)` (data.js) says the week on screen is missing a small file
// whose download failed. Then the week is asked for once more per load(), even
// under the same meta; it only counts as changed if a different week came back.

export function createLoader({ loadMeta, loadWeek, incomplete = () => false }) {
  const state = { meta: null, week: null, error: null };
  let running = null;

  async function run() {
    try {
      const meta = await loadMeta();
      // state.meta is always the meta state.week came from.
      const moved = !state.week || state.week.week !== meta.week
        || state.meta.generated_at !== meta.generated_at;
      let changed = moved;
      if (moved || incomplete(state.week)) {
        const week = await loadWeek(meta, meta.week, { retry: true });
        if (!week) throw new Error(`No data for week ${meta.week}`);
        if (!moved) changed = week !== state.week;
        state.meta = meta;
        state.week = week;
      }
      state.error = null;
      return { changed, error: null };
    } catch (error) {
      state.error = error;
      return { changed: false, error };
    }
  }

  return {
    get meta() { return state.meta; },
    get week() { return state.week; },
    /** The last load's failure; null once a load has succeeded. */
    get error() { return state.error; },
    /** Look for a newer publish. Resolves (never rejects) to {changed, error}:
     *  `changed` when a new meta and week were adopted, or a file the week
     *  was missing has arrived. One at a time: a call
     *  made while another is running gets that one's promise. */
    load() {
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
  };
}
