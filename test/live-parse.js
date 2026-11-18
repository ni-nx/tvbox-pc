'use strict';
/* 直播源解析自测：各种 m3u / txt 写法、直播源清单、无后缀 HLS 探测。仅开发用。 */
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
  const get = async (u) => (await window.tvbox.httpGet({ url: u })).text || '';
  const flat = (d) => (d.groups || []).map(g => ({ g: g.name, ch: g.channels.map(c => ({ n: c.name, u: c.urls.length, ref: c.referer || '', ua: c.ua || '' })) }));

  // 1. m3u：tvg-name 优先 + group-title + EXTVLCOPT Referer/UA
  out.tvg = flat(parseLiveText(await get('${MOCK}/live-tvg.m3u')));
  // 2. m3u：#EXTGRP 分组
  out.extgrp = flat(parseLiveText(await get('${MOCK}/live-extgrp.m3u')));
  // 3. txt：全角逗号 + 多地址
  out.fullwidth = flat(parseLiveText(await get('${MOCK}/live-fullwidth.txt')));
  // 4. 直播源清单（JSON 多仓）
  out.repo = parseLiveText(await get('${MOCK}/live-repo.json'));
  // 5. 无 .m3u8 后缀的地址：应被识别成 HLS
  window.__lastPlayMode = '';
  await playUrl('${MOCK}/live-stream.php');
  await sleep(700);
  out.sniffMode = window.__lastPlayMode;
  // 6. 清单自动展开：loadLiveSource 应把两条源加进 S.lives 并加载第一条
  S.lives = [{ name: '清单', url: '${MOCK}/live-repo.json', type: 0 }];
  switchView('live');
  await sleep(2600);
  out.livesAfterRepo = S.lives.map(l => l.name);
  out.tabs = document.querySelectorAll('#liveSrcTabs .tab').length;
  out.channelsShown = document.querySelectorAll('#liveSide .ch-item').length;
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
  const res = await win.webContents.executeJavaScript(SCRIPT, true);
  console.log('LIVEPARSE_RESULT ' + JSON.stringify(res, null, 2));
  app.quit();
}).catch((e) => { console.error('LIVEPARSE_FAIL', e); app.exit(1); });
