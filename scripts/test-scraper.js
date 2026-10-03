// Smoke test for BingeBang scraper (no Electron needed).
const BB = require('../src/services/bingebang.js');

(async () => {
  console.log('== home ==');
  const home = await BB.getHome();
  console.log('hero:', home.hero.map(h => h.title).slice(0, 3));
  console.log('rows:', home.rows.map(r => `${r.title}:${r.items.length}`).join(' | '));

  console.log('\n== detail (movie) ==');
  const slug = home.rows[0].items[0];
  console.log('sample:', slug.title, slug.url);
  // fetch detail via HTML path
  const { getDetail } = BB;
  // getDetail expects watchUrl; reuse service that fetches HTML itself
  // BB.getDetail uses fetch to BASE — works in Node 18+
  try {
    const d = await getDetail(slug.url);
    console.log('detail:', d.title, '| genres:', d.genres, '| recs:', d.recs.length, '| similar:', d.similar.length, '| cast:', d.cast.length);
  } catch (e) { console.error('detail failed:', e.message); }

  console.log('\n== search ==');
  const { searchMulti } = BB;
  // searchMulti uses getJSON — implement quick inline (service exports it? uses fetch)
  // BB.searchMulti not exported with that name? we exported searchMulti
  try {
    const res = await BB.searchMulti('batman', 1).catch(() => null);
    console.log('search type:', typeof res, Array.isArray(res) ? res.length : 'n/a');
  } catch (e) { console.error('search failed:', e.message); }

  console.log('\n== player ticket ==');
  try {
    const cfg = await BB.getPlayerConfig(slug.play_url);
    console.log('ticket len:', cfg.ticket.length, '| sourcesUrl:', cfg.sourcesUrl, '| media:', cfg.mediaType, cfg.mediaId);
  } catch (e) { console.error('player cfg failed:', e.message); }

  console.log('\nOK');
})().catch(e => { console.error(e); process.exit(1); });
