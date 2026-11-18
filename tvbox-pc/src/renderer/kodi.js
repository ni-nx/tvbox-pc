'use strict';
/* ============================================================
 *  Kodi 式交互层：焦点导航 / 背景联动 / 遥控器与键盘操作
 *  依赖 app.js 里的数据与渲染函数（同为全局脚本）
 * ============================================================ */
(function () {
  const SEL =
    '.nav-btn, .brand-btn, .tv-menu-item, .card, .tab, .site-tile, .btn, .ep, .ch-item, .grp-item, ' +
    '.iface-row, .more, .close-x, .list-line, .osk-key, .input, .search-input, .d-chip, .hot-chip, .src-row';

  let focusEl = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('.hidden')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.01;
  }

  function currentScope() {
    if (!$('#detailPane').classList.contains('hidden')) return '#detailBody';
    if (!$('#modalPane').classList.contains('hidden')) return '.modal';
    return '';   // 空 = 整屏（顶栏 + 内容），光标可以从海报区移到标题栏
  }

  function listFocusables() {
    const scopeSel = currentScope();
    const root = scopeSel ? $(scopeSel) : document.body;
    if (!root) return [];
    return $$(SEL, root).filter((el) => {
      if (el.classList.contains('input') && /^(range|checkbox|radio|color|file)$/i.test(el.type || '')) return false;
      return isVisible(el) && !el.disabled && !el.closest('#playerPane');
    });
  }

  /* ---------- 背景联动 ---------- */
  function applyBackdrop(el) {
    const backdrop = $('#backdrop');
    if (!backdrop || !el) return;
    let node = null;
    if (el.classList.contains('card')) node = el.querySelector('.poster');
    else if (el.classList.contains('d-shot')) node = el;
    if (!node) return;
    const bg = getComputedStyle(node).backgroundImage;
    if (bg && bg !== 'none' && bg.indexOf('url(') === 0) backdrop.style.backgroundImage = bg;
  }

  /* ---------- 焦点 ---------- */
  function ensureVisible(el) {
    // 分类胶囊：整颗对齐到边界，只露完整胶囊；末颗贴右
    if (el && el.classList && el.classList.contains('tab') && el.parentElement) {
      const sc = el.parentElement;
      if (el === sc.lastElementChild) {
        const r = el.getBoundingClientRect();
        const cr = sc.getBoundingClientRect();
        sc.scrollLeft += r.right - cr.right;
      } else if (typeof window.alignCatTabs === 'function') {
        window.alignCatTabs(sc);
      }
      return;
    }
    try {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (e) {}
  }

  function syncHomeHeader(el) {
    // 首页：焦点在顶部磁贴行时显示品牌/状态标题栏；焦点下移进海报后，标题栏自动收起（TVBox 同款）
    if (typeof S === 'undefined' || !S || S.view !== 'home') {
      document.body.classList.remove('home-header-collapsed');
      return;
    }
    const nav = $('#nav');
    const inNav = !!(nav && (el === nav || nav.contains(el))) || !!(el && el.closest && el.closest('.brand-btn'));
    document.body.classList.toggle('home-header-collapsed', !inNav);
  }

  function resetCardTransform(el) {
    if (el && el.classList && el.classList.contains('card')) el.style.removeProperty('transform');
  }

  function setFocus(el) {
    if (!el) return;
    if (el === focusEl) { ensureVisible(el); return; }
    $$('.focus').forEach((n) => { if (n !== el) n.classList.remove('focus'); });
    if (focusEl) { focusEl.classList.remove('focus'); resetCardTransform(focusEl); }
    focusEl = el;
    el.classList.add('focus');
    // 搜索框：焦点环落在框上时，光标也进入框内
    if (el.id === 'searchInput' && document.activeElement !== el) {
      try { el.focus(); } catch (e) {}
    }
    // 选中卡片整体轻微浮起 1.06，边框随卡片一起放大（transform 走内联，避免历史 CSS 规则覆盖）
    if (el.classList.contains('card')) el.style.transform = 'scale(1.06)';
    ensureVisible(el);
    applyBackdrop(el);
    syncHomeHeader(el);
  }

  function clearFocus() {
    $$('.focus').forEach((n) => n.classList.remove('focus'));
    if (focusEl) resetCardTransform(focusEl);
    focusEl = null;
  }

  function preferredFocus() {
    // 弹窗打开时，焦点先进弹窗内第一个可选中项（线路列表 / 确认框等）
    if (!$('#modalPane').classList.contains('hidden')) {
      const m = $('.modal');
      const ml = m ? $$(SEL, m).filter(isVisible) : [];
      if (ml.length) return ml[0];
    }
    // 首页自动聚焦始终落在顶部「点播」磁贴，内容异步回来后也不被海报抢焦点
    if (typeof S !== 'undefined' && S.view === 'home') {
      const tile = $('#tileVod');
      if (tile && isVisible(tile)) return tile;
    }
    const scopeSel = currentScope();
    const root = scopeSel ? $(scopeSel) : document.body;
    if (!root) return null;
    const cards = $$('.card', root).filter(isVisible);
    if (cards.length) return cards[0];
    const list = listFocusables();
    return list[0] || null;
  }

  function autofocus() {
    if (focusEl && isVisible(focusEl)) { sweepStale(); return; }
    const ae = document.activeElement;
    if (ae && /input|textarea/i.test(ae.tagName) && isVisible(ae)) {
      // 搜索框：光标已在框内时，仍补上遥控器焦点环
      if (ae.id === 'searchInput') setFocus(ae);
      return;
    }
    const el = preferredFocus();
    if (el) setFocus(el);
  }

  function sweepStale() {
    $$('.focus').forEach((n) => { if (n !== focusEl) n.classList.remove('focus'); });
  }

  function move(dir) {
    const list = listFocusables();
    if (!list.length) return;
    if (!focusEl || !list.includes(focusEl)) { setFocus(list[0]); return; }

    const r = focusEl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    // 左上角线路名：点播磁贴再往左到品牌；品牌往右回到点播磁贴
    if (dir === 'left' && focusEl.id === 'tileVod') {
      const brand = $('#brandBtn');
      if (brand && isVisible(brand)) { setFocus(brand); return; }
    }
    if (dir === 'right' && focusEl.id === 'brandBtn') {
      const vod = $('#tileVod');
      if (vod && isVisible(vod)) { setFocus(vod); return; }
    }

    // 搜索入口：输入框 ↔ 右侧历史/热搜胶囊，左右贯通（顶栏搜索按钮已移除）
    if (typeof S !== 'undefined' && S.view === 'search') {
      const entry = $('#searchEntry');
      if (entry && !entry.classList.contains('hidden')) {
        const inp = $('#searchInput');
        const btn = $('#btnSearch');
        const asideChips = $$('#histChips .hot-chip, #hotChips .hot-chip').filter(isVisible);
        if (dir === 'right') {
          if (focusEl === inp && btn) { setFocus(btn); return; }
          if ((focusEl === inp || focusEl === btn) && asideChips.length) { setFocus(asideChips[0]); return; }
        } else if (dir === 'left') {
          if (asideChips.length && focusEl === asideChips[0] && btn) { setFocus(btn); return; }
          if (focusEl === btn || (asideChips.length && focusEl === asideChips[0])) { if (inp) setFocus(inp); return; }
        }
      }
    }

    // 海报按行往上退：先回到上一行同列卡片；只有当前已是第一行、上面没有卡片时，才回到顶部磁贴（按水平位置对齐）
    if (dir === 'up' && focusEl.classList.contains('card')) {
      const upCards = list
        .filter((el) => el !== focusEl && el.classList.contains('card'))
        .filter((el) => {
          const q = el.getBoundingClientRect();
          return q.top + q.height / 2 < r.top + r.height / 2 - 20;
        });
      if (upCards.length) {
        let upBest = null;
        let upScore = Infinity;
        for (const el of upCards) {
          const q = el.getBoundingClientRect();
          const dd = Math.abs(q.left + q.width / 2 - cx) + Math.abs(q.top + q.height / 2 - cy) * 0.5;
          if (dd < upScore) { upScore = dd; upBest = el; }
        }
        setFocus(upBest);
        return;
      }
      let tiles = list.filter((el) => el.classList.contains('nav-btn'));
      if (!tiles.length) {
        // 标题栏/磁贴行处于收起状态：先展开，再重新取可聚焦项
        document.body.classList.remove('home-header-collapsed');
        const list2 = listFocusables();
        tiles = list2.filter((el) => el.classList.contains('nav-btn'));
      }
      if (tiles.length) {
        // 按卡片在本行的列序号对齐到同序号磁贴（卡片网格与磁贴行边距不同，纯像素对齐会错位）
        const rowCards = list
          .filter((el) => el.classList.contains('card'))
          .filter((el) => {
            const q = el.getBoundingClientRect();
            return Math.abs(q.top + q.height / 2 - (r.top + r.height / 2)) < 20;
          })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        const colIdx = Math.max(0, rowCards.indexOf(focusEl));
        let tBest = tiles[Math.min(colIdx, tiles.length - 1)];
        if (!tBest) {
          let tScore = Infinity;
          for (const el of tiles) {
            const q = el.getBoundingClientRect();
            const dd = Math.abs(q.left + q.width / 2 - cx);
            if (dd < tScore) { tScore = dd; tBest = el; }
          }
        }
        setFocus(tBest);
        return;
      }
    }

    let best = null;
    let bestScore = Infinity;

    for (const el of list) {
      if (el === focusEl) continue;
      const q = el.getBoundingClientRect();
      const ex = q.left + q.width / 2;
      const ey = q.top + q.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;
      let score = Infinity;

      const sameRow = Math.abs(dy) < (r.height + q.height) / 2 * 0.9;
      if (dir === 'left' && dx < -3 && sameRow) score = Math.abs(dx) + Math.abs(dy) * 2.2;
      else if (dir === 'right' && dx > 3 && sameRow) score = Math.abs(dx) + Math.abs(dy) * 2.2;
      else if (dir === 'up' && dy < -3) score = Math.abs(dy) * 2.4 + Math.abs(dx);
      else if (dir === 'down' && dy > 3) score = Math.abs(dy) * 2.4 + Math.abs(dx);

      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { setFocus(best); return; }
    // 点播页：焦点在最后一张卡片继续往下，自动追加下一页
    if (dir === 'down' && focusEl && focusEl.classList.contains('card')
      && typeof S !== 'undefined' && S.view === 'category'
      && typeof window.loadNextCatPage === 'function') {
      window.loadNextCatPage();
    }
  }

  function activate(el) {
    if (!el) return;
    // 输入框：遥控器按 Enter 就是「进去输入」，不当作点击
    if (/^(input|textarea)$/i.test(el.tagName)) {
      clearFocus();
      el.focus();
      if (el.select) { try { el.select(); } catch (e) {} }
      return;
    }
    el.click();
  }

  /* 把整条滚动链回顶 */
  function resetScrollTop(el) {
    let n = el;
    while (n) {
      if (n.scrollTop) n.scrollTop = 0;
      n = n.parentElement;
    }
  }

  /* 回到首页并把焦点落到指定磁贴（默认「点播」磁贴） */
  function focusHomeTile(tileId) {
    document.body.classList.remove('home-header-collapsed');
    resetScrollTop($('#view-home'));
    const tile = $(tileId || '#tileVod');
    if (!tile) return;
    const land = () => {
      if (typeof S !== 'undefined' && S.view === 'home' && focusEl !== tile) setFocus(tile);
    };
    // 先解折叠再下一帧聚焦（折叠态磁贴行 display:none）；延迟一拍等 MutationObserver/autofocus 回稳后再落一次
    requestAnimationFrame(land);
    setTimeout(land, 160);
  }

  /* ---------- 返回 ---------- */
  function goBack() {
    if (!$('#playerPane').classList.contains('hidden')) {
      // 直播：先收左侧频道菜单，再退出播放
      if (S.play && S.play.mode === 'live' && !$('#epPanel').classList.contains('hidden')) {
        $('#epPanel').classList.add('hidden');
        if (typeof pNav !== 'undefined') pNav.mode = 'video';
        return;
      }
      closePlayer(); return;
    }
    // 弹窗：第一次 Esc 焦点先回落到底部「返回/取消」操作键；焦点已在操作键上时再按 Esc 才关闭弹窗
    if (!$('#modalPane').classList.contains('hidden')) {
      const modal = $('.modal');
      const backBtn = $('.modal-actions .btn');
      if (backBtn && isVisible(backBtn) && focusEl && focusEl !== backBtn && modal && modal.contains(focusEl)) {
        setFocus(backBtn);
        return;
      }
      hideModal(); focusHomeTile(); return;
    }
    if (!$('#detailPane').classList.contains('hidden')) { $('#detailPane').classList.add('hidden'); focusHomeTile(); return; }
    // 首页：无论焦点在卡片 / 磁贴 / 品牌等任意位置（含焦点已丢失），按 Esc 都直接回到顶部「点播」磁贴
    if (typeof S !== 'undefined' && S.view === 'home') {
      const tile = $('#tileVod');
      if (tile && focusEl !== tile) focusHomeTile();
      return;
    }
    // 点播分类页：第一级 Esc 焦点回到首个分类胶囊（初始位置）；已在首个分类时再按 Esc 才回首页点播磁贴
    if (typeof S !== 'undefined' && S.view === 'category') {
      const firstTab = $('#catTabs .tab');
      const picker = $('#view-category .site-tile');
      if (picker || !firstTab) { switchView('home'); focusHomeTile(); return; }
      if (!focusEl || focusEl !== firstTab) {
        resetScrollTop(firstTab);
        setFocus(firstTab);
        return;
      }
      switchView('home'); focusHomeTile(); return;
    }
    // 搜索结果屏：第一级 Esc 焦点先回到顶部「全部」胶囊（并切回全部）；已在「全部」上再按 Esc 才回搜索入口；入口再按回首页
    if (typeof S !== 'undefined' && S.view === 'search') {
      const entry = $('#searchEntry');
      const result = $('#searchResult');
      if (entry && result && !result.classList.contains('hidden') && entry.classList.contains('hidden')) {
        const all = $('#searchTabs .tab[data-si="-1"]');
        const onAll = !!(focusEl && focusEl.dataset && focusEl.dataset.si === '-1');
        if (!onAll && all && isVisible(all)) {
          if (typeof window.__searchShowAll === 'function') window.__searchShowAll();
          setFocus(all);
          return;
        }
        clearFocus();
        if (typeof window.__showSearchEntry === 'function') window.__showSearchEntry();
        const inp = $('#searchInput');
        if (inp) setFocus(inp);
        return;
      }
      // 已在搜索入口：回首页，焦点落到「搜索」磁贴
      switchView('home');
      focusHomeTile('#tileSearch');
      return;
    }
    // 其它整屏页（直播 / 搜索 / 收藏 / 设置）：回首页并落到点播磁贴
    switchView('home');
    focusHomeTile();
  }

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', (e) => {
    // 播放器内交给原生控件
    if (!$('#playerPane').classList.contains('hidden')) return;

    const tag = (e.target && e.target.tagName) || '';
    const isInput = /input|textarea|select/i.test(tag);

    if (e.key === 'Escape') { e.preventDefault(); goBack(); return; }
    if (e.key === 'Backspace') {
      if (isInput) return;           // 输入框里正常退格
      e.preventDefault(); goBack(); return;
    }
    if (isInput) {
      // 输入框里按 ↓ 直接进入屏幕键盘（安卓 TVBox 的做法）
      if (e.key === 'ArrowDown') {
        const osk = $('#osk');
        if (osk) {
          const keys = $$('.osk-key', osk).filter(isVisible);
          if (keys.length) { e.preventDefault(); e.target.blur(); setFocus(keys[0]); }
        }
        return;
      }
      // 搜索框：← → ↑ 交给遥控器导航（框住搜索框后可往右走到按钮/胶囊），其余按键留给光标
      const navKey = e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp';
      if (!(e.target && e.target.id === 'searchInput' && navKey)) return;
    }

    // 屏幕键盘最上面一排按 ↑ 回到输入框
    if (e.key === 'ArrowUp' && focusEl && focusEl.classList.contains('osk-key')) {
      const row = focusEl.closest('.osk-row');
      const firstRow = document.querySelector('#osk .osk-row');
      if (row && firstRow && row === firstRow) {
        const inp = $('#searchInput');
        if (inp) { e.preventDefault(); clearFocus(); inp.focus(); return; }
      }
    }

    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); move('left'); break;
      case 'ArrowRight': e.preventDefault(); move('right'); break;
      case 'ArrowUp': e.preventDefault(); move('up'); break;
      case 'ArrowDown': e.preventDefault(); move('down'); break;
      case 'Enter':
        if (focusEl) { e.preventDefault(); activate(focusEl); }
        break;
      case ' ':
        if (focusEl) { e.preventDefault(); activate(focusEl); }
        break;
      default: break;
    }
  }, true);

  /* ---------- 输入框获得焦点时让出遥控器焦点环 ---------- */
  document.addEventListener('focusin', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/input|textarea|select/i.test(tag)) {
      // 搜索框：光标留在框内，同时保留遥控器焦点环
      if (e.target && e.target.id === 'searchInput') return;
      clearFocus();
    }
  });
  document.addEventListener('focusout', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (/input|textarea|select/i.test(tag)) setTimeout(autofocus, 140);
  });

  /* ---------- 鼠标悬停即焦点 ---------- */
  let lastHover = 0;
  document.addEventListener('mousemove', (e) => {
    const target = e.target && e.target.closest ? e.target.closest(SEL) : null;
    if (!target || target === focusEl || !isVisible(target)) return;
    const scopeSel = currentScope();
    const scopeRoot = scopeSel ? $(scopeSel) : document.body;
    if (!scopeRoot || !scopeRoot.contains(target)) return;
    const now = Date.now();
    if (now - lastHover < 55) return;
    lastHover = now;
    setFocus(target);
  });

  /* ---------- 视图切换后自动聚焦 ---------- */
  const origSwitchView = window.switchView;
  window.switchView = function () {
    const args = arguments;
    origSwitchView.apply(window, args);
    document.body.classList.remove('home-header-collapsed');
    setTimeout(() => {
      clearFocus();
      // 首页固定先聚焦「点播」磁贴（TVBox 一进来焦点就在这），并且把首页滚回顶部
      if (typeof S !== 'undefined' && S.view === 'home') {
        const home = $('#view-home');
        if (home) home.scrollTop = 0;
        const tile = $('#tileVod');
        if (tile) { setFocus(tile); return; }
      }
      autofocus();
    }, 70);
  };

  /* ---------- 页面 / 浮层变化 ---------- */
  let moTimer = 0;
  const mo = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = setTimeout(() => {
      tickClock();
      if (!$('#playerPane').classList.contains('hidden')) return;
      autofocus();
    }, 140);
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });

  // 详情打开：把海报铺成背景，并聚焦主按钮（详情内容是异步渲染的，需重试）
  const detailPane = $('#detailPane');
  const detailMo = new MutationObserver(() => {
    if (detailPane.classList.contains('hidden')) return;
    let tries = 0;
    const tick = () => {
      if (detailPane.classList.contains('hidden')) return;
      const poster = $('#detailBody .d-shot');
      if (poster) {
        const bg = getComputedStyle(poster).backgroundImage;
        if (bg && bg.indexOf('url(') === 0) {
          detailPane.style.setProperty('--fanart', bg);
          $('#backdrop').style.backgroundImage = bg;
        }
      }
      const first = $('#btnPlayFirst');
      if (first) { setFocus(first); return; }
      if (tries++ < 8) setTimeout(tick, 180);
      else { const c = $('#detailClose'); if (c) setFocus(c); }
    };
    setTimeout(tick, 100);
  });
  detailMo.observe(detailPane, { attributes: true, attributeFilter: ['class'] });

  // 播放器关闭后回到详情主按钮
  const playerPane = $('#playerPane');
  const playerMo = new MutationObserver(() => {
    if (playerPane.classList.contains('hidden')) {
      const back = $('#btnPlayFirst') || $('#btnBackDetail');
      if (back) setFocus(back);
      autofocus();
    }
  });
  playerMo.observe(playerPane, { attributes: true, attributeFilter: ['class'] });

  /* ---------- 时钟 / 页脚 ---------- */
  function tickClock() {
    // 时钟交给 app.js 的状态区（时间 + 日期），这里只更新页脚文字
    if (typeof window.tickClock === 'function') window.tickClock();
    const right = $('#hintRight');
    if (right) {
      const usable = (S.sites || []).filter(isCmsSite).length;
      right.textContent = S.cfgName ? `${S.cfgName} · ${usable} 个站点` : '未加载接口';
    }
  }
  setInterval(tickClock, 20000);
  window.addEventListener('DOMContentLoaded', () => setTimeout(tickClock, 200));

  /* ---------- 启动后先聚焦菜单 ---------- */
  window.kodiFocus = () => focusEl;
  window.kodiMove = move;
  window.kodiSetFocus = (el) => { if (el) setFocus(el); };
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (!focusEl) autofocus();
    }, 900);
  });
})();
