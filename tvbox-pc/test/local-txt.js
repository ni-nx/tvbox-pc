'use strict';
/* 本地接口文件自测：把一段接口 json 当成本地 .json/.txt 文件导入 → 内容存进软件（localStorage）→ 刷新后还能用。仅开发用。 */
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

const STEP1 = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  switchView('settings');
  await sleep(400);
  out.hasPickBtn = !!document.querySelector('#btnPickFile');
  out.hasFileInput = !!document.querySelector('#fileIface');

  // 造一个「本地接口文件」：内容就是 mock 站点的真实 cms 接口
  const txt = JSON.stringify({
    name: '本地导入自测',
    sites: [{ key: 'local', name: '本地站点', type: 1, api: '${MOCK}/api.php/provide/vod/', searchable: 1 }]
  });
  const file = new File([txt], '我的本地接口.json', { type: 'application/json' });
  await importLocalInterface(file);
  await sleep(1400);

  out.cfgName = S.cfgName;
  out.sites = S.sites.length;
  out.usable = S.sites.filter(isCmsSite).length;
  out.ifaces = JSON.parse(localStorage.getItem('tvbox_iface_v1') || '[]')
    .map((i) => ({ name: i.name, hasUrl: !!i.url, rawLen: (i.raw || '').length }));
  out.pickerOpen = !document.querySelector('#modalPane').classList.contains('hidden');

  switchView('home');
  await sleep(1800);
  out.homeCards = document.querySelectorAll('#view-home .card').length;

  // 设置页列表里要出现这条本地接口
  switchView('settings');
  await sleep(400);
  out.listRows = document.querySelectorAll('#ifaceList .iface-row').length;
  out.listFirst = (document.querySelector('#ifaceList .i-name') || {}).textContent;

  location.reload();
  return out;
})()`;

const STEP2 = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(2200);
  out.bootName = S.cfgName;
  out.bootSites = S.sites.length;
  out.bootCards = document.querySelectorAll('#view-home .card').length;
  out.ifaces = JSON.parse(localStorage.getItem('tvbox_iface_v1') || '[]').length;
  // 启动默认浅色
  out.bootLight = document.body.classList.contains('light');
  out.bootTheme = (S.settings.theme || '');
  out.bootBg = getComputedStyle(document.body).backgroundColor;
  // 手动深色 / 跟随系统
  applyTheme('dark', true);
  out.darkOn = !document.body.classList.contains('light');
  applyTheme('auto', true);
  out.autoTheme = S.settings.theme;
  out.autoLight = document.body.classList.contains('light');
  out.stored = JSON.parse(localStorage.getItem('tvbox_settings_v1') || '{}').theme;
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
  ipcMain.handle('app:info', async () => ({ version: '2.5.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1400, height: 860, show: false, paintWhenInitiallyHidden: true,
    backgroundColor: '#f2f6fb',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/index.html');
  await new Promise((r) => setTimeout(r, 800));
  await win.webContents.executeJavaScript('localStorage.clear(); location.reload();', true);
  await new Promise((r) => setTimeout(r, 1200));

  const step1 = await win.webContents.executeJavaScript(STEP1, true);
  await new Promise((r) => setTimeout(r, 2400));
  const step2 = await win.webContents.executeJavaScript(STEP2, true);

  console.log('LOCAL_TXT_RESULT ' + JSON.stringify({ step1, step2 }, null, 2));
  app.quit();
}).catch((e) => { console.error('LOCAL_TXT_FAIL', e); app.exit(1); });
