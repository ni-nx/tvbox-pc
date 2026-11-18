'use strict';
/* 真接口自测：直接拿线上多仓/单仓接口跑一遍（点播列表 → 详情 → 选集；搜索；直播）。
   仅开发用，不参与打包。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const IFACE = process.env.IFACE_URL || 'https://tv.sxi.qzz.io/jsm.json';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

let base = '';
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f)) { res.writeHead(404).end('no'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
      res.end(fs.readFileSync(f));
    });
    server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; resolve(); });
  });
}

const SCRIPT = `(async () => {
  const out = { iface: ${JSON.stringify(IFACE)}, errors: [] };
  window.addEventListener('error', e => out.errors.push('onerror: ' + e.message));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  try {
    await loadInterface(${JSON.stringify(IFACE)}, { name: '线上接口', save: false, forcePicker: false });
  } catch (e) { out.loadErr = String(e.message || e); }
  out.sites = S.sites.length;
  out.usableSites = S.sites.filter(isCmsSite).length;
  out.lives = S.lives.length;
  out.skipped = {};
  S.sites.forEach(s => { const why = siteSkipReason(s); if (why) out.skipped[why] = (out.skipped[why] || 0) + 1; });

  switchView('home');
  await sleep(7000);
  out.homeCards = document.querySelectorAll('#homeRows .card').length;
  out.homeLoading = !!document.querySelector('#homeRows .loading');
  out.homeEmpty = !!document.querySelector('#homeRows .empty');

  const site = S.sites.filter(isCmsSite)[0];
  if (site) {
    try {
      const home = await fetchHome(site);
      out.firstSiteName = site.name;
      out.firstSiteList = home.list.length;
      if (home.list.length) {
        const vod = home.list[0];
        const det = await fetchDetail(site, vod.id);
        out.detailName = det && det.name;
        const groups = parsePlaySources(det || {});
        out.playGroups = groups.length;
        out.eps = groups.length ? groups[0].episodes.length : 0;
        out.searchWord = String(vod.name || '').slice(0, 2);
        const sr = await searchSite(site, out.searchWord);
        out.searchResults = sr.length;
      }
    } catch (e) { out.firstSiteErr = String(e.message || e); }
  }

  if (S.lives.length) {
    try {
      switchView('live');
      await sleep(9000);
      out.liveSrcLine = (document.getElementById('liveSrcLine') || {}).textContent;
      out.liveGroupsUi = document.querySelectorAll('#liveGroups .grp-item').length;
      out.liveChannelsUi = document.querySelectorAll('#liveSide .ch-item').length;
      out.livePageEmpty = !!document.querySelector('#view-live .empty');
    } catch (e) { out.liveErr = String(e.message || e); }
  }
  return JSON.stringify(out);
})()`;

app.whenReady().then(async () => {
  await startServer();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  ipcMain.handle('http:get', async (_e, p) => {
    try {
      const res = await fetch(p.url, { headers: p.headers || {} });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, finalUrl: res.url || p.url };
    } catch (e) {
      return { ok: false, status: 0, text: '', error: String(e.message || e) };
    }
  });
  ipcMain.handle('net:set-identity', async () => true);
  ipcMain.handle('app:info', async () => ({ version: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);
  await win.loadURL(base + '/index.html?theme=light');
  await new Promise(r => setTimeout(r, 800));
  const res = await win.webContents.executeJavaScript(SCRIPT, true);
  console.log('REAL_IFACE_RESULT ' + res);
  app.quit();
}).catch((e) => { console.log('REAL_IFACE_FAIL ' + e.message); app.quit(); });
