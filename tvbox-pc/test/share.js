'use strict';
/* 分享页解析自测：从一个「ckplayer 分享页」里抠出真实 m3u8，并尝试真正播起来。
   用法：node_modules\electron\dist\electron.exe test\share.js [分享页URL] */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const netfetch = require('../src/netfetch');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const PAGE = process.argv.find((a) => /^https?:\/\//i.test(a)) || 'https://v.lzcdn27.com/share/a6a141f631618325c81115ed35c32ff5';
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
  const out = { page: '${PAGE}' };
  try {
    const direct = await resolvePlaySource('${PAGE}');
    out.resolved = direct;
    const cands = (await (async () => {
      const r = await getText('${PAGE}');
      return streamsInHtml(r.text, r.finalUrl || '${PAGE}');
    })());
    out.candidates = cands.slice(0, 4);
    if (direct) {
      $('#playerPane').classList.remove('hidden');
      playUrl(direct);
      // 等播放器把元数据读出来
      const t0 = Date.now();
      while (Date.now() - t0 < 12000) {
        await new Promise(r => setTimeout(r, 400));
        const v = $('#video');
        if (v.duration && !isNaN(v.duration) && v.duration > 0) break;
      }
      const v = $('#video');
      out.video = { duration: v.duration || 0, readyState: v.readyState, currentTime: v.currentTime || 0,
                   error: v.error ? v.error.code : 0 };
    }
  } catch (e) { out.fatal = String(e && (e.stack || e.message || e)); }
  return out;
})()`;

app.whenReady().then(async () => {
  ipcMain.handle('http:get', async (_e, p) => {
    try {
      const r = await netfetch.httpGet(p.url, p.headers || {}, p.timeout || 15000);
      return { ok: !!r.ok, status: r.status || 0, text: r.text || '', finalUrl: r.finalUrl || p.url, error: r.error || '' };
    } catch (err) {
      return { ok: false, status: 0, text: '', error: String(err.message || err) };
    }
  });
  ipcMain.handle('net:set-identity', async (_e, ua, ref) => { netfetch.setIdentity(ua, ref); return true; });
  ipcMain.handle('app:info', async () => ({ version: 'livetest', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1280, height: 720, show: false,
    backgroundColor: '#000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/index.html');
  win.setOpacity(0.01);
  win.setFocusable(false);
  win.setSkipTaskbar(true);
  win.showInactive();
  await new Promise((r) => setTimeout(r, 800));

  const res = await win.webContents.executeJavaScript(SCRIPT, true);
  console.log('SHARE_RESULT ' + JSON.stringify(res, null, 2));
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
