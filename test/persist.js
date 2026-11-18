'use strict';
/* 接口记忆自测：多仓选过的线路写进 localStorage，刷新（等同重启）后自动恢复，不再弹选线路。仅开发用。 */
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

const PICK = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 清掉旧数据，保证从「没保存过」的干净状态开始
  localStorage.clear();
  location.reload();
  out.step = 'reloaded-clean';
  return out;
})()`;

const PICK2 = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  await loadInterface('${MOCK}/repo.json');
  await sleep(400);
  out.pickerShown = !document.querySelector('#modalPane').classList.contains('hidden');
  out.repoLines = document.querySelectorAll('#repoList .repo-line').length;
  // 点第一条线路（选完应当记住）
  const first = document.querySelector('#repoList .repo-line');
  if (first) first.click();
  await sleep(2200);

  out.afterPick = {
    cfgName: S.cfgName,
    cfgUrl: S.cfgUrl,
    cfgRepoLine: S.cfgRepoLine,
    sites: S.sites.length,
    usable: S.sites.filter(isCmsSite).length,
    pickerStillOpen: !document.querySelector('#modalPane').classList.contains('hidden'),
    homeCards: document.querySelectorAll('#view-home .card').length
  };
  out.repoPicksSaved = Object.keys(JSON.parse(localStorage.getItem('tvbox_repo_pick_v1') || '{}')).length;
  out.ifacesSaved = (JSON.parse(localStorage.getItem('tvbox_iface_v1') || '[]')).length;

  // 设置页：接口地址要回填
  switchView('settings');
  await sleep(500);
  out.settingsPrefill = (document.querySelector('#ifaceUrl') || {}).value || '';

  // 等同重启：刷新页面，走 init() 的自动恢复
  location.reload();
  return out;
})()`;

const AFTER = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(2500);
  out.chip = (document.querySelector('#cfgChip') || {}).textContent || '';
  out.cfgName = S.cfgName;
  out.sites = S.sites.length;
  out.usable = S.sites.filter(isCmsSite).length;
  out.pickerShownOnBoot = !document.querySelector('#modalPane').classList.contains('hidden');
  out.homeCards = document.querySelectorAll('#view-home .card').length;
  out.firstCard = (document.querySelector('#view-home .card .name') || {}).textContent || '';
  switchView('settings');
  await sleep(500);
  out.settingsPrefill = (document.querySelector('#ifaceUrl') || {}).value || '';
  out.switchLineBtn = !!(document.querySelector('#btnSwitchLine'));
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
  ipcMain.handle('app:info', async () => ({ version: '2.2.0', electron: process.versions.electron, chrome: process.versions.chrome }));
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
  await new Promise((r) => setTimeout(r, 1500));

  await win.webContents.executeJavaScript(PICK, true);
  await new Promise((r) => setTimeout(r, 2500));

  const pickRes = await win.webContents.executeJavaScript(PICK2, true);
  await new Promise((r) => setTimeout(r, 2600));

  const after = await win.webContents.executeJavaScript(AFTER, true);
  console.log('PERSIST_RESULT ' + JSON.stringify(Object.assign({ pick: pickRes, boot: after }, {}), null, 2));
  app.quit();
}).catch((e) => { console.error('PERSIST_FAIL', e); app.exit(1); });
