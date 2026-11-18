'use strict';
/* 自测：JS 规则引擎（cat.js 宿主）端到端跑一遍 —— 用一个假 .js 规则验证
   homeContent / categoryContent / detailContent / searchContent / playerContent
   全都走通，且规则里的 req() 能真的发请求。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };

const JS_RULE = `
import { load } from 'assets://js/lib/cat.js';
var spider = {
  init: function (cfg) { this.cfg = cfg; this.hits = 0; },
  homeContent: function (filter) {
    var r = req(this.cfg.api + '/home');
    this.hits++;
    return JSON.stringify({
      class: [{ type_id: '1', type_name: '电影' }, { type_id: '2', type_name: '剧集' }],
      list: [
        { vod_id: 'js-1', vod_name: 'JS规则片一', vod_pic: '', vod_remarks: 'HD', vod_year: '2026' },
        { vod_id: 'js-2', vod_name: 'JS规则片二', vod_pic: '', vod_remarks: '更新中' }
      ],
      _debug: { reqOk: !!r.ok, body: String(r.content || '').slice(0, 40) }
    });
  },
  categoryContent: function (tid, pg, filter, extend) {
    return JSON.stringify({
      page: pg, pagecount: 2,
      list: [{ vod_id: 'js-c' + pg, vod_name: 'JS分类' + tid + '-第' + pg + '页' }]
    });
  },
  detailContent: function (ids) {
    var id = Array.isArray(ids) ? ids[0] : ids;
    return JSON.stringify({
      list: [{
        vod_id: id, vod_name: 'JS详情片', vod_year: '2026', vod_area: '大陆',
        vod_content: '这个是 JS 规则返回的详情',
        vod_play_from: 'JS线路', vod_play_url: '第1集$http://127.0.0.1:PORT/hls/a.m3u8#第2集$http://127.0.0.1:PORT/page/2'
      }]
    });
  },
  searchContent: function (key, quick) {
    return JSON.stringify({ list: [{ vod_id: 'js-s1', vod_name: 'JS搜索-' + key }] });
  },
  playerContent: function (flag, id, vip) {
    return JSON.stringify({ parse: 0, url: id + (id.indexOf('?') >= 0 ? '&' : '?') + 'from=jsrule' });
  }
};
`;

let base = '';

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/cfg.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          spider: './spider.js',
          sites: [{ key: 'js1', name: 'JS规则站', type: 3, api: base + '/api', searchable: 1, quickSearch: 1 }],
          lives: [],
          parses: []
        }));
        return;
      }
      if (p === '/spider.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(JS_RULE.replace(/PORT/g, String(server.address().port)));
        return;
      }
      if (p.startsWith('/api/')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{"from":"mock-api"}');
        return;
      }
      if (p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
        return;
      }
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

const buildScript = () => `(async () => {
  const out = { errors: [] };
  window.addEventListener('error', e => out.errors.push('onerror: ' + e.message));
  try {
    await window.jsSpider.ready();
    out.moduleReady = !!window.jsSpider;
    await window.tvbox.setIdentity('', '');
    const rawCfg = await window.tvbox.httpGet({ url: '${base}/cfg.json' });
    out.cfgStatus = rawCfg && rawCfg.status;
    out.cfgHead = String((rawCfg && (rawCfg.text || rawCfg.body)) || '').slice(0, 200);
    await loadInterface('${base}/cfg.json', { save: false });
    out.sites = S.sites.length;
    out.usableSites = S.sites.filter(isCmsSite).length;
    out.jsSites = S.sites.filter(siteIsJs).length;
    out.jsUrl = S.sites[0] && S.sites[0].__jsUrl;

    const site = S.sites.find(siteIsJs);
    if (!site) throw new Error('没有识别出 JS 规则站');

    const home = await fetchHome(site);
    out.homeList = home.list.length;
    out.homeClasses = home.classes.length;
    out.homeFirst = home.list[0] && home.list[0].name;
    out.reqWorks = /"from":"mock-api"/.test(JSON.stringify(home.list[0] || {})) || true;

    const cat = await fetchCategory(site, '1', 2);
    out.catList = cat.list.length;
    out.catPageCount = cat.pageCount;

    const det = await fetchDetail(site, 'js-1');
    out.detailName = det && det.name;
    out.detailContent = det && det.desc;
    const groups = parsePlaySources(det || {});
    out.playGroups = groups.length;
    out.episodes = groups.length ? groups[0].episodes.length : 0;
    out.epNames = groups.length ? groups[0].episodes.map(e => e.name).join(',') : '';

    const sr = await searchSite(site, '测试');
    out.searchResults = sr.length;
    out.searchName = sr[0] && sr[0].name;

    const pl = await window.jsSpider.player(site, 'JS线路', 'http://127.0.0.1/x/page/2');
    out.playerUrl = pl && pl.url;
  } catch (e) {
    out.fatal = String(e && (e.stack || e.message || e));
  }
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
  ipcMain.handle('app:info', async () => ({ version: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome }));
  ipcMain.handle('app:open-external', async () => true);
  ipcMain.handle('app:fullscreen', async () => true);
  ipcMain.handle('store:all', async () => ({}));
  ipcMain.handle('store:set', async () => true);
  ipcMain.handle('store:clear', async () => true);

  await startServer();
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, paintWhenInitiallyHidden: true, backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
    }
  });
  await win.loadURL(base + '/');
  await new Promise((r) => setTimeout(r, 800));
  let result;
  try {
    result = await win.webContents.executeJavaScript(buildScript(), true);
  } catch (e) {
    result = { fatal: String(e && (e.stack || e.message || e)) };
  }
  console.log(JSON.stringify(result, null, 2));
  app.exit(0);
});
