'use strict';

const { app, BrowserWindow, ipcMain, session, shell, Menu, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const netfetch = require('./netfetch');

const ROOT = path.join(__dirname, 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

let mainWindow = null;
let serverInfo = null;

/* ------------------------------------------------------------------ *
 * 本地静态服务：让页面跑在 http://127.0.0.1 上，避免 file:// 下
 * 播放器 / XHR 的各种限制
 * ------------------------------------------------------------------ */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
        const filePath = path.normalize(path.join(ROOT, urlPath));
        if (!filePath.startsWith(ROOT)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          res.writeHead(404).end('not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const buf = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        });
        res.end(buf);
      } catch (e) {
        try { res.writeHead(500).end('error'); } catch (_) {}
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      serverInfo = { server, port, origin: `http://127.0.0.1:${port}` };
      resolve(serverInfo);
    });
  });
}

/* ------------------------------------------------------------------ *
 * 本地数据存盘：<userData>/tvbox-store.json
 * 页面跑在随机端口的本地 http 上，localStorage 会随端口变化而失效，
 * 所以接口、收藏、记录、设置都另外存一份 json 在磁盘里。
 * ------------------------------------------------------------------ */
let storeCache = null;
function storePath() { return path.join(app.getPath('userData'), 'tvbox-store.json'); }
function readStore() {
  if (storeCache) return storeCache;
  try { storeCache = JSON.parse(fs.readFileSync(storePath(), 'utf8')) || {}; }
  catch (e) { storeCache = {}; }
  return storeCache;
}
function writeStore() {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(storeCache || {}), 'utf8');
  } catch (e) {}
}
ipcMain.on('store:all', (evt) => { evt.returnValue = readStore(); });
ipcMain.on('store:set', (_evt, key, raw) => {
  if (typeof key !== 'string') return;
  const st = readStore();
  st[key] = raw;
  writeStore();
});
ipcMain.on('store:clear', () => { storeCache = {}; writeStore(); });

// 启动前把记住的主题带给页面，避免先闪一下浅色 / 深色
function storedTheme() {
  try {
    const raw = readStore()['tvbox_settings_v1'];
    const s = raw ? JSON.parse(raw) : null;
    return (s && s.theme) || '';
  } catch (e) { return ''; }
}

/* ------------------------------------------------------------------ *
 * 请求头注入：UA / Referer（部分源站校验）
 * ------------------------------------------------------------------ */
function applyRequestHeaders(ses) {
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    const id = netfetch.getIdentity();
    if (id.ua) headers['User-Agent'] = id.ua;
    if (id.referer) headers['Referer'] = id.referer;
    delete headers['Origin'];
    callback({ requestHeaders: headers });
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1440, Math.max(1100, Math.round(width * 0.82)));
  const h = Math.min(920, Math.max(700, Math.round(height * 0.86)));

  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#f2f6fb',   // 默认浅色界面，避免启动先闪一下黑
    title: 'TVBox PC',
    autoHideMenuBar: true,
    show: false,
    // 自绘标题栏：去掉系统那条标题条，窗口按钮由页面右上角自己画
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 影视源多为第三方站点，CORS 头不可控，桌面端关闭同源策略
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 页面内 <a target=_blank> 一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^http/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 全屏状态同步给渲染层：全屏时隐藏右上角窗口按键，退出全屏（含 Esc）后恢复
  mainWindow.on('enter-full-screen', () => mainWindow.webContents.send('tvbox:fullscreen', true));
  mainWindow.on('leave-full-screen', () => mainWindow.webContents.send('tvbox:fullscreen', false));

  mainWindow.webContents.on('before-input-event', (event, input) => {    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    }
    if (input.control && input.key.toLowerCase() === 'r') {
      mainWindow.reload();
      event.preventDefault();
    }
  });

  const origin = serverInfo ? serverInfo.origin : null;
  const th = storedTheme();
  const qs = th ? ('?theme=' + encodeURIComponent(th)) : '';
  if (origin) mainWindow.loadURL(origin + '/index.html' + qs);
  else mainWindow.loadFile(path.join(ROOT, 'index.html'));

  if (process.env.TVBOX_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
}

/* ------------------------------------------------------------------ *
 * IPC：网络请求（主进程发，绕过跨域，可带自定义头；403 自动走浏览器兜底）
 * ------------------------------------------------------------------ */
ipcMain.handle('http:get', async (_evt, payload) => {
  const { url, headers = {}, timeout = 15000 } = payload || {};
  return netfetch.httpGet(url, headers, timeout);
});

ipcMain.handle('net:set-identity', async (_evt, { ua, referer }) => {
  netfetch.setIdentity(ua, referer);
  try {
    if (mainWindow) mainWindow.webContents.setUserAgent(netfetch.getIdentity().ua);
    session.defaultSession.setUserAgent(netfetch.getIdentity().ua);
  } catch (_) {}
  return true;
});

ipcMain.handle('app:open-external', async (_evt, url) => {
  if (url && /^(http|https):\/\//i.test(url)) await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:fullscreen', async () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  origin: serverInfo ? serverInfo.origin : ''
}));

// 自绘标题栏的窗口按钮：最小化 / 最大化切换 / 关闭
ipcMain.handle('app:win', async (_evt, action) => {
  if (!mainWindow) return false;
  if (action === 'min') mainWindow.minimize();
  else if (action === 'max') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
  return { maximized: mainWindow.isMaximized() };
});

/* ------------------------------------------------------------------ *
 *  配置备份 / 恢复：导出、导入本地 json
 * ------------------------------------------------------------------ */
ipcMain.handle('file:save', async (_evt, { filename, content }) => {
  const win = mainWindow || undefined;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '备份配置',
    defaultPath: filename || 'tvbox-backup.json',
    filters: [{ name: '配置文件', extensions: ['json', 'txt'] }]
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    fs.writeFileSync(filePath, String(content || ''), 'utf8');
    return { canceled: false, filePath };
  } catch (e) {
    return { canceled: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('file:open', async () => {
  const win = mainWindow || undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '恢复配置',
    properties: ['openFile'],
    filters: [{ name: '配置文件', extensions: ['json', 'txt', 'conf'] }]
  });
  if (canceled || !filePaths || !filePaths.length) return { canceled: true };
  try {
    const filePath = filePaths[0];
    const content = fs.readFileSync(filePath, 'utf8');
    return { canceled: false, filePath, name: path.basename(filePath), content };
  } catch (e) {
    return { canceled: false, error: String(e && e.message || e) };
  }
});

/* ------------------------------------------------------------------ *
 *  代理 / 清缓存
 * ------------------------------------------------------------------ */
ipcMain.handle('net:set-proxy', async (_evt, raw) => {
  const rule = String(raw || '').trim();
  let proxyRules = 'direct://';
  if (rule) {
    // 支持 "host:port" 或完整 scheme；未带协议时按 http/https 代理处理
    proxyRules = /^[a-z]+:\/\//i.test(rule) ? rule : `http=${rule};https=${rule};ftp=${rule}`;
  }
  try {
    await session.defaultSession.setProxy({ proxyRules });
    return { ok: true, proxyRules };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('cache:clear', async () => {
  try {
    await session.defaultSession.clearCache();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

/* ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  applyRequestHeaders(session.defaultSession);
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverInfo && serverInfo.server) {
    try { serverInfo.server.close(); } catch (_) {}
  }
});
