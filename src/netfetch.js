'use strict';
/* ------------------------------------------------------------------ *
 * 网络层：三级取数，专门对付「源站 403」
 *   1) net.request —— Chromium 网络栈，TLS 指纹与真浏览器一致
 *   2) 隐藏浏览器窗口里的 fetch —— 带 cookie、Sec-Fetch-* 等浏览器专属请求头
 *   3) 两者都失败时把原因如实返回，由界面提示用户改用「浏览器复制粘贴」
 * ------------------------------------------------------------------ */
const { BrowserWindow, session, net } = require('electron');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const state = { ua: DEFAULT_UA, referer: '' };

function setIdentity(ua, referer) {
  state.ua = (ua && String(ua).trim()) || DEFAULT_UA;
  state.referer = (referer && String(referer).trim()) || '';
  try {
    if (session.defaultSession) session.defaultSession.setUserAgent(state.ua);
  } catch (_) {}
}

function getIdentity() {
  return { ua: state.ua, referer: state.referer };
}

function browserHeaders(extra) {
  const h = Object.assign({
    'User-Agent': state.ua || DEFAULT_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
  }, extra || {});
  if (state.referer && !h.Referer) h.Referer = state.referer;
  return h;
}

/* 老苹果CMS 常返回 GBK/GB18030，按 UTF-8 解会整页乱码 */
function decodeBody(buf, contentType) {
  const charset = (String(contentType || '').match(/charset\s*=\s*([^\s;]+)/i) || [])[1] || '';
  if (charset && !/utf-?8/i.test(charset)) {
    try { return new TextDecoder(charset).decode(buf); } catch (_) {}
  }
  const utf8 = buf.toString('utf8');
  if (utf8.indexOf('\uFFFD') === -1) return utf8;
  try {
    const gb = new TextDecoder('gb18030').decode(buf);
    const bad8 = (utf8.match(/\uFFFD/g) || []).length;
    const badGb = (gb.match(/\uFFFD/g) || []).length;
    if (badGb < bad8) return gb;
  } catch (_) {}
  return utf8;
}

function netRequest(url, headers, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => {
      try { req.abort(); } catch (_) {}
      finish({ ok: false, status: 0, text: '', error: '请求超时' });
    }, timeout || 15000);
    let req;
    try {
      req = net.request({ url, method: 'GET', redirect: 'follow', session: session.defaultSession });
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, status: 0, text: '', error: String(e.message || e) });
      return;
    }
    Object.keys(headers || {}).forEach((k) => {
      try { req.setHeader(k, String(headers[k])); } catch (_) {}
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        const ct = res.headers && res.headers['content-type'];
        finish({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          text: decodeBody(Buffer.concat(chunks), Array.isArray(ct) ? ct[0] : (ct || '')),
          finalUrl: url
        });
      });
      res.on('error', (e) => finish({ ok: false, status: res.statusCode || 0, text: '', error: String(e.message || e) }));
    });
    req.on('error', (e) => finish({ ok: false, status: 0, text: '', error: String(e.message || e) }));
    req.end();
  });
}

let helperWin = null;
function helperWindow() {
  if (helperWin && !helperWin.isDestroyed()) return helperWin;
  helperWin = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      session: session.defaultSession,
      backgroundThrottling: false
    }
  });
  helperWin.on('closed', () => { helperWin = null; });
  helperWin.loadURL('data:text/html,<html><head><meta charset="utf-8"></head><body></body></html>');
  return helperWin;
}

async function browserFetch(url, headers, timeout) {
  try {
    const w = helperWindow();
    if (w.webContents.isLoading()) await new Promise((r) => w.webContents.once('did-finish-load', r));
    const script = `(async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ${Number(timeout) || 15000});
      try {
        const r = await fetch(${JSON.stringify(url)}, {
          headers: ${JSON.stringify(headers || {})},
          credentials: 'include',
          redirect: 'follow',
          signal: ctrl.signal
        });
        const text = await r.text();
        return { ok: r.ok, status: r.status, text, finalUrl: r.url, viaBrowser: true };
      } catch (e) {
        return { ok: false, status: 0, text: '', error: String((e && e.message) || e) };
      } finally { clearTimeout(t); }
    })()`;
    const raw = w.webContents.executeJavaScript(script, true);
    return await Promise.race([
      raw,
      new Promise((r) => setTimeout(() => r({ ok: false, status: 0, text: '', error: '浏览器兜底超时' }), (Number(timeout) || 15000) + 4000))
    ]);
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String((e && e.message) || e) };
  }
}

async function httpGet(url, extra, timeout) {
  if (!url || !/^(http|https):\/\//i.test(url)) {
    return { ok: false, status: 0, text: '', error: '仅支持 http/https 地址' };
  }
  const hdrs = browserHeaders(extra);
  let r = await netRequest(url, hdrs, timeout);
  const blocked = (x) => !x.ok && (x.status === 403 || x.status === 401 || x.status === 429 || x.status === 0);
  if (blocked(r)) {
    const r2 = await browserFetch(url, hdrs, timeout);
    if (r2 && String(r2.text || '').trim()) r = r2;
    else if (!r.error && r2 && r2.error) r.error = r2.error;
  }
  // 还不行：直接如实返回 403，由界面提示改用「浏览器复制粘贴」
  return r;
}

/* 在隐藏窗口里访问页面（执行其 JS），用于通过简单的 cookie / JS 网关 */
async function warmVisit(url, timeout) {
  try {
    const w = helperWindow();
    await Promise.race([
      w.loadURL(url).catch(() => {}),
      new Promise((r) => setTimeout(r, timeout || 6000))
    ]);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { DEFAULT_UA, setIdentity, getIdentity, browserHeaders, decodeBody, netRequest, browserFetch, httpGet, warmVisit };
