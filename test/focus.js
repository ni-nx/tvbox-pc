'use strict';
/* 焦点引擎自测：验证方向键导航、Enter 确认、Backspace 逐层返回是否按预期工作。仅开发用。 */
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
  const keyOn = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const focused = () => {
    const el = (window.kodiFocus && window.kodiFocus()) || null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: el.className,
      text: (el.textContent || '').trim().slice(0, 18),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      ring: getComputedStyle(el).boxShadow.slice(0, 46)
    };
  };

  await window.tvbox.setIdentity('', '');
  await loadInterface('${MOCK}/config.json', { save: false });

  // 1. 首页自动聚焦
  switchView('home');
  await sleep(2400);
  out.homeFocus = focused();
  out.homeFocusCount = document.querySelectorAll('#view-home .focus').length;

  // 2. 方向键：右移、下移
  key('ArrowRight'); await sleep(90);
  out.afterRight = focused();
  key('ArrowDown'); await sleep(90);
  out.afterDown = focused();

  // 3. 从海报上移应到顶部菜单区（标题栏可进入）
  key('ArrowUp'); await sleep(120);
  out.upToTopbar = focused();
  out.topbarReachable = !!(out.upToTopbar && /nav-btn/.test(out.upToTopbar.cls || ''));
  // 顶栏里左右移动
  key('ArrowRight'); await sleep(90);
  out.topbarRight = focused();
  key('ArrowLeft'); await sleep(90);
  out.topbarLeft = focused();
  out.focusClassCount = document.querySelectorAll('.focus').length;

  // 4. 鼠标悬停即焦点 + Enter 打开详情
  switchView('home');
  await sleep(1800);
  const card = document.querySelectorAll('#view-home .card')[3];
  const rc = card.getBoundingClientRect();
  card.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rc.left + 20, clientY: rc.top + 20 }));
  await sleep(120);
  out.hoverFocus = focused();
  key('Enter');
  await sleep(1600);
  out.enterOpenedDetail = !document.querySelector('#detailPane').classList.contains('hidden');
  out.detailFocus = focused();
  out.detailFanart = (document.querySelector('#detailPane').style.getPropertyValue('--fanart') || '').slice(0, 30);

  // 5. 详情内下移到选集
  key('ArrowDown'); await sleep(90);
  out.detailDown = focused();

  // 6. Backspace 逐层返回
  key('Backspace'); await sleep(180);
  out.afterBack1 = !document.querySelector('#detailPane').classList.contains('hidden');

  // 7. 直播页分组焦点
  switchView('live');
  await sleep(700);
  out.liveFocus = focused();
  key('ArrowDown'); await sleep(90);
  out.liveDown = focused();

  // 8. 设置页输入框：方向键不应抢焦点
  switchView('settings');
  await sleep(500);
  const input = document.querySelector('#view-settings input.input');
  if (input) {
    input.focus();
    key('ArrowLeft');
    await sleep(90);
    out.inputKeepsFocus = document.activeElement === input;
    out.focusWhileTyping = focused();
  }

  // 9. 搜索页屏幕键盘：↓ 进键盘、Enter 输入字母、↑ 回输入框
  switchView('search');
  await sleep(600);
  const si = document.querySelector('#searchInput');
  out.oskKeys = document.querySelectorAll('#osk .osk-key').length;
  si.focus();
  keyOn(si, 'ArrowDown'); await sleep(150);
  out.oskFocus = focused();
  // 首行是功能键（退格/清空/搜索…），再 ↓ 一次落到字母 A
  key('ArrowDown'); await sleep(120);
  out.oskLetterFocus = focused();
  const before = si.value;
  key('Enter'); await sleep(120);
  out.oskTypedChar = si.value.slice(before.length);
  key('ArrowRight'); await sleep(90);
  out.oskRight = focused();
  key('Enter'); await sleep(120);
  out.oskTypedChars = si.value.slice(before.length);
  // 键盘首行的「搜索」功能键可点
  const goBtn = document.querySelector('#osk .osk-key[data-k="go"]');
  out.oskGoBtn = goBtn ? goBtn.textContent.trim() : '';
  key('ArrowUp'); await sleep(120);
  key('ArrowUp'); await sleep(180);
  out.oskUpBackToInput = document.activeElement === si;
  out.oskUpFocus = focused();

  out.focusErrors = 0;
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
  ipcMain.handle('app:info', async () => ({ version: '2.0.0', electron: process.versions.electron, chrome: process.versions.chrome }));
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
  await new Promise((r) => setTimeout(r, 800));
  const res = await win.webContents.executeJavaScript(SCRIPT, true);
  console.log('FOCUS_RESULT ' + JSON.stringify(res, null, 2));
  app.quit();
}).catch((e) => { console.error('FOCUS_FAIL', e); app.exit(1); });
