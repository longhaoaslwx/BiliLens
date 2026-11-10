/* BiliLens for Bilibili Evolved — 组件主体。
 *
 * 由 build-evolved.mjs 与 runtime.js、src/lib/*.js 一起打包为一个 UMD 单文件。
 * 依赖注入：__M = { md5, wbi, clean, analyze, federated, profiler }
 * 复用的是与 Chrome/Edge 扩展完全相同的清洗层、完整 /analyze 画像引擎、
 * 多源解析器与规则画像，因此口径一致，不重复实现统计逻辑。
 */
const BL_DEFAULTS = {
  maxPages: 2,
  pageSize: 50,
  hideOnlyEnter: true,
  start: '',
  end: '',
  timeoutMs: 12000,
  ttlMin: 60,
  redact: false,
  sites: 'danmakus,danmakus_live,aicu,icu,zeroroku,vtbs'
};

const BL_TAG_UTILS = {
  name: 'utils', displayName: '工具', color: '#A36FFD',
  icon: 'mdi-rocket-launch-outline', order: 5
};

const blState = {
  ctx: null, root: null, shadow: null,
  uid: '', tab: 'overview', loading: false,
  progress: '', report: null, error: '',
  channelFilter: '', channelHideSingle: false
};

/* ------------------------------ 样式 ------------------------------ */

const BL_CSS = `
:host{all:initial;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#e8eaf0}
*{box-sizing:border-box}
.bl-launch{width:44px;height:44px;border-radius:50%;border:1px solid #3a3f4b;background:#1b1e25;
 color:#f0729a;cursor:pointer;display:flex;align-items:center;justify-content:center;
 box-shadow:0 6px 20px rgba(0,0,0,.35);font-size:17px;font-weight:700;letter-spacing:-1px}
.bl-launch:hover{border-color:#f0729a;transform:translateY(-1px)}
.bl-panel{position:fixed;right:18px;bottom:72px;width:720px;max-width:calc(100vw - 36px);
 height:min(660px,calc(100vh - 100px));background:#14161a;border:1px solid #333843;
 border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.55);display:flex;flex-direction:column;
 overflow:hidden;font-size:12px;color:#e8eaf0}
.bl-panel[hidden]{display:none}
.bl-head{display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid #2b303a;background:#191c22}
.bl-head h2{margin:0;font-size:14px;font-weight:600;flex:1;color:#f2f4f8}
.bl-head h2 small{font-weight:400;color:#8b93a3;margin-left:6px;font-size:11px}
input,button,select{font-family:inherit;font-size:12px}
.bl-input{background:#0f1115;border:1px solid #363c47;color:#e8eaf0;border-radius:6px;padding:6px 9px;outline:none}
.bl-input:focus{border-color:#f0729a}
.bl-btn{background:#242a34;border:1px solid #3b4250;color:#e8eaf0;border-radius:6px;padding:6px 11px;cursor:pointer}
.bl-btn:hover{border-color:#f0729a;color:#fff}
.bl-btn.primary{background:#f0729a;border-color:#f0729a;color:#1a1216;font-weight:600}
.bl-btn.primary:hover{background:#ff8fb0}
.bl-btn:disabled{opacity:.5;cursor:not-allowed}
.bl-close{background:none;border:0;color:#8b93a3;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px}
.bl-tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid #2b303a;background:#171a20;overflow-x:auto}
.bl-tab{background:none;border:0;border-bottom:2px solid transparent;color:#9aa2b1;padding:9px 11px;
 cursor:pointer;white-space:nowrap}
.bl-tab:hover{color:#e8eaf0}
.bl-tab.on{color:#f0729a;border-bottom-color:#f0729a}
.bl-body{flex:1;overflow-y:auto;padding:13px;scrollbar-width:thin;scrollbar-color:#3b4250 transparent}
.bl-body::-webkit-scrollbar{width:8px}.bl-body::-webkit-scrollbar-thumb{background:#3b4250;border-radius:4px}
.bl-toast{position:absolute;left:50%;top:8px;transform:translate(-50%,-14px);background:#2a303b;
 border:1px solid #4a5261;color:#fff;padding:7px 13px;border-radius:6px;opacity:0;
 transition:.2s;pointer-events:none;z-index:5;white-space:nowrap}
.bl-toast.show{opacity:1;transform:translate(-50%,0)}
.notice{background:#22262e;border-left:2px solid #f0729a;border-radius:6px;padding:9px 11px;
 color:#c7cdd8;line-height:1.65;margin-bottom:11px}
.notice.warn{border-left-color:#e0a44a}
.card{background:#1a1d23;border:1px solid #2e333d;border-radius:9px;margin-bottom:11px;overflow:hidden}
.card h3{margin:0;padding:10px 12px;font-size:12.5px;font-weight:600;border-bottom:1px solid #2b303a;color:#f2f4f8}
.card .sub{margin:0;padding:8px 12px 0;color:#8b93a3;line-height:1.6;font-size:11px}
.card .body{padding:11px 12px}
.empty{color:#8b93a3;padding:12px 0;text-align:center}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.m{background:#14171c;border:1px solid #2c313b;border-radius:7px;padding:8px 10px;min-width:0}
.m span{display:block;color:#8b93a3;font-size:10.5px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m b{font-size:14px;color:#f2f4f8;font-variant-numeric:tabular-nums;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:11.5px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #292e37;vertical-align:top}
th{color:#8b93a3;font-weight:500;white-space:nowrap;background:#16191f}
td{color:#d5dae4;word-break:break-all}
tr:last-child td{border-bottom:0}
.bar-row{display:flex;align-items:center;gap:8px;margin:5px 0}
.bar-label{width:132px;flex:none;color:#b8bfcc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{flex:1;height:9px;background:#101318;border-radius:5px;overflow:hidden}
.bar-track i{display:block;height:100%;background:linear-gradient(90deg,#f0729a,#b58bf5);border-radius:5px}
.bar-val{width:66px;flex:none;text-align:right;color:#e8eaf0;font-variant-numeric:tabular-nums}
.heat{display:grid;grid-template-columns:34px repeat(24,1fr);gap:2px;align-items:center}
.heat .hl{color:#8b93a3;font-size:10px;text-align:right;padding-right:4px}
.heat .hc{height:11px;border-radius:2px;background:#232833}
.heat-axis{display:grid;grid-template-columns:34px repeat(24,1fr);gap:2px;margin-top:3px}
.heat-axis span{color:#6f7787;font-size:8px;text-align:center}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.cal .cc{height:11px;border-radius:2px;background:#232833}
.cal-lbl{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;color:#6f7787;font-size:9px;text-align:center;margin-bottom:4px}
.word-cloud{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}
.word-chip{background:#242a35;border:1px solid #363d4a;border-radius:5px;padding:2px 7px;color:#dfe4ee}
.prob-row{margin:7px 0}
.prob-head{display:flex;justify-content:space-between;color:#c3cad6;margin-bottom:3px}
.prob-track{height:7px;background:#101318;border-radius:4px;overflow:hidden}
.prob-fill{display:block;height:100%;background:#f0729a;border-radius:4px}
.prob-note{color:#78808f;font-size:10.5px;margin-top:3px;line-height:1.5}
.dim{background:#14171c;border:1px solid #2f3540;border-left:2px solid #b58bf5;border-radius:7px;padding:10px 11px;margin-bottom:9px}
.dim h4{margin:0 0 3px;font-size:12px;color:#f2f4f8}
.dim .dn{color:#8b93a3;font-size:10.5px;line-height:1.5;margin-bottom:7px}
.dim .choice{display:inline-block;background:#3a2b3a;color:#ffb0c9;border-radius:4px;padding:2px 8px;margin-bottom:8px}
.drivers{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:5px;margin-top:8px}
.drivers div{color:#aeb6c4;font-size:11px}.drivers b{color:#e8eaf0;font-weight:500}
.stage{display:flex;gap:9px;background:#14171c;border:1px solid #2c313b;border-radius:7px;padding:8px 10px;margin-bottom:6px}
.stage i{flex:none;width:20px;height:20px;border-radius:50%;background:#f0729a;color:#1a1216;
 font-style:normal;font-weight:700;text-align:center;line-height:20px;font-size:11px}
.stage strong{display:block;color:#e8eaf0;margin-bottom:2px}.stage span{color:#8b93a3;line-height:1.5}
details{margin-top:8px}summary{cursor:pointer;color:#f0729a;padding:4px 0}
.kv{color:#aeb6c4;line-height:1.7}.kv b{color:#e8eaf0;font-weight:500}
.chip{display:inline-block;background:#242a35;border:1px solid #363d4a;border-radius:4px;padding:2px 7px;margin:2px 4px 2px 0;color:#c9d0dc}
.spin{display:inline-block;width:11px;height:11px;border:2px solid #4a5261;border-top-color:#f0729a;
 border-radius:50%;animation:blspin .8s linear infinite;vertical-align:-1px;margin-right:6px}
@keyframes blspin{to{transform:rotate(360deg)}}
`;

/* ------------------------------ 小工具 ------------------------------ */

function blEsc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function blVal(v) {
  if (v === null || v === undefined || v === '') return '不可用';
  if (typeof v === 'number') return Number.isFinite(v) ? v.toLocaleString('zh-CN') : '不可用';
  return String(v);
}

function blMetric(label, value) {
  return `<div class="m"><span>${blEsc(label)}</span><b>${blEsc(blVal(value))}</b></div>`;
}

function blCard(title, body, sub) {
  return `<section class="card"><h3>${blEsc(title)}</h3>${sub ? `<p class="sub">${blEsc(sub)}</p>` : ''}<div class="body">${body}</div></section>`;
}

function blTable(headers, rows) {
  // 调用方既会传行数组，也会传已拼好的行 HTML 字符串，这里统一成数组
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  if (!list.length) return '<div class="empty">暂无数据</div>';
  return `<table><thead><tr>${headers.map((h) => `<th>${blEsc(h)}</th>`).join('')}</tr></thead><tbody>${list.join('')}</tbody></table>`;
}

function blBars(rows, valueFormat) {
  const list = (rows || []).filter((r) => r && Number(r.count ?? r.value) > 0);
  if (!list.length) return '<div class="empty">暂无数据</div>';
  const max = Math.max(...list.map((r) => Number(r.count ?? r.value) || 0), 1);
  const fmt = valueFormat || ((n) => String(n));
  return list.map((r) => {
    const n = Number(r.count ?? r.value) || 0;
    return `<div class="bar-row"><span class="bar-label" title="${blEsc(r.key ?? r.label)}">${blEsc(r.key ?? r.label)}</span>` +
      `<div class="bar-track"><i style="width:${Math.max(2, (n / max) * 100).toFixed(1)}%"></i></div>` +
      `<span class="bar-val">${blEsc(fmt(n))}</span></div>`;
  }).join('');
}

function blHeat(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 7 || !Array.isArray(matrix[0])) return '<div class="empty">暂无数据</div>';
  const flat = matrix.flat().map(Number);
  const max = Math.max(...flat, 1);
  const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  let html = '<div class="heat">';
  for (let d = 0; d < 7; d++) {
    html += `<span class="hl">${days[d]}</span>`;
    for (let h = 0; h < 24; h++) {
      const v = Number(matrix[d][h]) || 0;
      const t = v / max;
      const bg = v === 0 ? '#232833' : `rgba(240,114,154,${(0.22 + t * 0.78).toFixed(2)})`;
      html += `<div class="hc" style="background:${bg}" title="${days[d]} ${String(h).padStart(2, '0')}:00 · ${v} 次"></div>`;
    }
  }
  html += '</div><div class="heat-axis"><span></span>';
  for (let h = 0; h < 24; h++) html += `<span>${h % 3 === 0 ? h : ''}</span>`;
  return html + '</div>';
}

function blCalendar(days) {
  const list = (days || []).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
  if (!list.length) return '<div class="empty">暂无数据</div>';
  const counts = new Map(list.map((d) => [d.date, Number(d.interactions) || 0]));
  const max = Math.max(...counts.values(), 1);
  const first = new Date(list[0].date + 'T00:00:00');
  const last = new Date(list[list.length - 1].date + 'T00:00:00');
  const span = Math.min(366, Math.round((last - first) / 86400000) + 1);
  const pad = (first.getDay() + 6) % 7; // 周一为第一列
  let html = '<div class="cal-lbl">' + ['一', '二', '三', '四', '五', '六', '日'].map((d) => `<span>${d}</span>`).join('') + '</div><div class="cal">';
  for (let i = 0; i < pad; i++) html += '<div></div>';
  for (let i = 0; i < span; i++) {
    const dt = new Date(first.getTime() + i * 86400000);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const v = counts.get(key) || 0;
    const bg = v === 0 ? '#232833' : `rgba(181,139,245,${(0.25 + (v / max) * 0.75).toFixed(2)})`;
    html += `<div class="cc" style="background:${bg}" title="${key} · ${v} 次互动"></div>`;
  }
  return html + '</div>';
}

function blLine(points) {
  const list = (points || []).filter((p) => p && Number.isFinite(Number(p.count ?? p.value)));
  if (list.length < 2) return '<div class="empty">样本点不足，无法绘制趋势</div>';
  const vals = list.map((p) => Number(p.count ?? p.value) || 0);
  const max = Math.max(...vals, 1);
  const W = 660, H = 130, P = 10;
  const xy = vals.map((v, i) => [
    P + (i / (vals.length - 1)) * (W - 2 * P),
    H - P - (v / max) * (H - 2 * P)
  ]);
  const line = xy.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${P},${H - P} ${line} ${W - P},${H - P}`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="130" preserveAspectRatio="none" role="img" aria-label="互动趋势折线图">` +
    `<line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#3a4150" stroke-width="1"/>` +
    `<polygon points="${area}" fill="rgba(240,114,154,.16)"/>` +
    `<polyline points="${line}" fill="none" stroke="#f0729a" stroke-width="2" stroke-linejoin="round"/>` +
    `</svg><div class="kv" style="display:flex;justify-content:space-between">` +
    `<span>${blEsc(list[0].key ?? list[0].date ?? '')}</span><span>峰值 ${blVal(max)}</span>` +
    `<span>${blEsc(list[list.length - 1].key ?? list[list.length - 1].date ?? '')}</span></div>`;
}

function blWordCloud(words) {
  const list = (words || []).slice(0, 40);
  if (!list.length) return '<div class="empty">暂无可用分词</div>';
  const max = Math.max(...list.map((w) => Number(w.value) || 0), 1);
  return '<div class="word-cloud">' + list.map((w) => {
    const size = 11 + Math.round((Number(w.value) || 0) / max * 13);
    return `<span class="word-chip" style="font-size:${size}px">${blEsc(w.name)}</span>`;
  }).join('') + '</div>';
}

function blProbs(list) {
  if (!Array.isArray(list) || !list.length) return '<div class="empty">有效样本不足，未给出概率分布</div>';
  return list.map((p) => {
    const pct = Math.round((Number(p.probability) || 0) * 100);
    return `<div class="prob-row"><div class="prob-head"><span>${blEsc(p.label)}</span><span>${pct}%</span></div>` +
      `<div class="prob-track"><i class="prob-fill" style="width:${Math.max(1, pct)}%"></i></div>` +
      (p.note ? `<div class="prob-note">${blEsc(p.note)}</div>` : '') + '</div>';
  }).join('');
}

function blDim(dim) {
  if (!dim) return '';
  const drivers = (dim.drivers || []).map((d) =>
    `<div>${blEsc(d.label)}：<b>${blEsc(d.value)}</b></div>`).join('');
  return `<div class="dim"><h4>${blEsc(dim.title)}</h4><div class="dn">${blEsc(dim.note)}</div>` +
    `<div class="choice">${blEsc(dim.label)} · 置信度 ${Math.round((dim.confidence || 0) * 100)}%</div>` +
    (dim.choiceNote ? `<div class="prob-note">${blEsc(dim.choiceNote)}</div>` : '') +
    blProbs(dim.probabilities) +
    (drivers ? `<details><summary>驱动指标（本机可复核规则）</summary><div class="drivers">${drivers}</div></details>` : '') +
    '</div>';
}

function blOptions() {
  const raw = (blState.ctx && blState.ctx.settings && blState.ctx.settings.options) || {};
  const o = { ...BL_DEFAULTS };
  Object.keys(BL_DEFAULTS).forEach((k) => { if (raw[k] !== undefined && raw[k] !== null) o[k] = raw[k]; });
  o.maxPages = Math.min(5, Math.max(1, Number(o.maxPages) || 2));
  o.pageSize = Math.min(50, Math.max(10, Number(o.pageSize) || 50));
  o.timeoutMs = Math.min(30000, Math.max(3000, Number(o.timeoutMs) || 12000));
  o.ttlMin = Math.min(1440, Math.max(1, Number(o.ttlMin) || 60));
  o.hideOnlyEnter = o.hideOnlyEnter !== false;
  o.redact = o.redact === true;
  const allowed = __M.federated.SITES.map((s) => s.id);
  o.siteIds = String(o.sites || '').split(/[\s,]+/).filter((id) => allowed.includes(id));
  return o;
}

/* ------------------------------ B 站官方接口 ------------------------------ */

async function blBiliJson(path, params) {
  const qs = Object.entries(params).map(([k, v]) =>
    `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `https://api.bilibili.com${path}?${qs}`;
  const res = await fetch(url, {
    method: 'GET', credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9' }
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { httpStatus: res.status, json, url };
}

async function blOfficial(uid) {
  const [card, relation] = await Promise.all([
    blBiliJson('/x/web-interface/card', { mid: uid, photo: 'false' }),
    blBiliJson('/x/relation/stat', { vmid: uid })
  ]);
  // 与扩展侧 bili-api.js 的 normalize() 保持一致：data 取响应体的 json.data
  const cardData = (card.json && card.json.data) || {};
  const relationData = (relation.json && relation.json.data) || {};
  const cardOk = !!(card.json && card.json.code === 0 && cardData.card);
  const relOk = !!(relation.json && relation.json.code === 0 && relation.json.data);
  if (!cardOk && !relOk) return { error: `官方接口不可用（card HTTP ${card.httpStatus} / relation HTTP ${relation.httpStatus}）` };
  const profile = __M.profiler.buildProfile({
    mid: String(uid),
    collectedAt: new Date().toISOString(),
    card: { ok: cardOk, data: cardData, code: card.json ? card.json.code : card.httpStatus, source: card.url },
    relation: {
      ok: relOk, data: relationData,
      code: relation.json ? relation.json.code : relation.httpStatus, source: relation.url
    }
  });
  return { profile, endpoints: [card.url, relation.url] };
}

/* ------------------------------ UID 识别 ------------------------------ */

function blDetectUid() {
  try {
    const href = String(location.href || '');
    let m = href.match(/space\.bilibili\.com\/(\d{1,19})/);
    if (m) return m[1];
    m = href.match(/[?&](?:mid|uid|host_mid|author_id)=(\d{1,19})/);
    if (m) return m[1];
    let w = null;
    try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow) w = unsafeWindow; } catch (_) { /* 忽略 */ }
    const st = w && w.__INITIAL_STATE__;
    if (st) {
      const candidates = [
        st.upData && st.upData.mid,
        st.videoData && st.videoData.owner && st.videoData.owner.mid,
        st.userInfo && st.userInfo.mid,
        st.UserInfo && st.UserInfo.mid
      ];
      for (const c of candidates) if (c && /^\d{1,19}$/.test(String(c))) return String(c);
    }
    const link = document.querySelector('a[href*="space.bilibili.com/"]');
    if (link) {
      m = String(link.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d{1,19})/);
      if (m) return m[1];
    }
  } catch (_) { /* 忽略 */ }
  return '';
}

/* ------------------------------ 各标签页渲染 ------------------------------ */

function blRenderOverview() {
  const r = blState.report;
  const p = r && r.profile;
  if (!p) return blCard('官方档案', '<div class="empty">本次未取到 B 站官方接口数据，请检查网络或稍后重试。</div>');
  const f = p.facts || {}, d = p.derived || {}, inf = p.inference || {};
  const facts = [
    blMetric('UID', p.mid), blMetric('昵称', f.name), blMetric('等级', f.level),
    blMetric('粉丝数', f.follower), blMetric('关注数', f.following),
    blMetric('认证', f.officialTitle), blMetric('投稿数', f.archiveCount),
    blMetric('专栏数', f.articleCount), blMetric('注册时间', f.regtimeAvailable ? new Date(f.regtime * 1000).toLocaleDateString('zh-CN') : null),
    blMetric('数据覆盖', `${Math.round((p.coverage || 0) * 100)}%`)
  ].join('');
  const derived = [
    blMetric('粉关比', d.followerFollowingRatio === null ? null : Number(d.followerFollowingRatio).toFixed(2)),
    blMetric('投稿样本', d.videoSampleCount), blMetric('平均播放', d.avgPlay),
    blMetric('平均评论', d.avgComment), blMetric('零播放率', `${Math.round((d.zeroPlayRate || 0) * 100)}%`),
    blMetric('标题模板率', `${Math.round((d.titleTemplateRate || 0) * 100)}%`),
    blMetric('深夜发布率', `${Math.round((d.nightPostRate || 0) * 100)}%`),
    blMetric('线索分', inf.score), blMetric('分档', inf.band)
  ].join('');
  const hits = (inf.hits || []).map((h) =>
    `<tr><td>${blEsc(h.id)}</td><td>${blEsc(h.label)}</td><td>${blEsc(h.weight)}</td><td>${blEsc(h.evidence)}</td></tr>`).join('');
  const skipped = (inf.skipped || []).map((s) =>
    `<tr><td>${blEsc(s.id)}</td><td colspan="3">${blEsc(s.reason)}</td></tr>`).join('');
  const sources = (p.sources || []).map((s) =>
    `<tr><td>${blEsc(s.field)}</td><td>${blEsc(s.endpoint)}</td><td>${s.ok ? '成功' : '未取到'}</td><td>${blEsc(s.code)}</td></tr>`).join('');
  return `<div class="notice"><strong>口径说明。</strong>facts 为接口可复核事实，derived 为统计量，inference 为规则命中；评分只表示人工复核优先级，不是身份认定或事实结论。注册时间多数为 0，按「平台未公开」处理，不据此推断账号年龄。</div>` +
    blCard('基础档案 · facts', `<div class="grid">${facts}</div>`) +
    blCard('派生统计 · derived', `<div class="grid">${derived}</div>`) +
    blCard('规则命中 · inference', blTable(['规则', '说明', '权重', '依据'], hits),
      `数据充分性：${inf.sufficient ? '充分' : '不足'}。${inf.disclaimer || ''}`) +
    blCard('跳过的规则', blTable(['规则', '原因'], skipped)) +
    blCard('数据源状态', blTable(['字段', '端点', '状态', '返回码'], sources));
}

function blRenderPortrait() {
  const r = blState.report;
  const fed = r && r.federated;
  const P = fed && fed.livePortrait;
  if (!P || P.dataBasis !== 'cleaned') {
    return `<div class="notice warn"><strong>数据口径提示。</strong>${P ? '画像数据未标记清洗来源，为保证口径一致已跳过渲染' : '本次聚合未产出完整弹幕画像，请重新聚合'}。</div>`;
  }
  const S = P.summary || {}, I = P.insights || {}, C = P.channelConcentration || {}, U = P.support || {};
  const samples = (P.samples || []).slice(0, 20).map((s) =>
    `<tr><td>${blEsc(s.day)} ${String(s.hour).padStart(2, '0')}:00</td><td>${blEsc(s.typeLabel)}</td>` +
    `<td>${blEsc(s.channel)}</td><td>${blEsc(s.area)}</td><td>${blEsc(s.message)}</td><td>${blEsc(s.price)}</td></tr>`).join('');
  const channels = (P.channelAffinities || []).map((c) =>
    `<tr data-bl-channel="${blEsc(c.channelName)}" data-bl-sessions="${blEsc(c.sessions)}">` +
    `<td>${blEsc(c.channelName)}</td><td>${blEsc(c.loyaltyScore)}</td><td>${blEsc(c.records)}</td>` +
    `<td>${blEsc(c.sessions)}</td><td>${blEsc(c.textCount ?? 0)}</td><td>${blEsc(c.activeDays ?? 0)}</td>` +
    `<td>${blEsc(c.fans)}</td><td>${blEsc((c.tags || []).join('、'))}</td>` +
    `<td>${blEsc(c.payment)}</td></tr>`).join('');
  const eventRows = (P.eventTypes || []).map((e) => ({ key: e.label, count: e.count }));
  const classRows = Object.entries(P.classLabels || {}).map(([k, label]) =>
    `<tr><td>${blEsc(label)}</td><td>${blEsc(k)}</td><td>${blEsc((P.classNotes || {})[k] || '')}</td></tr>`).join('');
  let html = `<div class="notice"><strong>完整聚合画像。</strong>对齐 Danmakus /analyze 页的统计维度与展示结构；全部字段由清洗后数据在本机计算，${blEsc(P.classificationNote || '')}</div>`;
  html += blCard('互动画像 · 概览指标', `<div class="grid">${[
    blMetric('取回场次', S.totalLives), blMetric('有留痕场次', S.appearanceLives),
    blMetric('有互动场次', S.interactiveLives), blMetric('打米场次', S.paidLives),
    blMetric('总留痕', S.totalTraces), blMetric('有效互动', S.totalInteractions),
    blMetric('弹幕数', S.totalMessages), blMetric('不重复弹幕', S.uniqueMessages),
    blMetric('打米总额(元)', S.totalPayment), blMetric('付费主播数', S.paidChannels),
    blMetric('活跃天数', S.activeDays), blMetric('最长连续活跃', S.longestStreak),
    blMetric('日均互动', S.avgPerActiveDay), blMetric('涉及主播', S.distinctChannels)
  ].join('')}</div>`, `覆盖范围：${blEsc(P.coverage && P.coverage.scopeNote || '')} · 已取 ${blVal(P.coverage && P.coverage.sessionFetched)} / 服务端 ${blVal(P.coverage && P.coverage.sessionTotal)} 场`);
  html += blCard('留痕构成', blBars((P.leaveTrace || []).map((g) => ({ key: g.label, count: g.count }))) +
    `<div class="kv" style="margin-top:8px">事件类型：${(P.eventTypes || []).map((e) => `${blEsc(e.label)} ${blEsc(e.count)}`).join(' · ') || '暂无'}</div>`,
    '弹幕 / 礼物 / 醒目留言 / 大航海 / 入场 / 禁言 / 其他，含各自金额占比。');
  html += blCard('活跃节律', `<div class="grid">${[
    blMetric('最长连续活跃', P.longestStreak),
    blMetric('常互动时段', P.rhythmPeak && P.rhythmPeak.label),
    blMetric('深夜至清晨', P.periodCounts && P.periodCounts.late_night),
    blMetric('上午及下午', P.periodCounts && P.periodCounts.daytime),
    blMetric('黄金档晚间', P.periodCounts && P.periodCounts.evening)
  ].join('')}</div><h4 style="margin:12px 0 6px;color:#f2f4f8">7×24 时段热力图</h4>${blHeat(P.rhythmMatrix)}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">活跃日历</h4>${blCalendar(P.activityDays)}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">互动趋势</h4>${blLine(P.activeDates)}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">时段分布</h4>${blBars((P.hourBuckets || []).map((b) => ({ key: `${b.key}:00`, count: b.count })))}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">星期分布</h4>${blBars((P.weekdayBuckets || []).map((b) => ({ key: b.label, count: b.count })))}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">月份分布</h4>${blBars((P.monthBuckets || []).map((b) => ({ key: b.key, count: b.count })))}`);
  html += blCard('频道偏好', `<div class="grid">${[
    blMetric('最亲密主播', P.channelAffinities && P.channelAffinities[0] && P.channelAffinities[0].channelName),
    blMetric('亲密度', P.channelAffinities && P.channelAffinities[0] && P.channelAffinities[0].loyaltyScore),
    blMetric('涉及主播', C.distinctChannels), blMetric('跨分区数', C.spanAreas),
    blMetric('Top1 占比', `${Math.round((C.top1Share || 0) * 100)}%`),
    blMetric('Top3 占比', `${Math.round((C.top3Share || 0) * 100)}%`),
    blMetric('HHI', C.hhi),
    blMetric('互动口径主播/分区', C.interactiveChannels === undefined ? null : `${C.interactiveChannels} / ${C.interactiveAreas}`)
  ].join('')}</div><div class="kv" style="margin:8px 0">${blEsc(C.note || '')}「互动口径」只统计有弹幕 / 礼物 / SC 等互动记录的主播与分区，不含仅入场场次。</div>` +
    `<div style="margin:8px 0"><input class="bl-input" data-bl-ch-filter placeholder="按主播名筛选（仅影响显示）" value="${blEsc(blState.channelFilter)}" style="width:260px"> ` +
    `<label class="kv"><input type="checkbox" data-bl-ch-single ${blState.channelHideSingle ? 'checked' : ''}> 隐藏仅 1 场</label></div>` +
    `<div data-bl-ch-table>${blTable(['主播', '亲密度', '记录', '场次', '弹幕', '活跃天', '粉丝量级', '标签', '打米(元)'], channels)}</div>` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">分区偏好</h4>${blBars((P.areas || []).map((a) => ({ key: a.name, count: a.count })))}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">主播标签</h4>${blBars((P.channelTagCounts || []).map((t) => ({ key: t.key, count: t.count })))}`);
  html += blCard('表达风格', `<div class="grid">${[
    blMetric('复读指数', `${I.repeaterIndex}x`),
    blMetric('不重复弹幕', `${Math.round((I.uniqueMessageRatio || 0) * 100)}%`),
    blMetric('表情弹幕', `${Math.round((I.emojiRatio || 0) * 100)}%`),
    blMetric('房间表情', I.roomEmojiRecords),
    blMetric('平均长度', `${I.avgMessageLength} 字`),
    blMetric('深夜发言', `${Math.round((I.nightOwlRatio || 0) * 100)}%`),
    blMetric('最常说', I.maxRepeatedText ? `${I.maxRepeatedText} ×${I.maxRepeatedCount}` : null)
  ].join('')}</div><h4 style="margin:12px 0 6px;color:#f2f4f8">词云</h4>${blWordCloud(I.wordCloud)}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">高频词</h4>${blBars((I.highFreqWords || []).map((w) => ({ key: w.text, count: w.count })))}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">重复文本</h4>${blBars((P.repeatedPhrases || []).map((p) => ({ key: p.example || p.key, count: p.count })))}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">关键词类别</h4>${blBars((I.lexicon || []).map((l) => ({ key: l.label, count: l.count })))}` +
    `<div class="kv" style="margin-top:8px">${blEsc(I.tokenizerNote || '')}</div>`);
  html += blCard('支持方式分类 · 打米(元) / 打米构成 / 其他互动', `<div class="grid">${[
    blMetric('打米总额', `${U.totalPayment} 元`), blMetric('打米场次', U.paidLives),
    blMetric('打米主播', U.paidChannels), blMetric('单笔最高', `${U.maxSinglePayment} 元`),
    blMetric('最多打给', U.topPaidChannel && U.topPaidChannel.name),
    blMetric('纯互动次数', U.otherInteractions)
  ].join('')}</div><h4 style="margin:12px 0 6px;color:#f2f4f8">打米构成</h4>` +
    blBars((U.breakdown || []).map((b) => ({ key: b.label, count: b.amount })), (n) => `${n} 元`) +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">单笔最高（Top 8）</h4>` +
    ((U.topPayments || []).length ? blTable(['金额(元)', '类型', '主播 · 时间', '内容 / 礼物名'],
      (U.topPayments || []).map((p) =>
        `<tr><td>${blEsc(p.amount)}</td><td>${blEsc(p.typeLabel || '—')}</td>` +
        `<td>${blEsc(p.channel || '—')} · ${blEsc(p.day || '')} ${String(p.hour).padStart(2, '0')}:00</td>` +
        `<td>${blEsc(P.coverage && P.coverage.redacted ? '（已隐藏）' : (p.text || '—'))}</td></tr>`))
      : '<div class="empty">样本中无付费记录</div>') +
    `<div class="kv" style="margin-top:8px">${blEsc(U.note || '')}</div>`);
  html += blCard('画像分类五维统计分组', (P.dimensions || []).map(blDim).join(''),
    '分类由本机可复核规则 + 明确列出的驱动指标计算，不是服务端模型输出。');
  html += blCard('全部分类说明', blTable(['分组名称', '标识', '说明'], classRows));
  html += blCard('所涉直播间画像', `<h4 style="margin:0 0 6px;color:#f2f4f8">主播标签</h4>${blBars(P.channelTagCounts)}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">机构 / 个人势</h4>${blBars(P.agencyCounts)}` +
    `<h4 style="margin:12px 0 6px;color:#f2f4f8">粉丝量级</h4>${blBars(P.fansScale)}` +
    `<div class="grid" style="margin-top:10px">${[
      blMetric('取回场次', P.liveScale && P.liveScale.sessions),
      blMetric('直播间累计观看人次', P.liveScale && P.liveScale.watchCount),
      blMetric('直播间场均观看', P.liveScale && P.liveScale.avgWatchCount),
      blMetric('直播间峰值同时在线', P.liveScale && P.liveScale.maxOnlineMax),
      blMetric('直播间累计付费人次', P.liveScale && P.liveScale.payCount)
    ].join('')}</div>` +
    `<div class="kv" style="margin-top:6px">以上均为主播与直播间的属性：累计口径（观看/付费）与场均口径不可相互比较，「累计付费人次」高于「场均观看」属口径差异，不是数据错误，也不代表目标用户的行为。</div>` +
    ((blState.report && blState.report.federated && blState.report.federated.liveAgencyUnresolved || []).length
      ? `<div class="kv">${blState.report.federated.liveAgencyUnresolved.length} 个机构 UUID 未能解析为名称，已保留原始值。</div>` : '') +
    ``, P.channelMetaNote);
  html += blCard('发言内容原始记录样本', blTable(['时间', '类型', '主播', '分区', '内容', '金额'], samples),
    `共展示 ${Math.min(20, (P.samples || []).length)} 条，来源为清洗后记录；脱敏开启时内容留空。`);
  return html;
}

const BL_STATUS_LABEL = {
  data: '有结构化数据', official: '官方档案', page_only: '仅页面可达',
  not_listed: '站点未收录', cooldown: '风控冷却', timeout: '超时 / 未查询', error: '请求失败'
};

function blRenderFederated() {
  const r = blState.report;
  const f = r && r.federated;
  if (!f) return '<div class="empty">暂无多源数据</div>';
  const statuses = (f.statuses || []).map((s) =>
    `<tr><td>${blEsc(s.siteName)}</td><td>${blEsc(BL_STATUS_LABEL[s.status] || s.status)}</td><td>${blEsc(s.httpStatus)}</td>` +
    `<td>${blEsc(s.elapsedMs)} ms</td><td>${s.cached ? '是' : '否'}</td>` +
    `<td>${blEsc(s.message)}</td><td><a href="${blEsc(s.pageUrl)}" target="_blank" rel="noopener" style="color:#f0729a">人工核验</a></td></tr>`).join('');
  const channels = (f.topChannels || []).map((c) =>
    `<tr><td>${blEsc(c.name)}</td><td>${blEsc(c.uid)}</td><td>${blEsc(c.totalDanmaku)}</td>` +
    `<td>${blEsc(c.liveCount)}</td><td>${blEsc(c.duplicateCount || 1)}</td><td>${blEsc((c.tags || []).join('、'))}</td></tr>`).join('');
  const evidence = (f.evidence || []).slice(0, 20).map((e) =>
    `<tr><td>${blEsc(e.site)}</td><td>${blEsc(e.label || e.type || '')}</td><td>${blEsc(e.text || e.value || '')}</td></tr>`).join('');
  const sources = (r.results || []).flatMap((x) => (x.sourceUrls || []).map((u) =>
    `<tr><td>${blEsc(x.siteName)}</td><td>${blEsc(u)}</td></tr>`)).join('');
  const timeoutNote = f.sitesTimedOut
    ? `<div class="notice"><strong>部分站点未查询。</strong>整轮聚合已达 120 秒上限，标记为「超时 / 未查询」的站点未发起请求；可减少勾选站点，或稍后单独重试。</div>`
    : '';
  return timeoutNote +
    `<div class="notice"><strong>第三方数据边界。</strong>${blEsc((r.profile && r.profile.federated && r.profile.federated.disclaimer) || '仅作证据与可视化，不作为事实结论。')}</div>` +
    blCard('关键指标', `<div class="grid">${[
      blMetric('查询站点', f.sitesTotal), blMetric('有数据站点', f.sitesWithData),
      blMetric('缓存命中', f.sitesCached), blMetric('失败 / 冷却', f.sitesFailed),
      blMetric('关注主播（去重后）', f.channelCount), blMetric('关注主播原始行', f.channelRawRowCount),
      blMetric('主播重复行移除', f.channelDuplicateRowsDropped),
      blMetric('第三方历史评论', f.replyTotal), blMetric('累计弹幕量', f.totalDanmaku),
      blMetric('弹幕清洗前记录', f.liveRawRecordCount),
      blMetric('ZeroRoku 趋势点', f.trendPoints), blMetric('最新粉丝', f.fansLatest),
      blMetric('VTBs 已收录', f.vtbsListed === null ? null : (f.vtbsListed ? '是' : '否'))
    ].join('')}</div>`) +
    blCard('站点状态矩阵', blTable(['站点', '状态', 'HTTP', '耗时', '缓存', '说明', '核验'], statuses)) +
    blCard('关注主播（去重后）', blTable(['主播', 'UID', '主播累计弹幕', '主播累计场次', '原始重复行', '标签'], channels),
      '「主播累计弹幕 / 场次」是 Danmakus 统计的主播频道级累计值，不是目标用户的行为数据；同一主播快照按场次重复返回，按 uId 去重后合并计数。') +
    blCard('AICU 评论分布', `<h4 style="margin:0 0 6px;color:#f2f4f8">月份</h4>${blBars(f.monthBuckets)}` +
      `<h4 style="margin:12px 0 6px;color:#f2f4f8">时段</h4>${blBars(f.hourBuckets)}`) +
    blCard('ZeroRoku 粉丝趋势', blLine((f.trend || []).map((t) => ({ key: t.date || t.day, count: t.fans ?? t.value ?? t.count })))) +
    blCard('证据片段', blTable(['来源', '类型', '内容'], evidence)) +
    blCard('实际请求端点', blTable(['站点', 'URL'], sources));
}

function blRenderCleaning() {
  const r = blState.report;
  const c = r && r.federated && r.federated.cleaning;
  if (!c) return '<div class="empty">本次报告不含清洗报告</div>';
  const stages = (__M.clean.CLEAN_STAGES || []).map((s, i) =>
    `<div class="stage"><i>${i + 1}</i><div><strong>${blEsc(s.label)}</strong><span>${blEsc(s.detail)}</span></div></div>`).join('');
  const t = c.totals || {};
  const sources = (c.sources || []).map((s) => {
    const n = s.counts || {};
    return `<tr><td>${blEsc(s.label || s.sourceId)}</td><td>${blEsc(s.inputRows)}</td><td>${blEsc(s.outputRows)}</td>` +
      `<td>${blEsc(n.fieldsNormalized || 0)}</td><td>${blEsc(n.missingHandled || 0)}</td>` +
      `<td>${blEsc((n.anomaliesRemoved || 0) + (n.anomaliesClamped || 0))}</td>` +
      `<td>${blEsc(n.duplicatesRemoved || 0)}</td></tr>`;
  }).join('');
  const details = (c.sources || []).map((s) => {
    const blocks = Object.entries(s.details || {}).map(([stage, items]) => {
      const lines = Object.entries(items || {}).map(([k, v]) =>
        `<div class="kv">${blEsc(k)}：<b>${blEsc(v)}</b></div>`).join('');
      return `<div style="margin-bottom:6px"><strong style="color:#f2f4f8">${blEsc(stage)}</strong>${lines || '<div class="kv">无命中</div>'}</div>`;
    }).join('');
    const notes = (s.notes || []).map((x) => `<div class="kv">· ${blEsc(x)}</div>`).join('');
    return `<div style="margin-bottom:12px"><strong style="color:#f0729a">${blEsc(s.label || s.sourceId)}</strong>${blocks}${notes}</div>`;
  }).join('');
  return `<div class="notice"><strong>所有图表的唯一数据入口。</strong>第三方原始结果先经过下列四道固定工序，之后才进入聚合与可视化；缺失不等于 0，被剔除或截断的条目逐项留痕。${blEsc(c.disclaimer || '')}</div>` +
    blCard('清洗工序', stages) +
    blCard('清洗前后计数', `<div class="grid">${[
      blMetric('清洗前记录', t.inputRows), blMetric('清洗后记录', t.outputRows),
      blMetric('去重移除', t.duplicatesRemoved), blMetric('缺失处理', t.missingHandled),
      blMetric('异常剔除', t.anomaliesRemoved), blMetric('异常截断', t.anomaliesClamped),
      blMetric('字段规范化', t.fieldsNormalized), blMetric('图表数据口径', c.chartDataBasis)
    ].join('')}</div>`) +
    blCard('逐源清洗计数', blTable(['数据源', '输入', '输出', '规范化', '缺失', '异常', '去重'], sources)) +
    blCard('逐项清洗明细', `<details><summary>展开规则与命中计数</summary>${details || '<div class="empty">无明细</div>'}</details>`) +
    blCard('清洗覆盖范围', (c.appliedTo || []).map((x) => `<span class="chip">${blEsc(x)}</span>`).join(''));
}

function blRenderSettings() {
  const o = blOptions();
  const rows = [
    ['组件版本', BL_VERSION], ['运行形态', 'Bilibili Evolved 用户组件'],
    ['弹幕历史最大页数', o.maxPages], ['每页场次', o.pageSize],
    ['隐藏仅入场', o.hideOnlyEnter ? '是' : '否'], ['本地日期起始', o.start || '不限'],
    ['本地日期结束', o.end || '不限'], ['单请求超时(ms)', o.timeoutMs],
    ['缓存 TTL(分钟)', o.ttlMin], ['导出脱敏', o.redact ? '是' : '否'],
    ['启用站点', o.siteIds.join('、') || '无']
  ].map(([k, v]) => `<tr><td>${blEsc(k)}</td><td>${blEsc(v)}</td></tr>`).join('');
  return `<div class="notice"><strong>设置位置。</strong>以上参数来自 Bilibili Evolved 设置面板中本组件的选项，修改后刷新页面生效。缓存只写在本机 localStorage，不上传任何数据。</div>` +
    blCard('当前配置', blTable(['项目', '取值'], rows)) +
    blCard('数据管理', '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="bl-btn" data-act="export-json">导出完整 JSON</button>' +
      '<button class="bl-btn" data-act="export-csv">导出 CSV</button>' +
      '<button class="bl-btn" data-act="clear-cache">清除本机缓存</button>' +
      '<button class="bl-btn" data-act="rerun">强制刷新聚合</button></div>') +
    blCard('合规边界', '<div class="kv">仅读取各站点按 UID 公开的页面与接口；不登录、不保存凭证、不做去匿名化人肉；遇风控只冷却不重试；第三方口径与时效性不受本工具控制；所有分类与评分只是人工复核优先级，不构成身份认定、性格判断或行为定性。</div>');
}

/* ------------------------------ 面板骨架与交互 ------------------------------ */

const BL_TABS = [
  { id: 'overview', label: '画像概览' },
  { id: 'portrait', label: '完整弹幕画像' },
  { id: 'federated', label: '多源数据' },
  { id: 'cleaning', label: '数据清洗' },
  { id: 'settings', label: '设置与导出' }
];

function blRender() {
  const shadow = blState.shadow;
  if (!shadow) return;
  const body = shadow.querySelector('[data-bl-body]');
  if (!body) return;
  shadow.querySelectorAll('[data-tab]').forEach((el) => {
    el.classList.toggle('on', el.getAttribute('data-tab') === blState.tab);
  });
  const runBtn = shadow.querySelector('[data-act="run"]');
  if (runBtn) runBtn.disabled = blState.loading;
  if (blState.loading) {
    body.innerHTML = `<div class="card"><div class="body"><span class="spin"></span>正在聚合 ${blEsc(blState.uid)} 的数据…</div></div>` +
      `<div class="kv" style="padding:6px 2px">${blEsc(blState.progress || '准备请求…')}</div>`;
    return;
  }
  if (blState.error) {
    body.innerHTML = `<div class="notice warn"><strong>出错了。</strong>${blEsc(blState.error)}</div>` +
      (blState.report ? blState.tab === 'portrait' ? blRenderPortrait() : '' : '');
    return;
  }
  if (!blState.report) {
    body.innerHTML = `<div class="notice"><strong>使用方式。</strong>在上方输入 B 站 UID（或让组件自动识别当前页面用户），点击「分析」。组件会采集 B 站官方档案、七个多源查询项，先做去重 / 缺失 / 异常 / 字段规范化，再产出完整弹幕聚合画像。</div>` +
      `<div class="card"><h3>数据口径</h3><div class="body kv">${(__M.clean.CLEAN_STAGES || []).map((s, i) => `${i + 1}. ${blEsc(s.label)} — ${blEsc(s.detail)}`).join('<br>')}</div></div>`;
    return;
  }
  const map = {
    overview: blRenderOverview, portrait: blRenderPortrait,
    federated: blRenderFederated, cleaning: blRenderCleaning, settings: blRenderSettings
  };
  body.innerHTML = (map[blState.tab] || blRenderOverview)();
}

function blApplyChannelFilter() {
  const shadow = blState.shadow;
  if (!shadow || blState.tab !== 'portrait') return;
  const q = String(blState.channelFilter || '').trim();
  let re = null;
  if (/^\/.*\/$/.test(q)) { try { re = new RegExp(q.slice(1, -1), 'i'); } catch (_) { /* 忽略 */ } }
  shadow.querySelectorAll('[data-bl-channel]').forEach((tr) => {
    const name = tr.getAttribute('data-bl-channel') || '';
    const sessions = Number(tr.getAttribute('data-bl-sessions')) || 0;
    const matchText = !q || (re ? re.test(name) : name.toLowerCase().includes(q.toLowerCase()));
    const matchSingle = !blState.channelHideSingle || sessions > 1;
    tr.style.display = matchText && matchSingle ? '' : 'none';
  });
}

let blNavTimer = null;
let blLastHref = '';

function blSetAutofill(shadow, text, ok) {
  const el = shadow && shadow.querySelector('[data-bl-autofill]');
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? '#6ccf9c' : '#9ba4b3';
}

/** 从当前页面重新识别 UID；force=true 覆盖用户已输入的值。 */
function blDetectAndFill(shadow, uidInput, options) {
  const opts = options || {};
  const uid = blDetectUid();
  if (uid && uidInput && (opts.force || !String(uidInput.value || '').trim())) uidInput.value = uid;
  if (uid) {
    blState.uid = uid;
    blSetAutofill(shadow, `已自动识别当前页面 UID ${uid}`, true);
  } else {
    blSetAutofill(shadow, '当前页面未识别到 UID，请手动输入', false);
  }
  if (opts.toast) {
    try { blToast(uid ? `已识别当前页面 UID ${uid}` : '当前页面未识别到 UID', uid ? 'success' : 'error'); }
    catch (_) { /* 忽略 */ }
  }
  return uid;
}

/** B 站是 SPA：pushState 导航不会重新挂载组件，需轮询地址变化并重新识别。 */
function blWatchNavigation(shadow, uidInput) {
  try { blLastHref = String(location.href || ''); } catch (_) { return; }
  if (typeof setInterval !== 'function') return;
  if (blNavTimer) clearInterval(blNavTimer);
  blNavTimer = setInterval(() => {
    let href = '';
    try { href = String(location.href || ''); } catch (_) { return; }
    if (href === blLastHref) return;
    blLastHref = href;
    const uid = blDetectUid();
    if (uid && uidInput) {
      uidInput.value = uid;
      blState.uid = uid;
      blSetAutofill(shadow, `页面已跳转，自动识别 UID ${uid}`, true);
    } else if (!uid) {
      blSetAutofill(shadow, '当前页面未识别到 UID，请手动输入', false);
    }
  }, 1_500);
}

function blMount() {
  if (blState.root && document.body.contains(blState.root)) return;
  const host = document.createElement('div');
  host.className = 'bililens-evolved-root';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${BL_CSS}</style>` +
    `<div class="bl-toast" data-bl-toast></div>` +
    `<button class="bl-launch" data-act="toggle" title="BiliLens · B站用户画像">BL</button>` +
    `<div class="bl-panel" hidden>` +
    `<div class="bl-head"><h2>BiliLens <small>用户画像与弹幕聚合 · v${BL_VERSION}</small></h2>` +
    `<input class="bl-input" data-bl-uid placeholder="B 站 UID" style="width:130px" value="">` +
    `<button class="bl-btn primary" data-act="run">分析</button>` +
    `<button class="bl-btn" data-act="rerun">刷新</button>` +
    `<button class="bl-btn" data-act="detect" title="重新识别当前页面 UID">识别</button>` +
    `<button class="bl-close" data-act="toggle" aria-label="关闭">×</button></div>` +
    `<div data-bl-autofill style="padding:3px 10px;font-size:11px;color:#6ccf9c;background:rgba(108,207,156,.08);border-bottom:1px solid rgba(108,207,156,.2)"></div>` +
    `<div class="bl-tabs">${BL_TABS.map((t) => `<button class="bl-tab${t.id === 'overview' ? ' on' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}</div>` +
    `<div class="bl-body" data-bl-body></div></div>`;
  blState.root = host;
  blState.shadow = shadow;
  const uidInput = shadow.querySelector('[data-bl-uid]');
  blDetectAndFill(shadow, uidInput, {});
  blWatchNavigation(shadow, uidInput);

  shadow.addEventListener('click', (event) => {
    const target = event.target;
    const el = target && typeof target.closest === 'function'
      ? target.closest('[data-act], [data-tab]') : null;
    if (!el) return;
    const tab = el.getAttribute('data-tab');
    if (tab) { blState.tab = tab; blRender(); blApplyChannelFilter(); return; }
    const act = el.getAttribute('data-act');
    if (act === 'toggle') {
      const panel = shadow.querySelector('.bl-panel');
      if (panel) panel.hidden = !panel.hidden;
      if (!panel.hidden) blRender();
    } else if (act === 'run') blRun((uidInput && uidInput.value || '').trim(), false);
    else if (act === 'rerun') blRun((uidInput && uidInput.value || '').trim(), true);
    else if (act === 'detect') blDetectAndFill(shadow, uidInput, { force: true, toast: true });
    else if (act === 'export-json') blExport('json');
    else if (act === 'export-csv') blExport('csv');
    else if (act === 'clear-cache') {
      blClearCache();
      blToast('已清除本机缓存', 'success');
    }
  });
  shadow.addEventListener('input', (event) => {
    const t = event.target;
    if (t && t.matches('[data-bl-ch-filter]')) {
      blState.channelFilter = t.value;
      blApplyChannelFilter();
    }
  });
  shadow.addEventListener('change', (event) => {
    const t = event.target;
    if (t && t.matches('[data-bl-ch-single]')) {
      blState.channelHideSingle = !!t.checked;
      blApplyChannelFilter();
    }
  });
  shadow.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target && event.target.matches('[data-bl-uid]')) {
      blRun(String(event.target.value || '').trim(), false);
    }
  });
}

function blUnmount() {
  if (blNavTimer) { clearInterval(blNavTimer); blNavTimer = null; }
  if (blState.root && blState.root.parentNode) blState.root.parentNode.removeChild(blState.root);
  blState.root = null;
  blState.shadow = null;
}

/* ------------------------------ 编排 ------------------------------ */

async function blRun(uid, force) {
  if (blState.loading) return;
  if (!/^\d{1,19}$/.test(String(uid || ''))) {
    blToast('请输入纯数字 B 站 UID', 'error');
    return;
  }
  blState.uid = String(uid);
  blState.loading = true;
  blState.error = '';
  blState.progress = '采集 B 站官方档案…';
  blState.report = null;
  blRender();
  const opts = blOptions();
  try {
    let profile = null;
    let officialError = '';
    try {
      const official = await blOfficial(blState.uid);
      if (official.profile) profile = official.profile;
      else officialError = official.error || '官方接口不可用';
    } catch (error) {
      officialError = String(error && error.message ? error.message : error);
    }
    const results = await __M.federated.queryAll(blState.uid, {
      siteIds: opts.siteIds,
      force: !!force,
      deadlineAt: Date.now() + 120_000,
      ttlMin: opts.ttlMin,
      timeoutMs: opts.timeoutMs,
      redact: opts.redact,
      federatedLiveMaxPages: opts.maxPages,
      federatedLivePageSize: opts.pageSize,
      federatedLiveHideOnlyEnter: opts.hideOnlyEnter,
      federatedLiveStart: String(opts.start || ''),
      federatedLiveEnd: String(opts.end || ''),
      onProgress: (i, n, site) => {
        blState.progress = `多源聚合 ${i}/${n} · ${site.siteName}：${site.status}`;
        const body = blState.shadow && blState.shadow.querySelector('[data-bl-body]');
        const note = body && body.querySelector('.kv');
        if (note) note.textContent = blState.progress;
      }
    });
    const summary = __M.federated.summarizeFederated(results);
    if (profile) {
      __M.profiler.mergeFederated(profile, summary);
      __M.profiler.scoreProfiles([profile], {
        enableKeywordScoring: false, federatedScoring: false, cohortReady: false
      });
    }
    blState.report = {
      uid: blState.uid,
      generatedAt: new Date().toISOString(),
      profile, officialError,
      federated: summary,
      results,
      options: opts,
      dataBasis: summary.dataBasis,
      version: BL_VERSION
    };
    if (officialError) blToast(`官方档案未取到：${officialError}`, 'error');
    else blToast('聚合完成', 'success');
  } catch (error) {
    blState.error = String(error && error.message ? error.message : error);
  } finally {
    blState.loading = false;
    blRender();
    blApplyChannelFilter();
  }
}

function blExport(kind) {
  const r = blState.report;
  if (!r) { blToast('请先完成一次分析', 'error'); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (kind === 'json') {
    blDownload(`BiliLens-${r.uid}-${stamp}.json`, JSON.stringify(r, null, 2), 'application/json;charset=utf-8');
  } else {
    let p = r.profile;
    if (!p) {
      p = __M.profiler.buildProfile({ mid: r.uid, collectedAt: r.generatedAt });
      __M.profiler.scoreProfiles([p], {});
    }
    if (!p.federated) __M.profiler.mergeFederated(p, r.federated);
    blDownload(`BiliLens-${r.uid}-${stamp}.csv`, '\ufeff' + __M.profiler.toCsv([p]), 'text/csv;charset=utf-8');
  }
  blToast('已导出到下载目录', 'success');
}

/* ------------------------------ 组件元数据 ------------------------------ */

const component = {
  name: 'bililensUserProfile',
  displayName: 'BiliLens · B站用户画像与弹幕聚合',
  description: '在 B 站页面按 UID 采集官方档案与第三方公开聚合数据，先做去重 / 缺失 / 异常 / 字段规范化，再输出完整弹幕行为画像、多源证据与可视化。与 Chrome / Edge 扩展同源同口径。',
  tags: [BL_TAG_UTILS],
  enabledByDefault: true,
  configurable: true,
  urlInclude: [/bilibili\.com\//],
  options: {
    maxPages: { defaultValue: BL_DEFAULTS.maxPages, displayName: '弹幕历史最大页数', slider: { min: 1, max: 5, step: 1 } },
    pageSize: { defaultValue: BL_DEFAULTS.pageSize, displayName: '每页场次', slider: { min: 10, max: 50, step: 10 } },
    hideOnlyEnter: { defaultValue: BL_DEFAULTS.hideOnlyEnter, displayName: '隐藏仅入场记录' },
    start: { defaultValue: BL_DEFAULTS.start, displayName: '本地筛选起始日期 (YYYY-MM-DD)' },
    end: { defaultValue: BL_DEFAULTS.end, displayName: '本地筛选结束日期 (YYYY-MM-DD)' },
    timeoutMs: { defaultValue: BL_DEFAULTS.timeoutMs, displayName: '单请求超时 (ms)' },
    ttlMin: { defaultValue: BL_DEFAULTS.ttlMin, displayName: '缓存有效期 (分钟)' },
    redact: { defaultValue: BL_DEFAULTS.redact, displayName: '导出与样本脱敏' },
    sites: { defaultValue: BL_DEFAULTS.sites, displayName: '启用站点（逗号分隔的站点 ID）', multiline: true }
  },
  entry: (context) => {
    blState.ctx = context || null;
    try {
      if (!/bilibili\.com\//.test(String(location.href || ''))) return {};
      if (!document.body) {
        const start = () => blMount();
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
      } else blMount();
    } catch (error) {
      try { blToast('BiliLens 组件启动失败：' + String(error), 'error'); } catch (_) { /* 忽略 */ }
    }
    return { version: BL_VERSION, analyze: blRun };
  },
  reload: () => { try { blMount(); } catch (_) { /* 忽略 */ } },
  unload: () => { try { blUnmount(); } catch (_) { /* 忽略 */ } }
};
