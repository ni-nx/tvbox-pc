'use strict';
/* 多仓线路体检：把仓库里的每条线路抓下来，判断「是不是 cms 接口 / 有几个能直连的站点 / 首页到底有没有货」，生成一份可用线路清单。仅开发/排障用。 */
const fs = require('fs');
const path = require('path');

const REPO = process.argv[2] || 'https://15487.kstore.space/0619%E5%A4%9A%E7%BA%BF.txt';
const OUT = process.argv[3] || path.join(__dirname, '..', '..', '0619多线_可用线路.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CONCURRENCY = 8;
const TIMEOUT = 9000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, referer, timeout = TIMEOUT) {
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  if (referer) headers.Referer = referer;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function stripJson(t) {
  return String(t || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function tryJson(t) {
  try { return JSON.parse(stripJson(t)); } catch (e) { return null; }
}

/* 站点是否可直连：type 0/1 且 api 是 http(s) */
function cmsSites(cfg) {
  const sites = (cfg && Array.isArray(cfg.sites) ? cfg.sites : []);
  return sites.filter((s) => {
    const t = Number(s.type == null ? 0 : s.type);
    const api = String(s.api || '');
    return (t === 0 || t === 1) && /^https?:\/\//i.test(api);
  });
}

function joinApi(base, query) {
  const b = String(base || '');
  if (!b) return '';
  return b + (b.includes('?') ? '&' : '?') + query;
}

function parseRepoLines(text) {
  // 多仓既可能是「名称,地址」的 txt，也可能是 {"urls":[{"url","name"}]} 的 JSON
  const cfg = tryJson(text);
  if (cfg && Array.isArray(cfg.urls)) {
    return cfg.urls
      .map((u) => (typeof u === 'string'
        ? { name: '线路', url: u.trim() }
        : { name: String((u && u.name) || '线路'), url: String((u && u.url) || '').trim() }))
      .filter((x) => /^https?:\/\//i.test(x.url));
  }
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^[#/;]/.test(line)) continue;
    const idx = line.search(/[,，]/);
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim() || '线路';
    const url = line.slice(idx + 1).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ name, url });
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      res[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return res;
}

async function probeLine(line, idx, total) {
  let r = await get(line.url);
  // 超时/连接失败重试一次，给慢站多 20 秒
  if (!r.ok && (r.status === 0 || r.status >= 500)) {
    let origin = '';
    try { origin = new URL(line.url).origin; } catch (e) { /* ignore */ }
    await sleep(600);
    r = await get(line.url, origin || undefined, 20000);
  }
  const base = { ...line, idx, status: r.status, kind: '', usable: 0, allSites: 0, live: 0, sample: '', note: '' };
  if (!r.ok) {
    base.kind = '打不开';
    base.note = r.status ? 'HTTP ' + r.status : (r.error || '连接失败');
    console.log(`[${idx + 1}/${total}] ${line.name} -> ${base.note}`);
    return base;
  }
  const cfg = tryJson(r.text);
  if (!cfg || typeof cfg !== 'object') {
    base.kind = '不是 JSON 接口';
    base.note = '返回 ' + (r.text || '').slice(0, 60).replace(/\s+/g, ' ');
    console.log(`[${idx + 1}/${total}] ${line.name} -> ${base.kind}`);
    return base;
  }
  if (Array.isArray(cfg.urls)) {
    base.kind = '多仓子仓';
    base.subs = cfg.urls
      .map((u) => (typeof u === 'string'
        ? { name: '子线路', url: u.trim() }
        : { name: String((u && u.name) || '子线路'), url: String((u && u.url) || '').trim() }))
      .filter((x) => /^https?:\/\//i.test(x.url));
    base.note = `内含 ${base.subs.length} 条子线路`;
    console.log(`[${idx + 1}/${total}] ${line.name} -> 多仓子仓 ${base.note}`);
    return base;
  }
  const all = Array.isArray(cfg.sites) ? cfg.sites : [];
  const usable = cmsSites(cfg);
  base.allSites = all.length;
  base.usable = usable.length;
  base.live = Array.isArray(cfg.lives) ? cfg.lives.length : 0;
  if (!all.length) {
    base.kind = '只有直播/解析配置';
    base.note = `直播源 ${base.live} 条`;
    console.log(`[${idx + 1}/${total}] ${line.name} -> ${base.kind}`);
    return base;
  }
  if (!usable.length) {
    base.kind = '全是 spider 站';
    base.note = `${all.length} 个站点都不是 cms`;
    console.log(`[${idx + 1}/${total}] ${line.name} -> ${base.kind}`);
    return base;
  }
  // 抽样实测：拿第一个可直连站点拉 ac=list，看首页有没有货
  const targets = usable.slice(0, 2);
  let got = 0;
  for (const s of targets) {
    const u = joinApi(s.api, 'ac=list');
    const rr = await get(u, new URL(line.url).origin);
    const j = rr.ok ? tryJson(rr.text) : null;
    const list = j && Array.isArray(j.list) ? j.list.length : 0;
    if (list) { got = list; base.sample = `${s.name || '站点'} ${list} 条`; break; }
    base.sample = base.sample || `${(s.name || '站点')} 空${rr.status ? '(' + rr.status + ')' : ''}`;
  }
  base.kind = got ? '可用（有内容）' : '能解析但没测到内容';
  base.note = `可直连 ${usable.length}/${all.length} 个站点；抽样：${base.sample || '无'}`;
  console.log(`[${idx + 1}/${total}] ${line.name} -> ${base.kind}（${usable.length} 站）`);
  return base;
}

(async () => {
  console.log('抓取多仓：' + REPO);
  const repo = await get(REPO, REPO);
  if (!repo.ok) {
    console.error('仓库打不开：' + (repo.status || repo.error));
    process.exit(1);
  }
  let lines = parseRepoLines(repo.text);
  console.log('仓库里解析到 ' + lines.length + ' 条线路');

  const results = await mapLimit(lines, CONCURRENCY, (l, i) => probeLine(l, i, lines.length));

  // 多仓子仓：展开一层再测（只测子仓本身能不能打开）
  const subs = [];
  for (const r of results) {
    if (r.kind !== '多仓子仓' || !r.subs) continue;
    for (const s of r.subs) subs.push({ name: `${r.name} / ${s.name}`, url: s.url, from: r.name });
  }
  let subResults = [];
  if (subs.length) {
    console.log('子仓共 ' + subs.length + ' 条，继续体检…');
    subResults = await mapLimit(subs, CONCURRENCY, (l, i) => probeLine(l, i, subs.length));
  }

  const all = results.concat(subResults);
  const good = all.filter((r) => r.kind === '可用（有内容）');
  // 同一个地址常被仓库挂成两条（不同名字），合并成一条并记别名
  const goodGroups = [];
  for (const r of good) {
    const g = goodGroups.find((x) => x.url === r.url);
    if (g) { if (!g.names.includes(r.name)) g.names.push(r.name); continue; }
    goodGroups.push({ url: r.url, names: [r.name], usable: r.usable, allSites: r.allSites, note: r.note });
  }
  const ranked = goodGroups.slice().sort((a, b) => b.usable - a.usable);
  const parseOnly = all.filter((r) => r.kind === '能解析但没测到内容');
  const spider = all.filter((r) => r.kind === '全是 spider 站');
  const liveOnly = all.filter((r) => r.kind === '只有直播/解析配置');
  const bad = all.filter((r) => r.kind === '打不开' || r.kind === '不是 JSON 接口');

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const row = (r, k) => `${k}. ${r.name}\n   地址：${r.url}\n   ${r.note}`;

  const txt = [
    'TVBox PC · 多仓线路体检结果',
    `仓库：${REPO}`,
    `体检时间：${stamp}　检测：${all.length} 条（主仓 ${results.length} 条 + 子仓 ${subs.length} 条）`,
    '判定口径：能打开 → 是 cms JSON（不是 m3u/网页）→ 至少 1 个 type 0/1 且 api 为 http(s) 的站点 → 抽 1~2 个站点请求 ac=list 看首页是否真有内容。',
    '',
    `可用且有内容：${goodGroups.length} 条（去重前 ${good.length} 条）`,
    `能解析但抽样没内容：${parseOnly.length} 条`,
    `全是 spider 站（电脑端用不了）：${spider.length} 条`,
    `只有直播/解析配置：${liveOnly.length} 条`,
    `打不开或不是接口：${bad.length} 条`,
    '',
    '========================================',
    `零、优先试这几条（按可直连站点数排序，前 8 名）`,
    '========================================',
    ...ranked.slice(0, 8).map((g, i) => `${i + 1}. ${g.names.join(' / ')}（${g.usable} 个可直连站点）\n   ${g.url}`),
    '',
    '========================================',
    `一、可直接填进 TVBox PC 的线路（${goodGroups.length} 条）`,
    '========================================',
    ...(goodGroups.length
      ? goodGroups.map((g, i) => `${i + 1}. ${g.names.join(' / ')}\n   地址：${g.url}\n   可直连 ${g.usable}/${g.allSites} 个站点；${g.note.split('；').slice(-1)[0] || ''}`)
      : ['（没有）']),
    '',
    '========================================',
    `二、能解析但抽样没测到内容（${parseOnly.length} 条，可试但可能刷不出海报）`,
    '========================================',
    ...(parseOnly.length ? parseOnly.map((r, i) => row(r, i + 1)) : ['（没有）']),
    '',
    '========================================',
    `三、只有直播 / 解析配置（${liveOnly.length} 条，适合去「直播」页用）`,
    '========================================',
    ...(liveOnly.length ? liveOnly.map((r, i) => row(r, i + 1)) : ['（没有）']),
    '',
    '========================================',
    `四、全是 spider 站（${spider.length} 条，安卓 TVBox 能用，电脑版解析不了）`,
    '========================================',
    ...(spider.length ? spider.map((r, i) => `${i + 1}. ${r.name}　${r.note}`) : ['（没有）']),
    '',
    '========================================',
    `五、打不开 / 不是接口（${bad.length} 条）`,
    '========================================',
    ...(bad.length ? bad.map((r, i) => `${i + 1}. ${r.name}　${r.status ? 'HTTP ' + r.status : ''} ${r.note}`) : ['（没有）']),
    '',
    '========================================',
    '附：纯地址清单（只保留「可用且有内容」的线路，已去重，一行一条，可直接贴进启动器）',
    '========================================',
    ...(goodGroups.length ? goodGroups.map((g) => g.url) : ['（没有）']),
    ''
  ].join('\n');

  fs.writeFileSync(OUT, '\uFEFF' + txt, 'utf8');
  console.log('\n已写入：' + OUT);
  console.log(`结果：可用且有内容 ${goodGroups.length}（去重前 ${good.length}）/ 能解析 ${parseOnly.length} / spider ${spider.length} / 仅直播 ${liveOnly.length} / 打不开 ${bad.length}`);
  // 机器可读结果，便于后续脚本读取
  fs.writeFileSync(OUT.replace(/\.txt$/, '.json'), JSON.stringify(all.map((r) => ({ name: r.name, url: r.url, kind: r.kind, usable: r.usable, all: r.allSites, note: r.note })), null, 2), 'utf8');
})();
