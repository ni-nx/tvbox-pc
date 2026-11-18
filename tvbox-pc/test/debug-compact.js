'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.join(__dirname, '..', 'src', 'renderer');
let base = '';
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!fs.existsSync(f)) { res.writeHead(404).end('no'); return; }
      const ext = path.extname(f).toLowerCase();
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(fs.readFileSync(f));
    });
    server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; resolve(); });
  });
}
app.whenReady().then(async () => {
  ipcMain.handle('http:get', async (_e, p) => {
    try { const r = await fetch(p.url, { headers: p.headers || {} }); return { ok: r.ok, status: r.status, text: await r.text(), finalUrl: r.url }; }
    catch (e) { return { ok: false, status: 0, text: '', error: String(e.message || e) }; }
  });
  ipcMain.handle('net:set-identity', async () => true);
  ipcMain.handle('app:info', async () => ({ version: '2.5.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);
  await startServer();
  const win = new BrowserWindow({ width: 1400, height: 800, show: false, webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, webSecurity: false, backgroundThrottling: false } });
  await win.loadURL(base + '/index.html');
  await new Promise(r => setTimeout(r, 800));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    await loadInterface('http://127.0.0.1:8899/config.json', { save:false });
    switchView('search'); await sleep(500);
    const v = document.querySelector('#view-search');
    v.scrollTop = 220; v.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(200);
    const a = document.body.classList.contains('top-compact');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await sleep(300);
    const b = document.body.classList.contains('top-compact');
    const modal = document.querySelector('#modalPane').className;
    const tilesH = Math.round(document.querySelector('.tiles').getBoundingClientRect().height);
    return { afterScroll: a, afterUp: b, modal, tilesH, scrollTop: v.scrollTop, focus: (window.kodiFocus()||{}).className };
  })()`, true);
  console.log('DEBUG ' + JSON.stringify(res));
  app.quit();
});
