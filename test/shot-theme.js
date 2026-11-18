'use strict';
/* 2.4.1 界面意见回归：直播源次级菜单 / 键盘按需出现 / 顶栏自动收起 / 浅色主题。仅开发用。 */
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
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 1600));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, name), img.toPNG());
    console.log('shot ' + name);
  };
  const noise = "const s=document.createElement('style');s.textContent='*{transition:none!important;animation:none!important}';document.head.appendChild(s);";

  await js(`(async () => { ${noise} await window.tvbox.setIdentity('',''); await loadInterface('${MOCK}/config.json',{save:false});
    S.lives.push({ name: '示例直播二', url: '${MOCK}/live.txt' });
    switchView('live'); })()`);
  await new Promise((r) => setTimeout(r, 2200));

  // 1. 直播页：不再平铺直播源，只留一个「切换直播源」按钮
  const liveInfo = await js(`({
    sourceTabs: document.querySelectorAll('#liveSrcTabs .tab').length,
    srcBtn: !!document.querySelector('#btnLiveSrc'),
    srcLine: (document.querySelector('#liveSrcLine')||{}).textContent || '',
    groups: document.querySelectorAll('#liveGroups .grp-item').length,
    channels: document.querySelectorAll('#liveSide .ch-item').length
  })`);
  console.log('LIVESRC_UI ' + JSON.stringify(liveInfo));
  await shot('live-tvbox.png');

  // 2. 次级菜单：点开会列出直播源，可筛选
  await js(`(async () => { document.querySelector('#btnLiveSrc').click(); })()`);
  await new Promise((r) => setTimeout(r, 400));
  const pickerInfo = await js(`({
    modalOpen: !document.querySelector('#modalPane').classList.contains('hidden'),
    rows: document.querySelectorAll('#srcList .src-row').length,
    sections: document.querySelectorAll('#srcList .src-sec').length,
    firstFocus: !!document.querySelector('#srcList .src-row.focus'),
    filter: !!document.querySelector('#srcFilter')
  })`);
  console.log('LIVESRC_PICKER ' + JSON.stringify(pickerInfo));
  await shot('live-src-picker.png');
  await js(`(async () => { hideModal(); })()`);

  // 3. 搜索页：键盘默认收起，按「键盘」才出来
  await js(`(async () => { switchView('search'); })()`);
  await new Promise((r) => setTimeout(r, 700));
  const oskHidden = await js(`({
    hiddenByDefault: document.querySelector('#osk').classList.contains('hidden'),
    toggleLabel: (document.querySelector('#btnOsk')||{}).textContent,
    resultBelowFold: (document.querySelector('#searchResult')||{}).getBoundingClientRect().top < 700
  })`);
  console.log('OSK_HIDDEN ' + JSON.stringify(oskHidden));
  await shot('search-no-osk.png');

  await js(`(async () => { document.querySelector('#btnOsk').click(); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const oskShown = await js(`({
    shown: !document.querySelector('#osk').classList.contains('hidden'),
    label: (document.querySelector('#btnOsk')||{}).textContent,
    keyFocus: document.querySelectorAll('#osk .osk-key.focus').length
  })`);
  console.log('OSK_SHOWN ' + JSON.stringify(oskShown));
  await shot('search-osk.png');

  // 4. 顶栏自动收起：内容滚动 + 按 ↑ 恢复
  await js(`(() => { const v = document.querySelector('#view-search'); v.scrollTop = 220; v.dispatchEvent(new Event('scroll', {bubbles:true})); })()`);
  const compactOn = await js(`({ compact: document.body.classList.contains('top-compact'),
    tilesH: Math.round(document.querySelector('.tiles').getBoundingClientRect().height) })`);
  console.log('TOPBAR_COMPACT ' + JSON.stringify(compactOn));
  await shot('topbar-compact.png');

  await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true})); })()`);
  await new Promise((r) => setTimeout(r, 300));
  const compactOff = await js(`({ compact: document.body.classList.contains('top-compact'),
    tilesH: Math.round(document.querySelector('.tiles').getBoundingClientRect().height) })`);
  console.log('TOPBAR_EXPAND ' + JSON.stringify(compactOff));

  // 5. 浅色主题
  await js(`(async () => { applyTheme('light', false); switchView('home'); })()`);
  await new Promise((r) => setTimeout(r, 2500));
  const lightInfo = await js(`({
    light: document.body.classList.contains('light'),
    bg: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
    themed: S.settings.theme
  })`);
  console.log('LIGHT_UI ' + JSON.stringify(lightInfo));
  await shot('light-home.png');

  await js(`(async () => { switchView('live'); })()`);
  await new Promise((r) => setTimeout(r, 2000));
  await shot('light-live.png');

  await js(`(async () => { switchView('settings'); })()`);
  await new Promise((r) => setTimeout(r, 700));
  await shot('light-settings.png');

  // 6. 浅色下详情页
  await js(`(async () => {
    const site = S.sites.find(isCmsSite);
    const v = (await (await fetch('${MOCK}/api.php/provide/vod/?ac=list')).text());
    switchView('home');
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const detailOpen = await js(`(async () => {
    const site = S.sites.find(isCmsSite);
    if (!site) return false;
    const cat = await loadCatList(site).catch(() => null);
    if (!cat || !cat.length) return false;
    openDetail(site, { vod_id: 1, vod_name: '示例影片' }, false).catch(()=>{});
    return true;
  })()`).catch(() => false);
  if (detailOpen) {
    await new Promise((r) => setTimeout(r, 1800));
    await shot('light-detail.png');
  }

  // 7. 回到深色，确认切换回来
  await js(`(async () => { hideModal(); document.querySelector('#detailPane').classList.add('hidden'); applyTheme('dark', false); switchView('home'); })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const darkInfo = await js(`({ light: document.body.classList.contains('light'), bg: getComputedStyle(document.body).backgroundColor })`);
  console.log('DARK_UI ' + JSON.stringify(darkInfo));
  console.log('THEME_TEST_OK');
  app.quit();
}).catch((e) => { console.error('SHOT_THEME_FAIL', e); app.exit(1); });
