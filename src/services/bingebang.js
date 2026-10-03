// BingeBang API client — no TMDB key needed.
// Uses open /api/list, /api/discover, /api/search + HTML-embedded JSON for details.
// Base host is configurable (site moves domains often).

const BASE = 'https://bingebang.st';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 BingeBang-Mac/1.0';

async function getJSON(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function getHTML(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.text();
}

function img(path, size = 'w500') {
  if (!path) return '';
  if (/^https?:/.test(path)) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

function normalize(item, fallbackType) {
  const isTv = (item.media_type || item._type || fallbackType) === 'tv';
  return {
    id: item.id,
    type: isTv ? 'tv' : 'movie',
    title: item.title || item.name || 'Untitled',
    overview: item.overview || '',
    poster: img(item.poster_path, 'w500'),
    backdrop: img(item.backdrop_path || item.backdrop_titled_path, 'w1280'),
    logo: item.logo_path ? img(item.logo_path, 'w500') : '',
    year: item.year || (item.release_date || item.first_air_date || '').slice(0, 4),
    rating: item.vote_average ?? 0,
    votes: item.vote_count ?? 0,
    genres: (item.genres || []).map(g => g.name || g),
    genre_ids: item.genre_ids || (item.genres || []).map(g => g.id),
    runtime: item.runtime || null,
    seasons: item.number_of_seasons || null,
    url: item.url,           // e.g. /movie/watch/slug
    play_url: item.play_url, // e.g. /movie/play/slug
    raw: item,
  };
}

// ---- Home rows (all open APIs) ----
async function getHome() {
  const [tmW, tvW, nowPlaying, tvPop, moviePop, tvTop] = await Promise.all([
    getJSON('/api/list/trending_movie_week?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/trending_tv_week?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/movie_now_playing?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/tv_popular?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/movie_popular?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/tv_top_rated?limit=24').catch(() => ({ results: [] })),
  ]);
  const hero = (tmW.results || []).filter(m => m.backdrop_path && m.overview).slice(0, 5).map(i => normalize(i, 'movie'));
  return {
    hero,
    rows: [
      { key: 'trending-movies', title: 'Trending Movies This Week', items: (tmW.results || []).map(i => normalize(i, 'movie')) },
      { key: 'trending-tv', title: 'Trending Series This Week', items: (tvW.results || []).map(i => normalize(i, 'tv')) },
      { key: 'new', title: 'New Releases', items: (nowPlaying.results || []).map(i => normalize(i, 'movie')) },
      { key: 'popular-movies', title: 'Popular Movies', items: (moviePop.results || []).map(i => normalize(i, 'movie')) },
      { key: 'popular-tv', title: 'Popular Series', items: (tvPop.results || []).map(i => normalize(i, 'tv')) },
      { key: 'top-tv', title: 'Top Rated Series', items: (tvTop.results || []).map(i => normalize(i, 'tv')) },
    ],
  };
}

async function getMoviesPage() {
  const [trending, popular, top, now] = await Promise.all([
    getJSON('/api/list/trending_movie_day?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/movie_popular?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/movie_top_rated?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/movie_now_playing?limit=24').catch(() => ({ results: [] })),
  ]);
  return [
    { key: 'm-trending', title: 'Trending Today', items: (trending.results || []).map(i => normalize(i, 'movie')) },
    { key: 'm-popular', title: 'Popular', items: (popular.results || []).map(i => normalize(i, 'movie')) },
    { key: 'm-top', title: 'Top Rated', items: (top.results || []).map(i => normalize(i, 'movie')) },
    { key: 'm-now', title: 'Now Playing', items: (now.results || []).map(i => normalize(i, 'movie')) },
  ];
}

async function getTvPage() {
  const [trending, popular, airing, top] = await Promise.all([
    getJSON('/api/list/trending_tv_day?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/tv_popular?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/tv_on_the_air?limit=24').catch(() => ({ results: [] })),
    getJSON('/api/list/tv_top_rated?limit=24').catch(() => ({ results: [] })),
  ]);
  return [
    { key: 't-trending', title: 'Trending Today', items: (trending.results || []).map(i => normalize(i, 'tv')) },
    { key: 't-popular', title: 'Popular', items: (popular.results || []).map(i => normalize(i, 'tv')) },
    { key: 't-airing', title: 'On The Air', items: (airing.results || []).map(i => normalize(i, 'tv')) },
    { key: 't-top', title: 'Top Rated', items: (top.results || []).map(i => normalize(i, 'tv')) },
  ];
}

// ---- Detail: parse embedded application/json ----
function extractDetailJSON(html) {
  const re = /<script type="application\/json"[^>]*>(.*?)<\/script>/gs;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      if (data && (data.media_type || data.title || data.name) && (data.overview !== undefined)) {
        // detail blob has overview + credits/genres; hero list does not have credits
        if (data.credits || data.genres || data.recommendations) return data;
      }
    } catch { /* continue */ }
  }
  return null;
}

async function getDetail(watchUrl) {
  // watchUrl like /movie/watch/slug or /tv/watch/slug
  const html = await getHTML(watchUrl);
  const data = extractDetailJSON(html);
  if (!data) throw new Error('detail parse failed for ' + watchUrl);
  const isTv = (data.media_type === 'tv') || watchUrl.startsWith('/tv/');
  const item = normalize({ ...data, media_type: isTv ? 'tv' : 'movie', _type: isTv ? 'tv' : 'movie' }, isTv ? 'tv' : 'movie');
  const recs = ((data.recommendations && data.recommendations.results) || []).map(r => normalize({ ...r, media_type: r.media_type || (r.first_air_date ? 'tv' : 'movie') }));
  const similar = ((data.similar && data.similar.results) || []).map(r => normalize({ ...r, media_type: r.media_type || (r.first_air_date ? 'tv' : 'movie') }));
  return {
    ...item,
    tagline: data.tagline || '',
    certification: data.certification || '',
    trailer: data.trailer_key ? `https://www.youtube.com/embed/${data.trailer_key}` : '',
    cast: ((data.credits && data.credits.cast) || []).slice(0, 12).map(c => ({
      name: c.name, character: c.character, photo: c.profile_path ? img(c.profile_path, 'w185') : '',
    })),
    recs, similar,
    seasons: data.seasons || [],
    number_of_episodes: data.number_of_episodes || null,
    detailUrl: watchUrl,
  };
}

// ---- Search ----
async function searchMulti(query, page = 1) {
  const [movies, tv] = await Promise.all([
    getJSON(`/api/search/movie?query=${encodeURIComponent(query)}&page=${page}`).catch(() => ({ results: [] })),
    getJSON(`/api/search/tv?query=${encodeURIComponent(query)}&page=${page}`).catch(() => ({ results: [] })),
  ]);
  return [
    ...(movies.results || []).map(r => normalize({ ...r, media_type: 'movie' }, 'movie')),
    ...(tv.results || []).map(r => normalize({ ...r, media_type: 'tv' }, 'tv')),
  ];
}

// ---- Player ticket: decode inline (k,d) XOR -> __BB_PLAYER__ + __BB_EPISODES__ ----
function decodePlayerConfig(html) {
  const m = html.match(/var k=\[([0-9,]+)\],d=\[([0-9,]+)\]/);
  if (!m) throw new Error('player config not found');
  const k = m[1].split(',').map(Number);
  const d = m[2].split(',').map(Number);
  let s = '';
  for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i] ^ k[i % k.length]);
  if (!s.includes('__BB_PLAYER__')) throw new Error('__BB_PLAYER__ decode failed');
  // episodes block may be large; extract with balanced-brace scan
  const epMatch = s.match(/window\.__BB_EPISODES__\s*=\s*(\{[\s\S]*\});?/);
  // Pull the fields we need with regex (object contains a resolve() fn so no JSON.parse)
  const ticket = (s.match(/ticket:\s*"([^"]+)"/) || [])[1] || '';
  const sourcesUrl = (s.match(/sourcesUrl:\s*"([^"]+)"/) || [])[1] || '/api/player/sources';
  const mediaType = (s.match(/mediaType:\s*"([^"]+)"/) || [])[1] || '';
  const mediaId = Number((s.match(/mediaId:\s*([0-9]+)/) || [])[1] || 0);
  const imdb = (s.match(/imdb:\s*"([^"]*)"/) || [])[1] || '';
  const season = Number((s.match(/season:\s*([0-9]+)/) || [])[1] || 0);
  const episode = Number((s.match(/episode:\s*([0-9]+)/) || [])[1] || 0);
  let episodes = null;
  try {
    if (epMatch) {
      // __BB_EPISODES__ is pure JSON-ish (quoted keys) — try JSON.parse
      episodes = JSON.parse(epMatch[1]);
    }
  } catch { episodes = null; }
  // fallback: also try inline HTML __BB_EPISODES__ (non-obfuscated pages embed it plain?)
  if (!episodes) {
    const m2 = html.match(/window\.__BB_EPISODES__\s*=\s*(\{[\s\S]*?\});/);
    if (m2) { try { episodes = JSON.parse(m2[1]); } catch {} }
  }
  return { ticket, sourcesUrl, mediaType, mediaId, imdb, season, episode, episodes, raw: null };
}

async function getPlayerConfig(playUrl) {
  // playUrl like /movie/play/slug or /tv/play/slug[/S/E] or with ?season=&episode=
  const html = await getHTML(playUrl);
  return decodePlayerConfig(html);
}

module.exports = { BASE, getHome, getMoviesPage, getTvPage, getDetail, searchMulti, getPlayerConfig, decodePlayerConfig, normalize, img };
