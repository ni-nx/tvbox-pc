'use strict';
/* 截图：首页顶栏（焦点框 + 右上角状态区） */
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

app.whenReady().then(async () => {
  ipcMain.handle('http:get', async (_e, p) => {
    try {
      const res = await fetch(p.url, { headers: p.headers || {} });
      return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
    } catch (err) { return { ok: false, status: 0, text: '', error: String(err.message || err) }; }
  });
  ipcMain.handle('net:set-identity', async () => true);
  ipcMain.handle('app:info', async () => ({ version: '2.7.1', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);
  ipcMain.handle('store:all', async () => ({}));
  ipcMain.handle('store:set', async () => true);
  ipcMain.handle('store:clear', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1600, height: 900, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#eef3f8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/?theme=light');
  await new Promise((r) => setTimeout(r, 1200));
  const info = await win.webContents.executeJavaScript(`(async () => {
    document.body.classList.remove('top-compact');
    const t = document.querySelector('.tile');
    if (t && window.kodiSetFocus) window.kodiSetFocus(t);
    if (t) t.classList.add('focus');
    // 天气取不到时也给个样例，方便看排版
    const w = document.getElementById('weatherChip');
    if (w && !w.textContent.trim()) { w.textContent = '新余 · 小雨 18°'; w.hidden = false; }
    await new Promise(r => setTimeout(r, 400));
    const tiles = document.querySelector('.tiles');
    const cs = getComputedStyle(tiles);
    const chips = Array.from(document.querySelectorAll('.status-item')).map(e => ({ id: e.id, h: e.getBoundingClientRect().height, fs: getComputedStyle(e).fontSize }));
    return { overflow: cs.overflow, padding: cs.padding, chips };
  })()`, true);
  console.log(JSON.stringify(info));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1600, height: 320 });
  const out = process.env.SHOT_OUT || 'D:\\TVBox-PC-build\\top.png';
  fs.writeFileSync(out, img.toPNG());
  console.log('shot', out);
  app.exit(0);
});
