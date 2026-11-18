'use strict';
/* 真实接口自测：把用户给的多仓接口放进渲染进程里跑一遍，输出每条线路的可直连站点数。
   用法：node_modules\electron\dist\electron.exe test\live.js [接口URL] */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const netfetch = require('../src/netfetch');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const LIVE = process.argv.find((a) => /^https?:\/\//i.test(a)) || 'https://15487.kstore.space/0619%E5%A4%9A%E7%BA%BF.txt';
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
    server.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

const SCRIPT = `(async () => {
  const out = { errors: [] };
  window.addEventListener('error', e => out.errors.push('onerror: ' + e.message));
  try {
    await window.tvbox.setIdentity('', '');
    const cfg = await loadInterface('${LIVE}', { save: false });
    out.subReturned = !!cfg;                       // 非空说明是单接口，不是多仓
    out.pickerOpen = !document.querySelector('#modalPane').classList.contains('hidden');
    out.lines = (window.__repoLines || []).map(l => ({ name: l.name, url: l.url, n: (window.__repoLines || []).length }));

    // 点「合并可用站点」：全量探测 110 条线路，把可直连 cms 站点去重合并成一个接口
    const btns = document.querySelectorAll('#modalActions .btn');
    if (btns[1]) {
      btns[1].click();
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        await new Promise(r => setTimeout(r, 500));
        if (S.sites && S.sites.length && document.querySelector('#modalPane').classList.contains('hidden')) break;
      }
    }
    out.mergedName = S.cfgName;
    out.loadedUsable = S.sites.filter(isCmsSite).length;
    const probeArr = window.__repoProbe || [];
    out.probed = probeArr.filter(Boolean).length;
    out.linesTotal = (window.__repoLines || []).length;

    const site = S.sites.find(isCmsSite);
    if (site) {
      out.siteApi = site.api;
      try {
        const home = await fetchHome(site);
        out.homeList = home.list.length;
        out.firstTitle = home.list[0] && (home.list[0].title || home.list[0].name);
        const cat = await fetchCategory(site, '', 1);
        out.catList = cat.list.length;
      } catch (e) { out.homeError = String(e && (e.message || e)); }
    }
    hideModal();
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e));
  }
  return out;
})()`;

app.whenReady().then(async () => {
  ipcMain.handle('http:get', async (_e, p) => {
    try {
      const r = await netfetch.httpGet(p.url, p.headers || {}, p.timeout || 15000);
      return { ok: !!r.ok, status: r.status || 0, text: r.text || '', finalUrl: r.finalUrl || p.url, error: r.error || '' };
    } catch (err) {
      return { ok: false, status: 0, text: '', error: String(err.message || err) };
    }
  });
  ipcMain.handle('net:set-identity', async (_e, ua, ref) => { netfetch.setIdentity(ua, ref); return true; });
  ipcMain.handle('app:info', async () => ({ version: 'live', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/index.html');
  win.setOpacity(0.01);
  win.setFocusable(false);
  win.setSkipTaskbar(true);
  win.showInactive();
  await new Promise((r) => setTimeout(r, 800));

  const res = await win.webContents.executeJavaScript(SCRIPT, true);
  console.log('LIVE_RESULT ' + JSON.stringify(res, null, 2));
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
