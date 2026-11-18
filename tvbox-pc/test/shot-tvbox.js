'use strict';
/* 新版 TVBox 布局截图：浅色首页 / 深色首页 / 详情 / 搜索键盘 / 设置 / 播放器底部条。仅开发用。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
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
  ipcMain.handle('app:info', async () => ({ version: '2.5.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1600, height: 900, show: false, paintWhenInitiallyHidden: true,
    backgroundColor: '#f2f6fb',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const shots = path.join(__dirname, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const shot = async (name) => {
    await win.webContents.capturePage();      // 先抓一帧逼着窗口重绘（窗口是隐藏的）
    await sleep(220);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shots, name), img.toPNG());
    console.log('SHOT ' + name);
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await js("const s=document.createElement('style');s.textContent='*{transition:none!important;animation:none!important}';document.head.appendChild(s);");
  await js("applyTheme('light', false)");
  await js(`loadInterface('${MOCK}/config.json', { save: false })`.replace(/\n/g, ''));
  await sleep(2400);
  await js("switchView('home')");
  await sleep(2400);
  await shot('v2-home-light.png');

  await js("applyTheme('dark', false)");
  await sleep(500);
  await shot('v2-home-dark.png');
  await js("applyTheme('light', false)");
  await sleep(400);

  // 详情
  const card = "const c=document.querySelector('#aggGrid .card'); if(c) c.click();";
  await js(`(async () => { ${card} })()`);
  await sleep(1800);
  await shot('v2-detail.png');
  await js("document.querySelector('#detailPane').classList.add('hidden')");

  // 搜索 + 键盘
  await js("switchView('search')");
  await sleep(500);
  await shot('v2-search.png');
  await js("document.querySelector('#btnOsk').click()");
  await sleep(300);
  await shot('v2-search-osk.png');

  // 设置
  await js("switchView('settings')");
  await sleep(500);
  await shot('v2-settings.png');

  app.quit();
}).catch((e) => { console.error('SHOT_FAIL', e); app.exit(1); });
