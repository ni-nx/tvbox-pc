/* ============================================================
   jsspider.js —— 在渲染进程里跑 TVBox 的 JS 规则（cat.js 那套）
   影视TV 5.4.2 的 assets/js/lib/cat.js 完整搬了过来，配合这里的宿主：
   - req / http 用同步 XHR 实现（渲染窗口 webSecurity:false，可以跨域）
   - 规则文件里的 import 会被改写成对 cat.js 的引用
   - 规则导出的 spider 对象（var spider / export default）都能取到
   - 调用约定与 TVBox 一致：homeContent / categoryContent / detailContent /
     searchContent / playerContent，返回 JSON 字符串
   ============================================================ */
import * as CAT from './vendor/cat.js';

const cache = new Map(); // 规则地址 -> { sp, siteKey }
let readyResolve;
window.__jsSpiderReady = new Promise((r) => (readyResolve = r));

function absUrl(base, u) {
  try {
    return new URL(u, base || location.href).toString();
  } catch (e) {
    return u;
  }
}

/* TVBox 规则里 req(url, {method, body, headers, timeout}) 是同步的 */
function syncReq(url, opt) {
  const o = opt || {};
  const method = String(o.method || 'GET').toUpperCase();
  const xhr = new XMLHttpRequest();
  const finalUrl = absUrl(o.base || location.href, url);
  try {
    xhr.open(method, finalUrl, false);
    const headers = Object.assign({}, o.headers || {});
    if (o.body && method !== 'GET' && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    Object.keys(headers).forEach((k) => {
      try { xhr.setRequestHeader(k, String(headers[k])); } catch (e) {}
    });
    xhr.send(o.body == null ? null : o.body);
  } catch (e) {
    return { ok: false, status: 0, content: '', error: String(e && e.message ? e.message : e), url: finalUrl };
  }
  let text = '';
  try { text = xhr.responseText || ''; } catch (e) { text = ''; }
  return {
    ok: xhr.status >= 200 && xhr.status < 300,
    status: xhr.status,
    content: text,
    headers: { 'content-type': xhr.getResponseHeader('Content-Type') || '' },
    url: finalUrl
  };
}

function sleep(ms) {
  // 规则里偶尔用同步等待，这里不阻塞主线程，只做占位
  return new Promise((r) => setTimeout(r, Math.max(0, Math.min(2000, ms | 0))));
}

/* 把 ESM 规则源码改成可直接 eval 的函数体 */
function toBody(src) {
  let code = String(src || '');
  code = code.replace(/^\s*import\s+\*\s+as\s+([\w$]+)\s+from\s+['"][^'"]*['"];?/gm, 'const $1 = __CAT__;');
  code = code.replace(/^\s*import\s*\{([^}]*)\}\s*from\s+['"][^'"]*['"];?/gm, 'const {$1} = __CAT__;');
  code = code.replace(/^\s*import\s+([\w$]+)\s+from\s+['"][^'"]*['"];?/gm, 'const $1 = __CAT__.default || __CAT__;');
  code = code.replace(/^\s*import\s+['"][^'"]*['"];?/gm, '');
  code = code.replace(/^\s*export\s+default\s+/gm, 'var __default = ');
  code = code.replace(/^\s*export\s*\{[^}]*\};?/gm, '');
  code = code.replace(/^\s*export\s+const\s+/gm, 'const ');
  code = code.replace(/^\s*export\s+var\s+/gm, 'var ');
  code = code.replace(/^\s*export\s+function\s+/gm, 'function ');
  return `${code}
;
if (typeof __default !== 'undefined') return __default;
if (typeof spider !== 'undefined') return spider;
if (typeof module !== 'undefined' && module && module.exports) return module.exports;
if (globalThis.__JS_SPIDER__) return globalThis.__JS_SPIDER__;
return null;`;
}

function buildSpider(src, site) {
  const fn = new Function('__CAT__', 'req', 'http', '__site', 'sleep', toBody(src));
  const catShim = Object.assign({}, CAT, {
    req: (u, o) => syncReq(u, o),
    http: (u, o) => Promise.resolve(syncReq(u, o))
  });
  const obj = fn(catShim, (u, o) => syncReq(u, o), (u, o) => Promise.resolve(syncReq(u, o)), site, sleep);
  if (!obj || typeof obj !== 'object') throw new Error('这个 js 规则没有导出 spider 对象');
  return obj;
}

async function ensure(site) {
  const url = site.__jsUrl;
  if (!url) throw new Error('没有可用的 js 规则地址');
  if (cache.has(url)) return cache.get(url);
  const r = await window.tvbox.httpGet({ url, headers: { 'User-Agent': navigator.userAgent } });
  const text = (r && (r.text || r.body)) || '';
  if (!text) throw new Error('规则下载失败（' + ((r && r.status) || '无响应') + '）');
  let sp;
  try {
    sp = buildSpider(text, site);
  } catch (e) {
    throw new Error('规则加载失败：' + (e && e.message ? e.message : e));
  }
  if (typeof sp.init === 'function') {
    try { await sp.init(site); } catch (e) {}
  }
  cache.set(url, sp);
  return sp;
}

async function call(site, method, args) {
  await window.__jsSpiderReady;
  if (!site.__jsUrl) throw new Error('该站点不是 js 规则');
  const sp = await ensure(site);
  const fn = sp[method] || sp[method.replace(/Content$/, '')];
  if (typeof fn !== 'function') throw new Error('规则里没有 ' + method);
  const out = await fn.apply(sp, args || []);
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') return JSON.stringify(out);
  return '';
}

window.jsSpider = {
  ready: () => window.__jsSpiderReady,
  call,
  reset() { cache.clear(); },
  /* 用规则自带的 playerContent 解析播放地址：{parse,url,header} */
  async player(site, flag, id) {
    const text = await call(site, 'playerContent', [flag || '', id || '', []]);
    try { return JSON.parse(text); } catch (e) { return null; }
  }
};

readyResolve(CAT);
