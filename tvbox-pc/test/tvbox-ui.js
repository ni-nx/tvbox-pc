'use strict';
/* TVBox 化界面自测：方块图标行 → 左栏章节菜单 → 海报墙 的焦点串联；详情页 TVBox 布局（白边剧照 / 线路 / 集数 / 倒序分页 / 简介）。
   仅开发用。 */
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

const SCRIPT = `(async () => {
  const out = {};
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const focused = () => {
    const el = (window.kodiFocus && window.kodiFocus()) || null;
    if (!el) return null;
    return { cls: el.className, text: (el.textContent || '').trim().slice(0, 12), id: el.id || '' };
  };

  await window.tvbox.setIdentity('', '');
  await loadInterface('${MOCK}/config.json', { save: false });

  switchView('home');
  await sleep(2600);

  // 1) 首页：五个方块图标 + 左栏菜单 + 右侧海报墙
  out.tiles = document.querySelectorAll('#nav .nav-btn').length;
  out.activeTiles = document.querySelectorAll('#nav .nav-btn.active').length;
  out.menuItems = document.querySelectorAll('#homeMenu .tv-menu-item').length;
  out.menuActive = (document.querySelector('#homeMenu .tv-menu-item.active') || {}).textContent;
  const grid = document.querySelector('#aggGrid');
  out.aggCards = grid ? grid.querySelectorAll('.card').length : 0;
  out.aggTags = grid ? grid.querySelectorAll('.card .tag').length : 0;
  out.aggScores = grid ? grid.querySelectorAll('.card .score').length : 0;
  out.homeFocus = focused();

  // 2) 遥控器：海报 ↑ → 方块图标；图标 ←/→ 移动；↓ 回到内容区
  key('ArrowUp'); await sleep(150);
  out.upToTiles = focused();
  out.tileReachable = !!(out.upToTiles && /nav-btn/.test(out.upToTiles.cls || ''));
  key('ArrowRight'); await sleep(120);
  out.tileRight = focused();
  key('ArrowDown'); await sleep(160);
  out.downFromTiles = focused();

  // 3) 左栏菜单：点「最近观看」应换成观看记录（没有记录时给空态）
  const menuRecent = document.querySelector('#homeMenu .tv-menu-item[data-sec="recent"]');
  if (menuRecent) { menuRecent.click(); await sleep(320); }
  out.recentEmpty = !!document.querySelector('#homeRows .empty');
  const menuUpdate = document.querySelector('#homeMenu .tv-menu-item[data-sec="update"]');
  if (menuUpdate) { menuUpdate.click(); await sleep(420); }
  out.updateCards = document.querySelectorAll('#aggGrid .card').length;

  // 4) 方块图标 Enter → 搜索页并聚焦输入框
  const searchTile = document.querySelector('#nav .nav-btn[data-view="search"]');
  if (searchTile) {
    window.kodiSetFocus(searchTile);
    key('Enter'); await sleep(700);
    out.searchView = !document.querySelector('#view-search').classList.contains('hidden');
    out.searchInputFocused = document.activeElement === document.querySelector('#searchInput');
  }

  // 5) 搜索页：7 列键盘（含首行功能键）+ 右侧热搜
  out.oskKeys = document.querySelectorAll('#osk .osk-key').length;
  out.oskFnKeys = document.querySelectorAll('#osk .osk-key.fn').length;
  out.oskCols = document.querySelector('#osk .osk-row') ? document.querySelector('#osk .osk-row').children.length : 0;
  out.hotChips = document.querySelectorAll('#hotChips .hot-chip').length;

  // 6) 详情页 TVBox 布局
  switchView('home');
  await sleep(900);
  const card = document.querySelector('#aggGrid .card');
  if (card) { card.click(); await sleep(1800); }
  out.detailShot = !!document.querySelector('#detailBody .d-shot');
  out.detailShotBorder = document.querySelector('#detailBody .d-shot')
    ? getComputedStyle(document.querySelector('#detailBody .d-shot')).borderTopWidth : '';
  out.detailLines = document.querySelectorAll('#lineChips .d-chip').length;
  out.detailEps = document.querySelectorAll('#epChips .d-chip').length;
  out.detailPage = document.querySelectorAll('#epPage .d-chip').length;
  out.detailReverse = !!document.querySelector('#btnReverse');
  out.detailBtns = ['btnPlayFirst', 'btnDesc', 'btnFav', 'btnSwitchSrc']
    .filter((id) => document.getElementById(id)).length;
  const desc = document.querySelector('#btnDesc');
  if (desc) { desc.click(); await sleep(160); }
  out.descOpen = !document.querySelector('#descBox').classList.contains('hidden');
  // 换源 → 弹窗列出线路
  const sw = document.querySelector('#btnSwitchSrc');
  if (sw) { sw.click(); await sleep(240); }
  out.srcRows = document.querySelectorAll('.src-list .src-row').length;
  // 倒序翻页
  const rev = document.querySelector('#btnReverse');
  if (rev) { rev.click(); await sleep(160); }
  out.reverseOn = !!document.querySelector('#btnReverse.active');
  const pageBtn = document.querySelector('#epPage .range');
  if (pageBtn) { pageBtn.click(); await sleep(140); }
  out.afterPageEps = document.querySelectorAll('#epChips .d-chip').length;

  out.focusRing = document.querySelectorAll('.focus').length;
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
    width: 1600, height: 900, show: false, paintWhenInitiallyHidden: true,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const res = await win.webContents.executeJavaScript(SCRIPT, true);
  console.log('TVBOX_UI_RESULT ' + JSON.stringify(res, null, 2));

  // 截图留档
  await win.webContents.executeJavaScript(
    "const s=document.createElement('style');s.textContent='*{transition:none!important;animation:none!important}';document.head.appendChild(s);",
    true
  );
  const shots = path.join(__dirname, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  await win.webContents.executeJavaScript("hideModal();switchView('home');", true);
  await new Promise((r) => setTimeout(r, 2600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(shots, 'tvbox-home.png'), img.toPNG());
  console.log('TVBOX_UI_SHOT test/shots/tvbox-home.png');

  app.quit();
}).catch((e) => { console.error('TVBOX_UI_FAIL', e); app.exit(1); });
