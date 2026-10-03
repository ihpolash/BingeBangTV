// Local store: history, continue-watching, watchlist, ratings.
// Renderer uses window.api.store*; main process persists with electron-store.
// Fallback to localStorage when running outside Electron (tests/browser).

const KEY = 'bingebang-mac-v1';

function loadAll() {
  let s;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = JSON.parse(raw);
  } catch {}
  if (!s) s = { history: [], progress: {}, watchlist: [], ratings: {} };
  // Migrate legacy TV entries saved with season 0 / episode 0 (from before
  // detail-Play passed an explicit episode — the site always played S1E1).
  // Without this they render as the nonsense "S0E0".
  try {
    for (const k of Object.keys(s.progress || {})) {
      const p = s.progress[k];
      if (p && p.type === 'tv' && !(p.season > 0 && p.episode > 0)) {
        const nk = `tv:${p.tmdb}:s1e1`;
        if (!s.progress[nk]) {
          s.progress[nk] = { ...p, id: nk, season: 1, episode: 1 };
        }
        delete s.progress[k];
      }
    }
    for (const h of (s.history || [])) {
      if (h && h.type === 'tv' && !(h.season > 0 && h.episode > 0)) {
        h.season = 1; h.episode = 1;
        h.id = `tv:${h.tmdb}:s1e1`;
      }
    }
  } catch {}
  return s;
}
function saveAll(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}
let mem = loadAll();

const store = {
  _all() { return mem; },
  _save() { saveAll(mem); },

  touch(item, opts = {}) {
    // opts: { position, duration, season, episode, completed }
    const now = Date.now();
    const id = progressKey(item, opts);
    const prev = mem.progress[id] || {};
    mem.progress[id] = {
      id,
      tmdb: item.id, type: item.type,
      title: item.title, poster: item.poster, backdrop: item.backdrop,
      url: item.url, play_url: item.play_url,
      year: item.year, rating: item.rating, genre_ids: item.genre_ids || [],
      position: opts.position ?? prev.position ?? 0,
      duration: opts.duration ?? prev.duration ?? 0,
      season: opts.season ?? prev.season ?? 0,
      episode: opts.episode ?? prev.episode ?? 0,
      completed: !!opts.completed,
      updatedAt: now,
    };
    // history = append watch event (dedupe same id within 10min)
    const last = mem.history[0];
    if (!last || last.id !== id || (now - last.at) > 10 * 60 * 1000) {
      mem.history.unshift({ id, at: now, ...mem.progress[id] });
      mem.history = mem.history.slice(0, 500);
    } else {
      mem.history[0] = { id, at: now, ...mem.progress[id] };
    }
    this._save();
    return mem.progress[id];
  },

  getProgress(id) { return mem.progress[id]; },

  continueWatching(limit = 20) {
    return Object.values(mem.progress)
      .filter(p => !p.completed && (p.position || 0) > 30 && ((p.duration || 0) === 0 || p.position / p.duration < 0.95))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  },

  // Shows whose latest watched episode was finished → suggest the next one.
  // Entries open the show detail (never autoplay — the episode may not exist).
  upNext(limit = 10) {
    const byShow = {};
    for (const p of Object.values(mem.progress)) {
      if (p.type !== 'tv' || !(p.season > 0 && p.episode > 0)) continue;
      const k = `tv:${p.tmdb}`;
      if (!byShow[k] || (p.updatedAt || 0) > (byShow[k].updatedAt || 0)) byShow[k] = p;
    }
    const out = [];
    for (const p of Object.values(byShow)) {
      const done = p.completed || (p.duration > 0 && p.position / p.duration >= 0.95);
      if (!done) continue;
      out.push({ ...p, episode: p.episode + 1, position: 0, duration: 0, isNext: true });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  },

  history(limit = 100) {
    return mem.history.slice(0, limit);
  },

  markCompleted(item, opts = {}) {
    return this.touch(item, { ...opts, completed: true });
  },

  toggleWatchlist(item) {
    const id = itemKey(item);
    const i = mem.watchlist.findIndex(w => w.id === id);
    if (i >= 0) mem.watchlist.splice(i, 1);
    else mem.watchlist.unshift({ id, tmdb: item.id, type: item.type, title: item.title, poster: item.poster, url: item.url, play_url: item.play_url, year: item.year, rating: item.rating, genre_ids: item.genre_ids || [], addedAt: Date.now() });
    this._save();
    return i < 0;
  },
  inWatchlist(item) { return mem.watchlist.some(w => w.id === itemKey(item)); },
  getWatchlist() { return mem.watchlist; },

  rate(item, stars) {
    mem.ratings[itemKey(item)] = stars;
    this._save();
  },

  // Drop a movie or a whole show (all its episodes) from Continue Watching.
  // Watch history events are kept — this only clears resume state.
  removeShow(type, tmdb) {
    const prefix = `${type}:${tmdb}`;
    for (const k of Object.keys(mem.progress)) {
      if (k === prefix || k.startsWith(prefix + ':')) delete mem.progress[k];
    }
    this._save();
  },

  clearHistory() { mem.history = []; mem.progress = {}; this._save(); },
};

function itemKey(item) { return `${item.type}:${item.id}`; }
function progressKey(item, opts = {}) {
  const s = opts.season || 0, e = opts.episode || 0;
  if (item.type === 'tv' && (s || e)) return `tv:${item.id}:s${s}e${e}`;
  return `${item.type}:${item.id}`;
}

// ---- Recommendations: genre-affinity + site recs ----
function genreAffinity() {
  // Count genre_ids across progress+history weighted by recency & completion
  const counts = {};
  const entries = Object.values(mem.progress);
  for (const p of entries) {
    const w = p.completed ? 2 : 1;
    for (const g of (p.genre_ids || [])) counts[g] = (counts[g] || 0) + w;
  }
  return counts;
}

function scoreCandidate(c, affinity) {
  let s = 0;
  for (const g of (c.genre_ids || c.raw?.genre_ids || [])) s += (affinity[g] || 0) * 2;
  s += (c.rating || c.vote_average || 0) * 0.5;
  s += Math.min(5, (c.votes || 0) / 500);
  // penalize already watched
  const id = `${c.type || c.media_type || 'movie'}:${c.id}`;
  if (mem.progress[id]) s -= 50;
  return s;
}

function recommendFrom(pool, limit = 20) {
  // Dedupe overlapping catalog lists (same title in trending + popular).
  const ukeys = new Set();
  pool = (pool || []).filter(c => {
    const k = `${c.type || c.media_type || 'movie'}:${c.id}`;
    if (ukeys.has(k)) return false;
    ukeys.add(k);
    return true;
  });
  const affinity = genreAffinity();
  if (Object.keys(affinity).length === 0) {
    // cold start: top rated popular
    return [...pool].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, limit);
  }
  return [...pool].map(c => ({ c, s: scoreCandidate(c, affinity) }))
    .sort((a, b) => b.s - a.s).map(x => x.c).slice(0, limit);
}

function reasonsFor(candidate, historyItems) {
  // pick up to 2 history titles sharing most genres
  const cg = new Set(candidate.genre_ids || []);
  return historyItems
    .map(h => ({ h, overlap: (h.genre_ids || []).filter(g => cg.has(g)).length }))
    .filter(x => x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 2).map(x => x.h.title);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { store, recommendFrom, reasonsFor, genreAffinity };
if (typeof window !== 'undefined') { window.store = { store, recommendFrom, reasonsFor, genreAffinity }; window.recommendFrom = recommendFrom; }
