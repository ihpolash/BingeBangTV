# BingeBang — Mac App (Electron, native UI)

Not a webview wrapper. Native Electron shell + native `<video>`/HLS player,
local history, continue-watching with resume, My List, and recommendations
re-ranked from your watch history. No TMDB key needed — talks to
BingeBang's open `/api/list`, `/api/discover`, `/api/search` + embedded
detail JSON.

## Run

```bash
npm install
npm start        # native Mac window
npm run dev      # with DevTools
npm run test:scraper
```

## How playback stays native

- Catalog/detail/search = plain `fetch` to `https://bingebang.st/api/*`
  (open, no auth) + HTML-embedded JSON for details.
- Playback = hidden `BrowserWindow` loads the real `/movie/play/...` or
  `/tv/play/...` page once, calls the site's own `window.BBSecureFetch`
  in-page to get `sources` → `resolve` → native HLS/MP4 URLs.
- Those URLs are played in the visible window with `hls.js` + `<video>`
  (quality/server/subtitle pickers, episode picker, autoplay-next).
- No site iframe is ever shown. UI is 100% local.

Ticket decode (`var k=[...],d=[...]` XOR) is in
`src/services/bingebang.js` (`decodePlayerConfig`).

## Data (all local, this Mac only)

`localStorage key bingebang-mac-v1`:
- `progress`: `{ "movie:123": {position,duration,completed,…}, "tv:456:s1e2": {...} }`
- `history`: last 500 watch events
- `watchlist`, `ratings`

Continue-watching = progress with `position>30s` and `<95%`, sorted by
`updatedAt`. Recommendations = genre-affinity vector from history +
site `recommendations`/`similar`, penalizing already-watched.

## Package for MacBook

```bash
npm run pack:mac   # → dist/BingeBang.dmg + .zip (electron-builder)
```

If `bongebang.st` moves domain, change `BASE` in
`src/services/bingebang.js` + `src/main.js` resolver URLs.
