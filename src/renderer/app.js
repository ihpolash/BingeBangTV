/* BingeBang Mac — native UI, history, continue-watching, recommendations.
   Network goes through window.api.proxyFetch in Electron (no CORS),
   falls back to direct fetch in browser/test. */

const $view = document.getElementById('view');
const $status = document.getElementById('status');
const $search = document.getElementById('search');
const $sr = document.getElementById('search-results');

const IMG = (p, s = 'w500') => (!p ? '' : /^https?:/.test(p) ? p : `https://image.tmdb.org/t/p/${s}${p}`);
const S = window.store || null; // from store.js (localStorage-backed)
function DB() { return S ? S.store : fallbackStore; }
// tiny fallback if store.js failed to load
const fallbackStore = { _m: { history: [], progress: {}, watchlist: [] },
  touch() {}, continueWatching() { return []; }, history() { return []; },
  toggleWatchlist() {}, inWatchlist() { return false; }, getWatchlist() { return []; }, clearHistory() {} };

let HOME_CACHE = null;
let CATALOG_POOL = []; // for recommendations
let CURRENT = { route: 'home' };

async function bbFetch(path) {
  if (window.api?.proxyFetch) {
    const r = await window.api.proxyFetch({ path });
    if (!r.ok) throw new Error(`bb ${path} -> ${r.status} ${r.error || ''}`);
    const t = r.text;
    try { return JSON.parse(t); } catch { return t; }
  }
  const BASE = 'https://bingebang.st';
  const res = await fetch(BASE + path, { headers: { Accept: path.includes('/api/') ? 'application/json' : 'text/html' } });
  if (!res.ok) throw new Error(`bb ${path} -> ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

function norm(item, fb) {
  const isTv = (item.media_type || item._type || fb) === 'tv';
  return {
    id: item.id, type: isTv ? 'tv' : 'movie',
    title: item.title || item.name || 'Untitled',
    overview: item.overview || '',
    poster: IMG(item.poster_path, 'w500'),
    backdrop: IMG(item.backdrop_path || item.backdrop_titled_path, 'w1280'),
    year: item.year || (item.release_date || item.first_air_date || '').slice(0, 4),
    rating: item.vote_average ?? 0, votes: item.vote_count ?? 0,
    genre_ids: item.genre_ids || (item.genres || []).map(g => g.id),
    genres: (item.genres || []).map(g => g.name || g),
    url: item.url, play_url: item.play_url, raw: item,
  };
}

function cardHTML(it, wide) {
  const pct = progressPct(it);
  return `<div class="card ${wide ? 'wide' : ''}" data-url="${it.url}" data-type="${it.type}" data-id="${it.id}">
    <img loading="lazy" src="${it.poster || it.backdrop}" alt="" onerror="this.style.opacity=.2"/>
    <div class="ct"><div class="t" title="${esc(it.title)}">${esc(it.title)}</div>
    <div class="s"><span>${it.year || ''}</span><span>★ ${Number(it.rating || 0).toFixed(1)}</span></div>
    ${pct ? `<div class="progressbar"><span style="width:${pct}%"></span></div>` : ''}</div></div>`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Shared Continue-Watching track: in-progress items + Up-next episode cards
// (Up-next opens the show detail — never autoplays, the episode may not exist).
function cwTrackHTML(cw, next) {
  const resumed = groupCW(cw).map(p => {
    const pct = p.duration ? Math.round(100 * p.position / p.duration) : 0;
    return `<div class="card wide" data-url="${p.url}" data-type="${p.type}" data-id="${p.tmdb}" data-resume="1">
      <button class="card-x" data-remove="${p.type}:${p.tmdb}" title="Remove from Continue Watching">✕</button>
      <img loading="lazy" src="${p.backdrop || p.poster}" onerror="this.style.opacity=.2"/>
      <div class="ct"><div class="t">${esc(p.title)}</div>
      <div class="s"><span>${p.type === 'tv' && p.season ? `S${p.season}E${p.episode} · ` : ''}${pct}% watched</span><span>${fmtTime(p.position)}${p.duration ? ' / ' + fmtTime(p.duration) : ''}</span></div>
      <div class="progressbar"><span style="width:${pct}%"></span></div></div></div>`;
  }).join('');
  const upcoming = (next || []).map(p => {
    return `<div class="card wide" data-url="${p.url}" data-type="${p.type}" data-id="${p.tmdb}">
      <img loading="lazy" src="${p.backdrop || p.poster}" onerror="this.style.opacity=.2"/>
      <div class="ct"><div class="t">${esc(p.title)}</div>
      <div class="s"><span class="badge">Up next · S${p.season}E${p.episode}</span></div></div></div>`;
  }).join('');
  return resumed + upcoming;
}
function progressPct(it) {
  try {
    const st = DB();
    const all = st._all ? st._all().progress : null;
    if (!all) return 0;
    // For shows, match episode keys too (tv:<id>:s1e2) — use latest activity.
    let best = all[`${it.type}:${it.id}`] || null;
    if (it.type === 'tv') {
      for (const k of Object.keys(all)) {
        if (k === `tv:${it.id}` || k.startsWith(`tv:${it.id}:`)) {
          const p = all[k];
          if (!best || (p.updatedAt || 0) > (best.updatedAt || 0)) best = p;
        }
      }
    }
    const p = best;
    if (p && p.duration > 0 && p.position > 30 && !p.completed) return Math.round(100 * p.position / p.duration);
  } catch {}
  return 0;
}
// One card per show: collapse multiple episode entries to the latest one.
// Clicking opens the show detail, which has the per-episode Resume button.
function groupCW(cw) {
  const seenTv = new Set();
  const out = [];
  for (const p of (cw || [])) {
    if (p.type === 'tv') {
      const k = `tv:${p.tmdb}`;
      if (seenTv.has(k)) continue;
      seenTv.add(k);
    }
    out.push(p);
  }
  return out;
}

// ---------- routes ----------
document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => nav(b.dataset.nav));
function nav(route) {
  document.querySelectorAll('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === route));
  CURRENT.route = route;
  if (route === 'home') renderHome();
  if (route === 'movies') renderGridPage('movies');
  if (route === 'tv') renderGridPage('tv');
  if (route === 'mylist') renderMyList();
  if (route === 'history') renderHistory();
}
document.getElementById('btn-clear').onclick = () => { DB().clearHistory(); renderHome(); renderHistoryIfActive(); };
function renderHistoryIfActive() { if (CURRENT.route === 'history') renderHistory(); }

// ---------- language / regional trending rows (home) ----------
// Server-side proxies (instant): country catalogs for EN/HI/KO,
// Japan animation catalog for anime, Disney+ animation for Disney.
// Bangla is exact-verified (original_language === 'bn') with a daily cache.
const LANG_ROWS = [
  { key: 'en', title: 'English Trending', sub: "This week's trending · US catalog", country: 'US' },
  { key: 'hi', title: 'Hindi Trending', sub: "This week's trending · India catalog", country: 'IN' },
  { key: 'ko', title: 'Korean Trending', sub: "This week's trending · Korea catalog", country: 'KR' },
  { key: 'anime', title: 'Anime Trending', sub: "This week's trending anime · Japan", country: 'JP', genres: '16' },
  { key: 'disney', title: 'Disney Animation Trending', sub: 'Animated favorites on Disney+', provider: 'disney-plus', genres: '16' },
];
let homeGen = 0;

async function fetchLangRow(def) {
  const q = new URLSearchParams({ sort: 'popularity.desc', limit: '24' });
  if (def.provider) q.set('provider', def.provider);
  if (def.country) q.set('country', def.country);
  if (def.genres) q.set('genres', def.genres);
  const [m, t] = await Promise.all([
    bbFetch(`/api/discover/movie?${q}`).catch(() => ({ results: [] })),
    bbFetch(`/api/discover/tv?${q}`).catch(() => ({ results: [] })),
  ]);
  return [...(m.results || []).map(x => norm(x, 'movie')), ...(t.results || []).map(x => norm(x, 'tv'))]
    .sort((a, b) => (b.raw?.popularity || 0) - (a.raw?.popularity || 0)).slice(0, 20);
}

function langCardHTML(it) {
  const pct = progressPct(it);
  return `<div class="card" data-url="${it.url}" data-type="${it.type}" data-id="${it.id}">
    <span class="badge langbadge">${it.type === 'tv' ? 'TV' : 'MOVIE'}</span>
    <img loading="lazy" src="${it.poster || it.backdrop}" alt="" onerror="this.style.opacity=.2"/>
    <div class="ct"><div class="t" title="${esc(it.title)}">${esc(it.title)}</div>
    <div class="s"><span>${it.year || ''}</span><span>★ ${Number(it.rating || 0).toFixed(1)}</span></div>
    ${pct ? `<div class="progressbar"><span style="width:${pct}%"></span></div>` : ''}</div></div>`;
}

async function renderHome() {
  const myGen = ++homeGen;
  setStatus('Loading home…');
  $view.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const [tmW, tvW, nowP, mPop, tPop, tTop, lang] = await Promise.all([
      bbFetch('/api/list/trending_movie_week?limit=24'),
      bbFetch('/api/list/trending_tv_week?limit=24'),
      bbFetch('/api/list/movie_now_playing?limit=24'),
      bbFetch('/api/list/movie_popular?limit=24'),
      bbFetch('/api/list/tv_popular?limit=24'),
      bbFetch('/api/list/tv_top_rated?limit=24'),
      Promise.all(LANG_ROWS.map(async (d) => {
        try { return { key: d.key, items: await fetchLangRow(d) }; }
        catch { return { key: d.key, items: [] }; }
      })),
    ]);
    if (myGen !== homeGen) return;
    const N = (r, t) => (r.results || []).map(x => norm({ ...x, media_type: t }, t));
    const hero = N(tmW, 'movie').filter(m => m.backdrop && m.overview).slice(0, 5);
    const rows = [
      { title: 'Trending Movies This Week', sub: 'What everyone is watching', items: N(tmW, 'movie') },
      { title: 'Trending Series This Week', sub: 'Binge-worthy now', items: N(tvW, 'tv') },
      { title: 'New Releases', sub: 'Fresh in theaters & just added', items: N(nowP, 'movie') },
      { title: 'Popular Movies', sub: '', items: N(mPop, 'movie') },
      { title: 'Popular Series', sub: '', items: N(tPop, 'tv') },
      { title: 'Top Rated Series', sub: '', items: N(tTop, 'tv') },
    ];
    CATALOG_POOL = [...N(tmW, 'movie'), ...N(tvW, 'tv'), ...N(nowP, 'movie'), ...N(mPop, 'movie'), ...N(tPop, 'tv')];
    HOME_CACHE = { hero, rows };

    const cw = DB().continueWatching(20);
    const next = typeof DB().upNext === 'function' ? DB().upNext(10) : [];
    const recs = recommend(CATALOG_POOL, 20);
    const h0 = hero[0];
    const langByKey = Object.fromEntries((lang || []).map(x => [x.key, x.items]));

    $view.innerHTML = `
      ${h0 ? `<div class="hero"><div class="hero-bg" style="background-image:url('${h0.backdrop}')"></div><div class="hero-shade"></div>
        <div class="hero-body"><div class="hero-kicker">#1 Trending</div><h1>${esc(h0.title)}</h1>
        <div class="hero-meta">★ ${h0.rating?.toFixed?.(1) ?? h0.rating} · ${h0.year} · ${(h0.genres || []).slice(0, 3).join(' · ')}</div>
        <div class="hero-overview">${esc(h0.overview)}</div>
        <div class="hero-actions"><button class="btn" data-play="${h0.play_url}" data-url="${h0.url}">▶ Play</button>
        <button class="btn ghost" data-open="${h0.url}">More info</button></div></div></div>` : ''}
      ${(cw.length || next.length) ? `<div class="row"><h2>Continue Watching</h2><div class="sub">Pick up where you left off — saved on this Mac</div>
        <div class="track">${cwTrackHTML(cw, next)}</div></div>` : ''}
      <div class="row" id="home-top10-sec"><h2>Streaming Top 10</h2><div class="sub">Top 10 right now, per platform and country · refreshed daily</div>
      ${homeTop10Controls()}</div>
      ${recs.length && hasHistory() ? `<div class="row"><h2>Picks For You</h2><div class="sub">Based on your watch history · stored locally</div>
        <div class="track">${recs.map(it => cardHTML(it)).join('')}</div></div>` : ''}
      ${rows.map(r => `<div class="row"><h2>${r.title}</h2>${r.sub ? `<div class="sub">${r.sub}</div>` : ''}
        <div class="track">${r.items.map(it => cardHTML(it)).join('')}</div></div>`).join('')}
      ${LANG_ROWS.map(d => {
        const items = langByKey[d.key] || [];
        return `<div class="row"><h2>${d.title}</h2><div class="sub">${d.sub}</div>
        <div class="track">${items.length ? items.map(langCardHTML).join('') : `<div class="sub">Nothing trending here today.</div>`}</div></div>`;
      }).join('')}
    `;
    setStatus('');
    bindCards();
    bindHomeTop10();
    refreshHomeTop10().catch(() => {});
  } catch (e) {
    $view.innerHTML = `<div class="empty">Couldn't load home.<br/>${esc(e.message)}<br/><br/><button class="btn" onclick="location.reload()">Retry</button></div>`;
    setStatus('offline');
  }
}

async function renderGridPage(kind) {
  setStatus('Loading…');
  $view.innerHTML = `<div class="empty">Loading…</div>`;
  const defs = kind === 'movies'
    ? [['Trending Today', '/api/list/trending_movie_day?limit=24', 'movie'], ['Popular', '/api/list/movie_popular?limit=24', 'movie'], ['Top Rated', '/api/list/movie_top_rated?limit=24', 'movie'], ['Now Playing', '/api/list/movie_now_playing?limit=24', 'movie']]
    : [['Trending Today', '/api/list/trending_tv_day?limit=24', 'tv'], ['Popular', '/api/list/tv_popular?limit=24', 'tv'], ['On The Air', '/api/list/tv_on_the_air?limit=24', 'tv'], ['Top Rated', '/api/list/tv_top_rated?limit=24', 'tv']];
  const rows = [];
  for (const [title, path, t] of defs) {
    try { const r = await bbFetch(path); rows.push({ title, items: (r.results || []).map(x => norm(x, t)) }); }
    catch (e) { rows.push({ title, items: [], err: e.message }); }
  }
  $view.innerHTML = rows.map(r => `<div class="row"><h2>${r.title}</h2><div class="grid">${r.items.map(it => cardHTML(it)).join('')}</div></div>`).join('');
  setStatus('');
  bindCards();
}

// ---------- streaming top 10 (per platform, refreshed daily) ----------
const PROVIDERS = [
  { slug: 'netflix', name: 'Netflix' },
  { slug: 'prime-video', name: 'Prime Video' },
  { slug: 'disney-plus', name: 'Disney+' },
  { slug: 'hbo-max', name: 'HBO Max' },
  { slug: 'apple-tv-plus', name: 'Apple TV+' },
];
let STREAM = {
  provider: 'netflix',
  kind: 'movie',
  country: (() => { try { return localStorage.getItem('bb:stream-country') || 'US'; } catch { return 'US'; } })(),
};
const COUNTRIES = [
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'IN', name: 'India' }, { code: 'BD', name: 'Bangladesh' },
  { code: 'KR', name: 'South Korea' }, { code: 'JP', name: 'Japan' },
  { code: 'CA', name: 'Canada' }, { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
];
function todayStr() { return new Date().toISOString().slice(0, 10); }
function readTopCache(slug, kind, country) {
  try {
    const raw = localStorage.getItem(`bb:top10:${slug}:${kind}:${country}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function fetchProviderTop(slug, kind, country) {
  const apiKind = kind === 'tv' ? 'tv' : 'movie';
  const base = `/api/discover/${apiKind}?provider=${encodeURIComponent(slug)}&sort=popularity.desc&limit=24`;
  let r = await bbFetch(`${base}&country=${encodeURIComponent(country)}`).catch(() => null);
  let fallback = false;
  if (!(r && (r.results || []).length) && country !== 'US') {
    // Country has no published Top 10 on this platform — show global instead.
    r = await bbFetch(base).catch(() => ({ results: [] }));
    fallback = true;
  }
  const items = ((r && r.results) || []).map(x => norm(x, kind)).slice(0, 10);
  try { localStorage.setItem(`bb:top10:${slug}:${kind}:${country}`, JSON.stringify({ date: todayStr(), items, fallback })); } catch {}
  return { items, fallback };
}
// Streaming Top 10 lives on Home (not a separate nav page).
function homeTop10Controls() {
  const { provider, kind, country } = STREAM;
  return `<div class="pills">${PROVIDERS.map(p => `<button class="pillbtn ${p.slug === provider ? 'on' : ''}" data-prov="${p.slug}">${p.name}</button>`).join('')}</div>
  <div class="pickerrow"><label>Country
    <select id="country-sel">${COUNTRIES.map(c => `<option value="${c.code}" ${c.code === country ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
  </label>
  <div class="pills" style="margin:0"><button class="pillbtn ${kind === 'movie' ? 'on' : ''}" data-kind="movie">Movies</button><button class="pillbtn ${kind === 'tv' ? 'on' : ''}" data-kind="tv">Series</button></div></div>
  <div id="home-top10-note"></div>
  <div id="home-top10"><div class="sub">Loading…</div></div>`;
}
function bindHomeTop10() {
  $view.querySelectorAll('#home-top10-sec [data-prov]').forEach(b => b.onclick = () => { STREAM.provider = b.dataset.prov; syncTop10Controls(); refreshHomeTop10(); });
  $view.querySelectorAll('#home-top10-sec [data-kind]').forEach(b => b.onclick = () => { STREAM.kind = b.dataset.kind; syncTop10Controls(); refreshHomeTop10(); });
  const sel = document.getElementById('country-sel');
  if (sel) sel.onchange = (e) => {
    STREAM.country = e.target.value;
    try { localStorage.setItem('bb:stream-country', STREAM.country); } catch {}
    refreshHomeTop10();
  };
}
function syncTop10Controls() {
  const sec = document.getElementById('home-top10-sec');
  if (!sec) return;
  sec.querySelectorAll('[data-prov]').forEach(b => b.classList.toggle('on', b.dataset.prov === STREAM.provider));
  sec.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('on', b.dataset.kind === STREAM.kind));
  const sel = document.getElementById('country-sel');
  if (sel) sel.value = STREAM.country;
}
function paintHomeTop10(items, provName, kind, date, cname, fallback, staleNote) {
  const body = document.getElementById('home-top10');
  if (!body) return; // navigated away
  const note = document.getElementById('home-top10-note');
  if (note) note.innerHTML = staleNote || '';
  body.innerHTML = `${fallback ? `<div class="sub">No published Top 10 for this country on ${provName} — showing the global list.</div>` : ''}
  <div class="sub">Top 10 ${kind === 'tv' ? 'series' : 'movies'} on ${provName} · ${cname} · updated ${date}</div>
  <div class="track">${items.map((it, i) => `
    <div class="card wide ranktrack" data-url="${it.url}" data-type="${it.type}" data-id="${it.id}">
      <div class="ranknum">${i + 1}</div>
      <img loading="lazy" src="${it.backdrop || it.poster}" onerror="this.style.opacity=.2"/>
      <div class="ct"><div class="t">${esc(it.title)}</div>
      <div class="s"><span>${it.year || ''}</span><span>★ ${Number(it.rating || 0).toFixed(1)}</span></div></div>
    </div>`).join('')}</div>`;
  bindCards(body);
}
async function refreshHomeTop10() {
  const { provider, kind, country } = STREAM;
  const prov = PROVIDERS.find(p => p.slug === provider) || PROVIDERS[0];
  const cname = (COUNTRIES.find(c => c.code === country) || {}).name || country;
  const cached = readTopCache(provider, kind, country);
  if (cached?.items?.length && cached.date === todayStr()) {
    paintHomeTop10(cached.items, prov.name, kind, cached.date, cname, !!cached.fallback);
  }
  try {
    const { items, fallback } = await fetchProviderTop(provider, kind, country);
    paintHomeTop10(items, prov.name, kind, todayStr(), cname, fallback);
  } catch (e) {
    const body = document.getElementById('home-top10');
    if (body && !body.querySelector('.ranktrack')) {
      body.innerHTML = `<div class="sub">Couldn't load Top 10 right now.</div>`;
    } else {
      paintHomeTop10(cached?.items || [], prov.name, kind, cached?.date || todayStr(), cname, !!cached?.fallback, `<div class="sub">Live refresh failed — showing today's cached list.</div>`);
    }
  }
}

function renderMyList() {  const list = DB().getWatchlist();
  updateListCount();
  $view.innerHTML = `<div class="row"><h2>My List</h2><div class="sub">${list.length} saved on this Mac</div>
    ${list.length ? `<div class="grid">${list.map(it => cardHTML({ ...it, id: it.tmdb })).join('')}</div>` : `<div class="empty">Nothing saved yet. Open any title and hit “+ My List”.</div>`}</div>`;
  bindCards();
}

function renderHistory() {
  const h = DB().history(100);
  const cw = DB().continueWatching(50);
  const next = typeof DB().upNext === 'function' ? DB().upNext(10) : [];
  $view.innerHTML = `
    ${(cw.length || next.length) ? `<div class="row"><h2>Continue Watching</h2><div class="track">${cwTrackHTML(cw, next)}</div></div>` : ''}
    <div class="row"><h2>Watch History</h2><div class="sub">${h.length} events · newest first</div>
    ${h.length ? `<div class="grid">${h.map(p => cardHTML({ id: p.tmdb, type: p.type, title: p.title, poster: p.poster, backdrop: p.backdrop, year: p.year, rating: p.rating, url: p.url })).join('')}</div>` : `<div class="empty">No watch history yet. Play something and it will show up here.</div>`}</div>`;
  bindCards();
}

// ---------- detail ----------
async function openDetail(watchUrl) {
  setStatus('Loading details…');
  $view.innerHTML = `<div class="empty">Loading details…</div>`;
  window.scrollTo(0, 0);
  try {
    const html = await bbFetch(watchUrl);
    const data = extractDetail(html);
    const isTv = watchUrl.startsWith('/tv/');
    const item = norm({ ...data, media_type: isTv ? 'tv' : 'movie' }, isTv ? 'tv' : 'movie');
    item.tagline = data.tagline || ''; item.trailer = data.trailer_key ? `https://www.youtube.com/embed/${data.trailer_key}` : '';
    item.cast = ((data.credits && data.credits.cast) || []).slice(0, 12);
    item.recs = ((data.recommendations && data.recommendations.results) || []).map(r => norm(r));
    item.similar = ((data.similar && data.similar.results) || []).map(r => norm(r));
    item.seasons = data.seasons || [];
    renderDetail(item);
    // TV: load episodes natively via player config of S1E1
    if (isTv && item.play_url) loadEpisodes(item).catch(() => {});
    // enrich recs with personal scores
    if (item.recs.length) {
      const scored = recommend(item.recs.concat(item.similar), 20);
      if (scored.length) {
        const el = document.getElementById('detail-personal');
        if (el) el.innerHTML = `<h2>Because you watched ${esc(item.title)}</h2><div class="sub">Re-ranked by your history</div><div class="track">${scored.map(x => cardHTML(x)).join('')}</div>`;
        bindCards(el);
      }
    }
  } catch (e) {
    $view.innerHTML = `<div class="empty">Couldn't load details.<br/>${esc(e.message)}</div>`;
  }
  setStatus('');
}

function extractDetail(html) {
  const re = /<script type="application\/json"[^>]*>(.*?)<\/script>/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const d = JSON.parse(m[1]);
      if (d && d.overview !== undefined && (d.credits || d.recommendations)) return d;
    } catch {}
  }
  throw new Error('detail parse failed');
}

function renderDetail(it) {
  const inList = DB().inWatchlist(it);
  $view.innerHTML = `
    <div class="detail-backdrop" style="background-image:url('${it.backdrop}')"></div>
    <div class="detail-main">
      <img class="poster" src="${it.poster}"/>
      <div class="detail-info">
        <h1>${esc(it.title)}</h1>
        <div class="meta">★ ${Number(it.rating || 0).toFixed(1)} · ${it.year || ''} · ${(it.genres || (it.raw.genre_ids || [])).join ? '' : ''}${esc((it.raw.genres || []).map(g => g.name).join(' · ') || (it.genres || []).join(' · '))}</div>
        ${it.tagline ? `<div class="meta"><em>${esc(it.tagline)}</em></div>` : ''}
        <div class="meta">${esc(it.raw.overview || it.overview || '')}</div>
        <div class="detail-actions">
          <button class="btn" id="detail-play">▶ Play${it.type === 'tv' ? ' S1E1' : ''}</button>
          <button class="btn ghost" id="detail-list">${inList ? '✓ In My List' : '+ My List'}</button>
          ${it.trailer ? `<button class="btn ghost" id="detail-trailer">Trailer</button>` : ''}
          <button class="btn ghost" onclick="history.back()">← Back</button>
        </div>
        <div id="detail-eps"></div>
        ${it.cast?.length ? `<h3>Cast</h3><div class="cast">${it.cast.map(c => `<div><img src="${IMG(c.profile_path, 'w185')}"/><br/>${esc(c.name)}</div>`).join('')}</div>` : ''}
      </div>
    </div>
    <div id="detail-personal" class="row"></div>
    ${it.recs?.length ? `<div class="row"><h2>You Might Like</h2><div class="track">${it.recs.map(x => cardHTML(x)).join('')}</div></div>` : ''}
    ${it.similar?.length ? `<div class="row"><h2>Similar</h2><div class="track">${it.similar.map(x => cardHTML(x)).join('')}</div></div>` : ''}
    ${it.trailer ? `<div class="row" id="trailer-row" hidden><h2>Trailer</h2><iframe width="100%" height="420" src="${it.trailer}" frameborder="0" allowfullscreen></iframe></div>` : ''}
  `;
  document.getElementById('detail-play').onclick = () => {
    // TV always plays an explicit episode — never bare S0E0.
    const ep = (it.type === 'tv' && window._defaultEp) ? window._defaultEp : {};
    playTitle(it, it.type === 'tv' && !ep.season ? { season: 1, episode: 1 } : ep);
  };
  document.getElementById('detail-list').onclick = (e) => {
    const added = DB().toggleWatchlist(it);
    e.target.textContent = added ? '✓ In My List' : '+ My List';
    updateListCount();
  };
  const tr = document.getElementById('detail-trailer');
  if (tr) tr.onclick = () => { const r = document.getElementById('trailer-row'); r.hidden = !r.hidden; };
  bindCards();
  // stash for player resume
  window._detail = it;
  window._episodes = null; // clear stale episodes — reloads per TV title in loadEpisodes
  window._defaultEp = null; // set once this title's episodes load
}

async function loadEpisodes(item) {
  const box = document.getElementById('detail-eps');
  if (!box) return;
  box.innerHTML = `<div class="sub">Loading episodes…</div>`;
  const cfg = await bbFetch(item.play_url); // HTML text
  const eps = parseEpisodes(cfg);
  if (!eps) { box.innerHTML = ''; return; }
  window._episodes = eps;
  const seasons = eps.seasons || [];
  let curS = seasons[0]?.season ?? 1;
  const render = () => {
    const s = seasons.find(x => x.season === curS);
    box.innerHTML = `<h3>Episodes ${seasons.length > 1 ? `<select id="season-sel">${seasons.map(x => `<option value="${x.season}" ${x.season === curS ? 'selected' : ''}>Season ${x.season}</option>`).join('')}</select>` : ''}</h3>
      <div class="eps">${(s?.episodes || []).map(e => `<button data-s="${curS}" data-e="${e.episode}" title="${esc(e.plot || '')}">E${e.episode} · ${esc(e.title || '')}</button>`).join('')}</div>`;
    const sel = document.getElementById('season-sel');
    if (sel) sel.onchange = () => { curS = Number(sel.value); render(); };
    box.querySelectorAll('button[data-e]').forEach(b => b.onclick = () => playTitle(item, { season: Number(b.dataset.s), episode: Number(b.dataset.e) }));
  };
  render();
  // Default Play target = first available episode (so TV never plays S0E0).
  try {
    const s1 = seasons[0];
    const e1 = s1 && s1.episodes && s1.episodes[0];
    if (s1 && e1) window._defaultEp = { season: s1.season, episode: e1.episode };
    else window._defaultEp = { season: 1, episode: 1 };
  } catch { window._defaultEp = { season: 1, episode: 1 }; }
  // update Play button to resume last episode
  const lastTv = lastEpisodeFor(item.id);
  if (lastTv && lastTv.season > 0 && lastTv.episode > 0) {
    const btn = document.getElementById('detail-play');
    if (btn) { btn.textContent = `▶ Resume S${lastTv.season}E${lastTv.episode}`; btn.onclick = () => playTitle(item, lastTv); }
  }
}
function lastEpisodeFor(tmdb) {
  try {
    const all = DB()._all().progress;
    // Only real episodes — legacy season-0 entries are ignored (migrated on load).
    const eps = Object.values(all).filter(p => p.tmdb === tmdb && p.type === 'tv' && p.season > 0 && p.episode > 0);
    if (!eps.length) return null;
    // Prefer the latest in-progress episode; fall back to latest overall.
    const prog = eps.filter(p => !p.completed && (p.position || 0) > 30);
    const pool = prog.length ? prog : eps;
    pool.sort((a, b) => b.updatedAt - a.updatedAt);
    return { season: pool[0].season, episode: pool[0].episode };
  } catch { return null; }
}
function parseEpisodes(html) {
  if (typeof html !== 'string') return null;
  // player HTML contains window.__BB_EPISODES__ = {...}; (sometimes inside XOR blob — try plain first)
  let m = html.match(/window\.__BB_EPISODES__\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  // else decode XOR blob like services/bingebang.js
  const km = html.match(/var k=\[([0-9,]+)\],d=\[([0-9,]+)\]/);
  if (!km) return null;
  const k = km[1].split(',').map(Number), d = km[2].split(',').map(Number);
  let s = '';
  for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i] ^ k[i % k.length]);
  m = s.match(/window\.__BB_EPISODES__\s*=\s*(\{[\s\S]*\});?/);
  if (!m) return null;
  try { return JSON.parse(m[1].slice(0, m[1].lastIndexOf('}') + 1).length > m[1].length ? m[1] : m[1]); } catch {
    // trim trailing junk after final balanced brace
    const txt = m[1];
    let depth = 0, end = -1;
    for (let i = 0; i < txt.length; i++) {
      if (txt[i] === '{') depth++;
      if (txt[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) { try { return JSON.parse(txt.slice(0, end + 1)); } catch {} }
    return null;
  }
}

// ---------- player (native <video> + hls.js, no site iframe) ----------
const video = document.getElementById('video');
let hls = null, saveTimer = null, currentPlay = null;
// Bumped on every open AND close. Stale async work (resolve, HLS manifest,
// metadata) checks it before touching <video>, so nothing can start
// playing after the user closed the player.
let playGen = 0;

function stopTrailer() {
  document.querySelectorAll('#trailer-row iframe').forEach(f => { try { f.src = 'about:blank'; } catch {} });
}

// Fully unload the media element — pause() alone can leave audio alive.
function teardownMedia() {
  try { video.pause(); } catch {}
  video.onloadedmetadata = null;
  video.onended = null;
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  try { resetAudioPicker(); } catch {}
  try { video.removeAttribute('src'); video.load(); } catch {}
}

// Persist current position. Driven by pause/seek/timeupdate + close flush,
// so progress is saved even for quick watches — not only by the 5s timer.
let lastSave = 0;
function saveNow(force) {
  if (!currentPlay) return;
  const t = video.currentTime || 0;
  if (!(t > 1)) return;
  const now = Date.now();
  if (!force && now - lastSave < 8000) return;
  lastSave = now;
  const d = video.duration;
  const dur = Number.isFinite(d) ? Math.floor(d) : 0;
  const done = dur > 0 && (dur - t) < 90;
  try {
    DB().touch(currentPlay.item, {
      season: currentPlay.season || 0, episode: currentPlay.episode || 0,
      position: Math.floor(t), duration: dur, completed: done,
    });
  } catch {}
}
video.addEventListener('pause', () => saveNow(true));
video.addEventListener('seeked', () => saveNow(true));
video.addEventListener('timeupdate', () => saveNow(false));

// ---------- dubbed-audio hunting across servers ----------
// Providers rarely put dubs in every copy of a title — but often ONE server
// carries Hindi/English/etc. These helpers read each server's HLS master
// playlist (#EXT-X-MEDIA TYPE=AUDIO) and steer playback to the dub you want.
function getAudioPref() {
  try { return localStorage.getItem('bb:audio-pref') || 'hi'; } catch { return 'hi'; }
}
function audioPrefOrder() {
  const p = getAudioPref();
  if (!p || p === 'orig') return [];
  const order = [p];
  if (p !== 'en') order.push('en');
  return order;
}
function langCode(l) { return String(l || '').toLowerCase().split('-')[0]; }
function sameLang(a, b) {
  a = langCode(a); b = langCode(b);
  return !!a && (a === b || (AUDIO_NAMES[a] && AUDIO_NAMES[a] === AUDIO_NAMES[b]));
}
function parseAudioRenditions(m3u8) {
  const out = [];
  if (typeof m3u8 !== 'string') return out;
  const re = /#EXT-X-MEDIA:([^\n\r]+)/g;
  let m;
  while ((m = re.exec(m3u8)) !== null) {
    const attrs = {};
    const are = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
    let a;
    while ((a = are.exec(m[1])) !== null) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
    if ((attrs.TYPE || '').toUpperCase() !== 'AUDIO') continue;
    out.push({ lang: langCode(attrs.LANGUAGE), name: attrs.NAME || '' });
  }
  return out;
}
async function probeServerAudio(url, ms = 7000) {
  try {
    if (!url || !/\.m3u8/i.test(url)) return [];
    const res = await Promise.race([
      (window.api?.proxyFetch
        ? window.api.proxyFetch({ path: url })
        : fetch(url).then(async r => ({ ok: r.ok, text: await r.text() }))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
    ]);
    const text = typeof res.text === 'string' ? res.text.slice(0, 500000) : '';
    if (!res.ok || !text.includes('#EXT')) return [];
    return parseAudioRenditions(text);
  } catch { return []; }
}

async function playTitle(item, { season, episode } = {}) {
  const myGen = ++playGen;
  stopTrailer();
  teardownMedia(); // never stack two pipelines — one <video>, one stream
  currentPlay = { item, season: season || 0, episode: episode || 0 };
  lastSave = 0;
  const overlay = document.getElementById('player-overlay');
  overlay.hidden = false;
  document.getElementById('player-title').textContent = `${item.title}${season ? ` · S${season}E${episode}` : ''}`;
  document.getElementById('player-status').textContent = 'Resolving native streams…';
  document.getElementById('player-episodes').innerHTML = '';
  // resume position?
  const key = `${item.type}:${item.id}${item.type === 'tv' && season ? `:s${season}e${episode}` : ''}`;
  let resume = 0;
  try { resume = DB()._all().progress[key]?.position || 0; } catch {}

  if (!window.api?.resolve) {
    document.getElementById('player-status').textContent = 'Playback resolver needs Electron. Run with `npm start`.';
    return;
  }
  const r = await window.api.resolve({ playUrl: item.play_url, season, episode });
  if (myGen !== playGen) return; // closed while resolving — stay silent
  if (!r.ok) {
    document.getElementById('player-status').textContent = 'No streams: ' + (r.error || 'unknown');
    return;
  }
  const servers = (r.servers || []).filter(s => s.url);
  if (!servers.length) {
    const rl = (r.servers || []).find(s => s.rateLimited);
    document.getElementById('player-status').textContent = rl ? 'Rate limited — try again in a bit.' : 'No playable server right now.';
    return;
  }
  const sel = document.getElementById('server-pick');
  sel.innerHTML = servers.map((s, i) => `<option value="${i}">${esc(s.name)} · ${s.type}</option>`).join('');
  let curServerIdx = 0, userPicked = false, serverAudioLangs = [];
  const dubLangNames = (langs) => [...new Set((langs || []).map(l => AUDIO_NAMES[l.lang] || l.name || l.lang).filter(Boolean))];
  const evaluateDub = (order, { force = false } = {}) => {
    if (!order.length || !serverAudioLangs.length) return false;
    // annotate server options with the dubs each one carries
    sel.querySelectorAll('option').forEach((o) => {
      const i = Number(o.value);
      const names = dubLangNames(serverAudioLangs[i]);
      if (names.length > 1) o.textContent = `${servers[i].name} · ${servers[i].type} · 🔊 ${names.join(', ')}`;
    });
    const score = (langs) => {
      for (let i = 0; i < order.length; i++) {
        if ((langs || []).some(l => sameLang(l.lang || l, order[i]))) return order.length - i;
      }
      return 0;
    };
    const curScore = score(serverAudioLangs[curServerIdx]);
    let best = -1, bestScore = curScore;
    serverAudioLangs.forEach((langs, i) => {
      const s = score(langs);
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best >= 0 && best !== curServerIdx && (force || !userPicked)) {
      sel.value = String(best);
      pickServer(best, true);
      const st = document.getElementById('player-status');
      if (st) st.textContent = `🔊 Switched to ${servers[best].name} for ${dubLangNames(serverAudioLangs[best]).join(', ')} audio`;
      return true;
    }
    return false;
  };
  const pickServer = (idx, keepPos) => {
    curServerIdx = idx;
    const s = servers[idx];
    // subtitles
    const subSel = document.getElementById('sub-pick');
    subSel.innerHTML = `<option value="">No subtitles</option>` + (s.subtitles || []).map((u, i) => `<option value="${i}">${esc(u.label || u.lang || 'Sub ' + (i + 1))}</option>`).join('');
    subSel.onchange = () => {
      [...video.querySelectorAll('track')].forEach(t => t.remove());
      if (subSel.value === '') return;
      const u = s.subtitles[Number(subSel.value)];
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = u.label || 'subs'; tr.srclang = (u.lang || 'en').slice(0, 2);
      tr.src = u.url; tr.default = true;
      video.appendChild(tr);
    };
    // quality (mp4 renditions)
    const qSel = document.getElementById('quality-pick');
    const qs = s.qualities || [];
    qSel.innerHTML = qs.length ? qs.map((q, i) => `<option value="${i}">${esc(q.label || q.quality || i)}</option>`).join('') : `<option value="">Auto (HLS)</option>`;
    qSel.onchange = () => { if (qs.length) attachUrl(qs[Number(qSel.value)].url || s.url, s.type, Math.floor(video.currentTime || 0), myGen); };
    attachUrl(s.url, s.type, keepPos ? Math.floor(video.currentTime || 0) : resume, myGen);
    document.getElementById('player-status').textContent = `Server: ${s.name} · ${servers.length} available`;
    resume = 0; // only apply once
  };
  sel.onchange = () => { userPicked = true; pickServer(Number(sel.value), true); };
  // Preferred-dub picker (persisted). Changing it re-ranks immediately.
  const prefSel = document.getElementById('audiopref-pick');
  if (prefSel) {
    try { prefSel.value = getAudioPref(); } catch {}
    prefSel.onchange = () => {
      try { localStorage.setItem('bb:audio-pref', prefSel.value); } catch {}
      evaluateDub(audioPrefOrder(), { force: true });
    };
  }
  pickServer(0, false);
  // Hunt dubs in the background: playback starts instantly on the default
  // server, and we steer to a dubbed copy only if one actually exists.
  Promise.all(servers.map(s => probeServerAudio(s.url))).then((all) => {
    if (myGen !== playGen) return;
    serverAudioLangs = all;
    evaluateDub(audioPrefOrder());
  }).catch(() => {});

  // episodes bar — TV only. Movies never show episode buttons, even if a
  // previous TV title left stale data in window._episodes or the resolver
  // returned an episodes block for a non-TV page.
  const freshEps = r.episodes?.seasons?.length ? r.episodes : null;
  if (item.type === 'tv' && freshEps) window._episodes = freshEps;
  // Only reuse the detail-page episodes cache when it belongs to this title.
  const fallbackEps = (window._episodes?.seasons?.length && window._detail?.url && window._detail.url === item.url)
    ? window._episodes : null;
  const eps = item.type === 'tv' ? (freshEps || fallbackEps) : null;
  if (item.type === 'tv' && eps?.seasons?.length) {
    const bar = document.getElementById('player-episodes');
    const s0 = season || eps.seasons[0]?.season || 1;
    const cur = eps.seasons.find(x => x.season === s0) || eps.seasons[0];
    bar.innerHTML = (cur.episodes || []).map(e => `<button data-e="${e.episode}" class="${e.episode === episode ? 'cur' : ''}">E${e.episode}</button>`).join('');
    bar.querySelectorAll('button').forEach(b => b.onclick = () => playTitle(item, { season: s0, episode: Number(b.dataset.e) }));
  }

  // history touch + progress loop (event listeners also save on pause/seek)
  DB().touch(item, { season: season || 0, episode: episode || 0, position: resume });
  clearInterval(saveTimer);
  saveTimer = setInterval(() => saveNow(true), 5000);
  video.onended = () => {
    DB().touch(item, { season: season || 0, episode: episode || 0, position: Math.floor(video.duration || 0), duration: Math.floor(video.duration || 0), completed: true });
    // autoplay next episode — TV only, using the validated eps for this title
    if (item.type === 'tv' && eps?.seasons?.length && season && episode) {
      const s0 = eps.seasons.find(x => x.season === season);
      const next = s0?.episodes.find(e => e.episode === episode + 1);
      if (next) playTitle(item, { season, episode: episode + 1 });
    }
  };
}

function attachUrl(url, type, resume, gen) {
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  video.pause();
  video.onloadedmetadata = null;
  resetAudioPicker();
  if (/\.m3u8/i.test(url) && window.Hls?.isSupported()) {
    const cur = hls = new Hls({ enableWorker: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (gen !== playGen || cur !== hls) return; // closed / superseded
      populateAudioTracks(cur, gen);
      if (resume > 30) video.currentTime = resume;
      video.play().catch(() => {});
    });
    // Some streams list audio renditions after the manifest.
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      if (gen !== playGen || cur !== hls) return;
      populateAudioTracks(cur, gen);
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data?.fatal) document.getElementById('player-status').textContent = 'Stream error — try another server.';
    });
  } else {
    video.src = url;
    video.onloadedmetadata = () => {
      if (gen !== playGen) return; // closed while loading
      if (resume > 30) video.currentTime = resume;
      video.play().catch(() => {});
    };
  }
}
// HLS alternate-audio renditions (dubbed tracks) live inside the stream.
// Whatever the provider put in the playlist shows up here — typically the
// original language only; Hindi/Spanish/etc. appear when the source has them.
// Tip: different servers for the same title often carry different dubs.
const AUDIO_NAMES = { en: 'English', eng: 'English', hi: 'Hindi', hin: 'Hindi', bn: 'Bengali', ben: 'Bengali', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French', de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', pt: 'Portuguese', por: 'Portuguese', ar: 'Arabic', ara: 'Arabic', ru: 'Russian', rus: 'Russian', ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', ml: 'Malayalam', mal: 'Malayalam', kn: 'Kannada', kan: 'Kannada', pa: 'Punjabi', pan: 'Punjabi', gu: 'Gujarati', guj: 'Gujarati', mr: 'Marathi', mar: 'Marathi', or: 'Odia', ori: 'Odia', tr: 'Turkish', tur: 'Turkish', ur: 'Urdu', urd: 'Urdu' };
function audioLabel(t, i) {
  const code = String(t.lang || '').toLowerCase().split('-')[0];
  const name = AUDIO_NAMES[code] || t.name || code || `Track ${i + 1}`;
  const extra = t.name && code && t.name.toLowerCase() !== code && t.name.toLowerCase() !== name.toLowerCase() ? ` (${t.name})` : '';
  return `${name}${extra}${t.default ? ' · default' : ''}`;
}
function resetAudioPicker() {
  const sel = document.getElementById('audio-pick');
  if (sel) { sel.innerHTML = `<option value="">Audio: original</option>`; sel.onchange = null; }
}
function populateAudioTracks(hlsInst, gen) {  const sel = document.getElementById('audio-pick');
  if (!sel || !hlsInst) return;
  const tracks = hlsInst.audioTracks || [];
  if (tracks.length < 2) {
    // Single audio rendition — often the only one the provider ships.
    const only = tracks[0];
    sel.innerHTML = `<option value="">Audio: ${only ? esc(audioLabel(only, 0)).replace(/ · default$/, '') : 'original'}</option>`;
    sel.onchange = null;
    return;
  }
  const curIdx = hlsInst.audioTrack;
  sel.innerHTML = tracks.map((t, i) => `<option value="${i}" ${i === curIdx ? 'selected' : ''}>${esc(audioLabel(t, i))}</option>`).join('');
  sel.onchange = () => {
    const i = Number(sel.value);
    try { if (hlsInst && Number.isFinite(i)) hlsInst.audioTrack = i; } catch {}
  };
}
function closePlayer() {
  playGen++; // invalidate any pending resolve/manifest/metadata callbacks
  try { saveNow(true); } catch {} // flush final position BEFORE teardown
  currentPlay = null;
  const ov = document.getElementById('player-overlay');
  ov.hidden = true;
  clearInterval(saveTimer);
  teardownMedia();
  stopTrailer();
  updateListCount();
  if (CURRENT.route === 'home') renderHome();
  else if (CURRENT.route === 'history') renderHistory();
}
document.getElementById('player-back').onclick = closePlayer;

// ---------- search ----------
let searchT = null;
$search.addEventListener('input', () => {
  clearTimeout(searchT);
  const q = $search.value.trim();
  if (q.length < 2) { $sr.classList.remove('open'); return; }
  searchT = setTimeout(async () => {
    try {
      let items = [];
      // Primary: server-ranked mixed results (movies + tv interleaved)
      const multi = await bbFetch(`/api/search/multi?query=${encodeURIComponent(q)}`).catch(() => null);
      if (multi && (multi.results || []).length) {
        items = multi.results.map(x => norm(x, x.media_type === 'tv' ? 'tv' : 'movie')).slice(0, 14);
      } else {
        // Fallback: merge both lists, exact title matches first, then popularity
        const [m, t] = await Promise.all([
          bbFetch(`/api/search/movie?query=${encodeURIComponent(q)}&page=1`).catch(() => ({ results: [] })),
          bbFetch(`/api/search/tv?query=${encodeURIComponent(q)}&page=1`).catch(() => ({ results: [] })),
        ]);
        const ql = q.toLowerCase();
        const pool = [...(m.results || []).map(x => norm(x, 'movie')).slice(0, 15),
                      ...(t.results || []).map(x => norm(x, 'tv')).slice(0, 15)];
        items = pool.map(it => {
          const title = (it.title || '').toLowerCase();
          let s = 0;
          if (title === ql) s += 1000;
          else if (title.startsWith(ql)) s += 500;
          else if (title.includes(ql)) s += 100;
          s += Math.min(100, it.raw?.popularity || 0);
          return { it, s };
        }).sort((a, b) => b.s - a.s).map(x => x.it).slice(0, 14);
      }
      $sr.innerHTML = items.map(it => `<div class="sr-item" data-url="${it.url}"><img src="${it.poster}"/><div><div class="t">${esc(it.title)}</div><div class="s">${it.type} · ${it.year || ''} · ★ ${Number(it.rating || 0).toFixed(1)}</div></div></div>`).join('') || `<div class="sr-item">No results</div>`;
      $sr.classList.add('open');
      $sr.querySelectorAll('.sr-item[data-url]').forEach(el => el.onclick = () => { $sr.classList.remove('open'); openDetail(el.dataset.url); });
    } catch {}
  }, 250);
});
document.addEventListener('click', (e) => { if (!$sr.contains(e.target) && e.target !== $search) $sr.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== $search) { e.preventDefault(); $search.focus(); } if (e.key === 'Escape' && !document.getElementById('player-overlay').hidden) document.getElementById('player-back').click(); });

// ---------- recommendations ----------
function hasHistory() { try { return Object.keys(DB()._all().progress || {}).length > 0; } catch { return false; } }
function recommend(pool, limit) {
  // The pool merges several overlapping catalog lists — dedupe first or the
  // same title scores identically twice and renders double.
  const ukeys = new Set();
  pool = (pool || []).filter(c => {
    const k = `${c.type || c.media_type || 'movie'}:${c.id}`;
    if (ukeys.has(k)) return false;
    ukeys.add(k);
    return true;
  });
  try {
    if (window.recommendFrom) return window.recommendFrom(pool, limit);
  } catch {}
  // local fallback: genre affinity
  let aff = {};
  try {
    const prog = Object.values(DB()._all().progress || {});
    for (const p of prog) for (const g of (p.genre_ids || [])) aff[g] = (aff[g] || 0) + (p.completed ? 2 : 1);
  } catch {}
  if (!Object.keys(aff).length) return pool.slice(0, limit);
  const seen = new Set(Object.keys(DB()._all().progress || {}));
  return [...pool].map(c => {
    let s = (c.genre_ids || []).reduce((a, g) => a + (aff[g] || 0) * 2, 0) + (c.rating || 0) * .5;
    if (seen.has(`${c.type}:${c.id}`)) s -= 50;
    return { c, s };
  }).sort((a, b) => b.s - a.s).map(x => x.c).slice(0, limit);
}

// ---------- helpers ----------
function bindCards(root) {
  const scope = root || $view;
  // Remove-from-Continue-Watching buttons (must not open the title)
  scope.querySelectorAll('[data-remove]').forEach(x => {
    x.onclick = (e) => {
      e.stopPropagation();
      const [type, tmdb] = String(x.dataset.remove || '').split(':');
      try { DB().removeShow(type, Number(tmdb)); } catch {}
      if (CURRENT.route === 'history') renderHistory();
      else renderHome();
    };
  });
  scope.querySelectorAll('[data-url]').forEach(el => {
    el.onclick = (e) => {
      if (e.target.closest('[data-remove]')) return; // handled above
      openDetail(el.dataset.url);
    };
  });
}
function updateListCount() {
  try {
    const n = DB().getWatchlist().length;
    document.getElementById('nav-list-count').textContent = n ? n : '';
  } catch {}
}
function setStatus(t) { $status.textContent = t; }
function fmtTime(s) { s = Math.floor(s || 0); const m = Math.floor(s / 60), h = Math.floor(m / 60); return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`; }

// boot
updateListCount();
nav('home');
