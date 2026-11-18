'use strict';
/* 网络层自测：验证 403 的兜底链路（net.request → 隐藏浏览器 fetch）。仅开发用。 */
const { app } = require('electron');
const http = require('http');
const netfetch = require('../src/netfetch');

const routes = {
  // 正常接口
  '/ok.json': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ name: '正常接口', sites: [] }));
  },
  // 模拟 WAF：没有 Sec-Fetch-Mode（Chromium 渲染进程 fetch 才会带）就 403
  '/block-by-secfetch.json': (req, res) => {
    if (!req.headers['sec-fetch-mode']) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ name: '浏览器兜底成功', sites: [{ key: 'a', name: '站', type: 1, api: 'http://x/api' }] }));
  },
  // 一律 403：两层都过不去，应如实报 403
  '/always-403.json': (req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('blocked forever');
  },
  // GBK 编码的 json（老源站常见）
  '/gbk.json': (req, res) => {
    const txt = '{"name":"国标接口","sites":[]}';
    const gbk = Buffer.from(encodeGbk(txt), 'binary');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=gbk' });
    res.end(gbk);
  }
};

/* 极简 GBK 编码器：只用于生成测试数据（覆盖常用汉字 + ASCII） */
function encodeGbk(str) {
  const map = {
    '国': 'B9FA', '标': 'B1EA', '接': 'BDD3', '口': 'BFDA', '名': 'C3FB', '称': 'B3C6'
  };
  let out = '';
  for (const ch of str) {
    if (ch.charCodeAt(0) < 128) { out += ch; continue; }
    const hex = map[ch];
    if (!hex) throw new Error('缺少 GBK 映射: ' + ch);
    out += String.fromCharCode(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16));
  }
  return out;
}

function start() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const fn = routes[(req.url || '').split('?')[0]];
      if (!fn) { res.writeHead(404).end('no'); return; }
      fn(req, res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }));
  });
}

app.whenReady().then(async () => {
  netfetch.setIdentity('', '');
  const { srv, base } = await start();
  const out = {};

  let r = await netfetch.httpGet(base + '/ok.json', {}, 8000);
  out.ok = { status: r.status, viaBrowser: !!r.viaBrowser, text: (r.text || '').slice(0, 40) };

  r = await netfetch.httpGet(base + '/block-by-secfetch.json', {}, 8000);
  out.wafFallback = { status: r.status, viaBrowser: !!r.viaBrowser, text: (r.text || '').slice(0, 46) };

  const t1 = await netfetch.netRequest(base + '/block-by-secfetch.json', {}, 8000);
  out.tier1Status = t1.status;
  const t2 = await netfetch.browserFetch(base + '/block-by-secfetch.json', {}, 8000);
  out.tier2ViaBrowser = !!t2.viaBrowser;
  out.tier2Status = t2.status;

  r = await netfetch.httpGet(base + '/always-403.json', {}, 8000);
  out.always403 = { status: r.status, ok: r.ok, error: r.error || '' };

  r = await netfetch.httpGet(base + '/gbk.json', {}, 8000);
  out.gbk = { status: r.status, name: safeName(r.text) };

  console.log('NET_RESULT ' + JSON.stringify(out, null, 2));
  try { srv.close(); } catch (_) {}
  app.exit(0);
}).catch((e) => { console.error('NET_FAIL', e); app.exit(1); });

function safeName(t) {
  try { return JSON.parse(t).name; } catch (e) { return '(解析失败) ' + String(t).slice(0, 30); }
}
