'use strict';
/* 自测脚本：起静默窗口加载渲染进程，跑一遍接口解析链路并截图。仅开发用。 */
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
    server.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
}

const SCRIPT = `(async () => {
  const out = { errors: [] };
  window.addEventListener('error', e => out.errors.push('onerror: ' + e.message));
  try {
    await window.tvbox.setIdentity('', '');
    await loadInterface('${MOCK}/config.json', { save: false });
    out.sites = S.sites.length;
    out.usableSites = S.sites.filter(isCmsSite).length;
    out.lives = S.lives.length;
    out.parses = S.parses.length;
    out.chip = document.querySelector('#cfgChip').textContent;

    const site = S.sites.find(isCmsSite);
    const home = await fetchHome(site);
    out.homeList = home.list.length;
    out.homeClasses = home.classes.length;

    const cat = await fetchCategory(site, '', 2);
    out.catList = cat.list.length;
    out.pageCount = cat.pageCount;

    const det = await fetchDetail(site, cat.list[0].id);
    out.detailName = det && det.name;
    const groups = parsePlaySources(det || {});
    out.playGroups = groups.length;
    out.episodesPerGroup = groups.length ? groups[0].episodes.length : 0;
    out.firstEp = groups.length ? groups[0].episodes[0] : null;

    const sr = await searchSite(site, '示例');
    out.searchResults = sr.length;

    const liveRes = await window.tvbox.httpGet({ url: '${MOCK}/live.txt' });
    const live = parseLiveText(liveRes.text || '');
    out.liveGroups = live.groups.length;
    out.liveChannels = live.groups.reduce((a, g) => a + g.channels.length, 0);

    switchView('home');
    await new Promise(r => setTimeout(r, 2200));
    out.homeRows = document.querySelectorAll('#view-home .row-head').length;
    out.homeCards = document.querySelectorAll('#view-home .card').length;
    out.firstCardName = (document.querySelector('#view-home .card .name') || {}).textContent;

    openDetail(det, site);
    await new Promise(r => setTimeout(r, 900));
    out.detailOpen = !document.querySelector('#detailPane').classList.contains('hidden');
    out.detailEps = document.querySelectorAll('#epChips .d-chip').length;
    out.detailLines = document.querySelectorAll('#lineChips .d-chip').length;

    switchView('settings');
    await new Promise(r => setTimeout(r, 300));
    out.settingsRendered = document.querySelector('#view-settings .panel') !== null;
    out.aboutText = (document.querySelector('#aboutBox') || {}).textContent;

    // 接口诊断
    await diagnoseInterface();
    await new Promise(r => setTimeout(r, 900));
    out.diagText = ((document.querySelector('#modalBody') || {}).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260);
    out.diagRows = document.querySelectorAll('#modalBody .diag-row').length;
    out.diagVerdict = ((document.querySelector('#modalBody .diag-verdict') || {}).textContent || '').slice(0, 120);
    hideModal();

    // 多仓：线路列表 → 逐条探测 → 自动选最优
    await loadInterface('${MOCK}/repo.json', { save: false });
    await new Promise(r => setTimeout(r, 500));
    out.repoOpen = !document.querySelector('#modalPane').classList.contains('hidden');
    out.repoLines = document.querySelectorAll('#repoList .repo-line').length;
    const probeBtn = document.querySelectorAll('#modalActions .btn')[2];
    if (probeBtn) { probeBtn.click(); await new Promise(r => setTimeout(r, 3500)); }
    out.repoBadges = Array.from(document.querySelectorAll('#repoList .repo-badge')).map(e => e.textContent).join('|');
    const mergeBtn = document.querySelectorAll('#modalActions .btn')[1];
    if (mergeBtn) { mergeBtn.click(); await new Promise(r => setTimeout(r, 3000)); }
    out.mergedName = S.cfgName;
    out.mergedSites = S.sites.length;
    out.mergedUsable = S.sites.filter(isCmsSite).length;

    // 多仓 txt（名称,地址）
    await loadInterface('${MOCK}/repo.txt', { save: false });
    await new Promise(r => setTimeout(r, 500));
    out.txtRepoLines = document.querySelectorAll('#repoList .repo-line').length;
    hideModal();
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e));
  }
  return out;
})()`;

app.whenReady().then(async () => {
  // 与 main.js 同名的 IPC 桩，保证渲染进程链路完整
  ipcMain.handle('http:get', async (_e, p) => {
    try {
      const res = await fetch(p.url, { headers: p.headers || {} });
      return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
    } catch (err) {
      return { ok: false, status: 0, text: '', error: String(err.message || err) };
    }
  });
  ipcMain.handle('net:set-identity', async () => true);
  ipcMain.handle('app:info', async () => ({ version: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);

  await startServer();
  fs.mkdirSync(SHOTS, { recursive: true });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    x: 0,
    y: 0,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) logs.push(message);
  });

  await win.loadURL(base + '/index.html');
  // 隐藏窗口里带合成层（背景模糊、叠层）的页面有时不产生新帧，capturePage 会拿到旧画面。
  // 用「几乎全透明 + 不抢焦点 + 不进任务栏」的方式让窗口真实参与合成，用户看不到任何窗口。
  win.setOpacity(0.01);
  win.setFocusable(false);
  win.setSkipTaskbar(true);
  win.showInactive();
  await new Promise((r) => setTimeout(r, 800));

  const res = await win.webContents.executeJavaScript(SCRIPT, true);
  console.log('SMOKE_RESULT ' + JSON.stringify(res, null, 2));
  if (logs.length) console.log('CONSOLE_ERRORS ' + JSON.stringify(logs.slice(0, 10)));

  // 截图：详情
  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 1800));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS, name), img.toPNG());
    console.log('shot ' + name + ' ' + img.getSize().width + 'x' + img.getSize().height);
  };

  await shot('detail.png');

  await win.webContents.executeJavaScript(
    "document.querySelector('#detailPane').classList.add('hidden');switchView('category');" +
    "S.site=S.sites.find(isCmsSite);S.tid='';S.page=1;renderCategory();", true);
  await shot('category.png');

  await win.webContents.executeJavaScript("switchView('live');", true);
  await shot('live.png');

  await win.webContents.executeJavaScript("switchView('settings');", true);
  await shot('settings.png');

  await win.webContents.executeJavaScript("switchView('home');", true);
  await shot('home.png');

  await win.webContents.executeJavaScript("openDetail(S.detail.vod, S.detail.site);", true);
  await new Promise((r) => setTimeout(r, 2600));
  const d2 = await win.webContents.executeJavaScript(
    "(() => { const p = document.querySelector('#detailPane'); const r = p.getBoundingClientRect();" +
    " return { cls: p.className, display: getComputedStyle(p).display, w: Math.round(r.width), h: Math.round(r.height)," +
    " focused: (window.kodiFocus() || {}).id || (window.kodiFocus() || {}).className || ''," +
    " h2: (document.querySelector('#detailBody h2') || {}).textContent || ''," +
    " topEl: (document.elementFromPoint(700, 300) || {}).className }; })()", true);
  console.log('DETAIL2_STATE ' + JSON.stringify(d2));
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, 'detail2.png'), img2.toPNG());
  console.log('shot detail2.png ' + img2.getSize().width + 'x' + img2.getSize().height);

  // 接口诊断弹窗截图
  await win.webContents.executeJavaScript("diagnoseInterface();", true);
  await new Promise((r) => setTimeout(r, 2200));
  const img3 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(SHOTS, 'diag.png'), img3.toPNG());
  console.log('shot diag.png ' + img3.getSize().width + 'x' + img3.getSize().height);

  console.log('SHOTS_OK');
  app.exit(0);
});
