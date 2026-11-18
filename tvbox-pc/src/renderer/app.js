'use strict';

/* ============================================================
 *  TVBox PC —— 渲染进程
 *  仅实现 TVBox 开源接口协议（sites / lives / parses），
 *  软件本身不包含任何影视资源。
 * ============================================================ */

const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const K = {
  iface: 'tvbox_iface_v1',
  cur: 'tvbox_current_v1',
  set: 'tvbox_settings_v1',
  hist: 'tvbox_history_v1',
  fav: 'tvbox_fav_v1',
  searchHist: 'tvbox_search_hist_v1',
  repo: 'tvbox_repo_pick_v1',
  repoLast: 'tvbox_repo_last_v1',
  liveOk: 'tvbox_live_ok_v1',
  vodUrl: 'tvbox_vod_url_v1',
  liveUrl: 'tvbox_live_url_v1'
};

/* 先把磁盘里存的那一份灌回 localStorage：
   页面跑在随机端口上，localStorage 可能已经换了 origin，磁盘才是准的。 */
(function hydrateFromDisk() {
  try {
    const api = window.tvboxDisk;
    if (!api) return;
    const all = api.all() || {};
    Object.keys(all).forEach((k) => {
      try { if (!localStorage.getItem(k)) localStorage.setItem(k, all[k]); } catch (e) {}
    });
  } catch (e) {}
})();

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      const raw = JSON.stringify(v);
      localStorage.setItem(k, raw);
      if (window.tvboxDisk) window.tvboxDisk.set(k, raw);
    } catch (e) {}
  }
};

const S = {
  interfaces: store.get(K.iface, []),
  currentId: store.get(K.cur, ''),
  settings: Object.assign({ ua: '', referer: '', autoNext: true, volume: 0.8, theme: 'light', showClock: true, showWeather: true, showNet: true, weatherCity: '', incognito: false, proxy: '', posterSize: 'medium', fontSize: 'medium', videoFit: 'contain', bufferMult: 1, longPressRate: 3, backgroundPlay: true }, store.get(K.set, {})),
  history: store.get(K.hist, []),
  favs: store.get(K.fav, []),
  searchHist: store.get(K.searchHist, []),
  liveOk: store.get(K.liveOk, []),        // 上次成功解析出频道的直播源地址，切换直播源时排前面
  repoPicks: store.get(K.repo, {}),    // 多仓 URL -> 上次选的线路，记住省得每次重选
  lastRepo: store.get(K.repoLast, ''), // 上次用的是哪个多仓（用于设置页回填 + 换线路按钮）
  autoReferer: '',

  cfgName: '',
  cfgUrl: '',          // 当前点播接口来源地址（多仓时是仓库地址）
  cfgRepoLine: '',     // 多仓时当前加载的是哪条线路的地址
  cfgBase: '',         // 接口文件所在位置，用来把 ./jar/x.js 这类相对路径补全
  spider: '',          // 接口里的全局 spider 规则（.js 才能被桌面版执行）
  vodUrl: store.get(K.vodUrl, ''),   // 点播接口地址（持久化）
  liveUrl: store.get(K.liveUrl, ''), // 直播接口地址（持久化，留空沿用点播接口的 lives）
  vodName: '',
  liveName: '',
  liveSeparate: !!store.get(K.liveUrl, ''), // 直播是否走了独立接口
  sites: [],
  lives: [],
  parses: [],
  flags: [],

  site: null,          // 当前分类页站点
  classes: [],
  list: [],
  page: 1,
  pageCount: 1,
  tid: '',
  classCache: {},      // siteKey -> classes

  detail: null,        // {vod, site, groups}
  play: null,          // 播放上下文
  liveData: null,
  view: 'home',
  renderToken: 0
};

/* ---------------- 基础工具 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pick(o, ...keys) {
  for (const k of keys) {
    const v = o == null ? undefined : o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function resolveUrl(base, rel) {
  if (!rel) return '';
  const s = String(rel).trim();
  if (/^(https?:|data:|file:)/i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (!base) return s;
  try { return new URL(s, base).href; } catch (e) { return s; }
}

function joinUrl(base, params) {
  const qs = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => k + '=' + encodeURIComponent(String(v)))
    .join('&');
  if (!qs) return base;
  if (/[?&]$/.test(base)) return base + qs;
  return base + (base.includes('?') ? '&' : '?') + qs;
}

function toast(msg, type) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function loadingHtml(text) {
  return `<div class="loading"><span class="spinner"></span>${escapeHtml(text || '加载中…')}</div>`;
}

function emptyHtml(title, sub) {
  return `<div class="empty"><b>${escapeHtml(title)}</b>${escapeHtml(sub || '')}</div>`;
}

function showModal({ title, html, actions, wide }) {
  $('#modalTitle').textContent = title || '提示';
  $('#modalBody').innerHTML = html || '';
  const box = $('#modalActions');
  box.innerHTML = '';
  (actions || [{ label: '知道了', primary: true }]).forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '');
    b.textContent = a.label;
    b.onclick = () => {
      if (a.onClick) a.onClick();
      if (a.keepOpen !== true) hideModal();
    };
    box.appendChild(b);
  });
  const panel = document.querySelector('#modalPane .modal');
  if (panel) panel.classList.toggle('wide', !!wide);
  $('#modalPane').classList.remove('hidden');
  // 弹窗打开后遥控器焦点落到弹窗内第一个可选项
  setTimeout(() => {
    if (window.kodiSetFocus) {
      const first = panel && panel.querySelector('.src-row, .site-tile, .ep, .tab, .btn');
      if (first) window.kodiSetFocus(first);
    }
  }, 0);
}

function hideModal() {
  $('#modalPane').classList.add('hidden');
}

async function pool(items, limit, fn) {
  const queue = items.slice();
  const workers = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) {
    workers.push((async () => {
      while (queue.length) {
        const item = queue.shift();
        try { await fn(item); } catch (e) {}
      }
    })());
  }
  await Promise.all(workers);
}

/* ---------------- 网络 ---------------- */
function headers() {
  const h = { 'User-Agent': S.settings.ua || UA_DEFAULT, Accept: '*/*' };
  if (S.settings.referer) h.Referer = S.settings.referer;
  return h;
}

async function getText(url, extra) {
  if (!url) return { ok: false, text: '', error: '空地址' };
  const h = Object.assign(headers(), extra || {});
  try {
    const r = await window.tvbox.httpGet({ url, headers: h, timeout: 18000 });
    // 有些源站会按 UA / Referer 挡掉非常规请求：失败或空响应时用「浏览器形象」再试一次
    const bad = !r || !r.ok || !String(r.text || '').trim();
    if (bad && !(extra && extra.__noRetry)) {
      let origin = '';
      try { origin = new URL(url).origin + '/'; } catch (e) {}
      const h2 = Object.assign({}, h, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        Referer: origin
      });
      try {
        const r2 = await window.tvbox.httpGet({ url, headers: h2, timeout: 18000 });
        if (r2 && String(r2.text || '').trim()) return r2;
      } catch (e) {}
    }
    return r;
  } catch (e) {
    return { ok: false, text: '', error: String((e && e.message) || e) };
  }
}

/* ---------------- 接口协议解析 ----------------
 * TVBox 接口 json 结构：
 * { "sites":[...], "lives":[...], "parses":[...], "flags":[...], "spider":"..." }
 * 多仓：{ "urls":[ {"name":"线路一","url":"..."}, ... ] }
 * ---------------------------------------------- */
function mapVod(v) {
  if (!v) return null;
  const id = pick(v, 'vod_id', 'id', 'vid', 'VodID');
  return {
    id: String(id),
    name: stripHtml(pick(v, 'vod_name', 'name', 'title', 'VodName')),
    pic: pick(v, 'vod_pic', 'pic', 'v_pic', 'vod_pic_thumb', 'cover', 'img'),
    remarks: stripHtml(pick(v, 'vod_remarks', 'note', 'remarks', 'state')),
    year: String(pick(v, 'vod_year', 'year')),
    area: String(pick(v, 'vod_area', 'area')),
    typeName: stripHtml(pick(v, 'type_name', 'typeName', 'class')),
    lang: String(pick(v, 'vod_lang', 'lang')),
    actor: stripHtml(pick(v, 'vod_actor', 'actor')),
    director: stripHtml(pick(v, 'vod_director', 'director')),
    score: String(pick(v, 'vod_score', 'score')),
    content: stripHtml(pick(v, 'vod_content', 'content', 'des', 'blurb', 'vod_blurb')),
    playFrom: String(pick(v, 'vod_play_from', 'play_from')),
    playUrl: String(pick(v, 'vod_play_url', 'play_url')),
    raw: v
  };
}

function fromJson(j) {
  if (!j || typeof j !== 'object') return { classes: [], list: [], page: 0, pageCount: 0 };
  // 有些源把内容包在 data 里：{ "data": { "list": [...] } }
  const box = (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) ? j.data : j;
  const rawList = box.list || box.videos || box.items || j.list || j.videos || j.items || (Array.isArray(j) ? j : []);
  const rawClass = box.class || box.classes || box.types || j.class || j.classes || j.types || [];
  const classes = (Array.isArray(rawClass) ? rawClass : [])
    .map((c) => ({
      id: String(pick(c, 'type_id', 'id', 'tid', 'cat_id')),
      name: stripHtml(pick(c, 'type_name', 'name', 'title', 'cat'))
    }))
    .filter((c) => c.id && c.name);
  const list = (Array.isArray(rawList) ? rawList : []).map(mapVod).filter((v) => v && v.id);
  return {
    classes,
    list,
    page: Number(pick(box, 'page') || 0),
    pageCount: Number(pick(box, 'pagecount', 'page_count', 'total_page') || 0),
    total: Number(pick(box, 'total') || 0),
    msg: String(pick(box, 'msg') || '')
  };
}

function fromXml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (!doc || doc.getElementsByTagName('parsererror').length) return { classes: [], list: [] };
  const classes = Array.from(doc.getElementsByTagName('ty')).map((el) => ({
    id: el.getAttribute('id') || el.getAttribute('type_id') || '',
    name: (el.textContent || '').trim()
  })).filter((c) => c.id);

  const list = Array.from(doc.getElementsByTagName('video')).map((el) => {
    const g = (n) => {
      const t = el.getElementsByTagName(n)[0];
      return t ? (t.textContent || '').trim() : '';
    };
    const dds = Array.from(el.getElementsByTagName('dd'));
    const obj = {
      vod_id: g('id') || el.getAttribute('id'),
      vod_name: g('name'),
      vod_pic: g('pic'),
      vod_remarks: g('note') || g('remarks') || g('state'),
      vod_year: g('year'),
      vod_area: g('area'),
      vod_actor: g('actor'),
      vod_director: g('director'),
      vod_content: g('des') || g('content'),
      vod_play_from: Array.from(el.getElementsByTagName('dt')).map((t) => t.getAttribute('flag') || '').filter(Boolean).join('$$$'),
      vod_play_url: Array.from(el.getElementsByTagName('dt')).map((t) =>
        Array.from(t.getElementsByTagName('dd')).map((d) => (d.textContent || '').trim()).join('#')
      ).filter(Boolean).join('$$$')
    };
    if (!obj.vod_play_url && dds.length) {
      obj.vod_play_url = dds.map((d) => (d.textContent || '').trim()).join('#');
      obj.vod_play_from = dds[0].getAttribute('flag') || '';
    }
    return mapVod(obj);
  }).filter((v) => v && v.id);

  return { classes, list };
}

function parseBody(text) {
  const empty = { classes: [], list: [], page: 0, pageCount: 0 };
  if (!text) return empty;
  let t = String(text).replace(/^\uFEFF/, '').trim();
  if (!t) return empty;
  // JSONP 包裹：cb({...}) 或回调名带命名空间
  const jsonp = t.match(/^[\w$.\-]+\s*\(\s*([\s\S]*)\s*\)\s*;?\s*$/);
  if (jsonp) t = jsonp[1].trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return fromJson(JSON.parse(t)); } catch (e) {}
  }
  if (t.startsWith('<')) return fromXml(t);
  const m = t.match(/[\{\[][\s\S]*[\}\]]/);
  if (m) {
    try { return fromJson(JSON.parse(m[0])); } catch (e) {}
  }
  return empty;
}

function siteSkipReason(site) {
  if (!site) return '站点为空';
  const type = Number(site.type);
  const api = String(site.api || '');
  if (!api) return '没有 api 字段';
  if (type === 3) {
    if (site.__jsUrl || siteJsUrl(site)) return '';
    return 'spider 规则站（type=3），这个接口给的是 jar 规则，桌面版只能跑 .js 规则';
  }
  if (!/^https?:\/\//i.test(api)) return 'api 不是 http 地址（' + api.slice(0, 20) + '…），属于 csp_ 私有规则';
  return '';
}

/* 站点的 js 规则地址：优先站点自己的 spider，其次接口的全局 spider，只认 .js */
function siteJsUrl(site) {
  if (!site) return '';
  const own = String(site.spider || '').split(';')[0].trim();
  const global = String(S.spider || '').split(';')[0].trim();
  const isJs = (u) => /\.js(\?|#|$)/i.test(u);
  const picked = isJs(own) ? own : isJs(global) ? global : '';
  if (!picked) return '';
  return resolveUrl(S.cfgBase || '', picked);
}

function siteIsJs(site) {
  return !!site && Number(site.type) === 3 && !!siteJsUrl(site);
}

/* 解析一个 url 相对于接口地址的位置 */
function resolveUrl(base, u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^(data|file|assets):/i.test(s)) return s;
  if (s.startsWith('clan://')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  try {
    return new URL(s.replace(/^\.\//, ''), base || location.href).toString();
  } catch (e) {
    return s;
  }
}

function isCmsSite(site) {
  return !siteSkipReason(site);
}

/* 把接口「为什么刷不出内容」讲清楚，用于空态与诊断弹窗 */
function diagSummary() {
  const sites = S.sites || [];
  if (!sites.length) return '这个接口里没有 sites 数组，可能只带了直播或解析配置。';
  const groups = {};
  sites.forEach((s) => {
    const why = siteSkipReason(s);
    if (why) groups[why] = (groups[why] || 0) + 1;
  });
  const parts = Object.keys(groups).map((k) => `${groups[k]} 个${k}`);
  if (!parts.length) return '';
  return `接口共 ${sites.length} 个站点，其中 ${sites.filter(isCmsSite).length} 个可直连；被跳过的：${parts.join('，')}。`;
}

function siteKey(site) {
  return String((site && (site.key || site.name || site.api)) || '');
}

function absPic(site, pic) {
  if (!pic) return '';
  return resolveUrl(site && site.api, pic);
}

/* ---------------- 接口文本解析：容错 JSON / 多仓 txt ---------------- */
function stripJsonComments(t) {
  return String(t)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*(#|\/\/)[^\n\r]*$/gm, '')
    .replace(/([,:[{][ \t]*)#[^\n\r]*$/gm, '$1');
}

function parseJsonLoose(text) {
  const t = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!t) return null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
  let j = tryParse(t);
  if (j) return j;
  j = tryParse(stripJsonComments(t));
  if (j) return j;
  const m = t.match(/[\{\[][\s\S]*[\}\]]/);
  if (m) {
    j = tryParse(stripJsonComments(m[0]));
    if (j) return j;
  }
  return null;
}

/* 多仓 txt：「线路名,https://xxx/api.json」一行一条；直播 txt 会被 #genre# 排除 */
function parseRepoText(text) {
  const raw = String(text || '');
  if (/#genre#/i.test(raw)) return [];
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const out = [];
  for (const line of lines) {
    if (/^[#/;]/.test(line)) continue;
    const idx = line.indexOf(',');
    if (idx === -1) return [];
    const name = line.slice(0, idx).trim() || '线路';
    const url = line.slice(idx + 1).trim();
    if (!/^https?:\/\//i.test(url)) return [];
    out.push({ name, url });
  }
  return out;
}

/* ---------------- 多仓线路选择器（带逐条探测） ---------------- */
async function showRepoPicker(lines, opts = {}, repoUrl = '') {
  if (!lines.length) return;
  const probe = new Array(lines.length).fill(null);
  window.__repoProbe = probe;   // 仅自测读取
  window.__repoLines = lines;

  let order = lines.map((_, i) => i);

  function rememberPick(l) {
    if (!repoUrl) return;
    S.repoPicks[repoUrl] = { line: l.url, name: l.name, time: Date.now() };
    store.set(K.repo, S.repoPicks);
  }

  function badgeOf(p) {
    if (!p) return '<span class="repo-badge">未检测</span>';
    let badge;
    if (p.ok) badge = `<span class="repo-badge ${p.usable ? 'ok' : 'bad'}">可直连 ${p.usable}/${p.sites}</span>`;
    else badge = `<span class="repo-badge bad">${p.status ? 'HTTP ' + p.status : '打不开'}</span>`;
    if (p.kind === 'repo') badge += '<span class="repo-badge">又是多仓</span>';
    else if (p.kind === 'text') badge += '<span class="repo-badge">不是 json</span>';
    else if (p.ok && p.spider && !p.usable) badge += '<span class="repo-badge bad">spider 为主</span>';
    return badge;
  }

  function renderPicker(busy) {
    const rows = order.map((i) => {
      const l = lines[i];
      return `<div class="list-line repo-line" data-line="${i}">
        <b class="repo-name">${escapeHtml(l.name)}</b>
        <span class="repo-url">${escapeHtml(l.url)}</span>
        <span class="repo-right">${badgeOf(probe[i])}</span>
      </div>`;
    }).join('');
    const hint = busy
      ? `正在检测各线路…　<span id="repoHint">0/${lines.length}</span>`
      : `共 ${lines.length} 条线路。点「检测各线路」会逐条试一遍，标出每条里有多少能直连的站点；可直连 0 的全是 spider 规则站，桌面版刷不出内容。`;
    showModal({
      title: '多仓接口 · 选择一条线路',
      wide: true,
      html: `<div class="hint" style="margin-bottom:12px">${hint}</div><div id="repoList">${rows}</div>`,
      actions: [
        { label: '用最优线路', primary: true, keepOpen: true, onClick: () => pickBest() },
        { label: '合并可用站点', keepOpen: true, onClick: () => mergeAll() },
        { label: '检测各线路', keepOpen: true, onClick: () => probeAll() },
        { label: '取消' }
      ]
    });
    $$('#repoList .repo-line').forEach((el) => {
      el.onclick = () => choose(Number(el.dataset.line));
    });
  }

  async function choose(i) {
    const l = lines[i];
    if (!l) return;
    hideModal();
    try {
      toast('正在加载：' + l.name);
      const cfg = await loadInterface(l.url, Object.assign({}, opts, { repoLine: l.url, repoUrl }));
      if (cfg && cfg.sites.length && !cfg.sites.filter(isCmsSite).length) {
        showModal({
          title: '这条线路刷不出内容',
          html: `<b>${escapeHtml(l.name)}</b> 里 ${cfg.sites.length} 个站点全部是 spider / 规则站，` +
            '桌面版不能执行 Android 的 jar，所以首页会一直是空的。换一条可直连站点多的线路即可。',
          actions: [
            { label: '换一条线路', primary: true, onClick: () => showRepoPicker(lines, opts, repoUrl) },
            { label: '先这样' }
          ]
        });
      } else if (cfg) {
        rememberPick(l);
        S.cfgUrl = repoUrl || S.cfgUrl;
        toast('已加载：' + l.name + '（下次启动会自动用这条）', 'ok');
        switchView('home');
        if (S.view === 'settings') renderSettings();
      }
    } catch (err) {
      toast(String(err.message || err), 'err');
      showModal({
        title: '这条线路加载失败',
        html: `<b>${escapeHtml(l.name)}</b><br><span class="hint">${escapeHtml(String(err.message || err))}</span>`,
        actions: [
          { label: '换一条线路', primary: true, onClick: () => showRepoPicker(lines, opts, repoUrl) },
          { label: '关闭' }
        ]
      });
    }
  }

  async function probeAll() {
    if (probe._busy) return;
    probe._busy = true;
    renderPicker(true);
    let done = 0;
    const total = lines.length;
    const bump = (i, p) => {
      done += 1;
      probe[i] = p;
      const cell = document.querySelector(`#repoList .repo-line[data-line="${i}"] .repo-right`);
      if (cell) cell.innerHTML = badgeOf(p);
      const h = document.querySelector('#repoHint');
      if (h) h.textContent = `${done}/${total}`;
    };
    await pool(lines.map((l, i) => ({ l, i })), 8, async ({ l, i }) => {
      bump(i, await probeRepoLine(l.url));
    });
    probe._busy = false;
    // 检测完按「可直连站点数」排序，好的排前面
    order = order.slice().sort((a, b) => {
      const pa = probe[a] || { usable: -1 };
      const pb = probe[b] || { usable: -1 };
      return pb.usable - pa.usable;
    });
    renderPicker(false);
  }

  function pickBest() {
    if (!probe.some((p) => p && p.usable)) {
      if (!probe._busy) {
        // 没检测过就点「用最优线路」：先快速探测，探到够用的一条就停
        quickPick();
      } else {
        toast('正在检测，稍等…');
      }
      return;
    }
    let best = -1;
    probe.forEach((p, i) => {
      if (p && (!probe[best] || p.usable > probe[best].usable)) best = i;
    });
    if (best >= 0) choose(best);
  }

  /* 快速模式：并发 8 逐条试，碰到「可直连 ≥ 8」的线路立刻用它，
     不用等 100+ 条全部探完（这个多仓有 117 条） */
  async function quickPick() {
    if (probe._busy) return;
    probe._busy = true;
    renderPicker(true);
    const total = lines.length;
    let cursor = 0;
    let done = 0;
    let found = null;
    const worker = async () => {
      while (!found) {
        const i = cursor++;
        if (i >= total) return;
        const p = await probeRepoLine(lines[i].url);
        done += 1;
        probe[i] = p;
        const cell = document.querySelector(`#repoList .repo-line[data-line="${i}"] .repo-right`);
        if (cell) cell.innerHTML = badgeOf(p);
        const h = document.querySelector('#repoHint');
        if (h) h.textContent = `已试 ${done} 条…`;
        if (p.ok && p.usable >= 8) { found = i; return; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, total) }, worker));
    probe._busy = false;
    if (found !== null && found !== undefined) {
      choose(found);
    } else {
      toast('前 ' + done + ' 条里没有可直连站点够多的，点「检测各线路」看完整结果', 'err');
      renderPicker(false);
    }
  }

  /* 合并模式：把每条线路里能直连的 cms 站点全部抽出来，去重成一个接口。
     好处是一次拿到所有片源，不用在 110 条线路之间来回切。 */
  function buildMerged() {
    const seenApi = new Set();
    const seenLive = new Set();
    const seenParse = new Set();
    const sites = [];
    const lives = [];
    const parses = [];
    let linesUsed = 0;

    probe.forEach((p) => {
      if (!p || !p.ok) return;
      let added = false;
      (p.cms || []).forEach((s) => {
        const api = siteApi(s);
        const norm = api.toLowerCase().replace(/\/+$/, '');
        if (!norm || seenApi.has(norm) || sites.length >= 300) return;
        seenApi.add(norm);
        sites.push({
          key: 'm' + sites.length,
          name: s.name,
          type: 1,
          api,
          searchable: 1,
          quickSearch: 1
        });
        added = true;
      });
      (p.lives || []).forEach((l) => {
        if (!l.url || seenLive.has(l.url)) return;
        seenLive.add(l.url);
        lives.push({ name: l.name, url: l.url, type: 0 });
      });
      (p.parses || []).forEach((x) => {
        if (!x.url || seenParse.has(x.url)) return;
        seenParse.add(x.url);
        parses.push({ name: x.name, url: x.url, type: 1 });
      });
      if (added) linesUsed += 1;
    });

    return { sites, lives, parses, linesUsed };
  }

  async function mergeAll() {
    if (probe._busy) return;
    if (!probe.some((p) => p && p.usable)) {
      await probeAll();     // 没探过就先全量探一遍（有进度条）
      if (probe._busy) return;
    }
    const merged = buildMerged();
    if (!merged.sites.length) {
      toast('这些线路里没有可直连的站点，合并也没内容', 'err');
      return;
    }
    hideModal();
    const name = `多仓合并 · ${merged.linesUsed} 条线路`;
    const cfg = { name, sites: merged.sites, lives: merged.lives, parses: merged.parses, flags: [], spider: '' };
    applyConfig(cfg, name, '');
    S.cfgDiag = {
      input: '多仓合并（' + lines.length + ' 条线路里取可直连站点）',
      http: null,
      keys: ['urls'],
      sites: cfg.sites.length,
      usable: cfg.sites.length,
      lives: cfg.lives.length,
      parses: cfg.parses.length,
      spider: '',
      time: Date.now()
    };
    saveInterface({
      name,
      url: '',
      raw: JSON.stringify({ name, sites: cfg.sites, lives: cfg.lives, parses: cfg.parses })
    });
    // 记住「这个仓库我用的是合并结果」，下次启动直接回到合并后的界面
    if (repoUrl) {
      S.repoPicks[repoUrl] = { merged: true, name, time: Date.now() };
      store.set(K.repo, S.repoPicks);
      S.cfgUrl = repoUrl;
      S.cfgRepoLine = '';
      S.lastRepo = repoUrl;
      store.set(K.repoLast, repoUrl);
      saveInterface({ name: `多仓 · ${lines.length} 条线路`, url: repoUrl });
    }
    switchView('home');
    toast(`已合并 ${merged.linesUsed} 条线路，${cfg.sites.length} 个可直连站点`, 'ok');
  }

  renderPicker(false);
}

async function probeRepoLine(url) {
  const r = await getText(url);
  const info = {
    ok: false, status: r.status || 0, sites: 0, usable: 0, spider: false,
    kind: 'json', error: r.error || '', cms: [], lives: [], parses: []
  };
  if (!r.ok || !String(r.text || '').trim()) return info;
  const json = parseJsonLoose(r.text);
  if (!json) { info.kind = 'text'; return info; }
  if (Array.isArray(json.urls)) { info.ok = true; info.kind = 'repo'; return info; }
  const cfg = normalizeConfig(json, url);
  info.ok = true;
  info.sites = cfg.sites.length;
  info.usable = cfg.sites.filter(isCmsSite).length;
  info.spider = !!cfg.spider;
  info.cms = cfg.sites.filter(isCmsSite).map((s) => ({ key: s.key, name: s.name, api: siteApi(s) }));
  info.lives = cfg.lives.slice(0, 20);
  info.parses = cfg.parses.slice(0, 6);
  return info;
}

/* ---------------- 加载接口 ---------------- */
async function loadInterface(input, opts = {}) {
  const optionSave = opts.save !== false;
  let json = null;
  let baseUrl = '';
  let rawText = '';
  let httpInfo = null;

  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('接口内容为空');

  if (/^https?:\/\//i.test(trimmed)) {
    const r = await getText(trimmed);
    if (!r.ok) throw new Error(interfaceError(r));
    rawText = r.text || '';
    baseUrl = r.finalUrl || trimmed;
    httpInfo = {
      status: r.status || 0,
      ok: !!r.ok,
      finalUrl: baseUrl,
      bytes: rawText.length,
      preview: rawText.replace(/\s+/g, ' ').slice(0, 180)
    };
  } else {
    rawText = trimmed;
    baseUrl = '';
  }

  try {
    json = parseJsonLoose(rawText);
  } catch (e) {}
  if (!json) {
    // 多仓 txt：每行「名称,地址」
    const repo = parseRepoText(rawText);
    if (repo.length) json = { urls: repo.map((it) => ({ name: it.name, url: it.url })) };
  }
  if (!json) throw new Error('接口内容既不是 JSON，也不是「名称,地址」形式的多仓列表（如是直播 txt，请到「直播」页添加）');

  // 多仓
  if (Array.isArray(json.urls) && json.urls.length) {
    const lines = json.urls.map((u) => ({
      name: String(pick(u, 'name', 'title') || '线路'),
      url: resolveUrl(baseUrl, pick(u, 'url'))
    })).filter((l) => l.url);
    const repoUrl = /^https?:\/\//i.test(trimmed) ? trimmed : '';
    const depth = Number(opts.depth || 0);
    // 上次在这个仓库里选过的线路：直接沿用，不再弹窗
    const pickRec = repoUrl && S.repoPicks[repoUrl];
    // 上次在这个仓库里用的是「合并结果」：直接恢复那一份
    if (pickRec && pickRec.merged && !opts.forcePicker && depth === 0) {
      const rec = S.interfaces.find((x) => x.raw && x.name === pickRec.name);
      if (rec) {
        try {
          const cfg = await loadInterface(rec.raw,
            Object.assign({}, opts, { name: rec.name, save: false, depth: depth + 1 }));
          S.cfgUrl = repoUrl;
          S.cfgRepoLine = '';
          S.lastRepo = repoUrl;
          store.set(K.repoLast, repoUrl);
          toast('沿用上次的合并接口：' + rec.name, 'ok');
          return cfg;
        } catch (e) {
          delete S.repoPicks[repoUrl];
          store.set(K.repo, S.repoPicks);
        }
      }
    }
    if (pickRec && pickRec.line && !opts.forcePicker && depth < 2 &&
        lines.some((l) => l.url === pickRec.line)) {
      try {
        toast('沿用上次的线路：' + (pickRec.name || '线路'), 'ok');
        const cfg = await loadInterface(pickRec.line,
          Object.assign({}, opts, { repoLine: pickRec.line, repoUrl, depth: depth + 1 }));
        S.cfgUrl = repoUrl;
        return cfg;
      } catch (e) {
        delete S.repoPicks[repoUrl];
        store.set(K.repo, S.repoPicks);
      }
    }
    await showRepoPicker(lines, opts, repoUrl);
    return null;
  }

  const kind = opts.kind === 'live' ? 'live' : 'vod';
  const cfg = normalizeConfig(json, baseUrl);
  if (kind === 'live') {
    if (!cfg.lives.length) throw new Error('这个直播接口里没有 lives 分组（直播源列表为空）');
  } else if (!cfg.sites.length && !cfg.lives.length) {
    throw new Error('接口里没有可用的 sites / lives');
  }

  applyConfig(cfg, opts.name || '', baseUrl, kind);
  S.cfgDiag = {
    input: /^https?:\/\//i.test(trimmed) ? trimmed : '（粘贴的 json 文本）',
    http: httpInfo,
    keys: json && typeof json === 'object' ? Object.keys(json) : [],
    sites: cfg.sites.length,
    usable: cfg.sites.filter(isCmsSite).length,
    lives: cfg.lives.length,
    parses: cfg.parses.length,
    spider: cfg.spider,
    time: Date.now()
  };

  if (optionSave && kind !== 'live') saveInterface({
    name: opts.name || guessName(baseUrl, cfg),
    url: /^https?:\/\//i.test(trimmed) ? trimmed : '',
    raw: /^https?:\/\//i.test(trimmed) ? '' : rawText
  });

  // 记住这次用的是哪个地址，设置页要回填、重启要能自动恢复
  const httpUrl = /^https?:\/\//i.test(trimmed) ? trimmed : '';
  if (kind === 'live') {
    S.liveUrl = httpUrl;
    S.liveName = opts.name || cfg.name || '未命名直播接口';
    S.liveSeparate = true;
    store.set(K.liveUrl, S.liveUrl);
  } else {
    S.cfgUrl = httpUrl;
    S.vodUrl = httpUrl;
    S.vodName = opts.name || cfg.name || '未命名接口';
    store.set(K.vodUrl, S.vodUrl);
  }
  S.cfgRepoLine = opts.repoLine || '';
  if (opts.repoUrl) { S.lastRepo = opts.repoUrl; store.set(K.repoLast, opts.repoUrl); }
  else if (!opts.repoLine && !opts.keepRepo) { S.lastRepo = ''; store.set(K.repoLast, ''); }

  return cfg;
}

function interfaceError(r) {
  const st = r && r.status ? Number(r.status) : 0;
  if (st === 403 || st === 401 || st === 429) {
    return `接口被源站拒绝（HTTP ${st}）。已用 Chromium 网络栈 + 浏览器内 fetch 各试了一次仍被挡，` +
      '说明该地址对此网络/UA 做了封禁（常见于 Cloudflare 或防盗链）。' +
      '办法：在「设置」点「用系统浏览器打开」把卡片内容复制下来，粘贴到下面的 json 文本框再加载。';
  }
  if (st === 404) return '接口地址不存在（404），检查一下链接是否写错或已失效。';
  return '接口请求失败：' + ((r && (r.error || ('HTTP ' + r.status))) || '未知错误');
}

function guessName(baseUrl, cfg) {
  if (cfg && cfg.name) return cfg.name;
  if (baseUrl) {
    try { return new URL(baseUrl).hostname.replace(/^www\./, ''); } catch (e) { return baseUrl.slice(0, 40); }
  }
  return '本地接口';
}

function normalizeConfig(json, baseUrl) {
  const sites = (Array.isArray(json.sites) ? json.sites : []).map((s) => {
    const api = String(pick(s, 'api') || '');
    return {
      key: String(pick(s, 'key') || api || pick(s, 'name')),
      name: stripHtml(pick(s, 'name', 'title') || '未命名站点'),
      type: Number(pick(s, 'type') || 1),
      api: /^https?:/i.test(api) ? api : resolveUrl(baseUrl, api),
      searchable: s.searchable === undefined ? 1 : Number(s.searchable),
      quickSearch: s.quickSearch === undefined ? 1 : Number(s.quickSearch),
      ext: s.ext
    };
  });

  const lives = (Array.isArray(json.lives) ? json.lives : []).map((l) => ({
    name: stripHtml(pick(l, 'name', 'title') || '直播'),
    url: resolveUrl(baseUrl, pick(l, 'url')),
    type: Number(pick(l, 'type') || 0)
  })).filter((l) => l.url);

  const parses = (Array.isArray(json.parses) ? json.parses : []).map((p) => ({
    name: stripHtml(pick(p, 'name') || '解析'),
    url: resolveUrl(baseUrl, pick(p, 'url')),
    type: Number(pick(p, 'type') || 1)
  })).filter((p) => p.url);

  return {
    name: stripHtml(pick(json, 'name', 'title') || ''),
    sites,
    lives,
    parses,
    flags: Array.isArray(json.flags) ? json.flags : [],
    spider: String(pick(json, 'spider') || '')
  };
}

function applyConfig(cfg, name, baseUrl, kind) {
  // 直播独立接口：只替换直播源，不动点播站点 / 解析 / 规则
  if (kind === 'live') {
    S.lives = cfg.lives;
    S.liveName = name || cfg.name || '未命名直播接口';
    if (S.view === 'live') { try { renderLive(); } catch (e) {} }
    return;
  }

  S.cfgName = name || cfg.name || '未命名接口';
  S.spider = String(cfg.spider || '');
  S.cfgBase = baseUrl || '';
  S.sites = cfg.sites;
  // 直播走独立接口时保留独立直播源；否则沿用点播接口里的 lives
  if (!S.liveSeparate) S.lives = cfg.lives;
  S.parses = cfg.parses;
  S.flags = cfg.flags;
  S.classCache = {};
  S.site = null;
  S.classes = [];
  S.list = [];
  S.page = 1;

  // 给每个站点标出「用哪份 js 规则」，type=3 的站点能不能用全靠它
  S.sites.forEach((s) => {
    s.__jsUrl = siteJsUrl(s);
  });
  if (window.jsSpider) window.jsSpider.reset();

  const chip = $('#cfgChip');
  const usable = S.sites.filter(isCmsSite).length;
  const jsCount = S.sites.filter(siteIsJs).length;
  chip.textContent = `${S.cfgName} · ${usable} 个可用站点`;
  chip.title = S.cfgName + (jsCount ? `\n（其中 ${jsCount} 个走 JS 规则引擎）` : '') + (cfg.spider ? `\n全局 spider：${cfg.spider}` : '');
  chip.classList.add('on');
  if (!S.site) S.site = S.sites.find(isCmsSite) || S.sites.find(siteIsJs) || null;
  refreshBrand();

  // 接口刚落地时首页可能还停在「还没有加载接口」，这里补一次重绘
  if (S.view === 'home') {
    try { renderHome(); } catch (e) {}
  }
}

/* 读一个本地 txt / json 接口文件：内容整段存进软件（localStorage），再尝试加载 */
async function readFileText(file) {
  if (file.text) {
    try { return await file.text(); } catch (e) {}
  }
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('文件读取失败'));
    fr.readAsText(file, 'utf-8');
  });
}

async function importLocalInterface(file) {
  const name = String(file.name || '本地接口').replace(/\.(txt|json|conf)$/i, '');
  let text = '';
  try {
    text = (await readFileText(file)).replace(/\uFEFF/g, '').trim();
  } catch (e) {
    return toast('这个文件读不出来：' + String(e.message || e), 'err');
  }
  if (!text) return toast('文件是空的', 'err');

  // 先存进软件，哪怕解析失败也不会丢
  saveInterface({ name, raw: text });
  try {
    toast('正在导入「' + name + '」…');
    await loadInterface(text, { name, save: false });
    renderSettings();
    toast('本地接口已导入并保存到软件里', 'ok');
  } catch (e) {
    renderSettings();
    toast('文件已存进软件，但这次没解析成功：' + String(e.message || e), 'err');
  }
}

function saveInterface(rec) {
  const name = rec.name || '未命名接口';
  const item = {
    id: String(Date.now()),
    name,
    url: rec.url || '',
    raw: rec.raw || '',
    time: Date.now()
  };
  const exist = S.interfaces.findIndex((i) => (item.url && i.url === item.url) || (!item.url && i.name === item.name));
  if (exist >= 0) {
    S.interfaces[exist] = Object.assign(S.interfaces[exist], {
      name: item.name, url: item.url, raw: item.raw, time: item.time
    });
    S.currentId = S.interfaces[exist].id;
  } else {
    S.interfaces.unshift(item);
    S.currentId = item.id;
  }
  S.interfaces = S.interfaces.slice(0, 30);
  store.set(K.iface, S.interfaces);
  store.set(K.cur, S.currentId);
  return item;
}

/* ---------------- 站点请求 ---------------- */
function siteApi(site) {
  return String(site.api || '').replace(/#.*$/, '');
}

/* JS 规则站的取数入口：拿规则返回的 JSON 文本，交给统一的 parseBody */
async function jsFetch(site, method, args, label) {
  if (!window.jsSpider) throw new Error('JS 规则引擎没起来');
  const text = await window.jsSpider.call(site, method, args || []);
  const d = parseBody(text);
  if (!d.list.length && !d.classes.length && String(text || '').trim() && !/^[\s]*[\{\[<]/.test(String(text))) {
    throw new Error(`${label || method} 返回了非 JSON/XML 内容`);
  }
  return d;
}

async function fetchClasses(site) {
  const key = siteKey(site);
  if (S.classCache[key] && S.classCache[key].length) return S.classCache[key];
  let d;
  if (siteIsJs(site)) {
    d = await jsFetch(site, 'homeContent', [false], '分类');
  } else {
    d = parseBody((await getText(joinUrl(siteApi(site), { ac: 'list' }))).text);
    if (!d.classes.length) {
      d = parseBody((await getText(joinUrl(siteApi(site), { ac: 'videolist' }))).text);
    }
  }
  S.classCache[key] = d.classes;
  return d.classes;
}

async function fetchHome(site) {
  if (siteIsJs(site)) {
    try {
      const d = await jsFetch(site, 'homeContent', [false], '首页');
      if (d.classes.length) S.classCache[siteKey(site)] = d.classes;
      return d;
    } catch (e) {
      return { classes: [], list: [], page: 0, pageCount: 0, hint: String((e && e.message) || e) };
    }
  }
  const api = siteApi(site);
  let d = parseBody((await getText(joinUrl(api, { ac: 'list' }))).text);
  if (d.classes.length) S.classCache[siteKey(site)] = d.classes;
  if (!d.list.length) {
    const t = d.classes[0] ? d.classes[0].id : '';
    const d2 = parseBody((await getText(joinUrl(api, { ac: 'videolist', t, pg: 1 }))).text);
    d = { classes: d.classes.length ? d.classes : d2.classes, list: d2.list };
  }
  return d;
}

async function fetchCategory(site, tid, page) {
  if (siteIsJs(site)) {
    try {
      return await jsFetch(site, 'categoryContent', [String(tid), Number(page) || 1, false, {}], '分类列表');
    } catch (e) {
      return { classes: [], list: [], page: Number(page) || 1, pageCount: 1, hint: String((e && e.message) || e) };
    }
  }
  const api = siteApi(site);
  return parseBody((await getText(joinUrl(api, { ac: 'videolist', t: tid, pg: page }))).text);
}

async function fetchDetail(site, id) {
  if (siteIsJs(site)) {
    let d = await jsFetch(site, 'detailContent', [[String(id)]], '详情');
    return d.list[0] || null;
  }
  const api = siteApi(site);
  let d = parseBody((await getText(joinUrl(api, { ac: 'detail', ids: id }))).text);
  if (!d.list.length) d = parseBody((await getText(joinUrl(api, { ac: 'videolist', ids: id }))).text);
  if (!d.list.length) d = parseBody((await getText(joinUrl(api, { ids: id }))).text);
  return d.list[0] || null;
}

async function searchSite(site, wd) {
  if (siteIsJs(site)) {
    const d = await jsFetch(site, 'searchContent', [String(wd), false], '搜索');
    return d.list;
  }
  const api = siteApi(site);
  let d = parseBody((await getText(joinUrl(api, { wd }))).text);
  if (!d.list.length) d = parseBody((await getText(joinUrl(api, { ac: 'videolist', wd, pg: 1 }))).text);
  if (!d.list.length) d = parseBody((await getText(joinUrl(api, { ac: 'detail', wd }))).text);
  return d.list;
}

/* ---------------- 播放地址解析 ---------------- */
function parsePlaySources(vod) {
  if (!vod) return [];
  const froms = String(vod.playFrom || '').split('$$$');
  const groups = String(vod.playUrl || '').split('$$$');
  const out = [];
  groups.forEach((g, i) => {
    const items = String(g || '').split('#').map((s) => s.trim()).filter(Boolean);
    const episodes = items.map((item, idx) => {
      const pos = item.lastIndexOf('$');
      if (pos === -1) {
        // 有些源只有 url，没有集名
        return { name: items.length > 1 ? '第' + (idx + 1) + '集' : '播放', url: item };
      }
      return {
        name: (item.slice(0, pos) || '第' + (idx + 1) + '集').trim(),
        url: item.slice(pos + 1).trim()
      };
    }).filter((e) => e.url);
    if (episodes.length) {
      out.push({ from: (froms[i] || '线路' + (i + 1)).replace(/[\[\]]/g, '').trim(), episodes });
    }
  });
  return out;
}

function isDirectMedia(url) {
  return /\.(m3u8|mp4|flv|mkv|webm|mov|ts|mpd)(\?|#|$)/i.test(url) || /m3u8|\.mp4/i.test(url);
}

function extractMedia(text) {
  if (!text) return '';
  const t = String(text);
  try {
    const j = JSON.parse(t);
    const u = pick(j, 'url', 'data', 'playurl', 'video', 'm3u8');
    if (typeof u === 'string' && /^https?:/i.test(u)) return u;
  } catch (e) {}
  const m = t.match(/https?:\/\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|flv)[^\s"'<>\\)]*/i);
  return m ? m[0].replace(/\\\//g, '/') : '';
}

async function tryParse(pageUrl) {
  const list = (S.parses || []).filter((p) => p.url).slice(0, 6);
  for (const p of list) {
    const target = joinUrl(p.url, { url: pageUrl });
    const r = await getText(target);
    const media = extractMedia(r.text);
    if (media) return media;
  }
  return '';
}

/* 分享页 / 播放页：从 HTML 里抠出真正的 m3u8 / mp4
   —— 常见于「某某网盘分享页」「ckplayer 播放页」，播放地址写在 var main = "..." 里，
   或者藏在一个 iframe 内。相对路径按页面地址补全。 */
function originOf(url) {
  try { return new URL(url).origin + '/'; } catch (e) { return ''; }
}

function streamsInHtml(html, pageUrl) {
  const t = String(html || '');
  const out = [];
  const push = (raw) => {
    if (!raw) return;
    let u = String(raw).replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
    if (!u || !/\.(m3u8|mp4|flv|mkv|mov)(\?|#|$)/i.test(u)) return;
    if (!/^(https?:)?\/\//i.test(u) && !u.startsWith('/')) return;
    try { u = new URL(u, pageUrl).toString(); } catch (e) { return; }
    if (!out.includes(u)) out.push(u);
  };
  let m;
  const reVar = /(?:var\s+)?(?:main|url|video|videourl|playurl|m3u8|source)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((m = reVar.exec(t))) push(m[1]);
  const reQuote = /["']([^"'\s<>]+\.(?:m3u8|mp4|flv)(?:\?[^"'\s<>]*)?)["']/gi;
  while ((m = reQuote.exec(t))) push(m[1]);
  const reTag = /<(?:video|source)[^>]+src=["']([^"']+)["']/gi;
  while ((m = reTag.exec(t))) push(m[1]);
  return out;
}

async function resolvePlaySource(pageUrl, depth = 0) {
  if (!/^https?:\/\//i.test(pageUrl)) return '';
  if (isDirectMedia(pageUrl)) return pageUrl;
  const r = await getText(pageUrl);
  if (!r.ok || !String(r.text || '').trim()) return '';
  const base = r.finalUrl || pageUrl;
  const cands = streamsInHtml(r.text, base);
  if (cands.length) {
    // 优先带 index 的 m3u8（多为正片清单），其次任意 m3u8
    const m3u8 = cands.filter((u) => /\.m3u8/i.test(u));
    if (m3u8.length) return m3u8.find((u) => /index/i.test(u)) || m3u8[0];
    return cands[0];
  }
  if (depth >= 1) return '';
  const frame = r.text.match(/<iframe[^>]+src=["']([^"']+)["']/i) ||
    r.text.match(/location\.(?:href|replace)\s*[=(]\s*["']([^"']+)["']/i);
  if (frame) {
    let u = '';
    try { u = new URL(frame[1], base).toString(); } catch (e) { u = ''; }
    if (u && u !== pageUrl) return resolvePlaySource(u, depth + 1);
  }
  return '';
}

/* ============================================================
 *  视图渲染
 * ============================================================ */
function switchView(view) {
  S.view = view;
  // 点播 / 直播 / 搜索 / 设置 / 收藏 都是独立整屏页：顶栏（品牌 + 状态区）整条收掉
  document.body.classList.toggle('page-mode', view !== 'home');
  const pb = $('#pageBack');
  if (pb) pb.classList.toggle('hidden', view === 'home');
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + view);
  if (el) el.classList.remove('hidden');
  if (view === 'home') renderHome();
  if (view === 'category') renderCategory();
  if (view === 'search') renderSearchPage();
  if (view === 'live') renderLive();
  if (view === 'fav') renderFav();
  if (view === 'settings') renderSettings();
}

function cardHtml(vod, site, showSite, si) {
  const pic = absPic(site, vod.pic);
  const score = String(vod.score || '').trim();
  const scoreTxt = score && /^[0-9]+(\.[0-9]+)?$/.test(score) ? score : '';
  // 和 TVBox 一样：评分压在封面左下角的标题条里，片名居中显示在这条半透明色带上
  return `<div class="card" data-id="${escapeHtml(vod.id)}" data-site="${escapeHtml(siteKey(site))}"${si == null ? '' : ` data-si="${si}"`}>
    <div class="poster" style="${pic ? `background-image:url('${escapeHtml(pic)}')` : ''}">
      ${showSite ? `<span class="tag">${escapeHtml(site.name)}</span>` : ''}
      ${pic ? '' : '<span class="ph">暂无封面</span>'}
      <div class="pbar">
        <div class="pmeta">
          <span class="pscore">${scoreTxt ? `评分 ${escapeHtml(scoreTxt)}` : ''}</span>
          <span class="pextra">${vod.remarks ? escapeHtml(vod.remarks) : ''}</span>
        </div>
        <div class="ptitle"><span class="ptitle-t">${escapeHtml(vod.name)}</span></div>
      </div>
    </div>
  </div>`;
}

function setupCardMarquee(root) {
  $$('.ptitle', root || document).forEach((el) => {
    const t = el.querySelector('.ptitle-t');
    if (!t) return;
    el.classList.remove('marquee');
    el.style.removeProperty('--tw');
    el.style.removeProperty('--mq-dur');
    const overflow = t.scrollWidth - el.clientWidth;
    if (overflow > 4) {
      el.style.setProperty('--tw', overflow + 'px');
      el.style.setProperty('--mq-dur', Math.max(5, Math.round(t.scrollWidth / 38)) + 's');
      el.classList.add('marquee');
    }
  });
}

function bindCards(root, site, list) {
  $$('.card', root).forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.id;
      const vod = list.find((v) => v.id === id);
      if (vod) openDetail(vod, site);
    };
  });
  requestAnimationFrame(() => setupCardMarquee(root));
}

function findSiteByKey(key) {
  return S.sites.find((s) => siteKey(s) === key) || null;
}

/* ---------------- 首页 ---------------- */
let homeBusy = false;
let homeAgain = false;
let homeSec = 'update';   // 首页左栏当前选中的章节：recent / update

async function renderHome() {
  const root = $('#view-home');
  const token = ++S.renderToken;

  if (!S.sites.length) {
    root.innerHTML = `
      <div class="empty" style="padding-top:40px">
        <b>还没有加载接口</b>
        本软件是空壳播放器，需要先填入一个 TVBox 接口。<br>
        接口一般是一个 json 地址（形如 <code>https://xxx.com/api.json</code>）。
        <div class="row-flex" style="max-width:560px;margin:22px auto 0">
          <input class="input" id="quickUrl" placeholder="粘贴接口地址，例如 https://xxx.com/tvbox.json">
          <button class="btn primary" id="quickLoad">加载</button>
        </div>
        <div class="hint" style="margin-top:14px">
          支持多仓接口（自动提示选择线路）；也可以在
          <a href="#" style="color:var(--accent-2)" id="toSettings">设置</a> 里粘贴 json 文本。
        </div>
      </div>`;
    $('#quickLoad').onclick = async () => {
      const v = $('#quickUrl').value.trim();
      if (!v) return toast('请先填入接口地址', 'err');
      await quickLoad(v);
    };
    $('#quickUrl').onkeydown = (e) => { if (e.key === 'Enter') $('#quickLoad').click(); };
    $('#toSettings').onclick = (e) => { e.preventDefault(); switchView('settings'); };
    return;
  }

  const usable = S.sites.filter(isCmsSite);
  // 安卓 TVBox 首页：纵向堆叠「最近观看」「更新推荐」两段，海报整行铺满；不再有左侧切换菜单和小字统计
  root.innerHTML = `
    <div class="tv-page home-page">
      <section class="tv-content" id="homeRows">${loadingHtml('正在拉取各站点内容…')}</section>
    </div>`;

  if (homeBusy) { homeAgain = true; return; }
  homeBusy = true;

  try {
    const hist = S.history.slice(0, 12);
    const targets = usable.slice(0, 10);

    if (!targets.length) {
      const rows = $('#homeRows');
      const why = diagSummary() || '接口里没有能直接请求的 cms 站点。';
      if (rows) {
        rows.innerHTML = `<div class="empty">
          <b>当前接口没有可直连的站点</b>
          ${escapeHtml(why)}
          <div class="row-flex" style="justify-content:center;margin-top:18px">
            <button class="btn primary" id="btnDiagFromHome">接口诊断</button>
            <button class="btn" id="btnToSettings2">换个接口</button>
          </div>
        </div>`;
        const b1 = $('#btnDiagFromHome');
        const b2 = $('#btnToSettings2');
        if (b1) b1.onclick = () => diagnoseInterface();
        if (b2) b2.onclick = () => switchView('settings');
      }
      return;
    }

    // 拉取各站点首页，铺成「更新推荐」海报墙
    const results = [];

    // 各站点轮流取一条，避免整面墙都是同一个站点的片子
    const rotate = (list) => {
      const items = [];
      const seen = new Set();
      const maxLen = Math.max.apply(null, list.map((r) => r.list.length));
      for (let i = 0; i < maxLen && items.length < 60; i += 1) {
        for (const r of list) {
          const v = r.list[i];
          if (!v) continue;
          const k = v.name + '|' + siteKey(r.site);
          if (seen.has(k)) continue;
          seen.add(k);
          items.push({ vod: v, site: r.site });
          if (items.length >= 60) break;
        }
      }
      return items;
    };

    // 站点一条条回来，先把手上的铺上去，别让人对着「正在拉取」干等
    let paintTimer = null;
    const flushPaint = () => {
      paintTimer = null;
      if (S.renderToken !== token || !results.length) return;
      S.homeData = { hist, items: rotate(results), count: results.length };
      paintHomeSec();
    };

    await pool(targets, 6, async (site) => {
      const d = await fetchHome(site);
      if (d.list.length) {
        results.push({ site, list: d.list });
        if (!paintTimer) paintTimer = setTimeout(flushPaint, 400);
      }
    });
    if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
    if (S.renderToken !== token) return;

    const wrap = $('#homeRows');
    if (!wrap) return;
    wrap.querySelector('.loading')?.remove();

    if (!results.length) {
      wrap.innerHTML = `<div class="empty">
        <b>这些站点都没能返回内容</b>
        ${escapeHtml(diagSummary() || '接口地址能连上，但站点接口返回空 / 403 / 需要 Referer。')}
        <div class="row-flex" style="justify-content:center;margin-top:18px">
          <button class="btn primary" id="btnDiagFromHome">接口诊断</button>
          <button class="btn" id="btnRetryHome">重新拉取</button>
        </div>
      </div>`;
      const b1 = $('#btnDiagFromHome');
      const b2 = $('#btnRetryHome');
      if (b1) b1.onclick = () => diagnoseInterface();
      if (b2) b2.onclick = () => renderHome();
      return;
    }

    S.homeData = { hist, items: rotate(results), count: results.length };
    paintHomeSec();
  } catch (e) {
    const wrap2 = $('#homeRows');
    if (wrap2) {
      wrap2.innerHTML = `<div class="empty">
        <b>拉取内容出错</b>
        ${escapeHtml(String((e && e.message) || e))}
        <div class="row-flex" style="justify-content:center;margin-top:18px">
          <button class="btn primary" id="btnRetryHome">重新拉取</button>
        </div>
      </div>`;
      const b2 = $('#btnRetryHome');
      if (b2) b2.onclick = () => renderHome();
    }
  } finally {
    homeBusy = false;
    if (homeAgain) { homeAgain = false; renderHome(); }
  }
}

/* 首页：纵向堆叠「最近观看」「更新推荐」两段，不带计数小字 */
function paintHomeSec() {
  const wrap = $('#homeRows');
  if (!wrap || !S.homeData) return;
  const { hist, items } = S.homeData;

  const histHtml = hist.length
    ? `<div class="grid" id="histRow">${hist.map((h) => `
        <div class="card" data-hist="${escapeHtml(h.key)}">
          <div class="poster" style="${h.pic ? `background-image:url('${escapeHtml(h.pic)}')` : ''}">
            <span class="tag">${escapeHtml(h.siteName)}</span>
            <span class="badge">看到 ${formatTime(h.pos || 0)}</span>
            ${h.pic ? '' : '<span class="ph">暂无封面</span>'}
            <div class="pbar">
              <div class="pmeta"></div>
              <div class="ptitle"><span class="ptitle-t">${escapeHtml(h.vod.name)}</span></div>
            </div>
          </div>
        </div>`).join('')}</div>`
    : '';

  wrap.innerHTML = `
    ${hist.length ? `<section class="home-sec">
      <h2 class="home-sec-title">最近观看</h2>
      ${histHtml}
    </section>` : ''}
    <section class="home-sec">
      <h2 class="home-sec-title">更新推荐</h2>
      <div class="grid" id="aggGrid">${items.map((it) => cardHtml(it.vod, it.site, true)).join('')}</div>
    </section>`;

  $$('#homeRows .card').forEach((el) => {
    el.onclick = () => {
      if (el.dataset.hist) {
        const h = S.history.find((x) => x.key === el.dataset.hist);
        if (!h) return;
        const site = findSiteByKey(h.siteKey);
        if (!site) return toast('该站点已不在当前接口中', 'err');
        openDetail(h.vod, site, h);
        return;
      }
      const sk = el.dataset.site;
      const id = el.dataset.id;
      const site = findSiteByKey(sk);
      const it = (S.homeData.items || []).find((x) => x.vod.id === id && siteKey(x.site) === sk);
      if (it && site) openDetail(it.vod, site);
    };
  });
  requestAnimationFrame(() => setupCardMarquee($('#homeRows')));
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(ss).padStart(2, '0');
}

async function quickLoad(url) {
  try {
    toast('正在加载接口…');
    await loadInterface(url);
    toast('接口加载成功', 'ok');
    switchView('home');
  } catch (e) {
    toast(String(e.message || e), 'err');
  }
}

/* ---------------- 分类 ---------------- */
/* 首页「点播」按 OK / 点击后进入的页面：顶部一串分类（榜单）胶囊 + 整屏海报 */
function openVod() {
  if (!S.sites.length) { switchView('home'); toast('请先加载接口'); return; }
  if (!S.site) S.site = S.sites.find(isCmsSite) || S.sites.find(siteIsJs) || null;
  switchView('category');
}

/* 左上角品牌点开线路弹窗：列出可直连站点，选中即切换 */
function openSourcePicker() {
  const usable = S.sites.filter(isCmsSite);
  if (!usable.length) { toast('当前接口没有可直连站点', 'err'); return; }
  const cur = S.site ? siteKey(S.site) : '';
  const rows = usable.map((s) => {
    const k = siteKey(s);
    const active = k === cur;
    return `<div class="src-row ${active ? 'active' : ''}" tabindex="0" data-key="${escapeHtml(k)}">
      <span class="src-name">${escapeHtml(s.name)}</span>
      <span class="src-sub">${escapeHtml((s.api || '').replace(/^https?:\/\//, '').split('?')[0].slice(0, 40))}</span>
    </div>`;
  }).join('');
  showModal({ title: '选择线路', html: `<div class="src-list">${rows}</div>`, actions: [{ label: '取消' }] });
  $$('.src-row').forEach((el) => {
    el.onclick = () => {
      const site = findSiteByKey(el.dataset.key);
      if (!site) return;
      S.site = site;
      S.tid = '';
      S.page = 1;
      S.list = [];
      refreshBrand();
      hideModal();
      switchView('home');
    };
  });
}

/* 左上角品牌名跟随当前站点；未导入源时显示 TVBox PC */
function refreshBrand() {
  const name = S.site && S.site.name ? S.site.name : 'TVBox PC';
  const el = document.querySelector('.brand-name');
  if (el) el.textContent = escapeHtml(name);
}

async function renderCategory() {
  const root = $('#view-category');
  // 滚动接近底部自动追加下一页（无翻页条）
  root.onscroll = () => {
    if (root.scrollTop + root.clientHeight > root.scrollHeight - 220) {
      if (typeof loadNextCatPage === 'function') loadNextCatPage();
    }
  };

  if (!S.sites.length) {
    root.innerHTML = emptyHtml('还没有加载接口', '请先在「首页」或「设置」里填入接口地址');
    return;
  }

  if (!S.site) {
    const usable = S.sites.filter(isCmsSite);
    const unsupported = S.sites.length - usable.length;
    root.innerHTML = `
      <div class="page-head">
        <h1>选择站点</h1>
        <span class="sub">共 ${usable.length} 个可直连站点${unsupported ? `，${unsupported} 个 spider 站点已跳过` : ''}</span>
        <div class="spacer"></div>
        <button class="btn" id="btnBackSiteHidden" style="display:none"></button>
      </div>
      <div class="site-grid">
        ${usable.map((s) => `<div class="site-tile" data-key="${escapeHtml(siteKey(s))}">
          <div class="t-name">${escapeHtml(s.name)}</div>
          <div class="t-sub">${escapeHtml((s.api || '').replace(/^https?:\/\//, '').split('?')[0].slice(0, 48))}</div>
        </div>`).join('')}
      </div>`;
    $$('.site-tile', root).forEach((el) => {
      el.onclick = () => {
        S.site = findSiteByKey(el.dataset.key);
        S.tid = '';
        S.page = 1;
        S.list = [];
        renderCategory();
      };
    });
    return;
  }

  const site = S.site;
  // 和 TVBox 一样：这页顶部只有一行分类（榜单），下面直接整屏海报，没有大标题和站点名
  root.innerHTML = `
    <div class="cat-top">
      <div id="catTabs" class="tabs"><span class="hint">加载分类中…</span></div>
    </div>
    <div id="catList">${loadingHtml()}</div>`;

  const classes = await fetchClasses(site);
  const tabs = $('#catTabs');
  if (!tabs) return;
  tabs.innerHTML = [`<button class="tab ${S.tid === '' ? 'active' : ''}" data-tid="">全部</button>`]
    .concat(classes.map((c) => `<button class="tab ${S.tid === c.id ? 'active' : ''}" data-tid="${escapeHtml(c.id)}">${escapeHtml(c.name)}</button>`))
    .join('');
  $$('.tab', tabs).forEach((el) => {
    el.onclick = () => {
      S.tid = el.dataset.tid;
      S.page = 1;
      $$('.tab', tabs).forEach((t) => t.classList.toggle('active', t === el));
      loadCatList();
    };
  });
  layoutCatTabs();
  window.addEventListener('resize', layoutCatTabs);

  await loadCatList();
}

/* 分类胶囊：等宽排布，一屏只放得下整数颗，其余整颗藏在两侧 */
function layoutCatTabs() {
  const sc = $('#catTabs');
  if (!sc) return;
  const chips = $$('.tab', sc);
  if (!chips.length) return;
  const cs = getComputedStyle(sc);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const gap = 12;
  const avail = sc.clientWidth - padL - padR;
  const pitch = 130; // 单颗占位（宽+间距），保守取整保证一屏整数颗
  let n = Math.max(1, Math.floor((avail + gap) / pitch));
  let w = Math.floor((avail - (n - 1) * gap) / n);
  chips.forEach((c) => { c.style.width = w + 'px'; c.style.minWidth = w + 'px'; });
  alignCatTabs(sc);
}

function alignCatTabs(sc) {
  if (!sc) return;
  const chips = $$('.tab', sc);
  if (!chips.length) return;
  const focus = sc.querySelector('.tab.focus') || chips[0];
  const r = focus.getBoundingClientRect();
  const cr = sc.getBoundingClientRect();
  sc.scrollLeft += r.left - cr.left;
}
window.alignCatTabs = alignCatTabs;

async function loadCatList() {
  const root = $('#catList');
  if (!root) return;
  root.innerHTML = loadingHtml();
  S.catLoading = false;
  const d = await fetchCategory(S.site, S.tid, S.page);
  S.list = d.list;
  S.pageCount = d.pageCount || 0;
  if (!d.list.length) {
    root.innerHTML = emptyHtml('这个分类没有内容', d.msg || '换一个分类或换一个站点试试');
    return;
  }
  root.innerHTML = `<div class="grid">${d.list.map((v) => cardHtml(v, S.site)).join('')}</div>`;
  bindCards(root, S.site, d.list);
}

/* 滚动到底 / 遥控器到末卡时自动追加下一页，不再显示翻页条 */
async function loadNextCatPage() {
  if (S.catLoading) return;
  if (typeof S === 'undefined' || !S.site) return;
  if (S.pageCount && S.page >= S.pageCount) return;
  const root = $('#catList');
  const grid = root ? root.querySelector('.grid') : null;
  if (!grid) return;
  S.catLoading = true;
  S.page++;
  let d;
  try {
    d = await fetchCategory(S.site, S.tid, S.page);
  } catch (e) {
    S.page--; S.catLoading = false; return;
  }
  S.catLoading = false;
  S.pageCount = d.pageCount || S.pageCount;
  if (!d.list || !d.list.length) { S.page--; return; }
  S.list = S.list.concat(d.list);
  const wrap = document.createElement('div');
  wrap.innerHTML = d.list.map((v) => cardHtml(v, S.site)).join('');
  $$('.card', wrap).forEach((c) => grid.appendChild(c));
  bindCards(grid, S.site, d.list);
}
window.loadNextCatPage = loadNextCatPage;

/* ---------------- 搜索 ---------------- */
let searchResults = [];
let searchKeyword = '';
let searching = false;
let searchFilterSi = '-1';   // 结果页当前站点筛选：-1 = 全部

function renderSearchPage() {
  const root = $('#view-search');
  // 键盘：数字 / 字母 / 空格·删除·清空·搜索
  const rows = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M']
  ];
  const key = (k) => `<button class="osk-key" data-k="${k}">${k}</button>`;
  const oskHtml = `
    ${rows.map((r) => `<div class="osk-row">${r.map(key).join('')}</div>`).join('')}
    <div class="osk-row fn">
      <button class="osk-key wide" data-k="space">空格</button>
      <button class="osk-key wide" data-k="del">删除</button>
      <button class="osk-key wide" data-k="clear">清空</button>
      <button class="osk-key go" data-k="go">搜索</button>
    </div>`;

  const hot = hotWords();
  const hist = (S.searchHist || []).slice(0, 12);

  root.innerHTML = `
    <div class="search-entry" id="searchEntry">
      <div class="search-page">
        <div class="search-left">
          <div class="search-bar">
            <svg class="mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18.4v2.6M9 21h6"/></svg>
            <input class="search-input" id="searchInput" placeholder="关键字…">
          </div>
          <div class="suggest hidden" id="searchSuggest"></div>
          <div class="osk" id="osk">${oskHtml}</div>
        </div>
        <aside class="search-right">
          <div class="hist-block">
            <h3 class="hot-title">历史</h3>
            <div class="hot-chips" id="histChips">
              ${hist.length ? hist.map((w) => `<button class="hot-chip" data-hist="${escapeHtml(w)}">${escapeHtml(w)}</button>`).join('')
                : '<div class="hint">还没有搜索记录</div>'}
            </div>
          </div>
          <div class="hot-block">
            <h3 class="hot-title">热搜</h3>
            <div class="hot-chips" id="hotChips">
              ${hot.length ? hot.map((w) => `<button class="hot-chip" data-w="${escapeHtml(w)}">${escapeHtml(w)}</button>`).join('')
                : '<div class="hint">接口里还没有可以推荐的热词，先随便搜一个吧。</div>'}
            </div>
          </div>
        </aside>
      </div>
    </div>
    <div id="searchResult" class="search-result hidden">
      <div class="sr-head">
        <h2 class="sr-title" id="srTitle"></h2>
        <div id="searchTabs" class="tabs search-tabs"></div>
      </div>
      <div id="searchList" class="grid"></div>
    </div>`;

  const input = $('#searchInput');
  input.value = searchKeyword;
  const osk = $('#osk');
  // 屏幕键盘默认展开
  const setOsk = (open) => {
    osk.classList.toggle('hidden', !open);
    if (open) {
      const keys = $$('#osk .osk-key');
      if (keys[0] && window.kodiSetFocus) window.kodiSetFocus(keys[0]);
    } else if (osk.contains(document.activeElement)) {
      input.focus();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') go();
    else if (e.key === 'ArrowDown') setOsk(true);
  };

  const entry = $('#searchEntry');
  const result = $('#searchResult');
  const showEntry = () => { entry.classList.remove('hidden'); result.classList.add('hidden'); };
  const showResult = () => { entry.classList.add('hidden'); result.classList.remove('hidden'); };
  window.__showSearchEntry = showEntry;

  const go = () => {
    searchKeyword = input.value.trim();
    if (!searchKeyword) return;
    showResult();
    doSearch(searchKeyword);
  };
  const topBtn = $('#btnSearch');
  if (topBtn) topBtn.onclick = go;
  setTimeout(() => { input.focus(); if (window.kodiSetFocus) window.kodiSetFocus(input); }, 30);

  // 输入时给搜索建议（取当前可搜索站点的真实返回，不是本地瞎编的词）
  input.oninput = () => queueSuggest();
  window.__queueSuggest = queueSuggest;

  $$('#osk .osk-key').forEach((btn) => {
    btn.onclick = () => {
      const k = btn.dataset.k;
      if (k === 'del') input.value = input.value.slice(0, -1);
      else if (k === 'clear') input.value = '';
      else if (k === 'go') { go(); return; }
      else {
        const ch = k === 'space' ? ' ' : k.toLowerCase();
        const p = input.selectionStart == null ? input.value.length : input.selectionStart;
        input.value = input.value.slice(0, p) + ch + input.value.slice(input.selectionEnd == null ? p : input.selectionEnd);
        input.setSelectionRange(p + ch.length, p + ch.length);
      }
      if (window.__queueSuggest) window.__queueSuggest();
    };
  });

  $$('#histChips .hot-chip').forEach((el) => {
    el.onclick = () => { input.value = el.dataset.hist; go(); };
  });
  $$('#hotChips .hot-chip').forEach((el) => {
    el.onclick = () => {
      input.value = el.dataset.w;
      go();
    };
  });

  if (searchKeyword) { showResult(); doSearch(searchKeyword); }
}

/* 热搜词：优先用接口首页返回的真实片名，再补上最近看过的 / 收藏的 */
function hotWords() {
  const out = [];
  const push = (w) => {
    const t = String(w || '').trim();
    if (!t || t.length > 12) return;
    if (!out.includes(t)) out.push(t);
  };
  (S.homeData && S.homeData.items ? S.homeData.items : []).forEach((it) => push(it.vod.name));
  S.history.forEach((h) => push(h.vod && h.vod.name));
  S.favs.forEach((f) => push(f.vod && f.vod.name));
  return out.slice(0, 28);
}

/* 输入联想：debounce 后查一次当前站点，把真实片名列成可点的建议 */
let suggestTimer = 0;
let suggestToken = 0;
function queueSuggest() { clearTimeout(suggestTimer); suggestTimer = setTimeout(runSuggest, 450); }
async function runSuggest() {
  const input = $('#searchInput');
  const box = $('#searchSuggest');
  if (!input || !box) return;
  const q = input.value.trim();
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const site = S.sites.find((s) => isCmsSite(s) && Number(s.searchable) !== 0);
  if (!site) { box.classList.add('hidden'); return; }
  const tk = ++suggestToken;
  let list = [];
  try { list = await searchSite(site, q); } catch (e) {}
  if (tk !== suggestToken || !document.contains(box)) return;
  const names = [...new Set(list.map((v) => v.name).filter(Boolean))].slice(0, 8);
  if (!names.length || input.value.trim() !== q) { box.classList.add('hidden'); return; }
  box.innerHTML = names.map((n) => `<button class="sg-item" data-w="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
  box.classList.remove('hidden');
  $$('.sg-item', box).forEach((el) => {
    el.onclick = () => {
      input.value = el.dataset.w;
      box.classList.add('hidden');
      searchKeyword = input.value.trim();
      if (searchKeyword) doSearch(searchKeyword);
    };
  });
}

async function doSearch(keyword) {
  const box = $('#searchResult');
  if (!box || searching) return;
  const kw = String(keyword || '').trim();
  if (kw) {
    if (!S.settings.incognito) {
      S.searchHist = [kw, ...(S.searchHist || []).filter((x) => x !== kw)].slice(0, 20);
      store.set(K.searchHist, S.searchHist);
    }
  }
  const title = $('#srTitle');
  const tabs = $('#searchTabs');
  const list = $('#searchList');
  const entry = $('#searchEntry');
  if (entry) entry.classList.add('hidden');
  if (box) box.classList.remove('hidden');
  const sites = S.sites.filter((s) => isCmsSite(s) && Number(s.searchable) !== 0);
  if (!sites.length) {
    if (title) title.textContent = '';
    if (tabs) tabs.innerHTML = '';
    if (list) list.innerHTML = emptyHtml('当前接口没有可搜索的站点', '检查接口里的 sites 是否设置了 searchable');
    return;
  }
  searching = true;
  if (title) title.textContent = `"${kw}" 的搜索结果`;
  if (tabs) tabs.innerHTML = '';
  if (list) list.innerHTML = loadingHtml(`正在搜索「${kw}」，共 ${sites.length} 个站点…`);
  searchResults = [];
  searchFilterSi = '-1';
  const token = ++S.renderToken;

  await pool(sites, 6, async (site) => {
    const l = await searchSite(site, keyword);
    if (S.renderToken !== token) return;
    if (l.length) {
      searchResults.push({ site, list: l.slice(0, 30) });
      renderSearchWall();
      renderSearchTabs();
    }
  });

  searching = false;
  if (S.renderToken !== token) return;
  if (!searchResults.length) {
    if (tabs) tabs.innerHTML = '';
    if (list) list.innerHTML = emptyHtml(`没有找到「${kw}」`, '换个关键词，或换一个站点 / 接口');
  }
}

/* 结果墙：所有站点的卡片铺在同一个网格里，每张卡片带站点角标 */
function renderSearchWall() {
  const list = $('#searchList');
  if (!list) return;
  list.innerHTML = searchResults
    .map((r, i) => `<div class="wall-group" data-si="${i}">${r.list.map((v) => cardHtml(v, r.site, true, i)).join('')}</div>`)
    .join('');
  searchResults.forEach((r, i) => {
    const g = list.querySelector(`.wall-group[data-si="${i}"]`);
    if (g) bindCards(g, r.site, r.list);
  });
  applySearchFilter(searchFilterSi);
}

/* 结果页顶部：可切换的数据源胶囊（全部 / 各站点） */
function applySearchFilter(si) {
  searchFilterSi = si;
  $$('#searchTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.si === si));
  $$('#searchList .wall-group').forEach((g) => {
    g.style.display = (si === '-1' || g.dataset.si === si) ? '' : 'none';
  });
}
function renderSearchTabs() {
  const tabs = $('#searchTabs');
  if (!tabs) return;
  if (!searchResults.length) { tabs.innerHTML = ''; return; }
  tabs.innerHTML = [`<button class="tab" data-si="-1">全部</button>`]
    .concat(searchResults.map((r, i) => `<button class="tab" data-si="${i}">${escapeHtml(r.site.name)}</button>`)).join('');
  $$('.tab', tabs).forEach((el) => { el.onclick = () => applySearchFilter(el.dataset.si); });
  applySearchFilter(searchFilterSi);
}
window.__searchFilterSi = () => searchFilterSi;
window.__searchShowAll = () => {
  applySearchFilter('-1');
  const sc = $('#view-search');
  if (sc) sc.scrollTop = 0;
  return $('#searchTabs .tab[data-si="-1"]');
};

/* ---------------- 详情 ---------------- */
async function openDetail(vod, site, histItem) {
  const pane = $('#detailPane');
  const body = $('#detailBody');
  pane.classList.remove('hidden');
  body.innerHTML = `<div class="close-x" id="detailClose">×</div>${loadingHtml('正在获取详情…')}`;
  $('#detailClose').onclick = () => pane.classList.add('hidden');

  let full = vod;
  if (!vod.playUrl) {
    const remote = await fetchDetail(site, vod.id);
    if (remote) full = remote;
  }
  renderDetail(full, site, histItem);
}

function renderDetail(vod, site, histItem) {
  const body = $('#detailBody');
  pane_show();

  const groups = parsePlaySources(vod);
  const pic = absPic(site, vod.pic);
  const isFav = S.favs.some((f) => f.key === favKey(site, vod.id));
  const hist = S.history.find((h) => h.key === favKey(site, vod.id));
  const lastGi = hist ? hist.gi : 0;
  const lastEi = hist ? hist.ei : 0;

  // 安卓 TVBox 详情页：左边大剧照（白边），右边片名/评分/站源年份地区类型/导演演员 + 三个胶囊按钮，
  // 下面是线路行、集数行、倒序与分页行（每页 20 集）。
  const d = (S.detailState = {
    vod, site, groups,
    gi: Math.min(lastGi, Math.max(0, groups.length - 1)),
    ei: lastEi,
    descOpen: false,
    reverse: false,
    page: Math.min(Math.floor((lastEi || 0) / 20), Math.max(0, Math.ceil(((groups[Math.min(lastGi, Math.max(0, groups.length - 1))] || { episodes: [] }).episodes.length || 1) / 20) - 1))
  });

  const metaLine = [
    vod.year ? '年份：' + escapeHtml(vod.year) : '',
    vod.area ? '地区：' + escapeHtml(vod.area) : '',
    vod.typeName ? '类型：' + escapeHtml(String(vod.typeName).replace(/\s+/g, ',')) : '',
    vod.lang ? '语言：' + escapeHtml(vod.lang) : ''
  ].filter(Boolean).join('　');

  body.innerHTML = `
    <div class="close-x" id="detailClose">×</div>
    <div class="d-head">
      <div class="d-shot${pic ? '' : ' empty-shot'}"${pic ? ` style="background-image:url('${escapeHtml(pic)}')"` : ''}>
        ${pic ? '' : '<span class="shot-ph">暂无剧照</span>'}
      </div>
      <div class="d-info">
        <h2 class="d-name">${escapeHtml(vod.name)}</h2>
        ${vod.score ? `<div class="d-score">${escapeHtml(vod.score)}</div>` : ''}
        ${vod.remarks ? `<div class="d-note">${escapeHtml(vod.remarks)}</div>` : ''}
        <div class="d-line">站源：<b>${escapeHtml(site.name)}</b>　${metaLine}</div>
        ${vod.director ? `<div class="d-line">导演：${escapeHtml(vod.director)}</div>` : ''}
        ${vod.actor ? `<div class="d-line">演员：${escapeHtml(vod.actor)}</div>` : ''}
        <div class="d-actions">
          <button class="btn dbtn primary" id="btnPlayFirst">${hist ? '继续观看 ' + formatTime(hist.pos || 0) : '播放'}</button>
          <button class="btn dbtn" id="btnDesc">简介</button>
          <button class="btn dbtn" id="btnFav">${isFav ? '已收藏' : '收藏'}</button>
          <button class="btn dbtn" id="btnSwitchSrc">换源</button>
        </div>
      </div>
    </div>

    <div class="d-descbox hidden" id="descBox">${escapeHtml(vod.content || '暂无简介')}</div>

    <div id="detailGroups">
      ${groups.length ? `
        <div class="d-sec-line" id="lineChips"></div>
        <div class="d-sec-eps" id="epChips"></div>
        <div class="d-sec-page" id="epPage"></div>` : `
        <div class="hint" style="padding:16px;border:1px solid var(--line);border-radius:12px;margin-top:16px">
          该影片没有解析到播放地址（可能接口不同源 / 需要专用播放器规则）。
        </div>`}
    </div>`;

  $('#detailClose').onclick = () => $('#detailPane').classList.add('hidden');
  $('#btnDesc').onclick = () => {
    d.descOpen = !d.descOpen;
    $('#descBox').classList.toggle('hidden', !d.descOpen);
    $('#btnDesc').classList.toggle('primary', d.descOpen);
  };
  $('#btnFav').onclick = () => {
    toggleFav(site, vod);
    const on = S.favs.some((f) => f.key === favKey(site, vod.id));
    $('#btnFav').textContent = on ? '已收藏' : '收藏';
    $('#btnFav').classList.toggle('primary', on);
  };
  $('#btnSwitchSrc').onclick = () => showDetailSourcePicker();

  if (groups.length) {
    paintDetailLines();
    paintDetailEps();
  }

  $('#btnPlayFirst').onclick = () => {
    if (!groups.length) return toast('没有可播放的地址', 'err');
    if (hist && groups[hist.gi] && groups[hist.gi].episodes[hist.ei]) startPlay(groups, hist.gi, hist.ei, vod, site);
    else startPlay(groups, d.gi, 0, vod, site);
  };

  S.detail = { vod, site, groups };
}

/* 详情页：线路胶囊（TVBox 那一排「独家T / 官方① / 备用①」） */
function paintDetailLines() {
  const d = S.detailState;
  const box = $('#lineChips');
  if (!d || !box) return;
  box.innerHTML = d.groups.map((g, i) =>
    `<button class="d-chip line ${i === d.gi ? 'active' : ''}" data-g="${i}">${escapeHtml(g.from || ('线路' + (i + 1)))}</button>`).join('');
  $$('#lineChips .d-chip').forEach((el) => {
    el.onclick = () => {
      d.gi = Number(el.dataset.g);
      d.page = 0;
      paintDetailLines();
      paintDetailEps();
    };
  });
}

/* 详情页：集数胶囊 + 倒序 / 翻页 / 每页 20 集 */
function paintDetailEps() {
  const d = S.detailState;
  const chips = $('#epChips');
  const pageBox = $('#epPage');
  if (!d || !chips || !pageBox) return;
  const eps = (d.groups[d.gi] || { episodes: [] }).episodes || [];
  const total = eps.length;
  const per = 20;
  const pages = Math.max(1, Math.ceil(total / per));
  if (d.page >= pages) d.page = pages - 1;
  const start = d.page * per;
  const slice = eps.slice(start, start + per);
  const list = d.reverse ? slice.slice().reverse() : slice;

  chips.innerHTML = list.map((ep, k) => {
    const idx = d.reverse ? start + (slice.length - 1 - k) : start + k;
    const active = (d.gi === (S.detailState.lastGi || 0)) && idx === d.ei;
    return `<button class="d-chip ep${active ? ' active' : ''}" data-e="${idx}">${escapeHtml(ep.name)}</button>`;
  }).join('') || '<div class="hint">这条线路没有集数信息</div>';

  $$('#epChips .d-chip').forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.e);
      d.ei = i;
      startPlay(d.groups, d.gi, i, d.vod, d.site);
    };
  });

  const rangeBtns = [];
  for (let p = 0; p < pages; p += 1) {
    const a = p * per + 1;
    const b = Math.min(total, (p + 1) * per);
    rangeBtns.push(`<button class="d-chip range${p === d.page ? ' active' : ''}" data-p="${p}">${a}-${b}</button>`);
  }
  pageBox.innerHTML = `
    <button class="d-chip tool${d.reverse ? ' active' : ''}" id="btnReverse">倒序</button>
    <button class="d-chip tool" id="btnPagePrev">→</button>
    ${rangeBtns.join('')}`;
  $('#btnReverse').onclick = () => { d.reverse = !d.reverse; paintDetailEps(); };
  $('#btnPagePrev').onclick = () => {
    d.page = (d.page + 1) % pages;
    paintDetailEps();
  };
  $$('#epPage .range').forEach((el) => {
    el.onclick = () => { d.page = Number(el.dataset.p); paintDetailEps(); };
  });
}

/* 详情页「换源」：列出同一部片子在当前接口下的其他线路 */
function showDetailSourcePicker() {
  const d = S.detailState;
  if (!d) return;
  if (!d.groups.length) return toast('没有可切换的线路', 'err');
  const rows = d.groups.map((g, i) => `
    <div class="src-row ${i === d.gi ? 'on' : ''}" data-g="${i}">
      <div class="src-main"><div class="src-name">${escapeHtml(g.from || ('线路' + (i + 1)))}</div>
        <div class="src-sub">${g.episodes.length} 集${i === d.gi ? ' · 正在看' : ''}</div></div>
    </div>`).join('');
  showModal({
    title: '换源（共 ' + d.groups.length + ' 条线路）',
    wide: true,
    html: `<div class="src-list">${rows}</div>`,
    actions: [{ label: '关闭' }]
  });
  $$('.src-list .src-row').forEach((el) => {
    el.onclick = () => {
      d.gi = Number(el.dataset.g);
      d.page = 0;
      d.ei = 0;
      hideModal();
      paintDetailLines();
      paintDetailEps();
      toast('已切换到 ' + (d.groups[d.gi].from || '该线路'));
    };
  });
}

function pane_show() {
  $('#detailPane').classList.remove('hidden');
}

function favKey(site, id) {
  return siteKey(site) + '::' + id;
}

function toggleFav(site, vod) {
  const key = favKey(site, vod.id);
  const idx = S.favs.findIndex((f) => f.key === key);
  if (idx >= 0) {
    S.favs.splice(idx, 1);
    toast('已取消收藏');
  } else {
    S.favs.unshift({
      key,
      siteKey: siteKey(site),
      siteName: site.name,
      vod: { id: vod.id, name: vod.name, pic: absPic(site, vod.pic), year: vod.year, remarks: vod.remarks },
      time: Date.now()
    });
    S.favs = S.favs.slice(0, 200);
    toast('已加入收藏', 'ok');
  }
  store.set(K.fav, S.favs);
}

/* ---------------- 播放器 ---------------- */
let hls = null;
let pendingSeek = 0;
let pressTimer = 0;
let pressActive = false;
let prevRate = 1;
let saveTimer = 0;

function startPlay(groups, gi, ei, vod, site) {
  const group = groups[gi];
  if (!group) return;
  const ep = group.episodes[ei];
  if (!ep) return;

  S.play = { mode: 'vod', groups, gi, ei, vod, site };
  $('#playerPane').classList.remove('hidden');
  $('#detailPane').classList.add('hidden');
  $('#playerTitle').textContent = `${vod.name} · ${group.from} · ${ep.name}`;
  const sub = $('#playerSub');
  if (sub) sub.textContent = [vod.year, vod.area, vod.typeName, site && site.name].filter(Boolean).join(' · ');
  pNav.mode = 'video';
  pNav.idx = 0;
  playerClearFocus();
  playerShowBars();
  $('#epPanel').classList.add('hidden');

  const hist = S.history.find((h) => h.key === favKey(site, vod.id) && h.gi === gi && h.ei === ei);
  pendingSeek = hist ? hist.pos || 0 : 0;

  resolveAndPlay(ep.url, vod, site);
  renderEpPanel();
  $('#video').focus();
}

async function resolveAndPlay(rawUrl, vod, site) {
  const msg = $('#playerMsg');
  msg.classList.add('hidden');

  if (isDirectMedia(rawUrl)) {
    playUrl(rawUrl);
    return;
  }

  // 网页地址：先自己从网页里找播放地址（分享页/播放页），再走接口给的解析规则
  msg.classList.remove('hidden');
  // JS 规则站：先问规则自己（playerContent），这是它们最可靠的出流方式
  if (site && siteIsJs(site)) {
    msg.innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:-3px;margin-right:8px"></span>正在用 JS 规则解析这个播放地址…';
    try {
      const p = await window.jsSpider.player(site, (vod && vod.flag) || '', rawUrl);
      const u = p && (p.url || p.playUrl);
      if (p && (!p.parse || p.parse === 0) && typeof u === 'string' && u) {
        msg.classList.add('hidden');
        playUrl(u, p.header ? { Referer: p.header } : undefined);
        return;
      }
    } catch (e) {}
  }
  msg.innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:-3px;margin-right:8px"></span>正在从网页里找播放地址…';
  const found = await resolvePlaySource(rawUrl);
  if (found) {
    msg.classList.add('hidden');
    S.autoReferer = originOf(found);
    playUrl(found);
    return;
  }

  msg.innerHTML = '<span class="spinner" style="display:inline-block;vertical-align:-3px;margin-right:8px"></span>该地址需要解析，正在尝试解析接口…';
  const media = await tryParse(rawUrl);
  if (media) {
    msg.classList.add('hidden');
    playUrl(media);
    return;
  }
  msg.innerHTML = `这个地址既不是直接的视频/直播流，也不是能自动读出播放地址的网页（接口给的解析规则也没解析出来）。<br>
    常见原因：分享页需要登录/会员才能出流、页面靠 JS 动态出流、或者解析接口已失效。<br>
    <b>${escapeHtml(rawUrl.slice(0, 80))}</b><br>
    <button class="btn" id="btnOpenWeb" style="margin-top:12px">用系统浏览器打开</button>`;
  $('#btnOpenWeb').onclick = () => window.tvbox.openExternal(rawUrl);
}

async function playUrl(url, hdrs) {
  const video = $('#video');
  destroyHls();
  video.pause();
  video.removeAttribute('src');
  video.load();

  // 频道自带的 Referer / UA 优先，其次是分享页抠流时记下的 Referer
  const ref = (hdrs && hdrs.referer) || S.autoReferer || '';
  const ua = (hdrs && hdrs.ua) || '';
  if (ref || ua) {
    window.tvbox.setIdentity(ua || S.settings.ua || '', ref || S.settings.referer || '').catch(() => {});
  }

  let isM3u8 = /\.m3u8(\?|#|$)/i.test(url) || /m3u8/i.test(url);
  const looksLikeVideoFile = /\.(mp4|flv|mkv|ts|avi|mov|webm|mp3|aac)(\?|#|$)/i.test(url);
  // 很多直播地址没有 .m3u8 后缀（live.php?id=… 之类），先取开头几十字节看看是不是 HLS 清单
  if (!isM3u8 && !looksLikeVideoFile) {
    try {
      const r = await window.tvbox.httpGet({
        url,
        headers: Object.assign({ Range: 'bytes=0-400' }, ref ? { Referer: ref } : {}, ua ? { 'User-Agent': ua } : {})
      });
      const head = String((r && r.text) || '').slice(0, 200);
      if (/^\uFEFF?\s*#EXTM3U/i.test(head) || /#EXT-X-(STREAM-INF|TARGETDURATION)/i.test(head)) isM3u8 = true;
      else if (r && !r.ok && (r.status === 403 || r.status === 401)) {
        showPlayerError(`直播地址需要鉴权（HTTP ${r.status}），这类频道通常只能在原 App / 浏览器里看`, url);
        return;
      }
    } catch (e) { /* 探不到就按直链播 */ }
  }

  if (isM3u8 && window.Hls && window.Hls.isSupported()) {
    window.__lastPlayMode = 'hls';
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: bufferSeconds(),
      manifestLoadingTimeOut: 25000,
      manifestLoadingMaxRetry: 3,
      fragLoadingTimeOut: 40000
    });
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data || !data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        if (data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut') {
          showPlayerError('视频地址加载失败（可能已失效或被源站限制）', url);
        } else {
          try { hls.startLoad(); } catch (e) {}
        }
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch (e) {}
      } else {
        showPlayerError('播放器错误：' + (data.details || data.type), url);
      }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else {
    window.__lastPlayMode = 'native';
    video.src = url;
  }

  video.volume = Number(S.settings.volume || 0.8);
  video.play().catch(() => {});

  video.onloadedmetadata = () => {
    if (pendingSeek > 3) {
      try { video.currentTime = pendingSeek; } catch (e) {}
      toast('已跳转到上次观看位置 ' + formatTime(pendingSeek));
    }
    pendingSeek = 0;
  };

  $('#playerMsg').classList.add('hidden');
}

function showPlayerError(text, url) {
  const msg = $('#playerMsg');
  msg.classList.remove('hidden');
  msg.innerHTML = `${escapeHtml(text)}<br><span class="hint" style="word-break:break-all">${escapeHtml(String(url).slice(0, 120))}</span>
    <div style="margin-top:12px">
      <button class="btn" id="btnReparse">换个解析试试</button>
    </div>`;
  $('#btnReparse').onclick = async () => {
    const page = await resolvePlaySource(url);
    if (page) { S.autoReferer = originOf(page); playUrl(page); return; }
    const media = await tryParse(url);
    if (media) playUrl(media);
    else toast('解析失败', 'err');
  };
}

function destroyHls() {
  if (hls) {
    try { hls.destroy(); } catch (e) {}
    hls = null;
  }
}

function closePlayer() {
  const video = $('#video');
  try { video.pause(); } catch (e) {}
  destroyHls();
  video.removeAttribute('src');
  video.load();
  $('#playerPane').classList.add('hidden');
  playerSetEpOpen(false);
  pNav.mode = 'video';
  playerClearFocus();
  clearTimeout(playerHideTimer);
  clearTimeout(pressTimer);
  pressActive = false;
  prevRate = 1;
  try { video.playbackRate = 1; } catch (e) {}
  S.play = null;
  S.autoReferer = '';
  // 播放完把 Referer 换回设置里的值，别影响后续接口请求
  window.tvbox.setIdentity(S.settings.ua || '', S.settings.referer || '').catch(() => {});
  if (S.detail) pane_show();
}

function livePanelMark() {
  const panel = $('#epPanel');
  const p = S.play;
  if (!panel || !p || p.mode !== 'live') return;
  pNav.mode = 'live';
  if (pNav.col == null) pNav.col = 'ch';
  const gi = pNav.gi == null ? (p.gi || 0) : pNav.gi;
  const ci = pNav.idx == null ? p.ci : pNav.idx;
  $$('.lv-grp', panel).forEach((el, i) => {
    el.classList.toggle('focus', pNav.col === 'grp' && i === gi);
    if (pNav.col === 'grp' && i === gi && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  });
  $$('.ch-item', panel).forEach((el, i) => {
    el.classList.toggle('focus', pNav.col !== 'grp' && i === ci);
    if (pNav.col !== 'grp' && i === ci && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  });
}

function renderEpPanel() {
  const panel = $('#epPanel');
  const p = S.play;
  if (!p) return;
  if (p.mode === 'live') {
    panel.classList.add('live');
    const groups = (S.liveData && S.liveData.groups) || [{ name: p.groupName || '频道', channels: p.channels }];
    panel.innerHTML = `
      <div class="lv-groups">${groups.map((g, gi) => `<div class="lv-grp ${gi === (p.gi || 0) ? 'active' : ''}" data-g="${gi}">${escapeHtml(g.name)}</div>`).join('')}</div>
      <div class="lv-channels"><h4>${escapeHtml(p.groupName || '')}</h4>
        ${p.channels.map((c, i) => `<div class="ch-item ${i === p.ci ? 'active' : ''}" data-i="${i}"><span class="idx">${String(i + 1).padStart(3, '0')}</span><span class="nm">${escapeHtml(c.name)}</span></div>`).join('')}</div>`;
    $$('.lv-grp', panel).forEach((el) => {
      el.onclick = () => {
        const g = groups[Number(el.dataset.g)];
        if (g && g.channels && g.channels.length) playLiveChannel(g.channels, 0, g.name, p.sourceName);
      };
    });
    $$('.ch-item', panel).forEach((el) => {
      el.onclick = () => playLiveChannel(p.channels, Number(el.dataset.i), p.groupName, p.sourceName);
    });
    const cur = panel.querySelector('.ch-item.active');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
    return;
  }
  panel.classList.remove('live');
  panel.innerHTML = `<h4>选集 · ${escapeHtml(p.groups[p.gi].from)}</h4>
    <div class="eps">${p.groups[p.gi].episodes.map((ep, i) =>
      `<button class="ep ${i === p.ei ? 'active' : ''}" data-e="${i}">${escapeHtml(ep.name)}</button>`).join('')}</div>`;
  $$('.ep', panel).forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.e);
      startPlay(p.groups, p.gi, i, p.vod, p.site);
      $('#playerPane').classList.remove('hidden');
    };
  });
}

function nextEpisode() {
  const p = S.play;
  if (!p || p.mode !== 'vod') return false;
  const eps = p.groups[p.gi].episodes;
  if (p.ei + 1 < eps.length) {
    startPlay(p.groups, p.gi, p.ei + 1, p.vod, p.site);
    return true;
  }
  return false;
}

/* ---------- 播放器控制条（进度 / 一排功能键，遥控器操作） ---------- */
const pNav = { mode: 'video', idx: 0 };
let playerHideTimer = 0;

function playerShowBars() {
  const top = $('#playerTop');
  const bottom = $('#playerBottom');
  if (top) top.classList.remove('faded');
  if (bottom) bottom.classList.remove('faded');
  clearTimeout(playerHideTimer);
  playerHideTimer = setTimeout(playerHideBars, 4000);
  playerUpdateBar();
  playerSyncPlayBtn();
}

function playerHideBars() {
  // 选集面板 / 报错框开着时不藏，免得按钮点不到
  if (!$('#epPanel').classList.contains('hidden')) return;
  if (!$('#playerMsg').classList.contains('hidden')) return;
  if (pNav.mode !== 'video') return;
  const top = $('#playerTop');
  const bottom = $('#playerBottom');
  if (top) top.classList.add('faded');
  if (bottom) bottom.classList.add('faded');
}

function playerUpdateBar() {
  const v = $('#video');
  if (!v) return;
  const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  const cur = v.currentTime || 0;
  const pct = dur ? (cur / dur) * 100 : 0;
  const fill = $('#pbFill');
  const dot = $('#pbDot');
  const buf = $('#pbBuf');
  if (fill) fill.style.width = pct + '%';
  if (dot) dot.style.left = pct + '%';
  if (buf) {
    let b = 0;
    try {
      if (v.buffered && v.buffered.length) b = (v.buffered.end(v.buffered.length - 1) / (dur || v.buffered.end(v.buffered.length - 1))) * 100;
    } catch (e) { b = 0; }
    buf.style.width = b + '%';
  }
  const curEl = $('#pbCur');
  const durEl = $('#pbDur');
  if (curEl) curEl.textContent = formatTime(cur);
  if (durEl) durEl.textContent = dur ? formatTime(dur) : '直播';
}

function playerSyncPlayBtn() {
  const v = $('#video');
  const btn = $('#btnPlayPause');
  if (btn && v) btn.textContent = v.paused ? '播放' : '暂停';
  const p = S.play;
  const isVod = !!(p && p.mode === 'vod');
  const prev = $('#btnPrevEp');
  const next = $('#btnNextEp');
  if (prev) prev.disabled = !isVod || p.ei <= 0;
  if (next) next.disabled = !isVod || p.ei >= p.groups[p.gi].episodes.length - 1;
}

function playerBtns() {
  return $$('#playerBottom .pb-btns .pbtn').filter((el) => !el.disabled);
}

function playerSetEpOpen(open) {
  $('#epPanel').classList.toggle('hidden', !open);
  const shell = $('.player-shell');
  if (shell) shell.classList.toggle('ep-open', !!open);
  if (!open) {
    pNav.mode = 'video';
    playerClearFocus();
  }
}

function playerClearFocus() {
  $$('#playerPane .pbtn').forEach((el) => el.classList.remove('focus'));
  $$('#epPanel .ep').forEach((el) => el.classList.remove('focus'));
}

function playerFocusBtn(i) {
  const list = playerBtns();
  if (!list.length) return;
  pNav.mode = 'btns';
  pNav.idx = Math.max(0, Math.min(list.length - 1, i));
  playerClearFocus();
  list[pNav.idx].classList.add('focus');
  playerShowBars();
}

function playerFocusEp(i) {
  const eps = $$('#epPanel .ep');
  if (!eps.length) return;
  pNav.mode = 'eps';
  pNav.idx = Math.max(0, Math.min(eps.length - 1, i));
  playerClearFocus();
  eps[pNav.idx].classList.add('focus');
  eps[pNav.idx].scrollIntoView({ block: 'nearest' });
}

/* 播放进度记录 */
function saveProgress(force) {
  const p = S.play;
  const video = $('#video');
  if (!p || p.mode !== 'vod' || !video || !video.duration) return;
  if (S.settings.incognito) return;   // 无痕模式：不记录观看历史
  const now = Date.now();
  if (!force && now - saveTimer < 5000) return;
  saveTimer = now;

  const key = favKey(p.site, p.vod.id);
  const pos = video.currentTime || 0;
  const item = {
    key,
    siteKey: siteKey(p.site),
    siteName: p.site.name,
    vod: { id: p.vod.id, name: p.vod.name, pic: absPic(p.site, p.vod.pic), year: p.vod.year, remarks: p.vod.remarks },
    gi: p.gi,
    ei: p.ei,
    pos: pos > video.duration - 8 ? 0 : pos,
    dur: video.duration,
    time: now
  };
  S.history = S.history.filter((h) => h.key !== key);
  S.history.unshift(item);
  S.history = S.history.slice(0, 60);
  store.set(K.hist, S.history);
}

/* ---------------- 直播 ---------------- */
let liveSelGroup = 0;

async function renderLive(keepSourceIdx, tries) {
  const root = $('#view-live');
  if (!S.lives.length) {
    root.innerHTML = emptyHtml('当前接口没有直播源', '接口 json 里的 lives 字段为空；也可以到「设置」换一个带直播的接口');
    return;
  }
  // 默认落在上次解析出过频道的源上，没有就从头来
  const okIdx = S.lives.findIndex((l) => S.liveOk.includes(l.url));
  const idx = Number.isInteger(keepSourceIdx) ? keepSourceIdx : (okIdx >= 0 ? okIdx : 0);
  const source = S.lives[idx] || S.lives[0];
  const attempt = Number(tries) || 0;
  liveSelGroup = 0;
  root.innerHTML = `
    <div class="page-head">
      <h1>直播</h1>
      <span class="sub" id="liveSrcLine"></span>
      <div class="spacer"></div>
      ${S.lives.length > 1 || S.liveExtra ? '<button class="btn" id="btnLiveSrc">切换直播源</button>' : ''}
      <button class="btn" id="btnLiveRefresh">刷新频道</button>
    </div>
    <div class="live-layout">
      <aside class="live-groups" id="liveGroups">${loadingHtml('加载分组…')}</aside>
      <section class="live-main">
        <div class="live-main-head">
          <h3 id="liveGroupName">频道</h3>
          <span class="hint" id="liveGroupHint"></span>
        </div>
        <div id="liveSide"><div class="live-empty">正在解析直播源…</div></div>
      </section>
    </div>`;

  const srcLine = $('#liveSrcLine');
  if (srcLine) srcLine.textContent = `当前源：${source.name}${source._from ? '（清单里带出来的）' : ''}`;
  const btnSrc = $('#btnLiveSrc');
  if (btnSrc) btnSrc.onclick = () => showLiveSourcePicker(idx);
  const btnRefresh = $('#btnLiveRefresh');
  if (btnRefresh) btnRefresh.onclick = () => { toast('正在重新解析直播源…'); renderLive(idx); };

  const data = await loadLiveSource(source);
  if (!data) {
    if (attempt < 3 && S.lives.length > 1) return renderLive((idx + 1) % S.lives.length, attempt + 1);
    return;
  }
  S.liveData = data;

  if (!data.groups.length) {
    // 这个源没频道就自动往后换一个，别让用户自己去猜哪个能用
    if (attempt < 3 && S.lives.length > 1) {
      toast(`「${source.name}」没解析出频道，自动换下一个直播源…`);
      return renderLive((idx + 1) % S.lives.length, attempt + 1);
    }
    const groups = $('#liveGroups');
    const side = $('#liveSide');
    if (groups) groups.innerHTML = emptyHtml('没有分组', data.hint || '');
    if (side) side.innerHTML = `<div class="live-empty">
      <b>这个直播源没解析出频道</b>
      ${escapeHtml(data.hint || '可能是地址失效、需要 Referer，或者格式不是 m3u / TVBox txt')}
      <div class="row-flex" style="justify-content:center;margin-top:16px">
        <button class="btn primary" id="btnLiveNext">换下一个源试试</button>
      </div>
    </div>`;
    const b = $('#btnLiveNext');
    if (b) b.onclick = () => renderLive((idx + 1) % S.lives.length, attempt + 1);
    return;
  }
  // 整个源全是 RTMP / 私有协议（桌面播不了）也算不可用，继续往后换
  const playable = data.groups.reduce((a, g) => a + (g.channels || []).filter((c) => (c.urls || []).some((u) => !liveUrlUnplayable(u))).length, 0);
  if (!playable && attempt < 3 && S.lives.length > 1) {
    toast(`「${source.name}」里的频道都是 RTMP，桌面版播不了，自动换下一个直播源…`);
    return renderLive((idx + 1) % S.lives.length, attempt + 1);
  }
  paintLiveGroups(data, source, idx);
  paintLiveChannels(data, source, idx);
  markLiveOk(source);
  // 和安卓 TVBox 一样：进直播直接开播当前分组第一个能播的频道，左侧浮出分组/频道菜单
  const g0 = data.groups[liveSelGroup] || data.groups[0];
  if (g0 && g0.channels && g0.channels.length) {
    let ci0 = g0.channels.findIndex((c) => !liveUrlUnplayable((c.urls || [])[0]));
    if (ci0 < 0) ci0 = 0;
    playLiveChannel(g0.channels, ci0, g0.name, source.name);
  }
  // 进直播页先把焦点放到左侧分组，遥控器一进来就能上下切分组
  setTimeout(() => {
    const g = document.querySelector('#liveGroups .grp-item.active');
    if (g && window.kodiSetFocus) window.kodiSetFocus(g);
  }, 120);
}

/* 直播源能用不能用：解析出频道就记下来，下次「切换直播源」排在最前 */
function markLiveOk(source) {
  if (!source || !source.url) return;
  if (!S.liveOk.includes(source.url)) {
    S.liveOk.unshift(source.url);
    S.liveOk = S.liveOk.slice(0, 200);
    store.set(K.liveOk, S.liveOk);
  }
}

/* 次级菜单：切换直播源（只把能用的排前面，其余折叠在下面，可搜索） */
function showLiveSourcePicker(curIdx) {
  const ok = (l) => S.liveOk.includes(l.url);
  const all = S.lives.map((l, i) => ({ l, i }));
  const usable = all.filter((x) => ok(x.l));
  const rest = all.filter((x) => !ok(x.l));
  const row = ({ l, i }) => `
    <button class="src-row" data-i="${i}">
      <span class="src-name">${escapeHtml(l.name)}</span>
      <span class="src-tag ${i === curIdx ? 'now' : (ok(l) ? 'ok' : '')}">${i === curIdx ? '正在看' : (ok(l) ? '可用' : '未验证')}</span>
    </button>`;
  const bodyHtml = `
    ${usable.length ? `<div class="src-sec">用过能出频道的（${usable.length}）</div>${usable.map(row).join('')}` : ''}
    ${rest.length ? `<div class="src-sec">其余 ${rest.length} 个 · 点一下即尝试解析</div>${rest.map(row).join('')}` : ''}`;
  showModal({
    title: `切换直播源 · 共 ${S.lives.length} 个`,
    html: `<div class="src-picker">
      <input class="input" id="srcFilter" placeholder="输入关键字筛选直播源" />
      <div class="src-list" id="srcList">${bodyHtml}</div>
    </div>`,
    wide: true,
    actions: [{ label: '关闭' }]
  });

  const list = $('#srcList');
  const filter = $('#srcFilter');
  const bindRows = () => {
    $$('#srcList .src-row').forEach((el) => {
      el.onclick = () => { hideModal(); renderLive(Number(el.dataset.i)); };
    });
    const first = list.querySelector('.src-row');
    if (first && window.kodiSetFocus) window.kodiSetFocus(first);
  };
  const paint = (kw) => {
    const q = String(kw || '').trim().toLowerCase();
    if (!q) { list.innerHTML = bodyHtml; }
    else {
      const hit = all.filter((x) => String(x.l.name).toLowerCase().includes(q) || String(x.l.url || '').toLowerCase().includes(q));
      list.innerHTML = hit.length ? hit.map(row).join('') : '<div class="src-empty">没有匹配的直播源</div>';
    }
    bindRows();
  };
  bindRows();
  if (filter) filter.oninput = () => paint(filter.value);
}

/* 左侧分组栏 */
function paintLiveGroups(data, source, idx) {
  const box = $('#liveGroups');
  if (!box) return;
  const total = data.groups.reduce((n, g) => n + g.channels.length, 0);
  box.innerHTML = `<h4>${escapeHtml(source.name)} · ${total} 个频道</h4>` +
    data.groups.map((g, gi) => `<div class="grp-item ${gi === liveSelGroup ? 'active' : ''}" data-g="${gi}">
      <span>${escapeHtml(g.name)}</span><span class="n">${g.channels.length}</span>
    </div>`).join('');
  $$('.grp-item', box).forEach((el) => {
    el.onclick = () => {
      liveSelGroup = Number(el.dataset.g);
      $$('.grp-item', box).forEach((x) => x.classList.toggle('active', x === el));
      paintLiveChannels(data, source, idx);
    };
  });
}

/* 右侧频道墙（编号 + 名称，和电视上那列频道号一样） */
function paintLiveChannels(data, source, idx) {
  const box = $('#liveSide');
  const g = data.groups[liveSelGroup];
  if (!box || !g) return;
  const nameEl = $('#liveGroupName');
  const hintEl = $('#liveGroupHint');
  if (nameEl) nameEl.textContent = g.name;
  if (hintEl) hintEl.textContent = `${g.channels.length} 个频道 · Enter 播放`;
  box.innerHTML = g.channels.map((c, ci) => {
    const bad = liveUrlUnplayable((c.urls || [])[0]);
    const alt = bad && (c.urls || []).some((u) => !liveUrlUnplayable(u));
    return `<div class="ch-item" data-g="${liveSelGroup}" data-c="${ci}">
    <span class="idx">${String(ci + 1).padStart(3, '0')}</span><span class="nm">${escapeHtml(c.name)}</span>
    ${bad && !alt ? '<span class="ch-tag">RTMP</span>' : ''}
  </div>`;
  }).join('');
  $$('.ch-item', box).forEach((el) => {
    el.onclick = () => {
      $$('.ch-item', box).forEach((x) => x.classList.toggle('active', x === el));
      playLiveChannel(g.channels, Number(el.dataset.c), g.name, source.name);
    };
  });
}

async function loadLiveSource(source, depth) {
  const d = Number(depth || 0);
  const r = await getText(source.url);
  if (!r.ok || !r.text) {
    const root = $('#liveSide');
    if (root) root.innerHTML = emptyHtml('直播源加载失败', r.error || ('HTTP ' + r.status));
    return null;
  }
  const parsed = parseLiveText(r.text);
  // 「多条直播源」清单：把里面的地址收进左侧标签，然后加载第一条
  if (parsed.multi && parsed.multi.length) {
    if (d > 0) return { groups: [], hint: '这是个「清单套清单」的地址，里面的条目还是清单' };
    let added = 0;
    parsed.multi.forEach((m) => {
      if (S.lives.some((l) => l.url === m.url)) return;
      S.lives.push({ name: m.name + '（' + source.name + '）', url: m.url, type: 0, _from: source.name });
      added += 1;
    });
    const target = S.lives.findIndex((l) => l.url === parsed.multi[0].url);
    if (added) {
      toast(`这个地址是直播源清单，已加入 ${added} 条，正在加载第一条`, 'ok');
      renderLive(target >= 0 ? target : 0);
      return null;
    }
    return loadLiveSource(S.lives[target >= 0 ? target : 0], d + 1);
  }
  return parsed;
}

/* m3u / TVBox txt 直播源解析，尽量容忍各家写法 */
function parseLiveText(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const t = raw.trim();
  if (!t) return { groups: [], hint: '文件是空的' };

  // JSON：多仓直播清单 {"urls":[{"name","url"}]}、{"lives":[...]}、或 {"groups":{...}}
  if (t[0] === '{' || t[0] === '[') {
    let json = null;
    try { json = parseJsonLoose(t); } catch (e) {}
    if (json && Array.isArray(json.urls) && json.urls.length) {
      const multi = json.urls.map((x) => ({
        name: String(pick(x, 'name', 'title') || '直播源'),
        url: String(pick(x, 'url') || '')
      })).filter((x) => /^https?:/i.test(x.url));
      if (multi.length) return { groups: [], multi };
    }
    if (json && Array.isArray(json.lives) && json.lives.length) {
      const multi = json.lives.map((x) => ({
        name: String(pick(x, 'name', 'title') || '直播源'),
        url: String(pick(x, 'url') || '')
      })).filter((x) => /^https?:/i.test(x.url));
      if (multi.length) return { groups: [], multi };
    }
    return { groups: [], hint: '这个地址返回的是 JSON，不是 m3u / txt；如果它放了多个直播源，试试用里面的单条 .txt 地址' };
  }

  const isM3u = /^#EXTM3U/i.test(t) || /^#EXTINF/i.test(t);
  if (isM3u) return parseM3uLive(t);

  // TVBox txt：分组名,#genre#  /  频道名,url1#url2
  const groups = [];
  let cur = null;
  for (const line of t.split('\n')) {
    const s = line.trim().replace(/，/g, ',');
    if (!s || s.startsWith('//') || (s.startsWith('#') && !/#genre#/i.test(s))) continue;
    const parts = s.split(',');
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    const rest = parts.slice(1).join(',').trim();
    if (/^#genre#$/i.test(rest)) {
      cur = { name: name || '未分组', channels: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) { cur = { name: '未分组', channels: [] }; groups.push(cur); }
    const urls = rest.split('#').map((x) => x.trim()).filter((x) => /^(http|rtmp|rtsp|https):/i.test(x));
    if (!urls.length) continue;
    cur.channels.push({ name: name || '未命名频道', urls });
  }
  const out = { groups: groups.filter((g) => g.channels.length) };
  if (!out.groups.length) {
    out.hint = '这个文件既不像 m3u，也没有「名称,地址」的行；如果是 JSON 多仓，请填里面某一条 txt 的地址';
  }
  return out;
}

function parseM3uLive(t) {
  const groups = [];
  let pendingName = '';
  let pendingOpts = null;
  let extGrp = '';
  let lastChannel = null;

  const push = (url, opts) => {
    const gname = (opts && opts.group) || extGrp || '未分组';
    let g = groups.find((x) => x.name === gname);
    if (!g) { g = { name: gname, channels: [] }; groups.push(g); }
    const urls = url.split('#').map((x) => x.trim()).filter((x) => /^(http|rtmp|rtsp):/i.test(x));
    if (!urls.length) return;
    // 连续两行 URL 且没有新的 #EXTINF：当成同一频道的备用地址
    if (!pendingName && lastChannel && lastChannel === g.channels[g.channels.length - 1]) {
      urls.forEach((u) => { if (!lastChannel.urls.includes(u)) lastChannel.urls.push(u); });
      return;
    }
    const ch = {
      name: pendingName || '未命名频道',
      urls,
      referer: (pendingOpts && pendingOpts.referer) || '',
      ua: (pendingOpts && pendingOpts.ua) || ''
    };
    g.channels.push(ch);
    lastChannel = ch;
    pendingName = '';
    pendingOpts = null;
  };

  for (const line of t.split('\n')) {
    const s = line.trim();
    if (!s) continue;

    if (/^#EXTINF/i.test(s)) {
      const tvName = (s.match(/tvg-name="([^"]*)"/i) || [])[1] || '';
      const tvId = (s.match(/tvg-id="([^"]*)"/i) || [])[1] || '';
      const afterComma = s.includes(',') ? s.slice(s.lastIndexOf(',') + 1).trim() : '';
      pendingName = (tvName || afterComma || tvId || '').split('|')[0].trim();
      const gm = s.match(/group-title="([^"]*)"/i);
      pendingOpts = { group: gm ? gm[1] : '' };
      lastChannel = null;
      continue;
    }
    if (/^#EXTGRP:/i.test(s)) { extGrp = s.split(':')[1].trim(); continue; }
    if (/^#EXTVLCOPT/i.test(s)) {
      const ref = s.match(/http-referrer=([^\s]+)/i) || s.match(/http-referer=([^\s]+)/i);
      const ua = s.match(/http-user-agent=([^\s]+)/i);
      if (pendingOpts) {
        if (ref) pendingOpts.referer = ref[1];
        if (ua) pendingOpts.ua = ua[1];
      }
      continue;
    }
    if (s.startsWith('#')) continue;

    push(s, pendingOpts);
  }

  const out = { groups: groups.filter((g) => g.channels.length) };
  if (!out.groups.length) out.hint = '这是 m3u 文件，但没有解析出频道地址（可能只有注释行或地址被加密）';
  return out;
}


/* 桌面播放器（Chromium）只吃 http(s) 的 m3u8 / flv / mp4；RTMP、私有协议播不了 */
function liveUrlUnplayable(u) {
  return /^(rtmp|rtmps|rtsp|rtp|udp|p2p|mitv|rtp2|rtmp2|tvbus|force):/i.test(String(u || '').trim());
}

function playLiveChannel(channels, ci, groupName, sourceName) {
  const ch = channels[ci];
  if (!ch) return;
  let url = (ch.urls || [])[0] || '';
  if (liveUrlUnplayable(url)) {
    const alt = (ch.urls || []).find((u) => !liveUrlUnplayable(u));
    if (alt) {
      url = alt;
    } else {
      // 同组里找一个能播的频道顶上去，别让用户以为软件坏了
      const nextIdx = channels.findIndex((c, i) => i !== ci && !liveUrlUnplayable((c.urls || [])[0]));
      if (nextIdx >= 0) {
        toast(`「${ch.name}」是 RTMP，桌面版播不了，已换到「${channels[nextIdx].name}」`);
        return playLiveChannel(channels, nextIdx, groupName, sourceName);
      }
      toast(`「${ch.name}」是 RTMP / 私有协议，桌面播放器支持不了，换一个频道试试`, 'err');
      return;
    }
  }
  const gi = S.liveData ? Math.max(0, S.liveData.groups.findIndex((g) => g.name === groupName)) : 0;
  S.play = { mode: 'live', channels, ci, groupName, sourceName, gi };
  $('#playerPane').classList.remove('hidden');
  $('#detailPane').classList.add('hidden');
  $('#playerTitle').textContent = `${sourceName || ''} · ${groupName || ''} · ${ch.name}`;
  const sub = $('#playerSub');
  if (sub) sub.textContent = [ch.name, ch.urls && ch.urls[1] ? '有备用地址' : ''].filter(Boolean).join(' · ');
  pNav.mode = 'live';
  pNav.idx = ci;
  pNav.gi = gi;
  pNav.col = 'ch';
  playerClearFocus();
  playerShowBars();
  // 直播：左侧「分组 + 频道号」两级菜单默认展开，画面在菜单后面继续播
  $('#epPanel').classList.remove('hidden');
  pendingSeek = 0;
  // m3u 里的 #EXTVLCOPT 自带的 Referer / UA 优先，没有就用频道域名兜底
  playUrl(url, { referer: ch.referer, ua: ch.ua });
  renderEpPanel();
  livePanelMark();
}

/* ---------------- 收藏 ---------------- */
function renderFav() {
  const root = $('#view-fav');
  if (!S.favs.length) {
    root.innerHTML = emptyHtml('还没有收藏', '在影片详情页点「收藏」就会出现在这里');
    return;
  }
  root.innerHTML = `
    <div class="page-head">
      <h1>我的收藏</h1>
      <span class="sub">${S.favs.length} 部</span>
      <div class="spacer"></div>
      <button class="btn" id="btnClearFav">清空收藏</button>
    </div>
    <div class="grid">
      ${S.favs.map((f) => `<div class="card" data-key="${escapeHtml(f.key)}">
        <div class="poster" style="${f.vod.pic ? `background-image:url('${escapeHtml(f.vod.pic)}')` : ''}">
          <span class="tag">${escapeHtml(f.siteName)}</span>
          ${f.vod.pic ? '' : '<span class="ph">暂无封面</span>'}
          <div class="pbar">
            <div class="pmeta">
              <span class="pscore"></span>
              <span class="pextra">${f.vod.remarks ? escapeHtml(f.vod.remarks) : ''}</span>
            </div>
            <div class="ptitle"><span class="ptitle-t">${escapeHtml(f.vod.name)}</span></div>
          </div>
        </div>
      </div>`).join('')}
    </div>`;

  setupCardMarquee(root);

  $$('.card', root).forEach((el) => {
    el.onclick = () => {
      const f = S.favs.find((x) => x.key === el.dataset.key);
      if (!f) return;
      const site = findSiteByKey(f.siteKey);
      if (!site) return toast('该站点已不在当前接口中', 'err');
      openDetail(Object.assign({ playUrl: '', playFrom: '' }, f.vod), site);
    };
  });
  $('#btnClearFav').onclick = () => {
    showModal({
      title: '清空收藏',
      html: `确定删除全部 ${S.favs.length} 条收藏吗？`,
      actions: [
        { label: '取消' },
        { label: '确定清空', primary: true, onClick: () => { S.favs = []; store.set(K.fav, []); renderFav(); } }
      ]
    });
  };
}

/* ---------------- 设置 ---------------- */
/* ---------------- 站点体检 ---------------- */
async function testSites() {
  const box = $('#healthBox');
  if (!box) return;
  const sites = S.sites.filter(isCmsSite);
  if (!sites.length) {
    box.innerHTML = `<div class="hint">当前接口没有可直连站点可测。</div>`;
    return;
  }
  box.innerHTML = loadingHtml(`正在检测 ${sites.length} 个站点…`);
  const rows = [];

  await pool(sites, 4, async (site) => {
    const t0 = Date.now();
    let r = { ok: false, text: '', status: 0, error: '' };
    try {
      r = await getText(joinUrl(siteApi(site), { ac: 'list' }));
    } catch (e) {
      r.error = String(e.message || e);
    }
    const ms = Date.now() - t0;
    const body = r.ok && r.text ? parseBody(r.text) : { classes: [], list: [] };
    rows.push({
      name: site.name,
      ok: body.list.length > 0 || body.classes.length > 0,
      ms,
      list: body.list.length,
      classes: body.classes.length,
      status: r.status,
      error: r.error || ''
    });
  });

  rows.sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : a.ok ? -1 : 1));
  const okCount = rows.filter((r) => r.ok).length;
  box.innerHTML = `
    <div class="hint" style="margin:12px 0 8px">
      可用 <b style="color:#9be8b8">${okCount}</b> / ${rows.length} 个站点，按响应快慢排序
    </div>
    <div class="iface-list">
      ${rows.map((r) => `<div class="iface-row">
        <div style="min-width:0;flex:1">
          <div class="i-name">${escapeHtml(r.name)}</div>
          <div class="i-url">${r.ok ? `分类 ${r.classes} 个 · 条目 ${r.list} 条` : escapeHtml(r.error || ('HTTP ' + r.status) || '无响应')}</div>
        </div>
        <div style="text-align:right;white-space:nowrap">
          <span class="tag" style="color:${r.ok ? '#9be8b8' : '#ff9b9b'};border-color:${r.ok ? 'rgba(90,200,130,.4)' : 'rgba(255,110,110,.4)'}">${r.ok ? '可用' : '异常'}</span>
          <span class="hint" style="margin-left:8px">${r.ms} ms</span>
        </div>
      </div>`).join('')}
    </div>`;
}

/* ---------------- 接口诊断：讲清楚为什么刷不出内容 ---------------- */
async function diagnoseInterface() {
  if (!S.sites.length && !S.cfgDiag) return toast('先加载一个接口再诊断', 'err');
  const d = S.cfgDiag || {};
  const sites = S.sites || [];
  const usable = sites.filter(isCmsSite);
  showModal({ title: '接口诊断', wide: true, html: loadingHtml('正在逐个请求站点…'), actions: [{ label: '关闭', primary: true }] });

  const rows = [];
  await pool(usable.slice(0, 8), 3, async (site) => {
    const r = await getText(joinUrl(siteApi(site), { ac: 'list' }));
    const body = parseBody(r.text || '');
    rows.push({
      name: site.name,
      api: siteApi(site),
      status: r.status || 0,
      ok: !!r.ok,
      bytes: (r.text || '').length,
      classes: body.classes.length,
      list: body.list.length,
      err: r.error || ''
    });
  });

  const good = rows.filter((r) => r.classes || r.list);
  const skipped = sites.filter((s) => !isCmsSite(s)).map((s) => ({ name: s.name, why: siteSkipReason(s), type: Number(s.type), api: String(s.api || '') }));

  let verdict;
  if (!sites.length) verdict = '接口 json 里没有 sites 数组，只有直播/解析配置 —— 这种接口只能看直播。';
  else if (!usable.length) verdict = `接口里 ${sites.length} 个站点全部被跳过（spider / csp_ 规则站）。桌面版不能执行 jar，所以首页刷不出内容 —— 换一个只含 type 0 / type 1 的接口。`;
  else if (!good.length) verdict = `${usable.length} 个可直连站点的 ac=list 都拿不到数据（多为 403、域名失效、或必须带 Referer）。可在设置里填 Referer 后再诊断一次。`;
  else verdict = `${usable.length} 个可直连站点里 ${good.length} 个能正常返回数据。若首页仍空白，多半是并发被限流，点「刷新」再试或减少可用站点。`;

  const html = `
    <div class="diag-grid">
      <div><span class="k">接口</span><b>${escapeHtml(d.input || S.cfgName || '—')}</b></div>
      ${d.http ? `<div><span class="k">响应</span><b>HTTP ${d.http.status} · ${d.http.bytes} 字节</b></div>` : '<div><span class="k">来源</span><b>粘贴的 json 文本</b></div>'}
      <div><span class="k">顶层字段</span><b>${escapeHtml((d.keys || []).join(' / ') || '—')}</b></div>
      <div><span class="k">站点</span><b>${sites.length} 个 · 可直连 ${usable.length} 个</b></div>
      <div><span class="k">直播 / 解析</span><b>${d.lives || 0} / ${d.parses || 0}</b></div>
      ${d.spider ? `<div><span class="k">spider</span><b class="mono">${escapeHtml(String(d.spider).slice(0, 52))}</b></div>` : ''}
    </div>
    ${d.http && d.http.preview ? `<div class="diag-pre">${escapeHtml(d.http.preview)}</div>` : ''}

    <div class="d-line-title"><h4>站点实测 · ac=list</h4></div>
    <div class="diag-rows" id="diagRows">
      ${rows.length ? rows.map((r) => `
        <div class="diag-row ${r.classes || r.list ? 'ok' : 'bad'}">
          <b class="diag-name">${escapeHtml(r.name)}</b>
          <span class="diag-api">${escapeHtml(r.api)}</span>
          <span class="diag-res">${r.classes || r.list ? `分类 ${r.classes} · 条目 ${r.list}` : `HTTP ${r.status} · ${r.bytes} 字节`}${!r.classes && !r.list && r.err ? ' · ' + escapeHtml(String(r.err).slice(0, 36)) : ''}</span>
        </div>`).join('') : '<div class="hint" style="padding:8px 2px">没有可直连的站点，无需实测。</div>'}
    </div>

    ${skipped.length ? `<div class="d-line-title"><h4>被跳过的站点 · ${skipped.length}</h4></div>
      <div class="diag-rows">
        ${skipped.slice(0, 12).map((s) => `
          <div class="diag-row skip">
            <b class="diag-name">${escapeHtml(s.name)}</b>
            <span class="diag-res">${escapeHtml(s.why)}</span>
          </div>`).join('')}
      </div>` : ''}

    <div class="diag-verdict">${escapeHtml(verdict)}</div>`;
  const body = $('#modalBody');
  if (body) body.innerHTML = html;
}

/* 设置首页：TVBox 那种一列功能行，点进去才展开对应面板，不再整屏铺开 */
function buildSettingsMenu() {
  const menu = $('#setMenu');
  const holder = $('#settingsPanels');
  if (!menu || !holder) return;
  const panels = $$('.panel', holder);
  const nameOf = (p) => {
    const h = p.querySelector('h3');
    if (h) return h.childNodes[0].textContent.trim();
    const s = p.querySelector('summary');
    return s ? s.textContent.trim() : '';
  };
  const pick = (kw) => panels.filter((p) => nameOf(p).startsWith(kw));
  const rows = [
    { key: 'iface', title: '接口地址', value: S.cfgUrl ? (S.cfgName || S.cfgUrl) : '未设置', panels: [...pick('点播接口'), ...pick('直播接口'), ...pick('已保存接口')] },
    { key: 'play', title: '播放设置', value: '音量 / 缩放 / 缓冲 / 长按倍速 / 自动下一集', panels: pick('播放') },
    { key: 'look', title: '外观与状态栏', value: '主题 · 海报尺寸 · 字号', panels: pick('外观与状态栏') },
    { key: 'data', title: '数据管理', value: '无痕 / 记录 / 收藏 / 重置', panels: pick('数据') },
    { key: 'backup', title: '备份与恢复', value: '导出 / 导入 / 清缓存', panels: pick('备份与恢复') },
    { key: 'adv', title: '高级', value: '解析引擎 / 网络代理 / 格式', panels: [...pick('解析引擎'), ...pick('网络'), ...pick('接口格式说明')] },
    { key: 'about', title: '关于', value: '2.9.12', panels: pick('关于') }
  ];
  menu.innerHTML = rows.map((r, i) => `
    <button class="set-row" data-i="${i}">
      <span class="sr-title">${escapeHtml(r.title)}</span>
      <span class="sr-value">${escapeHtml(r.value)}</span>
      <span class="sr-arrow">›</span>
    </button>`).join('');
  $$('.set-row', menu).forEach((el) => {
    el.onclick = () => openSettingsPanels(rows[Number(el.dataset.i)]);
  });
}

function openSettingsPanels(row) {
  if (!row.panels.length) { toast('这一项没有内容'); return; }
  showModal({ title: row.title, html: '<div class="set-modal-body"></div>', wide: true, actions: [{ label: '返回' }] });
  const body = $('#modalBody .set-modal-body');
  const holder = $('#settingsPanels');
  const pane = $('#modalPane');
  if (!body || !holder || !pane) return;
  const moved = row.panels;
  moved.forEach((p) => {
    p.classList.add('set-in-modal');
    if (p.tagName === 'DETAILS') p.open = true;
    body.appendChild(p);
  });
  const obs = new MutationObserver(() => {
    if (pane.classList.contains('hidden')) {
      obs.disconnect();
      moved.forEach((p) => { p.classList.remove('set-in-modal'); holder.appendChild(p); });
    }
  });
  obs.observe(pane, { attributes: true, attributeFilter: ['class'] });
}

function renderSettings() {
  const root = $('#view-settings');
  const usable = S.sites.filter(isCmsSite).length;
  const curLine = S.cfgRepoLine ? (window.__repoLines || []).find((l) => l.url === S.cfgRepoLine) : null;
  const repoPick = S.cfgUrl ? S.repoPicks[S.cfgUrl] : null;
  const lineLabel = (repoPick && repoPick.line === S.cfgRepoLine && repoPick.name) ||
    (curLine && curLine.name) || S.cfgRepoLine;
  root.innerHTML = `
    <div class="page-head"><h1>设置</h1></div>
    <div class="set-menu" id="setMenu"></div>
    <div id="settingsPanels" hidden>

    <details class="panel adv">
      <summary>解析引擎（cms 直连 + js 规则）</summary>
      ${(() => {
        const rawSp = String(S.spider || '').split(';')[0].trim();
        let kind = '无';
        let ok = false;
        if (/\.js(\?|#|$)/i.test(rawSp)) { kind = '.js 规则'; ok = true; }
        else if (/\.jar(\?|#|$)/i.test(rawSp)) { kind = '.jar 规则（安卓 dex，桌面跑不了）'; }
        else if (rawSp) { kind = rawSp.slice(0, 48); }
        const jsN = S.sites.filter(siteIsJs).length;
        return `<div class="field"><label>引擎状态</label><div class="row-flex" style="gap:14px">
          <span class="pill ${ok ? 'ok' : ''}">${ok ? 'JS 规则引擎已就绪' : '仅 cms 直连'}</span>
          <span class="hint">${jsN} 个站点走 js 规则</span>
        </div></div>
        <div class="field"><label>全局 spider</label><div class="row-flex" style="gap:14px">
          <span class="pill ${ok ? 'ok' : ''}">${escapeHtml(kind)}</span>
          ${ok ? '<span class="hint">cat.js 已内置，规则直接执行</span>' : (rawSp ? '<span class="hint">给的是 jar：这台电脑跑不了 dex，换 .js 规则接口才会多出站点</span>' : '')}
        </div></div>`;
      })()}
    </details>

    <div class="panel">
      <h3>点播接口 <span class="t-sub">影视站点 / 解析规则，支持多仓和本地 txt</span></h3>
      <div class="row-flex" style="margin-bottom:12px">
        <input class="input" id="vodUrl" value="${escapeHtml(S.vodUrl || S.cfgUrl || '')}" placeholder="https://xxx.com/tvbox.json">
        <button class="btn primary" id="btnLoadVod">加载并保存</button>
        <button class="btn" id="btnPickFile">导入本地文件</button>
        <input type="file" id="fileIface" accept=".txt,.json,.conf,text/plain,application/json" style="display:none">
      </div>
      <div class="hint" style="margin-bottom:10px">本地 txt / json 也可以直接拖进窗口，内容会存进软件，之后不再依赖原文件。</div>
      ${S.cfgUrl ? `<div class="hint" style="margin-bottom:10px">
        当前点播：<code>${escapeHtml(S.cfgName || '未命名')}</code> ·
        来源 <code>${escapeHtml(S.cfgUrl.length > 64 ? S.cfgUrl.slice(0, 64) + '…' : S.cfgUrl)}</code>
        ${repoPick ? `　<span style="color:var(--accent-2)">（已记住：${escapeHtml(repoPick.merged ? ('合并结果 ' + repoPick.name) : (repoPick.name || '线路'))}，重启自动恢复）</span>` : ''}
        ${S.cfgRepoLine ? `　线路 <code>${escapeHtml(lineLabel)}</code>` : ''}
      </div>` : ''}
      ${S.cfgUrl && repoPick ? `<div class="row-flex" style="margin-bottom:12px">
        <button class="btn" id="btnSwitchLine">换一条线路 / 重新合并</button>
        <span class="hint">多仓接口已记住上次用的线路，不想换就不用管。</span>
      </div>` : ''}
      <details class="adv">
        <summary>更多点播工具（粘贴 json · 只存地址 · 诊断 · 体检 · 浏览器打开）</summary>
        <div class="field">
          <label>直接粘贴接口 json 文本</label>
          <textarea class="input" id="ifaceRaw" rows="4" placeholder='{"sites":[{"key":"a","name":"站点","type":1,"api":"https://..."}]}'></textarea>
        </div>
        <div class="row-flex">
          <button class="btn" id="btnLoadRaw">加载粘贴的 json</button>
          <button class="btn" id="btnSaveIface" title="只把地址存进列表，不联网">只保存地址</button>
          <button class="btn" id="btnOpenIface" title="被 403 挡住时，用系统浏览器打开把内容复制出来">用浏览器打开</button>
        </div>
        <div class="row-flex" style="margin-top:10px">
          <button class="btn" id="btnCheckIface">检查当前接口</button>
          <button class="btn primary" id="btnDiagIface">接口诊断</button>
          <button class="btn" id="btnTestSites">站点体检</button>
        </div>
        <div id="healthBox"></div>
      </details>
    </div>

    <div class="panel">
      <h3>直播接口 <span class="t-sub">单独给直播源用；留空则沿用点播接口里的直播源</span></h3>
      <div class="row-flex" style="margin-bottom:12px">
        <input class="input" id="liveUrl" value="${escapeHtml(S.liveUrl || '')}" placeholder="https://xxx.com/live.json">
        <button class="btn primary" id="btnLoadLive">加载直播接口</button>
        <button class="btn" id="btnClearLive">恢复沿用点播</button>
      </div>
      <div class="hint">
        ${S.liveSeparate && S.liveUrl
          ? `当前直播：<code>${escapeHtml(S.liveName || '未命名')}</code> · 来源 <code>${escapeHtml(S.liveUrl.length > 64 ? S.liveUrl.slice(0, 64) + '…' : S.liveUrl)}</code>（${S.lives.length} 个直播源）`
          : '当前沿用点播接口里的直播源。'}
      </div>
    </div>

    <div class="panel">
      <h3>已保存接口 <span class="t-sub">当前：${escapeHtml(S.cfgName || '无')} · ${usable} 个可用站点</span></h3>
      <div class="iface-list" id="ifaceList">
        ${S.interfaces.length ? S.interfaces.map((i) => `
          <div class="iface-row ${i.id === S.currentId ? 'on' : ''}" data-id="${escapeHtml(i.id)}">
            <div style="min-width:0">
              <div class="i-name">${escapeHtml(i.name)}</div>
              <div class="i-url">${escapeHtml(i.url || '（本地 txt / 粘贴内容，已存在软件内）')}</div>
            </div>
            <div class="i-act">
              <button class="btn small" data-act="use">使用</button>
              <button class="btn small" data-act="del">删除</button>
            </div>
          </div>`).join('') : '<div class="hint">还没有保存过接口</div>'}
      </div>
    </div>

    <details class="panel adv">
      <summary>网络（User-Agent / Referer，一般不用改）</summary>
      <div class="field">
        <label>User-Agent</label>
        <input class="input" id="setUa" value="${escapeHtml(S.settings.ua)}" placeholder="${escapeHtml(UA_DEFAULT)}（留空使用默认）">
      </div>
      <div class="field">
        <label>Referer（可选）</label>
        <input class="input" id="setRef" value="${escapeHtml(S.settings.referer)}" placeholder="https://example.com/">
      </div>
      <div class="field">
        <label>HTTP 代理（可选，留空直连）</label>
        <input class="input" id="setProxy" value="${escapeHtml(S.settings.proxy || '')}" placeholder="例如：127.0.0.1:8080 或 socks5://127.0.0.1:1080">
      </div>
      <button class="btn" id="btnSaveNet">保存网络设置</button>
    </details>

    <div class="panel">
      <h3>播放</h3>
      <div class="field">
        <label>默认音量：<span id="volLabel">${Math.round(Number(S.settings.volume) * 100)}%</span></label>
        <input type="range" min="0" max="100" value="${Math.round(Number(S.settings.volume) * 100)}" id="setVol" style="width:100%">
      </div>
      <div class="field">
        <label>缩放比例</label>
        <div class="row-flex" style="gap:10px">
          <button class="btn ${(S.settings.videoFit || 'contain') === 'contain' ? 'primary' : ''}" data-seg="fit" data-val="contain">原始</button>
          <button class="btn ${S.settings.videoFit === 'cover' ? 'primary' : ''}" data-seg="fit" data-val="cover">铺满</button>
          <button class="btn ${S.settings.videoFit === 'fill' ? 'primary' : ''}" data-seg="fit" data-val="fill">拉伸</button>
        </div>
      </div>
      <div class="field">
        <label>缓冲时间</label>
        <div class="row-flex" style="gap:10px">
          <button class="btn ${String(S.settings.bufferMult || 1) === '1' ? 'primary' : ''}" data-seg="buf" data-val="1">1 倍</button>
          <button class="btn ${String(S.settings.bufferMult) === '2' ? 'primary' : ''}" data-seg="buf" data-val="2">2 倍</button>
          <button class="btn ${String(S.settings.bufferMult) === '4' ? 'primary' : ''}" data-seg="buf" data-val="4">4 倍</button>
        </div>
      </div>
      <div class="field">
        <label>长按倍速</label>
        <div class="row-flex" style="gap:10px">
          <button class="btn ${String(S.settings.longPressRate || 3) === '1.5' ? 'primary' : ''}" data-seg="press" data-val="1.5">1.5 倍</button>
          <button class="btn ${String(S.settings.longPressRate) === '2' ? 'primary' : ''}" data-seg="press" data-val="2">2 倍</button>
          <button class="btn ${String(S.settings.longPressRate || 3) === '3' ? 'primary' : ''}" data-seg="press" data-val="3">3 倍</button>
        </div>
      </div>
      <div class="field">
        <label class="row-flex" style="cursor:pointer">
          <input type="checkbox" id="setBgPlay" ${S.settings.backgroundPlay !== false ? 'checked' : ''}>
          <span>后台继续播放（切到其他窗口 / 最小化不暂停）</span>
        </label>
      </div>
      <div class="field" style="margin-bottom:0">
        <label class="row-flex" style="cursor:pointer">
          <input type="checkbox" id="setAutoNext" ${S.settings.autoNext ? 'checked' : ''}>
          <span>播放完自动播放下一集</span>
        </label>
      </div>
    </div>

    <div class="panel">
      <h3>外观与状态栏</h3>
      <div class="row-flex" style="margin-bottom:8px">
        <button class="btn ${(S.settings.theme || 'light') === 'light' ? 'primary' : ''}" id="btnThemeLight">浅色</button>
        <button class="btn ${S.settings.theme === 'dark' ? 'primary' : ''}" id="btnThemeDark">深色</button>
        <button class="btn ${S.settings.theme === 'auto' ? 'primary' : ''}" id="btnThemeAuto">跟随系统</button>
        <span class="hint">启动默认浅色；播放器始终深色。</span>
      </div>
      <div class="field" style="margin-bottom:8px">
        <label>海报尺寸</label>
        <div class="row-flex" style="gap:10px">
          <button class="btn ${S.settings.posterSize === 'small' ? 'primary' : ''}" data-seg="poster" data-val="small">小</button>
          <button class="btn ${S.settings.posterSize === 'medium' ? 'primary' : ''}" data-seg="poster" data-val="medium">中</button>
          <button class="btn ${S.settings.posterSize === 'large' ? 'primary' : ''}" data-seg="poster" data-val="large">大</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:8px">
        <label>界面字号</label>
        <div class="row-flex" style="gap:10px">
          <button class="btn ${S.settings.fontSize === 'small' ? 'primary' : ''}" data-seg="font" data-val="small">小</button>
          <button class="btn ${S.settings.fontSize === 'medium' ? 'primary' : ''}" data-seg="font" data-val="medium">中</button>
          <button class="btn ${S.settings.fontSize === 'large' ? 'primary' : ''}" data-seg="font" data-val="large">大</button>
        </div>
      </div>
      <label class="switch-row"><input type="checkbox" id="setShowClock" ${S.settings.showClock !== false ? 'checked' : ''}><span>右上角显示日期和时间</span></label>
      <label class="switch-row"><input type="checkbox" id="setShowWeather" ${S.settings.showWeather !== false ? 'checked' : ''}><span>右上角显示天气</span></label>
      <label class="switch-row"><input type="checkbox" id="setShowNet" ${S.settings.showNet !== false ? 'checked' : ''}><span>右上角显示网络连接状态</span></label>
      <div class="field" style="margin-top:8px">
        <label>天气城市（留空自动定位）</label>
        <input class="input" id="setWeatherCity" value="${escapeHtml(S.settings.weatherCity || '')}" placeholder="例如：新余 / 北京">
        <button class="btn" id="btnSaveWeather" style="flex:0 0 auto">保存并刷新天气</button>
      </div>
    </div>

    <div class="panel">
      <h3>数据</h3>
      <label class="switch-row"><input type="checkbox" id="setIncognito" ${S.settings.incognito ? 'checked' : ''}><span>无痕模式：不记录观看历史和搜索记录（收藏仍保留）</span></label>
      <div class="row-flex" style="margin-top:12px">
        <button class="btn" id="btnClearHist">清空观看记录（${S.history.length}）</button>
        <button class="btn" id="btnClearFav2">清空收藏（${S.favs.length}）</button>
        <button class="btn" id="btnResetAll">恢复默认设置</button>
      </div>
    </div>

    <div class="panel">
      <h3>备份与恢复</h3>
      <div class="hint" style="margin-bottom:10px">备份会把点播/直播地址、已保存接口列表和当前设置导出为本地 json；恢复时从该文件导回。</div>
      <div class="row-flex">
        <button class="btn primary" id="btnBackup">备份配置到文件</button>
        <button class="btn" id="btnRestore">从文件恢复配置</button>
        <button class="btn" id="btnClearCache">清理缓存（海报 / 图片）</button>
      </div>
    </div>

    <details class="panel adv">
      <summary>接口格式说明（自己写接口时再看）</summary>
      <div class="hint" style="margin-bottom:10px">
        软件是空壳播放器，只实现 TVBox 的接口协议，不含任何影视资源。接口是一个 json：
        <code>sites</code> 是影视站点、<code>lives</code> 是直播源、<code>parses</code> 是解析接口、
        <code>urls</code> 表示多仓（会先让你选线路）。站点 <code>type</code> 为 0/1 的 cms 直连站可用，
        <code>type: 3</code> 只要规则是 <code>.js</code> 就能跑（内置 cat.js 引擎），<code>.jar</code> 规则桌面跑不了。
      </div>
      <pre class="code">{
  "sites": [
    {
      "key": "demo",
      "name": "示例站点",
      "type": 1,
      "api": "https://example.com/api.php/provide/vod/",
      "searchable": 1,
      "quickSearch": 1
    }
  ],
  "lives": [
    { "name": "示例直播", "url": "https://example.com/live.txt", "type": 0 }
  ],
  "parses": [
    { "name": "示例解析", "type": 1, "url": "https://example.com/parse?url=" }
  ],
  "flags": ["qq", "youku", "iqiyi"],
  "spider": ""
}

/* 多仓写法 */
{
  "urls": [
    { "name": "线路一", "url": "https://example.com/api1.json" },
    { "name": "线路二", "url": "https://example.com/api2.json" }
  ]
}

/* 直播 txt 格式
分组名,#genre#
频道名,http://xxx.m3u8
频道名2,http://a.m3u8#http://b.m3u8
*/</pre>
    </details>

    <div class="panel">
      <h3>关于</h3>
      <div class="hint" id="aboutBox">TVBox PC 2.9.12 · 基于 TVBox 开源接口协议的桌面客户端</div>
      <div class="hint" style="margin-top:8px">
        本项目遵循 TVBox 开源协议实现，仅作为播放器外壳使用；接口与内容由使用者自行提供，
        请遵守当地法律法规并使用合法授权的影视来源。
      </div>
    </div>
    </div>`;

  buildSettingsMenu();

  if ($('#btnSwitchLine')) $('#btnSwitchLine').onclick = async () => {
    if (!S.cfgUrl) return;
    try {
      toast('打开多仓线路列表…');
      await loadInterface(S.cfgUrl, { forcePicker: true });
      renderSettings();
    } catch (e) { toast(String(e.message || e), 'err'); }
  };

  $('#btnLoadVod').onclick = async () => {
    const url = $('#vodUrl').value.trim();
    if (!url) return toast('请填写点播接口地址', 'err');
    // 先把地址存进「已保存接口」，即使这次加载失败（403/网络不通）也不会丢
    try { saveInterface({ name: guessName(url, null), url }); } catch (e) {}
    try {
      toast('加载点播接口…');
      await loadInterface(url, { save: false, kind: 'vod' });
      toast('点播接口已加载并保存', 'ok');
      renderSettings();
    } catch (e) {
      toast('地址已保存，但这次没加载成功：' + String(e.message || e), 'err');
      renderSettings();
    }
  };
  $('#btnLoadLive').onclick = async () => {
    const url = $('#liveUrl').value.trim();
    if (!url) return toast('请填写直播接口地址，或点「恢复沿用点播」', 'err');
    try {
      toast('加载直播接口…');
      await loadInterface(url, { save: false, kind: 'live' });
      toast('直播接口已加载', 'ok');
      renderSettings();
    } catch (e) {
      toast('直播接口没加载成功：' + String(e.message || e), 'err');
      renderSettings();
    }
  };
  if ($('#btnClearLive')) $('#btnClearLive').onclick = async () => {
    S.liveUrl = '';
    S.liveName = '';
    S.liveSeparate = false;
    store.set(K.liveUrl, '');
    // 重新加载点播接口，恢复沿用它自带的直播源
    if (S.vodUrl) {
      try { await loadInterface(S.vodUrl, { save: false, keepRepo: true, kind: 'vod' }); } catch (e) {}
    } else {
      S.lives = [];
    }
    renderSettings();
    toast('已恢复沿用点播接口的直播源', 'ok');
  };
  // 只保存地址（不立刻联网加载），方便先把自己的一堆接口攒在列表里
  if ($('#btnSaveIface')) $('#btnSaveIface').onclick = () => {
    const url = $('#vodUrl').value.trim();
    if (!url) return toast('请填写接口地址', 'err');
    if (!/^https?:\/\//i.test(url)) return toast('地址要以 http:// 或 https:// 开头', 'err');
    const item = saveInterface({ name: guessName(url, null), url });
    renderSettings();
    toast('已保存「' + item.name + '」，下次启动会自动加载', 'ok');
  };
  $('#btnOpenIface').onclick = () => {
    const url = ($('#vodUrl').value || '').trim();
    if (!/^https?:\/\//i.test(url)) return toast('先填一个接口地址', 'err');
    window.tvbox.openExternal(url);
    toast('已用系统浏览器打开，把内容整段复制回来粘贴');
  };

  // 本地接口文件：读进来 → 整段存进「已保存接口」 → 立刻尝试加载
  const fileInput = $('#fileIface');
  if ($('#btnPickFile')) $('#btnPickFile').onclick = () => { if (fileInput) fileInput.click(); };
  if (fileInput) fileInput.onchange = async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) await importLocalInterface(f);
  };
  const settingsView = $('#view-settings');
  if (settingsView) {
    settingsView.ondragover = (e) => { e.preventDefault(); };
    settingsView.ondrop = async (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      await importLocalInterface(e.dataTransfer.files[0]);
    };
  }
  $('#btnLoadRaw').onclick = async () => {
    const raw = $('#ifaceRaw').value.trim();
    if (!raw) return toast('请粘贴 json 文本', 'err');
    try {
      await loadInterface(raw, { name: '粘贴的接口', kind: 'vod' });
      toast('接口已加载', 'ok');
      renderSettings();
    } catch (e) { toast(String(e.message || e), 'err'); }
  };
  $('#btnCheckIface').onclick = () => {
    const usable = S.sites.filter(isCmsSite);
    const skipped = S.sites.filter((s) => !isCmsSite(s));
    showModal({
      title: '当前接口概况',
      html: `<b>${escapeHtml(S.cfgName || '未加载')}</b><br>
        站点：${S.sites.length} 个（可用 ${usable.length} 个，跳过 ${skipped.length} 个）<br>
        直播源：${S.lives.length} 个<br>解析接口：${S.parses.length} 个<br>
        ${skipped.length ? '<br><span class="hint">被跳过的站点：' + skipped.map((s) => escapeHtml(s.name)).join('、') + '（spider 规则/无直连地址，桌面版暂不支持）</span>' : ''}`,
      actions: [{ label: '好', primary: true }]
    });
  };
  $('#btnTestSites').onclick = () => testSites();
  $('#btnDiagIface').onclick = () => diagnoseInterface();
  $('#btnSaveNet').onclick = async () => {
    S.settings.ua = $('#setUa').value.trim();
    S.settings.referer = $('#setRef').value.trim();
    S.settings.proxy = ($('#setProxy') || {}).value ? $('#setProxy').value.trim() : '';
    store.set(K.set, S.settings);
    await window.tvbox.setIdentity(S.settings.ua, S.settings.referer);
    try { await window.tvbox.setProxy(S.settings.proxy); } catch (e) {}
    toast('网络设置已保存', 'ok');
  };
  $('#setVol').oninput = (e) => {
    $('#volLabel').textContent = e.target.value + '%';
    S.settings.volume = Number(e.target.value) / 100;
  };
  $('#setVol').onchange = () => store.set(K.set, S.settings);
  $('#btnThemeDark').onclick = () => applyTheme('dark', true);
  $('#btnThemeLight').onclick = () => applyTheme('light', true);
  $('#btnThemeAuto').onclick = () => applyTheme('auto', true);
  $('#setAutoNext').onchange = (e) => {
    S.settings.autoNext = e.target.checked;
    store.set(K.set, S.settings);
  };
  // 播放器：缩放比例 / 缓冲时间 / 长按倍速
  $$('[data-seg="fit"]', root).forEach((b) => { b.onclick = () => applyVideoFit(b.dataset.val, true); });
  $$('[data-seg="buf"]', root).forEach((b) => { b.onclick = () => applyBufferMult(b.dataset.val, true); });
  $$('[data-seg="press"]', root).forEach((b) => { b.onclick = () => applyPressRate(b.dataset.val, true); });
  const bgEl = $('#setBgPlay');
  if (bgEl) bgEl.onchange = (e) => {
    S.settings.backgroundPlay = e.target.checked;
    store.set(K.set, S.settings);
  };
  // 海报尺寸 / 字号档位
  $$('[data-seg="poster"]', root).forEach((b) => { b.onclick = () => applyPosterSize(b.dataset.val, true); });
  $$('[data-seg="font"]', root).forEach((b) => { b.onclick = () => applyFontSize(b.dataset.val, true); });
  // 无痕模式
  const incEl = $('#setIncognito');
  if (incEl) incEl.onchange = (e) => {
    S.settings.incognito = e.target.checked;
    store.set(K.set, S.settings);
    toast(e.target.checked ? '无痕模式已开启，不再记录观看和搜索历史' : '无痕模式已关闭');
  };
  // 备份配置
  if ($('#btnBackup')) $('#btnBackup').onclick = async () => {
    const payload = {
      app: 'TVBox PC', version: 1, exportedAt: new Date().toISOString(),
      settings: S.settings, interfaces: S.interfaces, currentId: S.currentId,
      vodUrl: S.vodUrl, liveUrl: S.liveUrl, vodName: S.vodName, liveName: S.liveName,
      repoPicks: S.repoPicks, lastRepo: S.lastRepo
    };
    try {
      const res = await window.tvbox.saveFile({ filename: 'tvbox-backup.json', content: JSON.stringify(payload, null, 2) });
      if (res && res.canceled) return;
      if (res && res.error) toast('备份失败：' + res.error, 'err');
      else toast('配置已备份到 ' + (res.filePath || '文件'), 'ok');
    } catch (e) { toast('备份失败：' + String(e.message || e), 'err'); }
  };
  // 恢复配置
  if ($('#btnRestore')) $('#btnRestore').onclick = async () => {
    let res;
    try { res = await window.tvbox.openFile(); } catch (e) { return toast('恢复失败：' + String(e.message || e), 'err'); }
    if (!res || res.canceled) return;
    if (res.error) return toast('恢复失败：' + res.error, 'err');
    let data;
    try { data = JSON.parse(res.content); } catch (e) { return toast('文件不是有效的配置 json', 'err'); }
    if (data.settings && typeof data.settings === 'object') {
      S.settings = Object.assign(S.settings, data.settings);
      store.set(K.set, S.settings);
    }
    if (Array.isArray(data.interfaces)) { S.interfaces = data.interfaces; store.set(K.iface, S.interfaces); }
    if (data.currentId) { S.currentId = data.currentId; store.set(K.cur, data.currentId); }
    if (data.vodUrl !== undefined) { S.vodUrl = data.vodUrl; store.set(K.vodUrl, data.vodUrl); }
    if (data.liveUrl !== undefined) { S.liveUrl = data.liveUrl; store.set(K.liveUrl, data.liveUrl); }
    if (data.repoPicks) { S.repoPicks = data.repoPicks; store.set(K.repo, data.repoPicks); }
    if (data.lastRepo) { S.lastRepo = data.lastRepo; store.set(K.repoLast, data.lastRepo); }
    toast('配置已恢复，正在重载…', 'ok');
    setTimeout(() => location.reload(), 600);
  };
  // 清理缓存
  if ($('#btnClearCache')) $('#btnClearCache').onclick = async () => {
    try { await window.tvbox.clearCache(); } catch (e) {}
    weatherCache = { at: 0, text: '', city: '', lat: null, lon: null };
    renderSettings();
    toast('缓存已清理', 'ok');
  };
  // 右上角三个信息开关：改完立刻生效，同时写盘
  [['setShowClock', 'showClock'], ['setShowWeather', 'showWeather'], ['setShowNet', 'showNet']].forEach(([id, key]) => {
    const el = $('#' + id);
    if (el) el.onchange = (e) => {
      S.settings[key] = e.target.checked;
      store.set(K.set, S.settings);
      applyStatusVisibility();
    };
  });
  const wc = $('#btnSaveWeather');
  if (wc) wc.onclick = () => {
    S.settings.weatherCity = ($('#setWeatherCity').value || '').trim();
    store.set(K.set, S.settings);
    weatherCache.lat = null;
    refreshWeather();
    toast(S.settings.weatherCity ? `天气城市已设为 ${S.settings.weatherCity}` : '已改为自动定位，正在刷新天气…', 'ok');
  };
  $('#btnClearHist').onclick = () => {
    S.history = [];
    store.set(K.hist, []);
    renderSettings();
    toast('观看记录已清空');
  };
  $('#btnClearFav2').onclick = () => {
    S.favs = [];
    store.set(K.fav, []);
    renderSettings();
    toast('收藏已清空');
  };
  $('#btnResetAll').onclick = () => {
    showModal({
      title: '恢复默认',
      html: '将清除接口列表、收藏、观看记录和网络设置，确定继续？',
      actions: [
        { label: '取消' },
        { label: '确定', primary: true, onClick: () => {
          localStorage.removeItem(K.iface); localStorage.removeItem(K.cur);
          localStorage.removeItem(K.set); localStorage.removeItem(K.hist); localStorage.removeItem(K.fav);
          localStorage.removeItem(K.vodUrl); localStorage.removeItem(K.liveUrl);
          try { if (window.tvboxDisk) window.tvboxDisk.clear(); } catch (e) {}
          location.reload();
        } }
      ]
    });
  };

  $$('.iface-row [data-act]', root).forEach((btn) => {
    btn.onclick = async () => {
      const row = btn.closest('.iface-row');
      const id = row.dataset.id;
      const item = S.interfaces.find((i) => i.id === id);
      if (!item) return;
      if (btn.dataset.act === 'del') {
        S.interfaces = S.interfaces.filter((i) => i.id !== id);
        store.set(K.iface, S.interfaces);
        renderSettings();
        toast('已删除');
        return;
      }
      try {
        toast('切换接口…');
        await loadInterface(item.url || item.raw, { name: item.name, save: false, kind: 'vod' });
        S.currentId = id;
        store.set(K.cur, id);
        toast('已切换', 'ok');
        switchView('home');
      } catch (e) { toast(String(e.message || e), 'err'); }
    };
  });

  window.tvbox.info().then((info) => {
    const box = $('#aboutBox');
    if (box) box.textContent = `TVBox PC ${info.version} · Electron ${info.electron} · Chromium ${info.chrome}`;
  }).catch(() => {});
}

/* ============================================================
 *  事件绑定 / 启动
 * ============================================================ */
function bindGlobal() {
  // 顶栏按需收起：内容往下滚就把第二行胶囊收起来，按 ↑ / 鼠标靠近顶部 / 滚回顶部再展开
  const setCompact = (on) => document.body.classList.toggle('top-compact', !!on);
  let compactLock = 0;   // 刚按 ↑ 展开后的一小段时间内别再收起来，免得和滚动打架
  const isPlaying = () => !$('#playerPane').classList.contains('hidden');
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('view')) return;
    if (Date.now() < compactLock) return;
    if (document.querySelector('.nav-btn.focus, .pill.focus')) return;   // 焦点在顶栏时保持展开
    if (t.scrollTop > 56) setCompact(true);
    else if (t.scrollTop < 40) setCompact(false);
  }, true);
  document.addEventListener('mousemove', (e) => {
    if (isPlaying()) return;
    if (e.clientY < 90 && document.body.classList.contains('top-compact')) { compactLock = Date.now() + 500; setCompact(false); }
  }, true);
  // 按 ↑ 要回顶栏时先展开，kodi 才能把焦点落到方块图标上
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' || isPlaying()) return;
    if (document.body.classList.contains('top-compact')) { compactLock = Date.now() + 700; setCompact(false); }
  }, true);

  $$('.nav-btn').forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });
  const brandEl = document.querySelector('.brand');
  if (brandEl) { brandEl.style.cursor = 'pointer'; brandEl.onclick = openSourcePicker; }

  // 全屏时隐藏右上角窗口按键，退出全屏后恢复
  if (window.tvbox && window.tvbox.onFullscreen) {
    window.tvbox.onFullscreen((v) => document.body.classList.toggle('is-fullscreen', v));
  }
  // 「点播」不是停在首页，而是按进去：顶部分类/榜单 + 整屏海报（安卓 TVBox 的行为）
  const tileVod = $('#tileVod');
  if (tileVod) tileVod.onclick = () => openVod();
  $('#cfgChip').onclick = () => switchView('settings');
  const pageBack = $('#pageBack');
  if (pageBack) pageBack.onclick = () => switchView('home');

  // 自绘窗口按钮
  $$('.win-btn').forEach((b) => {
    b.onclick = () => { try { window.tvbox.winControl(b.dataset.w); } catch (e) {} };
  });

  // 第二行胶囊按钮（遥控器上按 ↓ 从菜单进来，最常用的入口都在这一排）
  const pill = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  pill('#pillHistory', () => {
    switchView('home');
    setTimeout(() => {
      const row = document.querySelector('#histRow .card');
      if (row) { if (window.kodiSetFocus) window.kodiSetFocus(row); row.scrollIntoView({ block: 'nearest' }); }
      else toast('还没有观看记录，先挑一部片子看看吧');
    }, 260);
  });
  pill('#pillLive', () => switchView('live'));
  pill('#pillSearch', () => {
    switchView('search');
    setTimeout(() => { const i = $('#searchInput'); if (i) i.focus(); }, 260);
  });
  pill('#pillLine', async () => {
    if (!S.cfgUrl) return toast('先在「设置」里填一个接口地址', 'err');
    try { await loadInterface(S.cfgUrl, { forcePicker: true }); } catch (e) { toast(String(e.message || e), 'err'); }
  });
  pill('#pillDiag', () => diagnoseInterface());
  pill('#pillFav', () => switchView('fav'));
  pill('#pillRefresh', () => {
    toast('正在刷新…');
    if (S.view === 'home') renderHome();
    else switchView(S.view);
  });

  $('#btnBackFromPlayer').onclick = closePlayer;
  const fullscreenBtn = () => window.tvbox.toggleFullscreen();
  $('#btnPlayerFull').onclick = fullscreenBtn;
  const epPanelBtn = () => {
    const open = $('#epPanel').classList.contains('hidden');
    playerSetEpOpen(open);
    if (open) {
      pNav.mode = 'eps';
      pNav.idx = 0;
      playerFocusEp(0);
    }
  };
  $('#btnEpPanel').onclick = epPanelBtn;
  if ($('#btnEpPanel2')) $('#btnEpPanel2').onclick = epPanelBtn;
  if ($('#btnPlayerFull2')) $('#btnPlayerFull2').onclick = fullscreenBtn;
  $('#btnPlayPause').onclick = () => {
    const v = $('#video');
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  $('#btnSeekBack').onclick = () => { const v = $('#video'); v.currentTime = Math.max(0, v.currentTime - 10); };
  $('#btnSeekFwd').onclick = () => {
    const v = $('#video');
    if (v.duration) v.currentTime = Math.min(v.duration, v.currentTime + 10);
  };
  $('#btnPrevEp').onclick = () => {
    const p = S.play;
    if (!p || p.mode !== 'vod') return toast('直播没有上一集');
    if (p.ei > 0) startPlay(p.groups, p.gi, p.ei - 1, p.vod, p.site);
    else toast('已经是第一集了');
  };
  $('#btnNextEp').onclick = () => {
    const p = S.play;
    if (!p || p.mode !== 'vod') return toast('直播没有下一集');
    if (!nextEpisode()) toast('已经是最后一集了');
  };
  const rates = [1, 1.25, 1.5, 2, 0.75];
  $('#btnRate').onclick = () => {
    const v = $('#video');
    const cur = rates.findIndex((r) => Math.abs(r - (v.playbackRate || 1)) < 0.01);
    const next = rates[(cur + 1) % rates.length];
    v.playbackRate = next;
    $('#rateLabel').textContent = next.toFixed(next === 2 ? 1 : 2).replace(/0$/, '') + '×';
    toast('倍速 ' + next + '×');
  };

  const video = $('#video');
  video.controls = false;
  video.ontimeupdate = () => { saveProgress(false); playerUpdateBar(); };
  video.ondurationchange = () => playerUpdateBar();
  video.onprogress = () => playerUpdateBar();
  video.onpause = () => { saveProgress(true); playerSyncPlayBtn(); };
  video.onplay = () => playerSyncPlayBtn();
  video.onended = () => {
    saveProgress(true);
    if (S.settings.autoNext) {
      if (!nextEpisode()) toast('已经是最后一集了');
    }
  };
  video.onerror = () => {
    const p = S.play;
    if (p && p.mode === 'vod') {
      const ep = p.groups[p.gi].episodes[p.ei];
      showPlayerError('视频加载失败，可能是地址失效或格式不受支持', ep.url);
    } else {
      showPlayerError('频道加载失败，可能是源地址失效', $('#video').src || '');
    }
  };
  video.onseeked = () => saveProgress(true);

  // 进度条：鼠标点击 / 拖动
  const track = $('#pbTrack');
  if (track) {
    const seekTo = (ev) => {
      const r = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      if (video.duration) video.currentTime = ratio * video.duration;
      playerUpdateBar();
    };
    let dragging = false;
    track.onmousedown = (ev) => { dragging = true; seekTo(ev); };
    track.onmousemove = (ev) => { if (dragging) seekTo(ev); };
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // 播放器浮层：鼠标一动就显出来，4 秒后自动隐藏
  const pane = $('#playerPane');
  pane.onmousemove = () => playerShowBars();

  // 播放器快捷键（播放器打开且不在输入框里时生效）
  document.addEventListener('keydown', (e) => {
    if ($('#playerPane').classList.contains('hidden')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/input|textarea/i.test(tag)) return;
    const v = $('#video');
    if (!v) return;

    // 直播：左侧「分组 + 频道」两级菜单。← → 在两列之间切换，↑ ↓ 移动，OK 播放，返回收起菜单
    const liveMode = S.play && S.play.mode === 'live';
    if (liveMode && !$('#epPanel').classList.contains('hidden')) {
      const p = S.play;
      const panel = $('#epPanel');
      const groups = (S.liveData && S.liveData.groups) || [];
      if (pNav.mode !== 'live') { pNav.mode = 'live'; pNav.idx = p.ci || 0; }
      if (e.key === 'Escape' || e.key === 'Backspace') {
        e.preventDefault(); e.stopImmediatePropagation();
        panel.classList.add('hidden'); pNav.mode = 'video'; return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        pNav.col = e.key === 'ArrowLeft' && groups.length ? 'grp' : 'ch';
        livePanelMark(); return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        if (pNav.col === 'grp' && groups.length) {
          pNav.gi = Math.max(0, Math.min(groups.length - 1, (pNav.gi == null ? (p.gi || 0) : pNav.gi) + d));
        } else {
          pNav.idx = Math.max(0, Math.min(p.channels.length - 1, (pNav.idx == null ? p.ci : pNav.idx) + d));
        }
        livePanelMark(); return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopImmediatePropagation();
        if (pNav.col === 'grp' && groups.length) {
          const g = groups[pNav.gi == null ? (p.gi || 0) : pNav.gi];
          if (g && g.channels.length) { pNav.col = 'ch'; playLiveChannel(g.channels, 0, g.name, p.sourceName); }
        } else {
          const i = pNav.idx == null ? p.ci : pNav.idx;
          playLiveChannel(p.channels, i, p.groupName, p.sourceName);
        }
        return;
      }
      return;
    }
    if (liveMode) {
      // 菜单收起来之后：↑ ↓ 直接换台，OK 重新拉出频道菜单
      const p = S.play;
      if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); $('#epPanel').classList.remove('hidden'); pNav.mode = 'live'; livePanelMark(); return; }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        const ni = (p.ci + d + p.channels.length) % p.channels.length;
        playLiveChannel(p.channels, ni, p.groupName, p.sourceName);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); playerShowBars(); return; }
    }

    // 选集抽屉打开时：方向键在小格子里走
    if (!$('#epPanel').classList.contains('hidden') && pNav.mode === 'eps') {
      const eps = $$('#epPanel .ep');
      if (!eps.length) return;
      const cols = 2;
      let idx = pNav.idx;
      if (e.key === 'ArrowRight') idx = Math.min(eps.length - 1, idx + 1);
      else if (e.key === 'ArrowLeft') idx = Math.max(0, idx - 1);
      else if (e.key === 'ArrowDown') idx = Math.min(eps.length - 1, idx + cols);
      else if (e.key === 'ArrowUp') idx = Math.max(0, idx - cols);
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pNav.idx = Math.max(0, Math.min(eps.length - 1, pNav.idx)); eps[pNav.idx].click(); return; }
      else if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); playerSetEpOpen(false); return; }
      else return;
      e.preventDefault();
      pNav.idx = idx;
      playerFocusEp(idx);
      return;
    }

    // 焦点在底下一排功能键上：左右移动、Enter 执行、↓ 回视频
    if (pNav.mode === 'btns') {
      if (e.key === 'ArrowLeft') { e.preventDefault(); playerFocusBtn(pNav.idx - 1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); playerFocusBtn(pNav.idx + 1); return; }
      if (e.key === 'ArrowDown' || e.key === 'Backspace') { e.preventDefault(); pNav.mode = 'video'; playerClearFocus(); return; }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const btns = playerBtns();
        if (btns[pNav.idx]) btns[pNav.idx].click();
        return;
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); playerShowBars(); return; }
      return;
    }

    switch (e.key) {
      case ' ':
      case 'Enter':
        e.preventDefault();
        playerShowBars();
        if (e.repeat) break;
        prevRate = v.playbackRate || 1;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          pressActive = true;
          v.playbackRate = Number(S.settings.longPressRate) || 3;
          toast('长按倍速 ' + v.playbackRate + '×');
        }, 450);
        break;
      case 'ArrowRight':
        e.preventDefault();
        playerShowBars();
        v.currentTime = Math.min((v.duration || 1e9), v.currentTime + 10);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        playerShowBars();
        v.currentTime = Math.max(0, v.currentTime - 10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        playerShowBars();
        v.volume = Math.min(1, Number((v.volume + 0.1).toFixed(2)));
        toast('音量 ' + Math.round(v.volume * 100) + '%');
        break;
      case 'ArrowDown':
        // 往下走就进功能键那排（和电视上调出控制条的手感一致）
        e.preventDefault();
        playerShowBars();
        playerFocusBtn(0);
        break;
      case 'f':
      case 'F':
        window.tvbox.toggleFullscreen();
        break;
      default:
        return;
    }
  });

  // 松开：长按恢复原倍速，短按播放 / 暂停
  document.addEventListener('keyup', (e) => {
    if ($('#playerPane').classList.contains('hidden')) return;
    if (e.key !== ' ' && e.key !== 'Enter') return;
    const v = $('#video');
    if (!v) return;
    clearTimeout(pressTimer);
    if (pressActive) {
      pressActive = false;
      v.playbackRate = prevRate || 1;
    } else if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  });

  // ESC 关闭浮层（弹窗的逐级回退由 kodi.js 统一处理：先回落返回键，再按 Esc 才关闭）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#playerPane').classList.contains('hidden')) closePlayer();
    else if (!$('#detailPane').classList.contains('hidden')) $('#detailPane').classList.add('hidden');
    else if ($('#epPanel') && !$('#epPanel').classList.contains('hidden')) $('#epPanel').classList.add('hidden');
  });

  // 点击遮罩关闭
  $('#detailPane').onclick = (e) => {
    if (e.target === $('#detailPane')) $('#detailPane').classList.add('hidden');
  };
  $('#modalPane').onclick = (e) => {
    if (e.target === $('#modalPane')) hideModal();
  };
}

const themeMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };
const THEME_MODES = ['light', 'dark', 'auto'];

function resolveTheme(mode) {
  if (mode === 'auto') return themeMq.matches ? 'dark' : 'light';
  return mode === 'dark' ? 'dark' : 'light';
}

function syncThemeButtons() {
  const mode = S.settings.theme || 'light';
  const map = { btnThemeLight: 'light', btnThemeDark: 'dark', btnThemeAuto: 'auto' };
  Object.keys(map).forEach((id) => {
    const el = $('#' + id);
    if (el) el.classList.toggle('primary', map[id] === mode);
  });
}

function applyTheme(theme, persist) {
  const m = THEME_MODES.includes(theme) ? theme : 'light';
  S.settings.theme = m;
  const t = resolveTheme(m);
  document.body.classList.toggle('light', t === 'light');
  document.body.setAttribute('data-theme', m);
  syncThemeButtons();
  if (persist) {
    store.set(K.set, S.settings);
    toast(m === 'light' ? '已切换到浅色界面'
      : m === 'dark' ? '已切换到深色界面'
        : ('已跟随系统（当前' + (t === 'dark' ? '深色' : '浅色') + '）'));
  }
}

/* 海报尺寸 / 字号档位 */
const POSTER_SIZES = ['small', 'medium', 'large'];
const FONT_SIZES = ['small', 'medium', 'large'];
function syncSegButtons(group, val) {
  $$(`[data-seg="${group}"]`).forEach((b) => b.classList.toggle('primary', b.dataset.val === val));
}
function applyPosterSize(size, persist) {
  const m = POSTER_SIZES.includes(size) ? size : 'medium';
  S.settings.posterSize = m;
  document.body.setAttribute('data-poster', m);
  syncSegButtons('poster', m);
  if (persist) { store.set(K.set, S.settings); toast('海报尺寸已切换'); }
}
function applyFontSize(size, persist) {
  const m = FONT_SIZES.includes(size) ? size : 'medium';
  S.settings.fontSize = m;
  document.body.setAttribute('data-font', m);
  syncSegButtons('font', m);
  if (persist) { store.set(K.set, S.settings); toast('字号已切换'); }
}
async function applyProxy(rule, persist) {
  S.settings.proxy = String(rule || '').trim();
  if (persist) store.set(K.set, S.settings);
  try { await window.tvbox.setProxy(S.settings.proxy); } catch (e) {}
}

const FIT_OPTS = ['contain', 'cover', 'fill'];
const FIT_LABEL = { contain: '原始', cover: '铺满', fill: '拉伸' };
const BUF_MAP = { 1: 15, 2: 30, 4: 60 };
const PRESS_OPTS = ['1.5', '2', '3'];
function applyVideoFit(fit, persist) {
  const m = FIT_OPTS.includes(fit) ? fit : 'contain';
  S.settings.videoFit = m;
  const v = $('#video');
  if (v) v.style.objectFit = m;
  syncSegButtons('fit', m);
  if (persist) { store.set(K.set, S.settings); toast('缩放比例：' + FIT_LABEL[m]); }
}
function applyBufferMult(mult, persist) {
  const m = BUF_MAP[mult] ? String(mult) : '1';
  S.settings.bufferMult = Number(m);
  syncSegButtons('buf', m);
  if (persist) { store.set(K.set, S.settings); toast('缓冲时间 ' + m + ' 倍'); }
}
function applyPressRate(rate, persist) {
  const m = PRESS_OPTS.includes(String(rate)) ? String(rate) : '3';
  S.settings.longPressRate = Number(m);
  syncSegButtons('press', m);
  if (persist) { store.set(K.set, S.settings); toast('长按倍速 ' + m + ' 倍'); }
}
function bufferSeconds() {
  return BUF_MAP[Number(S.settings.bufferMult)] || 15;
}

// 跟随系统时，系统换深浅色这边立刻跟上
if (themeMq.addEventListener) {
  themeMq.addEventListener('change', () => {
    if ((S.settings.theme || 'light') === 'auto') applyTheme('auto', false);
  });
}

/* ---------------- 右上角状态区：日期时间 / 天气 / 网络 ---------------- */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
let statusTimer = null;
let weatherTimer = null;
let weatherCache = { at: 0, text: '', city: '', lat: null, lon: null };

function tickClock() {
  const t = $('#clockTime');
  const d = $('#clockDate');
  if (!t) return;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  t.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if (d) d.textContent = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${WEEK[now.getDay()]}`;
}

function paintNet() {
  const chip = $('#netChip');
  if (!chip) return;
  const on = navigator.onLine !== false;
  chip.classList.toggle('off', !on);
  const txt = $('#netText');
  if (txt) txt.textContent = on ? '在线' : '离线';
  chip.title = on ? '网络已连接' : '网络已断开（接口和海报都会取不到）';
}

function applyStatusVisibility() {
  const st = S.settings;
  const c = $('#clock');
  const w = $('#weatherChip');
  const n = $('#netChip');
  if (c) c.hidden = st.showClock === false;
  if (n) n.hidden = st.showNet === false;
  if (w) w.hidden = st.showWeather === false || !weatherCache.text;
  if (st.showWeather !== false && !weatherTimer) {
    refreshWeather();
    weatherTimer = setInterval(refreshWeather, 30 * 60 * 1000);
  }
  if (st.showWeather === false && weatherTimer) {
    clearInterval(weatherTimer);
    weatherTimer = null;
  }
}

/* wttr.in 不需要 key，国内能直连；一条请求同时给出城市、天气和温度 */
const EN_WEATHER = [
  [/sunny|clear/i, '晴'], [/partly cloudy/i, '局部多云'], [/cloudy/i, '多云'], [/overcast/i, '阴'],
  [/thunder/i, '雷暴'], [/heavy rain|rain shower/i, '强阵雨'], [/light rain|drizzle/i, '小雨'], [/rain/i, '雨'],
  [/heavy snow/i, '大雪'], [/light snow/i, '小雪'], [/snow/i, '雪'], [/sleet/i, '雨夹雪'],
  [/haze|smoky/i, '霾'], [/mist|fog/i, '雾'], [/wind/i, '大风']
];

function zhWeather(en) {
  const s = String(en || '');
  const hit = EN_WEATHER.find(([re]) => re.test(s));
  return hit ? hit[1] : (s || '多云');
}

function weatherIcon(desc) {
  const s = String(desc || '');
  if (/晴/.test(s)) return '☀️';
  if (/雷/.test(s)) return '⛈️';
  if (/雪|雨夹雪/.test(s)) return '🌨️';
  if (/雨|阵雨|滴/.test(s)) return '🌧️';
  if (/雾|霾/.test(s)) return '🌫️';
  if (/风/.test(s)) return '💨';
  if (/阴/.test(s)) return '☁️';
  return '⛅';
}

async function refreshWeather() {
  if (S.settings.showWeather === false) return;
  const chip = $('#weatherChip');
  try {
    const city = String(S.settings.weatherCity || '').trim();
    const r = await window.tvbox.httpGet({
      url: 'https://wttr.in/' + encodeURIComponent(city) + '?format=j1&lang=zh'
    });
    const j = JSON.parse(r.text || '{}');
    const cur = (j.current_condition || [])[0];
    if (!cur || cur.temp_C == null) throw new Error('天气接口没返回温度');
    let area = city;
    if (!area) {
      // 自动定位：城市名拿中文的（wttr 给的是拼音），拿不到再用 wttr 的地名
      if (!weatherCache.city) {
        try {
          const ip = await window.tvbox.httpGet({ url: 'http://ip-api.com/json/?lang=zh-CN&fields=status,city,regionName' });
          const ij = JSON.parse(ip.text || '{}');
          weatherCache.city = ij.city || ij.regionName || '';
        } catch (e) { weatherCache.city = ''; }
      }
      area = weatherCache.city || String((((j.nearest_area || [])[0] || {}).areaName || [{}])[0].value || '');
    }
    const zh = cur.lang_zh && cur.lang_zh[0] && cur.lang_zh[0].value;
    const desc = (zh && /[一-龥]/.test(zh)) ? zh : zhWeather((cur.weatherDesc || [{}])[0].value);
    const icon = weatherIcon(desc);
    weatherCache = {
      at: Date.now(), city: area, icon,
      text: `${area ? area + ' · ' : ''}${desc} ${Math.round(Number(cur.temp_C))}°`
    };
    if (chip) {
      const ico = $('#weatherIco'); const tx = $('#weatherText');
      if (ico) ico.textContent = icon;
      if (tx) tx.textContent = weatherCache.text;
      chip.title = `天气：${weatherCache.text}（点击刷新，来源 wttr.in）`;
      chip.hidden = false;
    }
  } catch (e) {
    // 取不到就安静地藏起来，不在右上角挂一条报错
    if (chip) chip.hidden = true;
  }
}

function startStatusBar() {
  tickClock();
  paintNet();
  applyStatusVisibility();
  if (!statusTimer) statusTimer = setInterval(tickClock, 1000);
  window.addEventListener('online', paintNet);
  window.addEventListener('offline', paintNet);
  const w = $('#weatherChip');
  if (w) w.onclick = () => { weatherCache.lat = null; refreshWeather(); };
}


async function init() {
  bindGlobal();
  startStatusBar();
  applyTheme(S.settings.theme, false);
  applyPosterSize(S.settings.posterSize, false);
  applyFontSize(S.settings.fontSize, false);
  applyVideoFit(S.settings.videoFit, false);
  // 后台播放：关闭后，切后台 / 失焦即暂停
  const pauseIfBg = () => {
    if (S.settings.backgroundPlay !== false) return;
    const v = $('#video');
    if (v && !v.paused && !$('#playerPane').classList.contains('hidden')) v.pause();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseIfBg(); });
  window.addEventListener('blur', pauseIfBg);
  try {
    await window.tvbox.setIdentity(S.settings.ua || '', S.settings.referer || '');
  } catch (e) { /* 忽略：不影响主体功能 */ }
  try {
    await window.tvbox.setProxy(S.settings.proxy || '');
  } catch (e) { /* 忽略：代理不可用时不影响主体 */ }

  const chip = $('#cfgChip');
  chip.textContent = '未加载接口';

  // 恢复上次使用的点播接口
  const lastRepo = store.get(K.repoLast, '');
  const last = S.interfaces.find((i) => i.id === S.currentId) || S.interfaces[0];
  if (last) {
    try {
      await loadInterface(last.url || last.raw, { name: last.name, save: false, keepRepo: true, kind: 'vod' });
      S.currentId = last.id;
      // 多仓接口：设置页回填仓库地址，方便「换一条线路」
      if (lastRepo) { S.lastRepo = lastRepo; S.cfgUrl = lastRepo; }
    } catch (e) {
      console.warn('恢复点播接口失败', e);
    }
  }
  // 恢复独立的直播接口（若设置过）
  if (S.liveUrl) {
    try {
      await loadInterface(S.liveUrl, { save: false, keepRepo: true, kind: 'live' });
    } catch (e) {
      console.warn('恢复直播接口失败', e);
    }
  }
  switchView('home');

  // 看门狗：万一首页首帧卡在「正在拉取」，6 秒后自己再来一次
  setTimeout(() => {
    const rows = $('#homeRows');
    if (rows && rows.querySelector('.loading')) renderHome();
  }, 6000);
}

window.addEventListener('DOMContentLoaded', init);




