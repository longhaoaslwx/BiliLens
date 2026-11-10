/* B 站页面侧脚本。
 * 职责：
 *  1) 在 www.bilibili.com 页面上下文代发 API 请求（Referer / Cookie 与站内一致，
 *     CORS 头 Access-Control-Allow-Origin: https://www.bilibili.com 已实测可用）；
 *  2) 识别当前页的 UID / BV 号 / 评论区用户，供弹窗「使用当前页面」使用；
 *  3) 提供一个隔离样式的浮动入口，展示简要结果，完整报告在扩展弹窗中查看。
 */
(() => {
  const PREFIX = 'bililens';

  function detect() {
    const url = location.href;
    const context = { url, type: 'other', mids: [] };
    // 地址优先：B 站是 SPA，DOM 里的用户链接往往晚于地址栏变化
    const space = url.match(/space\.bilibili\.com\/(\d{1,19})(?:[/?#]|$)/i);
    const param = url.match(/[?&](?:mid|uid|host_mid|author_id|up_mid)=(\d{1,19})(?:[&#]|$)/i);
    const fromUrl = space ? space[1] : (param ? param[1] : '');
    if (fromUrl) { context.type = 'user'; context.mid = fromUrl; }
    const bv = url.match(/(BV[0-9A-Za-z]{10})/);
    if (bv) { context.type = 'video'; context.bvid = bv[0]; }

    const found = new Set();
    if (context.mid) found.add(context.mid);
    document.querySelectorAll('a[href*="space.bilibili.com/"]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/i);
      if (m) found.add(m[1]);
    });
    document.querySelectorAll('[data-user-id], [data-mid], [data-usermid]').forEach((el) => {
      const v = el.getAttribute('data-user-id') || el.getAttribute('data-mid') || el.getAttribute('data-usermid');
      if (/^\d+$/.test(v || '')) found.add(v);
    });
    context.mids = [...found].slice(0, 200);
    return context;
  }

  let currentContext = detect();

  function send(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => resolve(response || { ok: false, error: '后台无响应' }));
    });
  }

  function reportContext() {
    currentContext = detect();
    chrome.runtime.sendMessage({ type: 'SET_PAGE_CONTEXT', context: currentContext }).catch(() => {});
    renderPanel();
  }

  /* ------------------------------ 浮层 UI ------------------------------ */

  const SHEET_CSS = `
    :host { all: initial; font-variant-numeric: tabular-nums; }
    * { box-sizing: border-box; }
    .fab {
      width: 42px; height: 42px; border-radius: 50%; border: 1px solid #3a4150;
      background: #1b1e24; color: #f0729a; display: grid; place-items: center;
      cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.45);
    }
    .fab:hover { border-color: #f0729a; }
    .fab svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
    .panel {
      position: absolute; right: 0; bottom: 52px; width: 296px;
      background: #1b1e24; color: #e9ecf2; border: 1px solid #303641;
      border-radius: 10px; padding: 14px; box-shadow: 0 12px 36px rgba(0,0,0,.55);
      font: 12px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .hidden { display: none; }
    .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .title { font-size: 13px; font-weight: 600; }
    .close { background: none; border: 0; color: #9ba4b3; font-size: 17px; cursor: pointer; line-height: 1; }
    .row { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; color: #9ba4b3; }
    .row strong { color: #e9ecf2; font-weight: 500; word-break: break-all; text-align: right; }
    .btn {
      display: block; width: 100%; margin-top: 8px; padding: 8px 10px; border-radius: 7px;
      border: 1px solid #303641; background: #22262e; color: #e9ecf2; font: inherit;
      font-size: 11px; text-align: center; cursor: pointer;
    }
    .btn.primary { background: #f0729a; color: #1a1015; border-color: transparent; font-weight: 600; }
    .btn:hover { border-color: #f0729a; }
    .btn:disabled { opacity: .55; cursor: default; }
    .out { margin-top: 10px; padding: 9px; border-radius: 7px; background: #22262e; font-size: 11px; color: #9ba4b3; }
    .out b { color: #f0729a; font-size: 18px; }
    .out .hint { color: #6e7787; margin-top: 5px; }
    .foot { margin-top: 10px; font-size: 10px; color: #6e7787; }
  `;

  const ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>`;

  let host = null;
  let shadow = null;
  let panelOpen = false;

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function buildUI() {
    if (document.getElementById(PREFIX + '-root')) return;
    host = document.createElement('div');
    host.className = 'bililens-root';
    host.id = PREFIX + '-root';
    shadow = host.attachShadow({ mode: 'closed' });
    let cssInjected = false;
    if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet !== 'undefined') {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(SHEET_CSS);
        shadow.adoptedStyleSheets = [sheet];
        cssInjected = true;
      } catch { /* 回退到内联样式 */ }
    }
    shadow.innerHTML = `
      ${cssInjected ? '' : `<style>${SHEET_CSS}</style>`}
      <button class="fab" id="fab" title="BiliLens 页面画像">${ICON}</button>
      <div class="panel hidden" id="panel">
        <div class="head"><span class="title">BiliLens · 当前页面</span><button class="close" id="close">×</button></div>
        <div id="body"></div>
        <div class="out hidden" id="out"></div>
        <div class="foot">完整报告、证据链与导出请打开扩展弹窗。</div>
      </div>`;
    document.body.appendChild(host);

    shadow.getElementById('fab').addEventListener('click', () => {
      panelOpen = !panelOpen;
      shadow.getElementById('panel').classList.toggle('hidden', !panelOpen);
      if (panelOpen) renderPanel();
    });
    shadow.getElementById('close').addEventListener('click', () => {
      panelOpen = false;
      shadow.getElementById('panel').classList.add('hidden');
    });
  }

  function renderPanel() {
    if (!shadow) return;
    const ctx = currentContext;
    const body = shadow.getElementById('body');
    if (!body) return;
    const label = ctx.type === 'user' ? '用户主页'
      : ctx.type === 'video' ? '视频页面' : 'B 站页面';
    let rows = `<div class="row"><span>页面类型</span><strong>${label}</strong></div>`;
    if (ctx.mid) rows += `<div class="row"><span>UID</span><strong>${esc(ctx.mid)}</strong></div>`;
    if (ctx.bvid) rows += `<div class="row"><span>BV 号</span><strong>${esc(ctx.bvid)}</strong></div>`;
    rows += `<div class="row"><span>页面识别到的用户</span><strong>${ctx.mids.length} 个</strong></div>`;
    const actions = ctx.type === 'user'
      ? `<button class="btn primary" id="act-user">画像此用户</button>`
      : ctx.type === 'video'
        ? `<button class="btn primary" id="act-video">分析本视频评论区</button>`
        : `<button class="btn primary" id="act-first">画像首个识别到的用户</button>`;
    body.innerHTML = rows + (ctx.mid || ctx.bvid || ctx.mids.length ? actions : '');

    const userBtn = shadow.getElementById('act-user') || shadow.getElementById('act-first');
    if (userBtn) userBtn.addEventListener('click', () => quickUser(userBtn, ctx.mid || ctx.mids[0]));
    const videoBtn = shadow.getElementById('act-video');
    if (videoBtn) videoBtn.addEventListener('click', () => quickVideo(videoBtn, ctx.bvid));
  }

  function showOut(html) {
    const out = shadow.getElementById('out');
    out.innerHTML = html;
    out.classList.remove('hidden');
  }

  async function quickUser(button, mid) {
    if (!mid) return;
    button.disabled = true;
    button.textContent = '采集中…';
    try {
      const res = await send({ type: 'PROFILE_USER', input: mid });
      if (!res.ok) { showOut(`<div>${esc(res.error)}</div>`); return; }
      const p = res.report.profiles[0];
      const inf = p.inference || { score: 0, band: '—', hits: [] };
      showOut(`<div>${esc(p.facts.name)} · 线索分 <b>${inf.score}</b> ${esc(inf.band)}</div>
        <div>${inf.hits.slice(0, 3).map((h) => esc(h.id) + ' ' + esc(h.label)).join('；') || '无规则命中'}</div>
        <div class="hint">数据覆盖 ${Math.round(p.coverage * 100)}%，评分为线索优先级，需人工核验。</div>`);
    } finally {
      button.disabled = false;
      button.textContent = ctxLabel(button.id);
    }
  }

  function ctxLabel(id) {
    return id === 'act-video' ? '分析本视频评论区'
      : id === 'act-first' ? '画像首个识别到的用户' : '画像此用户';
  }

  async function quickVideo(button, bvid) {
    button.disabled = true;
    button.textContent = '分析中…';
    try {
      const res = await send({ type: 'ANALYZE_VIDEO', videoInput: bvid });
      if (!res.ok) { showOut(`<div>${esc(res.error)}</div>`); return; }
      const r = res.report;
      showOut(`<div>已分析 <b>${r.summary.profileCount}</b> 位评论者 · 平均分 ${r.summary.averageScore}</div>
        <div>关联线索簇 ${r.summary.clusterCount} 个 · 评论证据 ${r.comments.length} 条</div>
        <div class="hint">仅覆盖前 ${r.summary.profileCount} 位评论者，请在扩展弹窗中查看逐条证据并导出。</div>`);
    } finally {
      button.disabled = false;
      button.textContent = '分析本视频评论区';
    }
  }

  /* ------------------------------ 消息 ------------------------------ */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;
    if (message.type === 'BILILENS_GET_PAGE_CONTEXT') {
      sendResponse({ ok: true, context: detect() });
      return;
    }
    if (message.type === 'BILILENS_PAGE_FETCH') {
      // 仅在 www.bilibili.com 页面上下文执行，保证 Referer 与 CORS 正确。
      // 必须给 fetch 加硬超时：页面被冻结 / 接口挂起时，若此处不回调，
      // 后台的 tabs.sendMessage 会永久 pending，整轮聚合就会卡在「聚合中…」。
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      let replied = false;
      const reply = (payload) => {
        if (replied) return;
        replied = true;
        try { sendResponse(payload); } catch { /* 通道已关闭 */ }
      };
      fetch(message.url, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
        headers: { Accept: 'application/json, text/plain, */*' }
      })
        .then(async (res) => {
          let json = null;
          try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
          reply({ ok: res.ok, status: res.status, json });
        })
        .catch((error) => reply({ ok: false, error: `页面请求失败或超时：${String(error)}` }))
        .finally(() => clearTimeout(timer));
      return true;
    }
  });

  /* ------------------------------ 生命周期 ------------------------------ */

  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    buildUI();
    reportContext();
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        reportContext();
      }
    }, 1500);
  }

  boot();
})();
