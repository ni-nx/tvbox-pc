'use strict';
/* 自测：右上角状态区（日期时间 / 天气 / 网络）与设置页开关 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
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
  const out = {};
  out.url = location.href;
  out.hasStatusBar = !!document.getElementById('statusBar');
  out.topRight = (document.querySelector('.top-right') || {}).outerHTML || 'none';
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  out.time = (document.getElementById('clockTime') || {}).textContent;
  out.date = (document.getElementById('clockDate') || {}).textContent;
  out.clockVisible = vis(document.getElementById('clock'));
  out.netText = document.getElementById('netText').textContent;
  out.netVisible = vis(document.getElementById('netChip'));
  // 天气：真请求（定位 + open-meteo），最多等 20 秒
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const w = document.getElementById('weatherChip');
    if (w && w.textContent.trim()) { out.weather = w.textContent; break; }
    if (w && getComputedStyle(w).display === 'none' && Date.now() - t0 > 8000) { out.weatherHidden = true; break; }
    await new Promise(r => setTimeout(r, 700));
  }
  out.weatherVisible = vis(document.getElementById('weatherChip'));
  out.weatherText = (document.getElementById('weatherChip') || {}).textContent || '';

  // 开关：关掉时钟应立即隐藏，开回来应立即显示
  switchView('settings');
  await new Promise(r => setTimeout(r, 300));
  const ck = document.getElementById('setShowClock');
  out.hasClockSwitch = !!ck;
  if (ck) {
    ck.checked = false; ck.dispatchEvent(new Event('change'));
    out.clockHiddenAfterOff = !vis(document.getElementById('clock'));
    ck.checked = true; ck.dispatchEvent(new Event('change'));
    out.clockBackAfterOn = vis(document.getElementById('clock'));
  }
  const wk = document.getElementById('setShowNet');
  if (wk) {
    wk.checked = false; wk.dispatchEvent(new Event('change'));
    out.netHiddenAfterOff = !vis(document.getElementById('netChip'));
    wk.checked = true; wk.dispatchEvent(new Event('change'));
  }
  out.advancedPanels = document.querySelectorAll('#view-settings details.adv').length;
  out.panelsVisible = document.querySelectorAll('#view-settings > .panel').length;
  out.persisted = JSON.parse(localStorage.getItem('tvbox_settings_v1') || '{}');
  return out;
})()`;

app.whenReady().then(async () => {
  ipcMain.handle('http:get', async (_e, p) => {
    try {
      const res = await fetch(p.url, { headers: p.headers || {} });
      return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
    } catch (err) {
      return { ok: false, status: 0, text: '', error: String(err.message || err) };
    }
  });
  ipcMain.handle('net:set-identity', async () => true);
  ipcMain.handle('app:info', async () => ({ version: '2.7.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);
  ipcMain.handle('store:all', async () => ({}));
  ipcMain.handle('store:set', async () => true);
  ipcMain.handle('store:clear', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/');
  await new Promise((r) => setTimeout(r, 900));
  let result;
  try { result = await win.webContents.executeJavaScript(SCRIPT, true); }
  catch (e) { result = { fatal: String(e && (e.stack || e.message || e)) }; }
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
});
