'use strict';
/* 截图：多仓选线路弹窗（长清单），检查滚动条样式与是否出现双滚动条。仅开发用。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const SHOTS = path.join(__dirname, 'shots');
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:8899';
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
  ipcMain.handle('app:info', async () => ({ version: '2.3.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, paintWhenInitiallyHidden: true,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/index.html');
  await new Promise((r) => setTimeout(r, 1200));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    await loadInterface('${MOCK}/repo-big.json');
    await sleep(600);
    const modal = document.querySelector('.modal');
    const list = document.querySelector('#repoList');
    return {
      lines: document.querySelectorAll('#repoList .repo-line').length,
      modalScrolls: modal ? modal.scrollHeight > modal.clientHeight + 2 : null,
      listScrolls: list ? list.scrollHeight > list.clientHeight + 2 : null,
      listMaxH: list ? Math.round(list.clientHeight) : 0
    };
  })()`, true);
  await new Promise((r) => setTimeout(r, 1200));
  // 隐藏窗口里动画帧不推进，浮层的淡入会停在 opacity:0；截图前把过渡关掉
  await win.webContents.executeJavaScript(
    `(() => { const s = document.createElement('style'); s.textContent = '*{transition:none!important;animation:none!important}'; document.head.appendChild(s); return true; })()`, true);
  await new Promise((r) => setTimeout(r, 400));
  const state = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('#modalPane');
    return { visible: pane ? !pane.classList.contains('hidden') : false, title: (document.querySelector('.modal h3') || {}).textContent || '' };
  })()`, true);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, 'repo-picker.png'), img.toPNG());
  console.log('REPO_SHOT ' + JSON.stringify(Object.assign({}, res, { atCapture: state })));
  app.quit();
}).catch((e) => { console.error('REPO_SHOT_FAIL', e); app.exit(1); });
