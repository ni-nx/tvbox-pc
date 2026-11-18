'use strict';
/* 播放器 / 直播页截图自测：检查新版播放器控制条、选集抽屉、直播分组+频道墙。仅开发用。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:8899';
const SHOTS = path.join(__dirname, 'shots');
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
  ipcMain.handle('app:info', async () => ({ version: '2.4.1', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);

  await startServer();
  fs.mkdirSync(SHOTS, { recursive: true });

  const win = new BrowserWindow({
    width: 1600, height: 900, show: false, paintWhenInitiallyHidden: true,
    backgroundColor: '#0b0e13',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  win.setOpacity(0.01);
  win.setFocusable(false);
  win.setSkipTaskbar(true);
  win.showInactive();
  await win.loadURL(base + '/index.html');
  await new Promise((r) => setTimeout(r, 900));

  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 1700));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, name), img.toPNG());
    console.log('shot ' + name);
  };

  const noise = "const s=document.createElement('style');s.textContent='*{transition:none!important;animation:none!important}';document.head.appendChild(s);";

  // 1. 直播页：左侧分组 + 右侧频道墙
  await win.webContents.executeJavaScript(
    `(async () => { ${noise} await window.tvbox.setIdentity('',''); await loadInterface('${MOCK}/config.json',{save:false}); switchView('live'); })()`, true);
  await new Promise((r) => setTimeout(r, 2600));
  const liveInfo = await win.webContents.executeJavaScript(`({
    groups: document.querySelectorAll('#liveGroups .grp-item').length,
    channels: document.querySelectorAll('#liveSide .ch-item').length,
    groupName: (document.querySelector('#liveGroupName')||{}).textContent,
    firstCh: ((document.querySelector('#liveSide .ch-item .nm')||{}).textContent||'').trim()
  })`, true);
  console.log('LIVE_UI ' + JSON.stringify(liveInfo));
  await shot('live-tvbox.png');

  // 2. 点第二个分组，看频道墙切换
  await win.webContents.executeJavaScript(
    `(() => { const g=document.querySelectorAll('#liveGroups .grp-item')[1]; if(g) g.click(); })()`, true);
  await new Promise((r) => setTimeout(r, 700));
  const liveInfo2 = await win.webContents.executeJavaScript(`({
    groupName: (document.querySelector('#liveGroupName')||{}).textContent,
    channels: document.querySelectorAll('#liveSide .ch-item').length
  })`, true);
  console.log('LIVE_UI_SWITCH ' + JSON.stringify(liveInfo2));

  // 3. 播放器：造一个 vod 播放态（视频源用本地不存在的地址，画面黑底，重点看控制条排版）
  const playerInfo = await win.webContents.executeJavaScript(`(() => {
    const site = S.sites.find(isCmsSite);
    const eps = Array.from({length: 12}, (_, i) => ({ name: '第' + String(i + 1).padStart(2, '0') + '集', url: 'http://127.0.0.1:8899/none.m3u8' }));
    const groups = [{ from: '量子｜平安', episodes: eps }];
    S.play = { mode: 'vod', groups, gi: 0, ei: 0, vod: { name: '示例影片 · 吞噬星空', year: '2025', area: '内地', typeName: '动画' }, site };
    document.querySelector('#playerPane').classList.remove('hidden');
    document.querySelector('#playerTitle').textContent = '吞噬星空 · 量子｜平安 · 第01集';
    document.querySelector('#playerSub').textContent = '2025 · 内地 · 动画 · 示例CMS站';
    document.querySelector('#playerMsg').classList.add('hidden');
    renderEpPanel();
    playerShowBars();
    // 造一个假的进度，便于看进度条
    const v = document.querySelector('#video');
    Object.defineProperty(v, 'duration', { value: 2400, configurable: true });
    Object.defineProperty(v, 'currentTime', { value: 351, configurable: true });
    playerUpdateBar();
    playerSyncPlayBtn();
    return { bars: !!document.querySelector('#pbTrack'), btns: document.querySelectorAll('#playerBottom .pbtn').length };
  })()`, true);
  console.log('PLAYER_UI ' + JSON.stringify(playerInfo));
  await shot('player-tvbox.png');

  // 4. 选集抽屉 + 遥控焦点
  const epsInfo = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#epPanel').classList.remove('hidden');
    pNav.mode = 'eps'; pNav.idx = 0; playerFocusEp(0);
    return { eps: document.querySelectorAll('#epPanel .ep').length, focusCls: (window.kodiFocus ? '' : ''), epFocus: document.querySelectorAll('#epPanel .ep.focus').length };
  })()`, true);
  console.log('PLAYER_EPS ' + JSON.stringify(epsInfo));
  await shot('player-eps.png');

  // 5. 焦点到底部功能键排（模拟按 ↓）
  const navInfo = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#epPanel').classList.add('hidden');
    pNav.mode = 'video';
    playerFocusBtn(1);
    return { mode: pNav.mode, idx: pNav.idx, focusCount: document.querySelectorAll('#playerBottom .pbtn.focus').length, label: (document.querySelector('#btnPlayPause').textContent||'').trim() };
  })()`, true);
  console.log('PLAYER_NAV ' + JSON.stringify(navInfo));

  app.quit();
}).catch((e) => { console.error('SHOT_PLAYER_FAIL', e); app.exit(1); });
