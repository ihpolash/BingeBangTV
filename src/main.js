const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

// A second app copy would play a second audio stream and split history
// across two windows — only ever allow one instance.
if (!app.requestSingleInstanceLock()) app.quit();

let mainWin = null;
let resolverWin = null;

function createMain() {
  mainWin = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'BingeBang',
    backgroundColor: '#0a0612',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) mainWin.webContents.openDevTools({ mode: 'detach' });
  mainWin.on('closed', () => {
    mainWin = null;
    // Closing the window quits the app fully (only the hidden resolver would
    // remain — a windowless process that also holds the single-instance lock
    // and makes relaunching from Dock/Launchpad silently do nothing).
    app.quit();
  });
}

// Hidden resolver: loads real play pages so site JS (BBSecureFetch) runs,
// then calls it in-page to get native HLS URLs. UI stays 100% native.
// NOTE: the site player autoplays — this window is permanently muted and
// media autoplay is disabled so it can NEVER produce a second audio stream.
function getResolver() {
  if (resolverWin) return resolverWin;
  resolverWin = new BrowserWindow({
    show: false,
    backgroundColor: '#000',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      autoplayPolicy: 'document-user-activation-required',
    },
  });
  resolverWin.webContents.setAudioMuted(true);
  // Spoof Mac UA so Cloudflare serves same content
  resolverWin.webContents.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36 BingeBang-Mac/1.0');
  return resolverWin;
}

async function resolveInPage(playUrl, season, episode) {
  const win = getResolver();
  win.webContents.setAudioMuted(true); // re-assert: hidden window must stay silent
  let target = playUrl;
  // tv episode deep link: /tv/play/slug/S/E
  if (season && episode && /\/tv\/play\//.test(playUrl) && !/\/\d+\/\d+$/.test(playUrl)) {
    target = `${playUrl.replace(/\/$/, '')}/${season}/${episode}`;
  }
  const full = target.startsWith('http') ? target : `https://bingebang.st${target}`;
  await win.loadURL(full, { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36 BingeBang-Mac/1.0' });
  // wait for player config + BBSecureFetch
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      let n = 0;
      const t = setInterval(() => {
        n++;
        if ((window.__BB_PLAYER__ && window.BBSecureFetch) || n > 100) { clearInterval(t); resolve(true); }
      }, 100);
    });
  `);
  const result = await win.webContents.executeJavaScript(`
    (async () => {
      try {
        const cfg = window.__BB_PLAYER__;
        if (!cfg) return { ok: false, error: 'no player config' };
        const data = await window.BBSecureFetch(cfg.sourcesUrl);
        if (!data || !data.ok) return { ok: false, error: (data && data.error) || 'sources failed', raw: data };
        const servers = data.servers || [];
        const out = [];
        for (const s of servers) {
          try {
            const r = await cfg.resolve(s);
            out.push({ name: s.name || s.label || 'Server', url: r.url, type: r.type, subtitles: r.subtitles || [], qualities: r.qualities || [], source_url: s.source_url });
          } catch (e) {
            out.push({ name: s.name || 'Server', error: String(e && e.message || e), rateLimited: !!(e && e.rateLimited) });
          }
          if (out.filter(x => x.url).length >= 4) break; // enough for native playback
        }
        return { ok: true, servers: out, episodes: window.__BB_EPISODES__ || null, title: cfg.title };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    })()
  `);
  // Kill any media the site player may have started — we only need the URLs
  win.webContents.executeJavaScript(
    `try{document.querySelectorAll('video,audio').forEach(m=>{try{m.pause()}catch(e){};try{m.removeAttribute('src');m.load()}catch(e){}})}catch(e){}`
  ).catch(() => {});
  return result;
}

ipcMain.handle('bb:resolve', async (_e, { playUrl, season, episode }) => {
  try {
    return await resolveInPage(playUrl, season, episode);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// Generic BingeBang fetch proxy (avoids renderer CORS, keeps UA consistent)
ipcMain.handle('bb:fetch', async (_e, { path, method }) => {
  try {
    const url = path.startsWith('http') ? path : `https://bingebang.st${path}`;
    // Stream CDNs reject hotlinked playlists without a site Referer.
    const isStream = /m3u8|mp4|bingebangstream/i.test(url);
    const res = await fetch(url, {
      method: method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 BingeBang-Mac/1.0',
        Accept: path.includes('/api/') ? 'application/json' : '*/*',
        ...(isStream ? { Referer: 'https://bingebang.st/', Origin: 'https://bingebang.st' } : {}),
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

app.whenReady().then(() => {
  // Referer/CSP tweaks for HLS hosts (streaming CDN needs plain referer)
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = { ...details.requestHeaders };
    if (/bingebangstream|m3u8|mp4/i.test(details.url)) {
      h['Referer'] = 'https://bingebang.st/';
      h['Origin'] = 'https://bingebang.st';
    }
    cb({ requestHeaders: h });
  });
  createMain();
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    } else {
      createMain();
    }
  });
  // Reopen the window when the Dock/Launchpad icon is clicked and no
  // main window exists. NOTE: must not use getAllWindows().length here —
  // the hidden resolver window counts, which is exactly what made
  // reopening silently do nothing.
  app.on('activate', () => { if (!mainWin || mainWin.isDestroyed()) createMain(); });
});

app.on('before-quit', () => {
  try { if (resolverWin && !resolverWin.isDestroyed()) resolverWin.destroy(); } catch {}
  resolverWin = null;
});

app.on('window-all-closed', () => { app.quit(); });
