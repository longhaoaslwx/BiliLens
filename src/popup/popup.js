const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (value) => Number(value || 0).toLocaleString('zh-CN');
const ts = (sec) => sec ? new Date(Number(sec) * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
const safeUrl = (value) => {
  try {
    const u = new URL(String(value));
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '#';
  } catch { return '#'; }
};

const send = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (response) => {
    resolve(response || { ok: false, error: '后台无响应，请重新打开弹窗' });
  });
});

const state = {
  settings: null,
  report: null,
  pageContext: null,
  federatedSites: [],
  federatedSelected: new Set(),
  federatedReport: null
};

function setStatus(text, kind = '') {
  $('#status-text').textContent = text;
  const dot = $('#status-dot');
  dot.className = 'dot' + (kind ? ' ' + kind : '');
}

function setProgress(done, total, message, phase) {
  const wrap = $('#progress-wrap');
  if (!total) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  $('#progress-fill').style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  setStatus(message || `${phase || '处理中'} ${done}/${total}`, 'busy');
}

function hideProgress() {
  $('#progress-wrap').classList.add('hidden');
  $('#progress-fill').style.width = '0';
}

function setBusy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || '处理中…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function showError(container, message) {
  container.innerHTML = `<div class="error">${esc(message)}</div>`;
}

function switchTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

/* ------------------------------ 画像渲染 ------------------------------ */

function renderSourceRows(profile) {
  return profile.sources.map((s) => {
    const cls = s.ok ? 'ok' : (s.code === 'NOT_CALLED' ? 'na' : 'fail');
    const label = s.ok ? '已取得' : (s.code === 'NOT_CALLED' ? '未调用' : `失败 ${esc(s.code)}`);
    const time = s.source && s.source.fetchedAt ? new Date(s.source.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    return `<div class="source-row">
      <span class="pill ${cls}">${label}</span>
      <span>${esc(s.field)}</span>
      <code>${esc(s.endpoint)}</code>
      <span class="right" style="margin-left:auto;color:var(--faint)">${esc(time)}</span>
    </div>`;
  }).join('');
}

function renderProfile(report) {
  const p = report.profiles[0];
  if (!p) return '<div class="empty">未取得画像</div>';
  const f = p.facts;
  const inf = p.inference || { score: 0, band: '未评分', hits: [], skipped: [], sufficient: false };
  const d = p.derived;
  const coverage = Math.round(p.coverage * 100);
  const hits = inf.hits.length
    ? inf.hits.map((h) => `<div class="rule">
        <span class="rule-id">${esc(h.id)}</span>
        <span class="rule-body">${esc(h.label)}<div class="rule-evidence">${esc(h.evidence)}</div></span>
        <span class="rule-weight">+${h.weight}</span>
      </div>`).join('')
    : '<div class="empty">无规则命中</div>';

  const videos = p.videos.length
    ? `<table><thead><tr><th>发布时间</th><th>标题</th><th class="num">播放</th></tr></thead><tbody>` +
      p.videos.slice(0, 6).map((v) => `<tr><td>${esc(ts(v.created).slice(0, 10))}</td><td>${esc(v.title.slice(0, 26))}</td><td class="num">${num(v.play)}</td></tr>`).join('') +
      `</tbody></table>`
    : '<div class="empty">投稿列表不可用（可能触发风控或该用户无投稿）</div>';

  return `
    <div class="card">
      <div class="user-head">
        <img src="${safeUrl(f.avatar)}" alt="" />
        <div>
          <div class="user-name-row">
            <span class="user-name">${esc(f.name || '（未取得昵称）')}</span>
            <span class="user-meta">UID ${esc(p.mid)}</span>
          </div>
          <div class="user-meta">${esc(f.officialTitle || '无认证')}${f.vipLabel ? ' · ' + esc(f.vipLabel) : ''}${f.sex ? ' · ' + esc(f.sex) : ''}</div>
        </div>
      </div>
      <div class="kv-grid">
        <div class="kv"><span class="k">等级</span><span class="v">Lv ${f.level}</span></div>
        <div class="kv"><span class="k">粉丝</span><span class="v">${num(f.follower)}</span></div>
        <div class="kv"><span class="k">关注</span><span class="v">${num(f.following)}</span></div>
        <div class="kv"><span class="k">公开投稿</span><span class="v">${f.archiveCount === null ? '—' : num(f.archiveCount)}</span></div>
        <div class="kv"><span class="k">专栏</span><span class="v">${num(f.articleCount)}</span></div>
        <div class="kv"><span class="k">注册时间</span><span class="v small">${f.regtimeAvailable ? esc(new Date(f.regtime * 1000).toLocaleDateString('zh-CN')) : '平台未公开'}</span></div>
      </div>
      <p class="hint">个性签名：${esc(f.sign || '（空）')}</p>
    </div>

    ${renderProfileSummaryCard(p)}
    ${renderMarkCard(null, p)}

    <div class="card">
      <div class="card-title">线索分 · 可解释规则（非事实结论）</div>
      <div class="score-row">
        <div class="score-num">${inf.score}</div>
        <div>
          <span class="band">${esc(inf.band)}</span>
          <div class="score-note">${inf.sufficient ? '数据覆盖 ' + coverage + '%' : '数据覆盖 ' + coverage + '%，覆盖不足，评分仅供参考'}</div>
        </div>
      </div>
      <div class="bar" style="margin:10px 0"><div style="width:${coverage}%"></div></div>
      ${hits}
      ${inf.skipped.length ? `<p class="hint">因数据不可用跳过 ${inf.skipped.length} 条规则，未计入评分。</p>` : ''}
      <p class="hint">${esc(inf.disclaimer || '')}</p>
    </div>

    <div class="card">
      <div class="card-title">派生统计（基于已取得数据计算）</div>
      <div class="kv-grid">
        <div class="kv"><span class="k">标题模板率</span><span class="v small">${(d.titleTemplateRate * 100).toFixed(0)}%</span></div>
        <div class="kv"><span class="k">集中投稿</span><span class="v small">${d.burstCount} 次</span></div>
        <div class="kv"><span class="k">平均播放</span><span class="v small">${num(d.avgPlay)}</span></div>
        <div class="kv"><span class="k">夜间投稿</span><span class="v small">${(d.nightPostRate * 100).toFixed(0)}%</span></div>
        <div class="kv"><span class="k">评论样本</span><span class="v small">${d.commentCount} 条</span></div>
        <div class="kv"><span class="k">话术簇参与</span><span class="v small">${d.cohortWordingClusters}</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">数据源与可复核性</div>
      ${renderSourceRows(p)}
      <p class="hint">每项均记录接口、状态与采集时间；导出 JSON 保留完整证据链。</p>
    </div>

    <div class="card">
      <div class="card-title">最近投稿样本</div>
      ${videos}
    </div>

    ${report.extra && report.extra.resolution ? `<div class="card"><div class="card-title">昵称检索候选（点击继续画像）</div>${report.extra.resolution.map((u) => `<div class="link-row"><div class="link-main"><span class="link-site">${esc(u.name)}</span> <span class="user-meta">UID ${esc(u.mid)} · 粉丝 ${num(u.fans)}</span></div><button class="text-btn" data-mid="${esc(u.mid)}">画像</button></div>`).join('')}</div>` : ''}
  `;
}

function renderBatch(report) {
  const profiles = [...report.profiles].sort((a, b) => (b.inference?.score || 0) - (a.inference?.score || 0));
  const rows = profiles.map((p) => `<tr class="clickable" data-mid="${esc(p.mid)}" title="点击进行单账号深度采集（含投稿列表）">
    <td>${esc(p.facts.name || p.mid)}</td>
    <td class="num">${p.facts.level}</td>
    <td class="num">${num(p.facts.follower)}</td>
    <td class="num">${p.derived.commentCount}</td>
    <td class="num">${p.inference ? p.inference.score : '—'}</td>
    <td>${p.inference ? esc(p.inference.band) : '—'}</td>
  </tr>`).join('');

  const clusters = report.clusters.length
    ? report.clusters.map((c) => `<details class="cluster">
        <summary>${esc(c.label)} · ${c.members.length} 个账号 <span class="pill na">${esc(c.type)}</span></summary>
        <div class="evidence">
          <div>${esc(c.key)}</div>
          ${c.evidence.slice(0, 6).map((e) => `<div>${esc(JSON.stringify(e).slice(0, 220))}</div>`).join('')}
          <div style="color:var(--warn);margin-top:6px">${esc(c.caveat)}</div>
        </div>
      </details>`).join('')
    : '<div class="empty">未发现跨账号关联线索</div>';

  const extra = report.extra || {};
  return `
    <div class="card">
      <div class="card-title">样本概览 · ${esc(report.target.label)}</div>
      <div class="kv-grid">
        <div class="kv"><span class="k">评论条数</span><span class="v">${num(extra.commentCount ?? report.comments.length)}</span></div>
        <div class="kv"><span class="k">去重评论者</span><span class="v">${num(extra.uniqueCommenters ?? 0)}</span></div>
        <div class="kv"><span class="k">已画像</span><span class="v">${num(report.summary.profileCount)}</span></div>
        <div class="kv"><span class="k">未覆盖</span><span class="v">${num(extra.commentsSkipped ?? 0)}</span></div>
        <div class="kv"><span class="k">平均线索分</span><span class="v">${report.summary.averageScore}</span></div>
        <div class="kv"><span class="k">关联线索簇</span><span class="v">${report.summary.clusterCount}</span></div>
      </div>
      ${extra.errors && extra.errors.length ? `<p class="hint" style="color:var(--warn)">采集告警：${esc(extra.errors.join('；'))}</p>` : ''}
      <p class="hint">仅覆盖前 ${num(report.summary.profileCount)} 位评论者，样本存在选择偏差；${report.summary.insufficientCount} 个账号数据覆盖不足。</p>
    </div>
    ${renderSpamCard(extra.spam)}
    <div class="section-title">账号列表（按线索分排序）</div>
    <div class="card"><table>
      <thead><tr><th>昵称</th><th class="num">Lv</th><th class="num">粉丝</th><th class="num">评论</th><th class="num">分</th><th>分档</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="section-title">跨账号关联线索</div>
    ${clusters}
  `;
}

function renderReportSummary() {
  const box = $('#report-summary');
  const report = state.report;
  if (!report) { box.textContent = '暂无报告'; return; }
  box.innerHTML = `<strong>${esc(report.target.label)}</strong> · ${esc(report.target.kind)}<br />
    生成于 ${esc(new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false }))}<br />
    ${report.summary.profileCount} 个账号 · 平均分 ${report.summary.averageScore} · ${report.summary.clusterCount} 个关联线索簇 · ${report.comments.length} 条评论证据`;
}

/* ------------------------------ 多源数据可视化 ------------------------------ */

const compact = (value) => {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(1) + '亿';
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString('zh-CN');
};

const FED_STATUS = {
  data: { label: '有结构化数据', color: '#6ccf9c', cls: 'ok' },
  official: { label: '官方档案（不重复请求）', color: '#7aa2f7', cls: 'na' },
  page_only: { label: '仅页面可达', color: '#e4b45f', cls: 'na' },
  not_listed: { label: '站点未收录', color: '#9ba4b3', cls: 'na' },
  cooldown: { label: '风控冷却', color: '#f0729a', cls: 'na' },
  error: { label: '请求失败', color: '#e97a7a', cls: 'fail' }
};
const fedMeta = (status) => FED_STATUS[status] || { label: status || '未知状态', color: '#6e7787', cls: 'na' };
const fedValue = (value) => (value === null || value === undefined ? '—' : num(value));

/** 站点状态分布环图：只展示状态计数，不把不同站点的数据做跨站归一化比较。 */
function donutChart(statuses) {
  const groups = {};
  (statuses || []).forEach((s) => { const k = s.status || 'error'; groups[k] = (groups[k] || 0) + 1; });
  const entries = Object.entries(groups).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return '<div class="empty">无站点状态数据</div>';
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = entries.map(([key, count]) => {
    const length = (count / total) * circumference;
    const arc = `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="${fedMeta(key).color}" stroke-width="13" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 60 60)" />`;
    offset += length;
    return arc;
  }).join('');
  const legend = entries.map(([key, count]) =>
    `<span class="chart-legend-item"><i style="background:${fedMeta(key).color}"></i>${esc(fedMeta(key).label)} ${count}</span>`).join('');
  return `<div class="chart-flex">
    <svg class="donut" viewBox="0 0 120 120" role="img" aria-label="站点状态分布">
      <circle cx="60" cy="60" r="${radius}" fill="none" stroke="#22262e" stroke-width="13" />
      ${arcs}
      <text x="60" y="57" text-anchor="middle" fill="#e9ecf2" font-size="22" font-weight="700">${total}</text>
      <text x="60" y="73" text-anchor="middle" fill="#9ba4b3" font-size="10">站点</text>
    </svg>
    <div class="chart-legend">${legend}</div>
  </div>`;
}

/** ZeroRoku 粉丝趋势折线。纵轴为该样本自身的最小/最大值，不做跨账号对比。 */
function trendChart(trend) {
  const points = (trend || []).filter((t) => t && Number.isFinite(Number(t.fans))).slice(-90);
  if (points.length < 2) return '<div class="empty">粉丝趋势点不足（少于 2 个）</div>';
  const W = 360, H = 132, L = 10, R = 10, T = 14, B = 24;
  const values = points.map((p) => Number(p.fans) || 0);
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || Math.max(1, Math.abs(max) * 0.1);
  const lo = min - span * 0.08, hi = max + span * 0.08;
  const xAt = (i) => L + (i / (points.length - 1)) * (W - L - R);
  const yAt = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const coords = values.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
  const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const baseline = (H - B).toFixed(1);
  const area = `M${coords[0].x.toFixed(1)},${baseline} ` +
    coords.map((c) => `L${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') +
    ` L${coords[coords.length - 1].x.toFixed(1)},${baseline} Z`;
  const grid = [0, 0.5, 1].map((ratio) => {
    const gy = T + ratio * (H - T - B);
    const label = compact(hi - ratio * (hi - lo));
    return `<line x1="${L}" y1="${gy.toFixed(1)}" x2="${W - R}" y2="${gy.toFixed(1)}" stroke="#303641" stroke-width="1" stroke-dasharray="3 4" />
      <text x="${L + 2}" y="${(gy - 3).toFixed(1)}" fill="#6e7787" font-size="9">${esc(label)}</text>`;
  }).join('');
  const last = coords[coords.length - 1];
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="粉丝趋势">
    <defs><linearGradient id="fedTrendFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f0729a" stop-opacity="0.34" />
      <stop offset="100%" stop-color="#f0729a" stop-opacity="0.02" />
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#fedTrendFill)" />
    <polyline points="${line}" fill="none" stroke="#f0729a" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.2" fill="#f0729a" stroke="#14161a" stroke-width="1.5" />
    <text x="${L}" y="${H - 6}" fill="#6e7787" font-size="9">${esc(String(points[0].date || '').slice(0, 10))}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" fill="#9ba4b3" font-size="9">${esc(String(points[points.length - 1].date || '').slice(0, 10))}</text>
  </svg>`;
}

/** 通用柱状图：用于 AICU 评论的月份分布与 24 小时分布。 */
function barsChart(buckets, options = {}) {
  const raw = (buckets || []).filter((b) => b && b.key !== undefined);
  const items = options.max ? raw.slice(-options.max) : raw;
  if (!items.length) return '<div class="empty">无时间分布数据</div>';
  const W = 360, H = 112, L = 8, R = 8, T = 14, B = 20;
  const max = Math.max(1, ...items.map((b) => Number(b.count) || 0));
  const slot = (W - L - R) / items.length;
  const barWidth = Math.max(1.5, Math.min(24, slot - 2));
  const color = options.color || '#f0729a';
  const bars = items.map((b, i) => {
    const height = ((Number(b.count) || 0) / max) * (H - T - B);
    const bx = L + i * slot + (slot - barWidth) / 2;
    const by = H - B - height;
    return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(height, 0.8).toFixed(1)}" rx="1.5" fill="${color}" opacity="${b.count ? '0.88' : '0.22'}">
      <title>${esc(b.key)}：${num(b.count)}</title></rect>`;
  }).join('');
  const step = Math.max(1, Math.ceil(items.length / 6));
  const labels = items.map((b, i) => (i % step === 0 || i === items.length - 1)
    ? `<text x="${(L + i * slot + slot / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" fill="#6e7787" font-size="9">${esc(String(b.key).slice(-5))}</text>`
    : '').join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(options.title || '分布图')}">
    <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#303641" stroke-width="1" />
    <text x="${L + 2}" y="10" fill="#6e7787" font-size="9">峰值 ${num(max)}</text>
    ${bars}${labels}
  </svg>`;
}

/** 通用横向条：用于标签、事件类型、直播间、分区与重复文本的计数分布。 */
function pairBars(items, labelKey = 'label', emptyText = '无分布数据') {
  const rows = (items || []).slice(0, 10);
  if (!rows.length) return `<div class="empty">${esc(emptyText)}</div>`;
  const max = Math.max(1, ...rows.map((r) => Number(r.count) || 0));
  return `<div class="hbar-list">${rows.map((r) => {
    const label = r[labelKey] === undefined || r[labelKey] === null || r[labelKey] === '' ? '未标注' : r[labelKey];
    return `<div class="hbar-row">
      <span class="hbar-label" title="${esc(label)}">${esc(label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${Math.round(((Number(r.count) || 0) / max) * 100)}%"></span></span>
      <span class="hbar-value">${num(r.count)}</span>
    </div>`;
  }).join('')}</div>`;
}

/** Danmakus 关注主播标签分布。 */
const tagBars = (tags) => pairBars(
  (tags || []).map((t) => ({ label: t.tag, count: t.count })), 'label', '无标签数据'
);

function renderFederatedSites() {
  const list = $('#federated-site-list');
  if (!list) return;
  const selected = state.federatedSites.filter((s) => state.federatedSelected.has(s.id)).length;
  $('#federated-site-count').textContent = `共 ${state.federatedSites.length} 个 · 已选 ${selected} 个`;
  list.innerHTML = state.federatedSites.map((s) => `<label class="site-item" title="${esc(s.note)}">
    <input type="checkbox" data-fed-site="${esc(s.id)}" ${state.federatedSelected.has(s.id) ? 'checked' : ''} />
    <span>${esc(s.name)}</span>
    <span class="pill na">${esc(s.label)}</span>
  </label>`).join('');
}

async function persistFederatedSites() {
  const res = await send({ type: 'SET_SETTINGS', patch: { federatedSiteIds: [...state.federatedSelected] } });
  if (res.ok) state.settings = res.settings;
}

function renderSiteMatrix(f) {
  const statuses = f.statuses || [];
  const rawById = Object.fromEntries((f.rawResults || []).map((r) => [r.siteId, r]));
  if (!statuses.length) return '<div class="empty">无站点记录</div>';
  return statuses.map((s) => {
    const meta = fedMeta(s.status);
    const raw = rawById[s.siteId] || {};
    const sources = (raw.sourceUrls || []);
    const sourceHtml = sources.map((u) =>
      `<div><a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${esc(String(u).replace(/^https?:\/\//, '').slice(0, 90))}</a></div>`).join('');
    const site = state.federatedSites.find((x) => x.id === s.siteId);
    const when = s.fetchedAt ? new Date(s.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
    return `<div class="fed-site-row">
      <div class="fed-site-head">
        <span class="fed-site-name">${esc(s.siteName)} <span class="hint">${esc(site ? site.label : '')}</span></span>
        <span class="pill ${meta.cls}">${esc(meta.label)}</span>
        ${s.cached ? '<span class="pill na">缓存命中</span>' : ''}
        <button class="text-btn fed-refresh" data-fed-refresh="${esc(s.siteId)}" ${s.status === 'official' ? 'disabled title="官方档案不重复请求"' : ''}>刷新</button>
      </div>
      <div class="fed-site-msg">${esc(s.message || '')}</div>
      <div class="fed-site-foot">
        <span>${s.httpStatus ? 'HTTP ' + esc(s.httpStatus) : '—'}</span>
        <span>${num(s.elapsedMs)} ms</span>
        <span>${esc(when)}</span>
        <a href="${safeUrl(s.pageUrl)}" target="_blank" rel="noopener noreferrer" class="text-btn">人工核验 ↗</a>
      </div>
      ${sourceHtml ? `<details class="fed-sources"><summary>实际请求端点 ${sources.length} 个</summary><div class="evidence">${sourceHtml}</div></details>` : ''}
    </div>`;
  }).join('');
}

const metric = (label, value) => `<div class="kv"><span class="k">${esc(label)}</span><span class="v small">${value}</span></div>`;
const dayLabel = (ms) => (Number(ms) ? new Date(Number(ms)).toLocaleDateString('zh-CN') : '—');

/* ------------------------------ 数据清洗报告 ------------------------------ */

/** 所有图表的数据都来自清洗后结果；此处把四道工序与逐源计数完整摊开。 */
function renderCleaning(cleaning) {
  if (!cleaning || !cleaning.sources) {
    return `<div class="card"><div class="card-title">数据清洗报告</div>
      <div class="empty">本报告不含清洗报告（旧版本报告），请重新聚合以生成。</div></div>`;
  }
  const t = cleaning.totals || {};
  const stages = cleaning.stages || [];
  const sources = cleaning.sources || [];
  const cell = (label, value, kind = '') =>
    `<div class="kv"><span class="k">${esc(label)}</span><span class="v small ${kind}">${esc(value)}</span></div>`;
  const stageHtml = stages.map((s, i) => `<div class="clean-stage">
      <span class="clean-stage-idx">${i + 1}</span>
      <div><strong>${esc(s.label)}</strong><div class="hint">${esc(s.detail)}</div></div>
    </div>`).join('');
  const sourceRows = sources.map((s) => `<tr>
      <td>${esc(s.label)}</td>
      <td class="num">${num(s.inputRows)}</td>
      <td class="num">${num(s.outputRows)}</td>
      <td class="num">${num(s.counts.duplicatesRemoved)}</td>
      <td class="num">${num(s.counts.missingHandled)}</td>
      <td class="num">${num(s.counts.anomaliesRemoved)}</td>
      <td class="num">${num(s.counts.anomaliesClamped)}</td>
    </tr>`).join('');
  const detailHtml = sources.map((s) => {
    const groups = [
      ['字段规范化', s.details.normalize], ['缺失值处理', s.details.missing],
      ['异常值处理', s.details.anomaly], ['数据去重', s.details.dedupe]
    ].map(([title, obj]) => {
      const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
      if (!rows.length) return '';
      return `<div class="chart-sub">${esc(title)}</div>${rows.map(([k, v]) =>
        `<div class="clean-detail-row"><span>${esc(k)}</span><span class="num">${num(v)}</span></div>`).join('')}`;
    }).join('');
    return `<div class="clean-detail"><strong>${esc(s.label)}</strong>${groups || '<div class="hint">无清洗动作</div>'}
      ${(s.notes || []).map((n) => `<p class="hint">${esc(n)}</p>`).join('')}</div>`;
  }).join('');
  return `
    <div class="card">
      <div class="card-title">数据清洗报告 · 先清洗，后可视化 <span class="pill ok">${esc(cleaning.chartDataBasis || 'cleaned')}</span></div>
      <div class="kv-grid">
        ${cell('清洗前行/记录', num(t.inputRows))}
        ${cell('清洗后行/记录', num(t.outputRows), 'clean-ok')}
        ${cell('去重移除', num(t.duplicatesRemoved), 'clean-ok')}
        ${cell('缺失值处理', num(t.missingHandled))}
        ${cell('异常剔除', num(t.anomaliesRemoved))}
        ${cell('异常截断', num(t.anomaliesClamped))}
        ${cell('字段规范化', num(t.fieldsNormalized))}
        ${cell('数据源', num(sources.length))}
        ${cell('工序', num(stages.length))}
      </div>
      <div class="chart-sub">固定工序（顺序不可颠倒）</div>
      ${stageHtml}
      <div class="chart-sub">逐源清洗计数</div>
      <table><thead><tr><th>数据源</th><th class="num">前</th><th class="num">后</th>
        <th class="num">去重</th><th class="num">缺失</th><th class="num">剔除</th><th class="num">截断</th></tr></thead>
        <tbody>${sourceRows}</tbody></table>
      <details class="clean-details"><summary>展开逐项清洗明细与处理规则</summary>${detailHtml}</details>
      <p class="hint">${esc(cleaning.disclaimer || '')}下方所有图表、分类卡与指标只消费清洗后的数据；缺失显示「—」，不推断为 0。</p>
    </div>
  `;
}

/* ------------------------------ 完整画像专用图表 ------------------------------ */

/** 7×24 活跃热力图：行=星期，列=小时，颜色深浅只表示本批样本内的相对次数。 */
function heatmapChart(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  if (rows.length !== 7 || !Array.isArray(rows[0])) return '<div class="empty">无 7×24 活跃分布数据</div>';
  const max = Math.max(1, ...rows.flat().map((v) => Number(v) || 0));
  const week = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const cells = rows.map((row, w) => (row || []).map((v, h) => {
    const n = Number(v) || 0;
    const alpha = n ? (0.14 + 0.86 * (n / max)) : 0;
    return `<div class="heat-cell${n ? '' : ' zero'}" title="${esc(week[w])} ${String(h).padStart(2, '0')}:00 · ${num(n)} 次"
      style="background:${n ? `rgba(108,207,156,${alpha.toFixed(2)})` : 'var(--surface-2)'}"></div>`;
  }).join('')).join('');
  const axis = Array.from({ length: 24 }, (_, h) =>
    `<span>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>`).join('');
  return `<div class="heat-wrap">
      <div class="heat-labels">${week.map((w) => `<span>${esc(w)}</span>`).join('')}</div>
      <div class="heat-main"><div class="heat-grid">${cells}</div><div class="heat-axis">${axis}</div></div>
    </div>
    <p class="hint">峰值 ${num(max)} 次；颜色深浅为该样本内部相对值，不作跨账号比较。</p>`;
}

/** 活跃日历：按 UTC+8 自然日补齐空日，列=周、行=星期，最多展示最近 13 周。 */
function calendarChart(activityDays) {
  const list = (activityDays || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d.date))).slice(-91);
  if (!list.length) return '<div class="empty">无活跃日历数据</div>';
  const byDate = new Map(list.map((d) => [d.date, d]));
  const first = Date.parse(list[0].date + 'T00:00:00Z');
  const last = Date.parse(list[list.length - 1].date + 'T00:00:00Z');
  const max = Math.max(1, ...list.map((d) => Number(d.interactions) || 0));
  // 对齐到周一，保证 7 行网格正确
  const startDow = (new Date(first).getUTCDay() + 6) % 7;
  const renderStart = first - startDow * 86400000;
  let html = '';
  for (let t = renderStart; t <= last; t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const d = byDate.get(date);
    const n = d ? Number(d.interactions) || 0 : 0;
    const alpha = n ? 0.14 + 0.86 * (n / max) : 0;
    html += `<div class="cal-cell${n ? '' : ' zero'}" title="${esc(date)} · 互动 ${num(n)} 次 · 弹幕 ${num(d ? d.messages : 0)} 条 · ${num(d ? d.lives : 0)} 场"
      style="background:${n ? `rgba(122,162,247,${alpha.toFixed(2)})` : 'var(--surface-2)'}"></div>`;
  }
  return `<div class="cal-wrap">
      <div class="cal-labels"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
      <div class="cal-grid">${html}</div>
    </div>
    <p class="hint">${esc(list[0].date)} ~ ${esc(list[list.length - 1].date)} · 共 ${num(list.length)} 天有留痕；空白格表示该日无记录。</p>`;
}

/** 五维战力图（v1.5.3）：标准雷达图，5 个轴 = 5 个分类维度。
 *  轴长取该维度「主导分类的置信度」（0~100%），只表示本机规则在这一维上有多确定，
 *  不是能力/等级评分，也不能跨账号比较。 */
function radarChart(dims) {
  const list = (dims || []).filter(Boolean).slice(0, 5);
  if (list.length < 3) return '<div class="empty">分类维度不足（少于 3 个），无法绘制雷达图</div>';
  // viewBox 宽度贴近弹窗内实际渲染宽度（约 298px），避免 SVG 缩放导致 10px 文字发虚
  const W = 300, H = 206, CX = 150, CY = 112, R = 74, LABEL_R = 1.24;
  const n = list.length;
  const at = (i, ratio) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [CX + Math.cos(angle) * R * ratio, CY + Math.sin(angle) * R * ratio];
  };
  const pts = (ratioList) => list
    .map((_, i) => at(i, ratioList[i]).map((v) => v.toFixed(1)).join(','))
    .join(' ');
  const grid = [0.25, 0.5, 0.75, 1].map((r) =>
    `<polygon points="${pts(Array(n).fill(r))}" fill="none" stroke="#303641" stroke-width="1"
      ${r === 1 ? '' : 'stroke-dasharray="3 4"'} />`).join('');
  const axes = list.map((_, i) => {
    const [x, y] = at(i, 1);
    return `<line x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#303641" stroke-width="1" />`;
  }).join('');
  const values = list.map((d) => {
    const v = Number(d.confidence);
    return Number.isFinite(v) ? Math.max(0.015, Math.min(1, v)) : 0.015;
  });
  const dots = list.map((d, i) => {
    const [x, y] = at(i, values[i]);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#f0729a" stroke="#14161a" stroke-width="1.4">
      <title>${esc(d.title)}：${esc(d.label || '样本不足')} ${Math.round(values[i] * 100)}%</title></circle>`;
  }).join('');
  const labels = list.map((d, i) => {
    const [x, y] = at(i, LABEL_R);
    const anchor = Math.abs(x - CX) < 4 ? 'middle' : (x > CX ? 'start' : 'end');
    // 坐标取整：小字号中文落在小数像素上会被抗锯齿糊成重影
    const lx = Math.round(x), ly = Math.round(y);
    return `<text x="${lx}" y="${ly}" text-anchor="${anchor}" fill="#9ba4b3" font-size="10">${esc(d.title)}</text>
      <text x="${lx}" y="${ly + 13}" text-anchor="${anchor}" fill="#f0729a" font-size="10" font-weight="600">${Math.round(values[i] * 100)}%</text>`;
  }).join('');
  return `<svg class="chart-svg radar-svg" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="五维战力图：${esc(list.map((d) => `${d.title} ${Math.round((Number(d.confidence) || 0) * 100)}%`).join('，'))}">
    <defs><radialGradient id="radarFill" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f0729a" stop-opacity="0.42" />
      <stop offset="100%" stop-color="#7aa2f7" stop-opacity="0.12" />
    </radialGradient></defs>
    ${grid}${axes}
    <polygon points="${pts(values)}" fill="url(#radarFill)" stroke="#f0729a" stroke-width="1.8"
      stroke-linejoin="round" />
    ${dots}${labels}
  </svg>`;
}

/** 雷达图下方的分类图例：一眼看清每轴赢家，避免只看到百分比。 */
function radarLegend(dims) {
  const list = (dims || []).filter(Boolean).slice(0, 5);
  if (!list.length) return '';
  return `<div class="radar-legend">${list.map((d) => `<div class="radar-item">
      <span class="radar-k">${esc(d.title)}</span>
      <span class="radar-v">${esc(d.label || '样本不足')}</span>
      <span class="radar-p">${Math.round((Number(d.confidence) || 0) * 100)}%</span>
    </div>`).join('')}</div>`;
}

/** 词云：按本地分词频次调整字号，不做语义或情绪判断。 */
function wordCloud(words) {
  const list = (words || []).slice(0, 36);
  if (!list.length) return '<div class="empty">没有可用的分词数据</div>';
  const max = Math.max(1, ...list.map((w) => Number(w.value) || 0));
  return `<div class="word-cloud">${list.map((w) => `<span class="word-chip"
    style="font-size:${(10 + 11 * (Number(w.value) || 0) / max).toFixed(0)}px"
    title="${esc(w.name)}：${num(w.value)} 次">${esc(w.name)}</span>`).join('')}</div>`;
}

/** 分类概率条：与页面「点击查看全部分类说明与概率分布」一致。 */
function probabilityBars(probabilities) {
  const list = (probabilities || []).slice(0, 8);
  if (!list.length) return '<div class="empty">样本不足，暂无概率分布</div>';
  return `<div class="prob-list">${list.map((p) => `<div class="prob-row">
      <span class="prob-label" title="${esc(p.note || '')}">${esc(p.label)}</span>
      <span class="prob-track"><span class="prob-fill" style="width:${Math.max(1, Math.round((Number(p.probability) || 0) * 100))}%"></span></span>
      <span class="prob-value">${((Number(p.probability) || 0) * 100).toFixed(0)}%</span>
    </div>`).join('')}</div>`;
}

function dimensionCard(dim) {
  if (!dim) return '';
  const drivers = (dim.drivers || []).map((d) =>
    `<div class="clean-detail-row"><span>${esc(d.label)}</span><span class="num">${esc(d.value)}</span></div>`).join('');
  return `<div class="dim-card">
    <div class="dim-head"><strong>${esc(dim.title)}</strong>
      <span class="pill ok">${esc(dim.label)} · ${Math.round((Number(dim.confidence) || 0) * 100)}%</span></div>
    <div class="dim-note">${esc(dim.note)}</div>
    <div class="dim-choice">${esc(dim.choiceNote || '')}</div>
    <div class="chart-sub">驱动指标（可复核）</div>${drivers || '<div class="empty">无驱动指标</div>'}
    <details class="dim-probs"><summary>概率分布</summary>${probabilityBars(dim.probabilities)}</details>
  </div>`;
}

/* ------------------------------ 完整 /analyze 聚合画像 ------------------------------ */

/**
 * 逐项对齐 danmakus.com/analyze/{uid} 的展示结构，全部数据取自 f.livePortrait
 * （cleanSessions → buildLivePortrait 的清洗后结果）。不渲染任何服务端主观标签。
 */
function renderLiveBehavior(f, opts = {}) {
  const P = f.livePortrait;
  if (!P || P.dataBasis !== 'cleaned') {
    return `<div class="card"><div class="card-title">完整弹幕聚合画像</div>
      <div class="empty">${P ? '画像数据未标记清洗来源，为保证口径一致已跳过渲染' : '本次报告不含完整聚合画像，请重新聚合'}</div></div>`;
  }
  const cov = P.coverage || {}, S = P.summary || {}, I = P.insights || {},
    SUP = P.support || {}, CC = P.channelConcentration || {}, PP = P.personalityProfile || {};
  const redacted = !!cov.redacted;
  const scope = [
    cov.timeRange && cov.timeRange.filtered
      ? `本地筛选 ${esc(cov.timeRange.start || '不限')} ~ ${esc(cov.timeRange.end || '不限')}` : '未设置日期筛选',
    cov.hideOnlyEnter === false ? '含仅有入场记录的场次' : '已隐藏仅有入场记录的场次',
    cov.hasMore ? '仍有未取回场次，样本非全量' : '已取回可及的全部场次'
  ].join(' · ');
  const pctText = (v) => `${((Number(v) || 0) * 100).toFixed(0)}%`;
  const card = (title, body, extra = '') =>
    `<div class="card"><div class="card-title">${esc(title)}</div>${body}${extra}</div>`;

  /* 1. 概览指标 */
  const overview = card('互动画像 · 概览指标（清洗后样本）', `
    <div class="kv-grid">
      ${metric('共直播场次', num(S.totalLives) + ' 场')}
      ${metric('有留痕场次', num(S.appearanceLives) + ' 场')}
      ${metric('有互动场次', num(S.interactiveLives) + ' 场')}
      ${metric('打米场次', num(S.paidLives) + ' 场')}
      ${metric('弹幕条数', num(S.totalMessages) + ' 条')}
      ${metric('不重复弹幕', num(S.uniqueMessages) + ' 条')}
      ${metric('互动次数', num(S.totalInteractions) + ' 次')}
      ${metric('留痕总数', num(S.totalTraces) + ' 条')}
      ${metric('打米总额', num(S.totalPayment) + ' 元')}
      ${metric('活跃天数', num(S.activeDays) + ' 天')}
      ${metric('最长连续活跃', num(S.longestStreak) + ' 天')}
      ${metric('活跃日均', num(S.avgPerActiveDay) + ' 次')}
    </div>
    <p class="hint">${esc(scope)}。${esc(cov.scopeNote || '')}</p>
    <p class="hint">记录跨度 ${esc(dayLabel(cov.earliestTs))} ~ ${esc(dayLabel(cov.latestTs))}；${esc(S.appearanceShareNote || '')}。</p>`);

  /* 2. 留痕构成 */
  const leave = card('留痕构成 · 弹幕 / 礼物 / SC / 舰长', `
    ${pairBars((P.leaveTrace || []).map((x) => ({ label: x.label, count: x.count })), 'label', '无留痕记录')}
    <table><thead><tr><th>类型</th><th class="num">次数</th><th class="num">占比</th><th class="num">金额(元)</th></tr></thead><tbody>
      ${(P.leaveTrace || []).map((x) => `<tr><td>${esc(x.label)}</td><td class="num">${num(x.count)}</td>
        <td class="num">${pctText(x.share)}</td><td class="num">${num(x.payment)}</td></tr>`).join('')}
    </tbody></table>
    <div class="chart-sub">事件类型（站点原始枚举）</div>
    ${pairBars((P.eventTypes || []).map((x) => ({ label: x.label, count: x.count })), 'label', '无事件记录')}
    <p class="hint">口径提示：默认开启「隐藏仅入场场次」后，<strong>只留了入场记录的场次整体不参与统计</strong>，因此「入场」计数明显低于关闭该开关时的取回量；礼物等类型的减少来自去重（同一内容签名只计一次）。这不是数据丢失，是筛选与去重口径；关闭该开关重新聚合可看到含仅入场场次的口径。</p>`);

  /* 3. 活跃节律 */
  const rhythm = card('活跃节律 · 按 7×24 小时活跃分布统计', `
    <div class="kv-grid">
      ${metric('最长连续活跃', num(S.longestStreak) + ' 天')}
      ${metric('常互动时段', esc((P.rhythmPeak || {}).label || '暂无'))}
      ${metric('常看分区', esc((P.areas || [])[0] ? P.areas[0].name : '暂无'))}
      ${metric('互动场次占比', pctText(S.interactiveShare))}
      ${metric('深夜发言 01–05', pctText(I.nightOwlRatio))}
      ${metric('深夜至清晨占比', pctText(I.lateNightRatio))}
    </div>
    <div class="chart-sub">7×24 时段热力图</div>
    ${heatmapChart(P.rhythmMatrix)}
    <div class="chart-sub">活跃日历</div>
    ${calendarChart(P.activityDays)}
    <div class="chart-sub">互动趋势（按日 · 最近 60 天）</div>
    ${barsChart((P.activityDays || []).slice(-60).map((d) => ({ key: d.date, count: d.interactions })), { color: '#7aa2f7', title: '互动趋势' })}
    <div class="chart-sub">时段分布 · 按 24 小时（UTC+8）</div>
    ${barsChart(P.hourBuckets, { color: '#6ccf9c', title: '时段分布' })}
    <div class="chart-sub">按星期</div>
    ${pairBars((P.weekdayBuckets || []).map((d) => ({ label: d.label, count: d.count })), 'label', '无星期分布数据')}
    <div class="chart-sub">按月（最近 12 个月）</div>
    ${barsChart(P.monthBuckets, { max: 12, color: '#7aa2f7', title: '月份分布' })}
    <div class="chart-sub">活动节奏 · 最长连续 ${num(S.longestStreak)} 天，按有留痕的自然日连续计算</div>
    <p class="hint">${esc(P.classificationNote || '')}</p>`);

  /* 4. 频道偏好 */
  const topCh = (P.channelAffinities || [])[0];
  // v1.5.4：把独轮车结论挂到对应主播名后面（同一主播一行一个 pill），不再只给一个笼统的全局结论。
  // 主播表只有 8 列、主播名那格很窄，所以这里用短标签，完整文案放 title。
  const spamByChannel = new Map(((P.spam && P.spam.channels) || []).map((c) => [String(c.channelUid), c]));
  const SPAM_SHORT = { high: '独轮车', suspect: '疑似刷屏', watch: '观察', coordinated: '协同刷屏' };
  const channelSpamPill = (uid) => {
    const c = spamByChannel.get(String(uid));
    if (!c || c.level === 'none') return '';
    const t = (c.level === 'high' || c.level === 'coordinated') ? 'fail'
      : (c.level === 'suspect' || c.level === 'watch') ? 'warn' : 'ok';
    return ` <span class="pill ${t}" title="${esc(c.levelLabel)}：同簇 ${c.repeats}/${c.windowMessages} 条">${esc(SPAM_SHORT[c.level] || c.levelLabel)}</span>`;
  };
  const channelRows = (P.channelAffinities || []).slice(0, 10).map((c) => `<tr
      data-channel-row="1" data-sessions="${Number(c.sessions) || 0}" data-name="${esc(c.channelName)}">
      <td>${esc(c.channelName)}${channelSpamPill(c.channelUid)}</td>
      <td class="num">${c.fans === null || c.fans === undefined ? '—' : compact(c.fans)}</td>
      <td>${esc((c.tags || []).join(' / ') || '—')}</td>
      <td class="num">${num(c.sessions)}</td>
      <td class="num">${num(c.records)}</td>
      <td class="num">${num(c.textCount ?? 0)}</td>
      <td class="num">${num(c.activeDays ?? 0)}</td>
      <td class="num">${num(c.loyaltyScore)}</td>
    </tr>`).join('');
  const channels = card('频道偏好 · 最亲密主播 / 亲密度 / 频道分布', `
    <div class="kv-grid">
      ${metric('涉及主播', num(CC.distinctChannels))}
      ${metric('最亲密主播', esc(topCh ? topCh.channelName : '暂无'))}
      ${metric('亲密度', topCh ? num(topCh.loyaltyScore) : '—')}
      ${metric('Top1 记录占比', pctText(CC.top1Share))}
      ${metric('Top3 记录占比', pctText(CC.top3Share))}
      ${metric('频道集中度 HHI', num(CC.hhi))}
    </div>
    <div class="chart-sub">频道分布（按记录数 Top 10）</div>
    ${pairBars((P.channelAffinities || []).slice(0, 10).map((c) => ({ label: c.channelName, count: c.records })), 'label', '无频道记录')}
    <div class="chart-sub">分区偏好 · 按留痕场次</div>
    ${pairBars((P.areas || []).map((a) => ({ label: a.name, count: a.count })), 'label', '暂无分区记录')}
    <div class="chart-sub">跨房倾向与频道集中度</div>
    <div class="clean-detail-row"><span>涉及主播 / 跨分区数</span><span class="num">${num(CC.distinctChannels)} / ${num(CC.spanAreas)}</span></div>
    <div class="clean-detail-row"><span>互动口径涉及主播 / 分区</span><span class="num">${num(CC.interactiveChannels ?? '—')} / ${num(CC.interactiveAreas ?? '—')}</span></div>
    <p class="hint">${esc(CC.note || '')}「互动口径」只统计有弹幕 / 礼物 / SC 等互动记录的主播与分区，不含仅入场场次。</p>
    <details class="dim-probs"><summary>筛选主播 · 正则 / 隐藏仅 1 场</summary>
      <div class="filter-row">
        <input type="text" data-channel-filter placeholder="按主播名筛选（支持正则）" />
        <label class="filter-check"><input type="checkbox" data-channel-hide-single /> 隐藏仅 1 场</label>
      </div>
      <p class="hint">筛选只影响下方表格显示，不改动任何统计结果。</p>
    </details>
    <table><thead><tr><th>主播</th><th class="num">粉丝</th><th>标签</th><th class="num">场次</th><th class="num">留痕</th><th class="num">弹幕</th><th class="num">活跃天</th><th class="num">亲密度</th></tr></thead>
      <tbody>${channelRows || '<tr><td colspan="8">没有符合条件的频道</td></tr>'}</tbody></table>`);

  /* 5. 表达风格 */
  const repeatedHtml = (P.repeatedPhrases || []).slice(0, 8).map((r) => `<div class="fed-evidence-row">
      <span class="pill na">×${num(r.count)}</span>
      <span>${esc(redacted ? '（原文已按设置隐藏）' : (r.example || r.key))}</span>
      <span class="hint">首次 ${esc(dayLabel(r.firstTs))}</span>
    </div>`).join('') || '<div class="empty">样本中未发现重复文本</div>';
  const highFreqHtml = (I.highFreqWords || []).slice(0, 12).map((w) =>
    `<div class="clean-detail-row"><span>${esc(w.text)}</span><span class="num">${num(w.count)}</span></div>`).join('');
  const expression = card('表达风格 · 发言风格 / 表达习惯 / 词云', `
    <div class="kv-grid">
      ${metric('复读指数', num(I.repeaterIndex) + 'x')}
      ${metric('不重复弹幕', pctText(I.uniqueMessageRatio))}
      ${metric('表情弹幕', pctText(I.emojiRatio))}
      ${metric('房间表情', num(I.roomEmojiRecords) + ' 条')}
      ${metric('平均长度', num(I.avgMessageLength) + ' 字')}
      ${metric('深夜发言 01–05', pctText(I.nightOwlRatio))}
    </div>
    <p class="hint">原创派 / 表情包达人等分组由上方指标驱动，见下方「五维分类」卡，不采用服务端主观标签。</p>
    <div class="chart-sub">词云 · ${esc(I.tokenizerNote || '')}</div>
    ${wordCloud(I.wordCloud)}
    <div class="chart-sub">高频词（Top 12）</div>
    ${highFreqHtml || '<div class="empty">没有可用的分词数据</div>'}
    <div class="chart-sub">高频语句与玩梗倾向 · 最常说「${esc(I.maxRepeatedText || '暂无')}」× ${num(I.maxRepeatedCount)}</div>
    ${repeatedHtml}
    <details class="dim-probs"><summary>本地关键词规则命中计数（非语义 / 情绪判断）</summary>
      ${(I.lexicon || []).map((l) => `<div class="clean-detail-row"><span>${esc(l.label)}</span><span class="num">${num(l.count)}</span></div>`).join('')}
    </details>
    <p class="hint">归一化时折叠空白、全角转半角、移除表情标记、数字替换为 #；重复命中只表示同一句在清洗后样本中重复出现，不构成刷屏或组织化行为认定。</p>`);

  /* 6. 支持方式 */
  const supportBody = card('支持方式分类 · 打米 (元) / 打米构成 / 其他互动', `
    <div class="kv-grid">
      ${metric('打米总额', num(SUP.totalPayment) + ' 元')}
      ${metric('打米场次', num(SUP.paidLives) + ' 场')}
      ${metric('打米主播', num(SUP.paidChannels) + ' 个')}
      ${metric('单笔最高', num(SUP.maxSinglePayment) + ' 元')}
      ${metric('最多打给', esc(SUP.topPaidChannel ? SUP.topPaidChannel.name : '暂无'))}
      ${metric('其他互动', num(SUP.otherInteractions) + ' 次')}
    </div>
    <div class="chart-sub">打米构成</div>
    ${pairBars((SUP.breakdown || []).map((b) => ({ label: b.label, count: b.amount })), 'label', '无付费记录')}
    <table><thead><tr><th>构成</th><th class="num">金额(元)</th><th class="num">笔数</th></tr></thead><tbody>
      ${(SUP.breakdown || []).map((b) => `<tr><td>${esc(b.label)}</td><td class="num">${num(b.amount)}</td><td class="num">${num(b.count)}</td></tr>`).join('')
        || '<tr><td colspan="3">该区间内无付费记录（以持续发弹幕、常驻陪伴为主）</td></tr>'}
    </tbody></table>
    <div class="chart-sub">单笔最高（Top 8）</div>
    ${(SUP.topPayments || []).length ? `<table><thead><tr><th class="num">金额(元)</th><th>类型</th><th>主播 · 时间</th><th>内容 / 礼物名</th></tr></thead><tbody>
      ${(SUP.topPayments || []).map((p) => `<tr>
        <td class="num">${num(p.amount)}</td><td>${esc(p.typeLabel || '—')}</td>
        <td>${esc(p.channel || '—')} · ${esc(p.day || '')} ${String(p.hour).padStart(2, '0')}:00</td>
        <td>${esc(redacted ? '（已隐藏）' : (p.text || '—'))}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty">样本中无付费记录</div>'}
    <p class="hint">${esc(SUP.note || '')}</p>`);

  /* 7. 五维分类 */
  const dims = (P.dimensions || []).map(dimensionCard).join('');
  const allNotes = Object.entries(P.classNotes || {}).map(([k, v]) =>
    `<div class="clean-detail-row"><span>${esc((P.classLabels || {})[k] || k)}</span><span class="wrap">${esc(v)}</span></div>`).join('');
  // v1.5.3：五维战力图（雷达图）放在五维统计分组之上，先给整体形状再给逐维明细
  const radar = card('五维战力图 · 画像分类置信度', `
    ${radarChart(P.dimensions)}
    ${radarLegend(P.dimensions)}
    <p class="hint">轴长 = 该维度<strong>主导分类的置信度</strong>（本机规则计算）；五个维度各自独立，不构成整体能力评分，也不跨账号比较。形状越接近外圈表示该维度判定越确定，「样本不足」的维度会贴近圆心。</p>`);
  const personality = card('画像分类 · 核心粉丝光谱 / 表达风格 / 跨房倾向 / 活跃节律 / 支持方式', `
    ${dims}
    <details class="dim-probs"><summary>点击查看全部分类说明与概率分布</summary>${allNotes}</details>
    <p class="hint" style="color:var(--warn)">${esc(P.classificationNote || '')}</p>`);

  /* 8. 所涉直播间画像 */
  const scale = P.liveScale || {};
  const roomProfile = card('所涉直播间画像 · 主播与场次维度（按主播去重）', `
    <div class="kv-grid">
      ${metric('涉及主播', num(CC.distinctChannels))}
      ${metric('有记录场次', num(scale.sessions))}
      ${metric('直播间累计观看人次', compact(scale.watchCount || 0))}
      ${metric('直播间场均观看人次', compact(scale.avgWatchCount || 0))}
      ${metric('直播间峰值同时在线', compact(scale.maxOnlineMax || 0))}
      ${metric('直播间累计付费人次', compact(scale.payCount || 0))}
    </div>
    <p class="hint">以上均为<strong>主播与直播间的属性</strong>：累计口径（观看/付费）与场均口径（观看）不可相互比较，也不代表目标用户的消费或观看行为；「累计付费人次」高于「场均观看」属正常口径差异，不是数据错误。</p>
    <div class="chart-sub">主播标签（每个主播计一次 · 基于本次去重后的 ${num(CC.distinctChannels)} 个主播）</div>
    ${pairBars(P.channelTagCounts, 'key', '无主播标签数据')}
    <div class="chart-sub">机构 / 个人势（每个主播计一次）</div>
    ${pairBars(P.agencyCounts, 'key', '无机构数据')}
    ${(f.liveAgencyUnresolved || []).length ? `<p class="hint">${esc(f.liveAgencyUnresolved.length)} 个机构 UUID 未能解析为名称，已保留原始值；机构名字典来自 Danmakus 公开接口。</p>` : ''}
    <div class="chart-sub">主播粉丝量级</div>
    ${pairBars(P.fansScale, 'key', '无粉丝量级数据')}
    <p class="hint" style="color:var(--warn)">注意：${esc(P.channelMetaNote || '')}</p>`);

  /* 9. 原始记录样本 */
  const samples = (P.samples || []).slice(0, 8);
  const sampleHtml = samples.length
    ? `<table><thead><tr><th>日期</th><th>时段</th><th>类型</th><th>直播间</th><th>内容</th></tr></thead><tbody>${samples.map((s) => `<tr>
        <td>${esc(s.day)}</td><td>${esc(String(s.hour).padStart(2, '0'))}:00</td>
        <td>${esc(s.typeLabel || '')}</td><td>${esc(s.channel || '—')}</td>
        <td>${esc(redacted ? '（已隐藏）' : (s.message || '—'))}</td>
      </tr>`).join('')}</tbody></table>`
    : '<div class="empty">无记录样本</div>';
  const samplesCard = card('发言内容 · 原始记录样本（最多 8 条）',
    sampleHtml, `<p class="hint">完整逐站结果保存在导出的 JSON 证据链中；开启多源缓存脱敏或导出脱敏后原文不会写入。</p>`);

  const results = `
    <div class="section-title">互动画像 · Danmakus /analyze 完整聚合维度（本机清洗后计算）</div>
    ${overview}${leave}${rhythm}${channels}
    <div class="section-title">恶意刷屏判定 · 独轮车（按直播间主播）</div>
    ${renderSpamCard(P.spam)}
    ${expression}${supportBody}
    <div class="section-title">画像分类 · 五维统计分组</div>
    ${radar}
    ${personality}
    <div class="section-title">所涉直播间画像 · 来自记录中的主播 / 场次字段</div>
    ${roomProfile}
    <div class="notice">
      <strong>聚合画像边界。</strong>以上统计与分类由扩展在本机对清洗后的 Danmakus 公开 /history 记录重算，未调用其 POST 分析任务接口，也未采用服务端的主观性格标签；不是站点官方画像结论，不构成身份认定或行为定性。
    </div>
  `;
  // v1.4.0 分层：results=分析结果（弹窗与静态页共用），evidence=原始记录样本（仅静态页）
  if (opts.split) return { results, evidence: samplesCard };
  return `${results}${samplesCard}`;
}

/* ---------- 卡片分层（v1.4.0）：分析结果 > 分析手段 > 分析证据 ----------
 * 弹窗显示区域有限，只渲染「分析结果」层并以总结卡置顶；
 * 「分析手段」「分析证据」两层由导出的纯静态网页报告完整承载。 */

/** 首卡：用户画像总结（多维综合评价，语言简练、便于快速浏览）。 */
function renderSummaryCard(f) {
  const s = f && f.livePortrait ? f.livePortrait.summaryCard : null;
  if (!s) return '';
  const item = (k, v) => `<div class="sum-item"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  const sp = s.spam || null;
  const spTone = !sp ? 'na'
    : (sp.level === 'high' || sp.level === 'coordinated') ? 'fail'
      : (sp.level === 'suspect' || sp.level === 'watch') ? 'warn' : 'ok';
  const spamLine = sp
    ? `<p class="sum-spam"><span class="k">恶意行为</span><span class="pill ${spTone}">${esc(sp.label)}</span><span class="t">${esc(sp.text)}</span></p>`
    : '';
  return `<div class="card summary-card">
    <div class="card-title">用户画像总结 <span class="pill ok">分析结果</span></div>
    <p class="sum-headline">${esc(s.headline)}</p>
    ${spamLine}
    <p class="sum-coverage">${esc(s.coverageLine)}</p>
    <div class="sum-grid">
      ${item('最喜爱主播', s.favorite.text)}
      ${item('兴趣爱好', s.interests.text)}
      ${item('评论风格', s.commentStyle.text)}
      ${item('活跃节律', s.rhythm.text)}
      ${item('支持方式', s.support.text)}
      ${item('跨房倾向', s.crossRoom.text)}
    </div>
    <p class="hint">${esc(s.caveat)}</p>
  </div>`;
}

/** 恶意刷屏 / 独轮车判定卡（v1.5.4）。数据来自 lib/spam.js analyzeSpamBursts()。
 *  只陈列可复核证据（窗口 / 同簇 / 占比 / 间隔 / 用户数）与逐条规则结果，不做动机定罪。 */
function renderSpamCard(sp) {
  if (!sp) return '';
  // 画像页里这张卡紧跟「频道偏好 · 最亲密主播」小节，卡名就不再重复小节标题
  const title = sp.context === 'comment' ? '恶意刷屏判定 · 独轮车' : '判定结论 · 全量样本与按主播分解';
  if (!sp.ok) {
    return `<div class="card"><div class="card-title">${title}</div>
      <div class="empty">${esc(sp.note || '文本样本不足，未做判定')}</div></div>`;
  }
  const tone = (sp.level === 'high' || sp.level === 'coordinated') ? 'fail'
    : (sp.level === 'suspect' || sp.level === 'watch') ? 'warn' : 'ok';
  const b = sp.best || {};
  const g = sp.group || null;
  const clock = (ms) => {
    if (!Number(ms)) return '—';
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    // 加日期：弹幕历史可能跨月，只给时分会把不同天的样本看成同一段
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const gapText = b.medianGapMs === null || b.medianGapMs === undefined ? '—' : `${(b.medianGapMs / 1000).toFixed(1)}s`;
  const sampleRows = (sp.samples || []).slice(0, 5).map((m) => `<tr>
      <td>${esc(clock(m.ts))}</td><td>${esc(m.text || '（已按设置隐藏）')}</td></tr>`).join('');
  const ruleRows = (sp.rules || []).map((r) => `<div class="clean-detail-row">
      <span>${r.ok ? '✔' : '·'} <code>${esc(r.id)}</code> ${esc(r.label)}</span>
      <span class="wrap">${esc(r.detail)}</span></div>`).join('');
  const caps = (b.caps || []).length
    ? `<p class="hint" style="color:var(--warn)">已触发边界修正：${esc(b.caps.join('；'))}</p>` : '';
  // 按直播间主播分解：独轮车是「针对某个主播」的行为，必须能落到具体主播名下
  const chList = (sp.channels || []).slice(0, 8);
  const chRows = chList.map((c) => {
    const t = (c.level === 'high' || c.level === 'coordinated') ? 'fail'
      : (c.level === 'suspect' || c.level === 'watch') ? 'warn' : 'ok';
    return `<tr><td>${esc(c.channelName)}</td>
      <td><span class="pill ${t}">${esc(c.levelLabel)}</span></td>
      <td class="num">${c.level === 'none' ? '—' : `${num(c.repeats)}/${num(c.windowMessages)}`}</td></tr>`;
  }).join('');
  const chBlock = chList.length
    ? `<div class="chart-sub">按直播间主播分解 · ${num(sp.channelJudged)}/${num(sp.channelTotal)} 个主播文本足够判定</div>
      <table class="mark-table"><thead><tr><th>主播</th><th>判定</th><th class="num">同簇/窗口</th></tr></thead>
        <tbody>${chRows}</tbody></table>`
    : (Number(sp.channelTotal) ? `<p class="hint">${num(sp.channelTotal)} 个主播的弹幕均不足 ${8} 条，未做分组判定（结论仅按全量样本给出）。</p>` : '');
  return `<div class="card">
    <div class="card-title">${title} <span class="pill ${tone}">${esc(sp.levelLabel)}</span>
      <span class="pill na">${sp.context === 'comment' ? '评论区样本' : '弹幕历史'}</span></div>
    <p class="sum-headline">${esc(sp.behaviourLabel)}${sp.intent !== 'none' ? ' · ' + esc(sp.intentLabel) : ''}</p>
    <div class="kv-grid">
      ${metric('判定窗口', b.windowMs ? `${Math.round(b.windowMs / 1000)}s` : '—')}
      ${metric('窗口内消息', b.messages === undefined ? '—' : num(b.messages) + ' 条')}
      ${metric('同簇条数', b.repeats === undefined ? '—' : num(b.repeats) + ' 条')}
      ${metric('同簇占比', b.share === undefined ? '—' : `${Math.round(b.share * 100)}%`)}
      ${metric('间隔中位数', gapText)}
      ${metric('1s 内连发', b.burstCount === undefined ? '—' : num(b.burstCount) + ' 次')}
    </div>
    ${chBlock}
    ${g ? `<p class="hint">多人侧：${esc(g.kind === 'coordinated' ? '跨用户同步' : '多人复读')} · 同簇 ${num(g.users)} 人 / ${num(g.messages)} 条 · 单人最高占比 ${Math.round((g.share || 0) * 100)}%${g.attackHits ? ` · 攻击特征 ${num(g.attackHits)} 条` : ''}</p>` : ''}
    ${caps}
    <details class="dim-probs"><summary>判定条件与逐项结果（可复核）</summary>${ruleRows}</details>
    <details class="dim-probs"><summary>同簇样本（${num((sp.samples || []).length)} 条）与边界说明</summary>
      ${sampleRows ? `<table class="mark-table"><thead><tr><th>时间</th><th>内容</th></tr></thead><tbody>${sampleRows}</tbody></table>` : '<div class="empty">无同簇样本</div>'}
      <p class="hint">边界：${esc((sp.boundaryNotes || []).join(' '))}</p>
      <p class="hint">${esc(sp.disclaimer || '')}</p>
    </details>
  </div>`;
}

function renderFedOverviewCard(f, p, report) {
  const inf = p.inference || { hits: [], skipped: [] };
  const collected = f.collectedAt ? new Date(f.collectedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
  return `<div class="card">
    <div class="card-title">多源聚合概览 · UID ${esc(f.uid || report.target.value)}</div>
    <div class="kv-grid">
      ${metric('查询站点', num(f.sitesTotal))}
      ${metric('有结构化数据', num(f.sitesWithData))}
      ${metric('缓存命中', num(f.sitesCached))}
      ${metric('失败 / 冷却', num(f.sitesFailed))}
      ${metric('官方线索分', esc(inf.score !== undefined ? inf.score : '—'))}
      ${metric('采集时间', `<span title="${esc(collected)}">${esc(collected.slice(11, 19))}</span>`)}
    </div>
    <p class="hint">${esc(p.federated ? p.federated.disclaimer : report.extra.federatedDisclaimer || '')}</p>
  </div>`;
}

/** 粉丝牌 + 曾用名（v1.5.2）：画像页与多源结果层共用的关键结果卡。
 *  数据优先级：画像层 annotations（官方勋章墙 → AICU 兜底）> 多源 aicu_mark 站点 facts。
 *  两处都取不到时仍然渲染整卡，写清「未取得 + 原因」，而不是静默隐藏整张卡。 */
function renderMarkCard(f, p) {
  const pf = (p && p.facts) || {};
  const anno = (p && p.annotations) || null;
  const am = (anno && anno.medal) || null;
  const ak = (anno && anno.mark) || null;
  const pick = (primary, secondary) => (primary && primary.length ? primary : (secondary || []));

  const medals = pick(am && am.ok ? am.list : null, f && f.medals).slice(0, 12);
  const medalCount = (am && am.ok && am.count) || (f && f.medalCount) || medals.length || null;
  const formerNames = pick(ak && ak.formerNames, f ? f.formerNames : pf.formerNames);
  const guilds = pick(ak && ak.guilds, f ? f.guilds : null);
  const devices = pick(ak && ak.devices, f ? f.devices : null);
  const tags = pick(ak && ak.tags, f ? f.tags : null);
  const markText = (ak && ak.markText) || (f && f.markText) || '';
  const medalSource = (am && am.sourceLabel) || (medals.length ? 'AICU 第三方标注' : '');
  const medalMsg = (am && am.message) || (f && f.markNotes) || '';
  const markMsg = (ak && ak.message) || '';
  const topMedal = medals[0] || null;
  const headline = [
    medals.length
      ? `粉丝牌 ${num(medalCount)} 枚（最高 ${topMedal.name || '—'} Lv${topMedal.level === null || topMedal.level === undefined ? '—' : topMedal.level}）`
      : '粉丝牌未取得',
    formerNames.length ? `曾用名 ${formerNames.length} 个：${formerNames.join('、')}` : '曾用名未取得'
  ].join(' · ');

  const chips = (list) => (list || []).map((x) => `<span class="pill na">${esc(x)}</span>`).join(' ');
  const medalRows = medals.map((m) => {
    const link = m.streamerMid
      ? `<a href="${safeUrl('https://space.bilibili.com/' + m.streamerMid)}" target="_blank" rel="noopener noreferrer">${esc(m.streamerMid)}</a>`
      : '';
    const who = [m.streamer ? esc(m.streamer) : '', link].filter(Boolean).join(' ') || '—';
    return `<tr>
      <td>${esc(m.name || '—')}${m.wearing ? ' <span class="pill ok">佩戴中</span>' : ''}</td>
      <td class="num">Lv${m.level === null || m.level === undefined ? '—' : esc(m.level)}</td>
      <td class="num">${who}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="card-title">粉丝牌 · 曾用名 <span class="pill ok">分析结果</span>${medalSource ? `<span class="pill na">${esc(medalSource)}</span>` : ''}</div>
    <p class="sum-headline">${esc(headline)}</p>
    <div class="chart-sub">粉丝牌${medalCount ? `（${num(medalCount)} 枚，按等级降序）` : ''}</div>
    ${medals.length
      ? `<table class="mark-table"><thead><tr><th>勋章</th><th class="num">等级</th><th class="num">主播</th></tr></thead><tbody>${medalRows}</tbody></table>`
      : `<p class="hint">未取得粉丝牌${medalMsg ? esc('：' + medalMsg) : '：官方勋章墙需登录 B 站（Cookie），第三方站点也未收录该用户。'}</p>`}
    <div class="chart-sub">曾用名</div>
    ${formerNames.length ? `<div class="chip-row">${chips(formerNames)}</div>` : `<p class="hint">未取得曾用名${markMsg ? esc('：' + markMsg) : '：B 站无公开曾用名接口，第三方站点未收录该用户。'}</p>`}
    ${guilds.length ? `<div class="chart-sub">公会</div><div class="chip-row">${chips(guilds)}</div>` : ''}
    ${devices.length ? `<div class="chart-sub">设备</div><div class="chip-row">${chips(devices)}</div>` : ''}
    ${tags.length ? `<div class="chart-sub">标签</div><div class="chip-row">${chips(tags)}</div>` : ''}
    ${markText ? `<p class="hint">站点备注：${esc(markText)}</p>` : ''}
    <p class="hint">粉丝牌优先取 B 站官方勋章墙（含主播名与佩戴状态），未登录或失败时回落到 AICU 第三方标注；第三方数据可能滞后或遗漏，「未收录」不等于「没有」。曾用名只是昵称变更线索，不构成身份认定。</p>
  </div>`;
}

/** 画像页首卡（v1.5.2）：官方数据 + 粉丝牌 / 曾用名的简版总结，便于快速浏览。 */
function renderProfileSummaryCard(p) {
  const f = (p && p.facts) || {};
  const d = (p && p.derived) || {};
  const inf = (p && p.inference) || {};
  const anno = (p && p.annotations) || null;
  const am = (anno && anno.medal) || null;
  const ak = (anno && anno.mark) || null;
  const medals = (am && am.ok && am.list) || [];
  const top = medals[0] || null;
  const formerNames = (ak && ak.formerNames) || f.formerNames || [];
  const level = f.level === null || f.level === undefined ? '—' : f.level;
  const item = (k, v) => `<div class="sum-item"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  const headline = top
    ? `${f.name || '该用户'}（Lv${level}，粉丝 ${num(f.follower)}）持有 ${medals.length} 枚粉丝牌，最高为「${top.name} Lv${top.level}」${formerNames.length ? `，曾用名 ${formerNames.length} 个` : ''}。`
    : `${f.name || '该用户'}（Lv${level}，粉丝 ${num(f.follower)}）暂未取到粉丝牌标注，画像以公开关系、投稿与评论样本为主。`;
  const posting = d.videoSampleCount
    ? `标题模板率 ${(d.titleTemplateRate * 100).toFixed(0)}%、夜间投稿 ${(d.nightPostRate * 100).toFixed(0)}%、集中投稿 ${d.burstCount} 次`
    : '无可用投稿样本';
  return `<div class="card summary-card">
    <div class="card-title">用户画像总结 <span class="pill ok">分析结果</span></div>
    <p class="sum-headline">${esc(headline)}</p>
    <p class="sum-coverage">官方数据覆盖 ${Math.round((p.coverage || 0) * 100)}%，规则命中 ${(inf.hits || []).length} 条，线索分 ${inf.score === undefined ? '—' : inf.score}（${esc(inf.band || '未评分')}）</p>
    <div class="sum-grid">
      ${item('身份', `Lv${level} · 粉丝 ${num(f.follower)} · 关注 ${num(f.following)}`)}
      ${item('粉丝牌', medals.length ? `${medals.length} 枚` : '未取得')}
      ${item('最高粉丝牌', top ? `${top.name} Lv${top.level}${top.streamer ? ' · ' + top.streamer : ''}` : (f.medalTop || '未取得'))}
      ${item('曾用名', formerNames.length ? formerNames.join('、') : '未取得')}
      ${item('投稿倾向', posting)}
      ${item('评论样本', d.commentCount ? `${d.commentCount} 条` : '未采集')}
    </div>
    <p class="hint">「未取得」表示接口未返回或站点未收录，不推定为 0；粉丝牌与曾用名属第三方/官方登录态数据，需人工核验。</p>
  </div>`;
}


/** 结果层明细卡（v1.5.3）：趋势 / 评论时间分布在无样本时只呈现空占位，
 *  不再占住前排位置——opts.splitDeferred 时返回 { results, deferred } 由调用方后置。 */
function renderFedResultCards(f, p, opts = {}) {
  const channels = (f.topChannels || []).slice(0, 6).map((c) => `<tr>
    <td>${esc(c.name)}</td><td class="num">${c.danmaku === null || c.danmaku === undefined ? '—' : num(c.danmaku)}</td>
    <td class="num">${c.liveCount === null || c.liveCount === undefined ? '—' : num(c.liveCount)}</td>
    <td class="num">${num(c.duplicateCount || 1)}</td>
  </tr>`).join('');
  // 有效趋势点少于 2 个时趋势图只会显示占位；评论文本/时间桶全空时分布图同样为空
  const trendPoints = (f.trend || []).filter((t) => t && Number.isFinite(Number(t.fans))).length;
  const trendEmpty = trendPoints < 2;
  const replyEmpty = !((f.monthBuckets || []).length || (f.hourBuckets || []).length);
  const trendCard = `
    <div class="card">
      <div class="card-title">粉丝趋势 · ZeroRoku（最近 ${Math.min(trendPoints, 90)} 个点）</div>
      ${trendChart(f.trend)}
      <p class="hint">纵轴为该 UID 自身样本范围，非跨账号对比基准；页面改版或缺失时该图为空。</p>
    </div>`;
  const replyCard = `
    <div class="card">
      <div class="card-title">评论时间分布 · AICU（样本 ${num(f.replySampleCount)} 条）</div>
      <div class="chart-sub">按月（最近 12 个月）</div>
      ${barsChart(f.monthBuckets, { max: 12, color: '#7aa2f7', title: '评论月份分布' })}
      <div class="chart-sub">按 24 小时（UTC+8 换算）</div>
      ${barsChart(f.hourBuckets, { color: '#f0729a', title: '评论小时分布' })}
      ${p.federated && p.federated.hourPeak !== null && p.federated.hourPeak !== undefined
        ? `<p class="hint">峰值时段 ${esc(p.federated.hourPeak)}:00，占样本 ${((p.federated.hourPeakShare || 0) * 100).toFixed(0)}%。仅描述样本，不代表账号行为规律。</p>` : ''}
    </div>`;
  const tagCard = `
    <div class="card">
      <div class="card-title">关注主播标签分布 · Danmakus（已按 uId 去重）</div>
      <p class="hint">下方「弹幕 / 场次」是<strong>Danmakus 统计的主播频道级累计值</strong>（该主播开播以来的全部弹幕与直播场次），<strong>不是目标用户的行为数据</strong>；目标用户在该主播下的留痕见「完整弹幕聚合画像」。标签分布按去重后的主播数计一次。</p>
      ${tagBars(f.tagCounts)}
      ${channels ? `<table><thead><tr><th>主播</th><th class="num">主播累计弹幕</th><th class="num">主播累计场次</th><th class="num">原始重复行</th></tr></thead><tbody>${channels}</tbody></table>` : ''}
      <p class="hint">同一主播快照在该接口会按场次重复返回；去重前后行数见静态报告「分析手段」层。第三方频道累计值会随站点重新统计而变化，两次采集之间的数值漂移属正常现象。</p>
    </div>`;
  const results = `${trendEmpty ? '' : trendCard}${replyEmpty ? '' : replyCard}${tagCard}`;
  const deferred = `${trendEmpty ? trendCard : ''}${replyEmpty ? replyCard : ''}`;
  return opts.splitDeferred ? { results, deferred } : `${results}${deferred}`;
}

/** 分析手段层：清洗工序、站点覆盖与状态、口径指标、评分规则。仅静态网页报告渲染。 */
function renderFedMethodsCards(report) {
  const f = report.extra && report.extra.federated;
  const p = report.profiles[0];
  const inf = p.inference || { hits: [], skipped: [] };
  const fedHits = (inf.hits || []).filter((h) => String(h.id).startsWith('F'));
  return `
    ${f.dataBasis === 'cleaned' ? '' : `<div class="notice"><strong>数据口径提示。</strong>本次报告未标记清洗来源，为保证一致性请重新聚合后再查看完整画像。</div>`}
    ${renderCleaning(f.cleaning || (report.extra && report.extra.cleaning))}

    <div class="card">
      <div class="card-title">来源覆盖 · 站点状态分布（清洗后状态）</div>
      ${donutChart(f.statuses)}
      <p class="hint">环形图只统计站点状态数量；不同站点的数据口径不可直接相加或横向比较。</p>
    </div>

    <div class="card">
      <div class="card-title">第三方关键指标（逐项可回溯到站点）</div>
      <div class="kv-grid">
        ${metric('AICU 历史评论', fedValue(f.replyTotal))}
        ${metric('评论样本', fedValue(f.replySampleCount))}
        ${metric('涉及动态数', fedValue(f.distinctOids))}
        ${metric('关注主播', fedValue(f.channelCount))}
        ${metric('累计弹幕', fedValue(f.totalDanmaku))}
        ${metric('粉丝趋势点', fedValue(f.trendPoints))}
        ${metric('最新粉丝', f.fansLatest === null || f.fansLatest === undefined ? '—' : compact(f.fansLatest))}
        ${metric('近 30 点增量', f.fansDelta30Points === null || f.fansDelta30Points === undefined ? '—' : compact(f.fansDelta30Points))}
        ${metric('vtbs.moe 收录', f.vtbsListed === null || f.vtbsListed === undefined ? '—' : (f.vtbsListed ? '是' : '否'))}
        ${metric('弹幕记录', fedValue(f.liveRecordCount))}
        ${metric('弹幕活跃天数', fedValue(f.liveActiveDays))}
        ${metric('关注主播（去重后）', fedValue(f.channelCount))}
        ${metric('关注主播原始行', fedValue(f.channelRawRowCount))}
        ${metric('主播重复行移除', fedValue(f.channelDuplicateRowsDropped))}
        ${metric('弹幕清洗前记录', fedValue(f.liveRawRecordCount))}
      </div>
      <p class="hint">「历史评论」是第三方站点自行标注的总量，与本次抓取的样本数不是同一口径；缺失显示「—」，不推断为 0。关注主播已按 uId 去重，标签与累计量均只计唯一主播。</p>
    </div>

    <div class="section-title">站点状态矩阵 · 单站刷新与人工核验</div>
    <div class="card">${renderSiteMatrix(f)}</div>

    <div class="card">
      <div class="card-title">第三方证据参与评分（默认关闭）</div>
      ${fedHits.length
        ? fedHits.map((h) => `<div class="rule"><span class="rule-id">${esc(h.id)}</span><span class="rule-body">${esc(h.label)}<div class="rule-evidence">${esc(h.evidence)}</div></span><span class="rule-weight">+${h.weight}</span></div>`).join('')
        : '<div class="empty">未命中 F01 / F02，或未在设置中开启第三方证据计分</div>'}
      <p class="hint">开启开关后 F01 +8、F02 +6 才参与线索分；第三方数据的时效性与口径不受本工具控制，命中项必须人工核验。</p>
    </div>`;
}

/** 分析证据层：多源证据片段。仅静态网页报告渲染。 */
function renderFedEvidenceCards(report) {
  const f = report.extra && report.extra.federated;
  const evidence = (f.evidence || []).slice(0, 20).map((e) => `<div class="fed-evidence-row">
    <span class="pill na">${esc(e.site)}</span><span>${esc(e.label)}</span><span class="hint">${esc(e.value)}</span>
  </div>`).join('');
  return `<div class="card">
    <div class="card-title">原始证据片段（最多 20 条）</div>
    ${evidence || '<div class="empty">本次没有可展示的证据片段（可能已按设置脱敏）</div>'}
    <p class="hint">完整逐站结果保存在导出的 JSON 证据链中；导出可勾选脱敏。</p>
  </div>`;
}

/** 弹窗「多源数据」页：只渲染分析结果层（总结卡置顶）。 */
function renderFederated(report) {
  const f = report.extra && report.extra.federated;
  const p = report.profiles[0];
  if (!f || !p) return '<div class="error">本次报告不含多源数据</div>';
  const live = renderLiveBehavior(f, { split: true });
  const fedCards = renderFedResultCards(f, p, { splitDeferred: true });
  return `
    ${renderSummaryCard(f)}
    ${renderMarkCard(f, p)}
    <div class="section-title">分析结果 · 多源与完整画像（口径：清洗后样本）</div>
    ${renderFedOverviewCard(f, p, report)}
    ${fedCards.results}
    ${live.results}
    ${fedCards.deferred ? `<div class="section-title">数据不足的维度 · 无可用样本（后置）</div>${fedCards.deferred}` : ''}
  `;
}

/* ------------------------------ 页面上下文 ------------------------------ */

async function getPageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/bilibili\.com/.test(tab.url || '')) return null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'BILILENS_GET_PAGE_CONTEXT' });
    return res && res.ok ? res.context : null;
  } catch { return null; }
}

/* ------------------------------ 事件绑定 ------------------------------ */

$$('.tab').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

$('#profile-btn').addEventListener('click', async (event) => {
  const input = $('#user-input').value.trim();
  if (!input) { showError($('#profile-result'), '请输入 UID、主页链接或昵称'); return; }
  setBusy(event.currentTarget, true, '采集中…');
  setStatus('正在采集公开数据', 'busy');
  try {
    const res = await send({ type: 'PROFILE_USER', input });
    if (!res.ok) { showError($('#profile-result'), res.error); setStatus('采集失败', 'error'); return; }
    state.report = res.report;
    $('#profile-result').innerHTML = renderProfile(res.report);
    renderReportSummary();
    setStatus('画像完成 · 数据仅存本机');
  } finally {
    setBusy(event.currentTarget, false);
    hideProgress();
  }
});

$('#use-page-btn').addEventListener('click', async () => {
  const ctx = await getPageContext();
  if (!ctx) { setStatus('当前标签页不是可识别的 B 站页面', 'error'); return; }
  if (ctx.type === 'user' && ctx.mid) {
    $('#user-input').value = ctx.mid;
    setStatus(`已填入当前页面 UID ${ctx.mid}`);
  } else if (ctx.type === 'video' && ctx.bvid) {
    switchTab('comments');
    $('#video-input').value = ctx.bvid;
    setStatus(`已填入当前视频 ${ctx.bvid}`);
  } else if (ctx.mids && ctx.mids.length) {
    $('#user-input').value = ctx.mids[0];
    setStatus(`当前页面识别到 ${ctx.mids.length} 个用户，已填入首个`);
  } else {
    setStatus('页面未识别到可用目标，请手动输入', 'error');
  }
});

$('#profile-result').addEventListener('click', (event) => {
  const mid = event.target.closest('[data-mid]')?.dataset.mid;
  if (!mid) return;
  $('#user-input').value = mid;
  $('#profile-btn').click();
});

$('#comments-result').addEventListener('click', (event) => {
  const mid = event.target.closest('tr[data-mid]')?.dataset.mid;
  if (!mid) return;
  switchTab('profile');
  $('#user-input').value = mid;
  $('#profile-btn').click();
});

$('#analyze-video-btn').addEventListener('click', async (event) => {
  const videoInput = $('#video-input').value.trim();
  if (!videoInput) { showError($('#comments-result'), '请输入 BV 号、av 号或视频链接'); return; }
  setBusy(event.currentTarget, true, '分析中…');
  setProgress(0, 100, '正在准备采集', 'analyze');
  $('#comments-result').innerHTML = '<div class="empty">正在抓取评论并逐个画像，请勿关闭弹窗…</div>';
  try {
    const res = await send({
      type: 'ANALYZE_VIDEO',
      videoInput,
      pages: Number($('#video-pages').value),
      maxUsers: Number($('#video-maxusers').value)
    });
    if (!res.ok) { showError($('#comments-result'), res.error || '分析失败'); setStatus('分析失败', 'error'); return; }
    state.report = res.report;
    $('#comments-result').innerHTML = renderBatch(res.report);
    renderReportSummary();
    setStatus('评论区分析完成 · 请人工复核证据');
  } finally {
    setBusy(event.currentTarget, false);
    hideProgress();
  }
});

$('#fetch-comments-btn').addEventListener('click', async (event) => {
  const videoInput = $('#video-input').value.trim();
  if (!videoInput) { showError($('#comments-result'), '请输入 BV 号、av 号或视频链接'); return; }
  setBusy(event.currentTarget, true, '抓取中…');
  setStatus('正在抓取评论', 'busy');
  try {
    const res = await send({ type: 'FETCH_COMMENTS', videoInput, pages: Number($('#video-pages').value) });
    if (!res.ok) { showError($('#comments-result'), res.error || '抓取失败'); setStatus('抓取失败', 'error'); return; }
    const rows = res.comments.slice(0, 20).map((c) => `<tr><td>${esc(c.uname || c.mid)}</td><td class="num">${num(c.mid)}</td><td>${esc(c.message.slice(0, 50))}</td><td>${esc(ts(c.ctime).slice(0, 16))}</td></tr>`).join('');
    $('#comments-result').innerHTML = `<div class="card"><div class="card-title">${esc(res.videoTitle || '视频')} · 共 ${res.comments.length} 条评论（展示前 20 条）</div>
      <table><thead><tr><th>昵称</th><th class="num">UID</th><th>内容</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table>
      ${res.errors && res.errors.length ? `<p class="hint" style="color:var(--warn)">${esc(res.errors.join('；'))}</p>` : ''}
      </div>`;
    setStatus(`已抓取 ${res.comments.length} 条评论`);
  } finally {
    setBusy(event.currentTarget, false);
    hideProgress();
  }
});

/* ------------------------------ 详细网页报告跳转（v1.4.1） ------------------------------ */

/**
 * 弹窗跳转按钮：把当前多源报告渲染为完整分层网页（分析结果 > 分析手段 > 分析证据），
 * 暂存到 chrome.storage.local 后在新标签页打开扩展自带 viewer 页面渲染。
 * 弹窗本身的交互与卡片布局保持不变；blob/data URL 方案会被弹窗关闭或浏览器拦截，故走 storage 中转。
 */
const REPORT_TAB_KEY = 'bl:reportTab';

$('#open-report-btn').addEventListener('click', async (event) => {
  const report = (state.report && state.report.target && state.report.target.kind === 'federated')
    ? state.report : state.federatedReport;
  if (!report) { setStatus('暂无多源报告，请先在下方完成聚合', 'error'); return; }
  setBusy(event.currentTarget, true, '生成中…');
  try {
    const html = await buildStaticReportHtml(report);
    // 先写 storage 再开标签页：弹窗在新标签页获得焦点后即被销毁，不能依赖其后续代码
    await chrome.storage.local.set({ [REPORT_TAB_KEY]: html });
    chrome.tabs.create({ url: chrome.runtime.getURL('report/viewer.html') });
    setStatus('已在新标签页打开详细网页报告');
  } catch (err) {
    setStatus('详细报告打开失败', 'error');
    $('#export-result').innerHTML = `<div class="error">${esc((err && err.message) || String(err))}</div>`;
  } finally { setBusy(event.currentTarget, false); }
});

/* ------------------------------ 「更多」站点跳转菜单（v1.5.1） ------------------------------ */

/** 取当前目标 UID：优先输入框中的数字，其次当前多源报告的目标值。 */
function currentUid() {
  const raw = $('#federated-input').value.trim();
  const digits = (raw.match(/\d{4,}/) || [])[0];
  if (digits) return digits;
  const t = state.report && state.report.target;
  if (t && t.kind === 'federated' && /^\d+$/.test(String(t.value))) return String(t.value);
  return '';
}

/** 菜单项：B 站空间 + 每个已配置站点的 pageUrl（{uid} 自动替换）。 */
function buildMoreItems() {
  const uid = currentUid();
  const items = [{ label: 'B 站空间', url: uid ? `https://space.bilibili.com/${uid}` : '' }];
  state.federatedSites.forEach((s) => {
    items.push({
      label: `在 ${s.name}${s.label ? ' · ' + s.label : ''} 查看`,
      url: uid && s.pageUrl ? String(s.pageUrl).replace(/\{uid\}/g, uid) : ''
    });
  });
  return items;
}

function renderMoreMenu() {
  const menu = $('#more-menu');
  const items = buildMoreItems();
  menu.innerHTML = items.map((it) => it.url
    ? `<button class="more-item" data-more-url="${esc(it.url)}" role="menuitem">${esc(it.label)} ↗</button>`
    : `<button class="more-item disabled" disabled role="menuitem">${esc(it.label)}（先填 UID）</button>`).join('');
}

function setMoreOpen(open) {
  const menu = $('#more-menu');
  const btn = $('#more-btn');
  menu.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.textContent = open ? '更多 ▴' : '更多 ▾';
}

$('#more-btn').addEventListener('click', (event) => {
  event.stopPropagation();
  const willOpen = $('#more-menu').classList.contains('hidden');
  if (willOpen) renderMoreMenu();
  setMoreOpen(willOpen);
});

$('#more-menu').addEventListener('click', (event) => {
  const item = event.target.closest('[data-more-url]');
  if (!item) return;
  chrome.tabs.create({ url: item.dataset.moreUrl });
  setMoreOpen(false);
  setStatus('已在新标签页打开对应站点');
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.more-wrap') && !$('#more-menu').classList.contains('hidden')) setMoreOpen(false);
});

$('#export-json-btn').addEventListener('click', () => exportReport('json'));$('#export-csv-btn').addEventListener('click', () => exportReport('csv'));
async function exportReport(format) {
  const res = await send({ type: 'EXPORT', format });
  $('#export-result').innerHTML = res.ok
    ? `<div class="card"><div class="card-title">已开始下载</div>${esc(res.filename)} · ${num(res.bytes)} 字符</div>`
    : `<div class="error">${esc(res.error)}</div>`;
  setStatus(res.ok ? '导出完成' : '导出失败', res.ok ? '' : 'error');
}

/* ------------------------------ 纯静态网页报告（v1.4.0） ------------------------------ */

/**
 * 把当前多源报告渲染为自包含 HTML（单文件、离线可开）。
 * 卡片优先级：分析结果 > 分析手段 > 分析证据；首卡为用户画像总结卡。
 * 模板与样式均从扩展包内读取后内嵌，产物不再依赖任何扩展接口。
 */
async function buildStaticReportHtml(report) {
  const f = report.extra && report.extra.federated;
  const p = report.profiles && report.profiles[0];
  if (!f || !p) throw new Error('当前报告不含多源数据，请先在「多源数据」页完成聚合');
  const [css, shell] = await Promise.all([
    fetch(chrome.runtime.getURL('popup/popup.css')).then((r) => r.text()),
    fetch(chrome.runtime.getURL('report/report-shell.html')).then((r) => r.text())
  ]);
  const live = renderLiveBehavior(f, { split: true });
  const fedCards = renderFedResultCards(f, p, { splitDeferred: true });
  const body = [
    '<div class="report-tier">分析结果</div>',
    renderSummaryCard(f),
    renderMarkCard(f, p),
    renderFedOverviewCard(f, p, report),
    fedCards.results,
    live.results,
    fedCards.deferred ? `<div class="section-title">数据不足的维度 · 无可用样本（后置）</div>${fedCards.deferred}` : '',
    '<div class="report-tier">分析手段</div>',
    renderFedMethodsCards(report),
    '<div class="report-tier">分析证据</div>',
    renderFedEvidenceCards(report),
    live.evidence,
    '<div class="notice"><strong>报告边界。</strong>本页为 BiliLens 生成的纯静态快照，数据来自生成时刻的公开接口与清洗结果，不随源站更新；所有统计与分类均在扩展本机计算，不构成事实结论。</div>'
  ].join('');
  const title = `BiliLens 画像报告 · ${report.target.label || report.target.value}`;
  // 用 split/join 而非 replace：CSS/HTML 内容可能包含 $& 等替换特殊序列
  return shell
    .split('__TITLE__').join(esc(title))
    .split('__GENERATED__').join(new Date().toLocaleString('zh-CN', { hour12: false }))
    .split('__CSS__').join(css)
    .split('__BODY__').join(body);
}

$('#export-html-btn').addEventListener('click', async (event) => {
  const report = (state.report && state.report.target && state.report.target.kind === 'federated')
    ? state.report : state.federatedReport;
  if (!report) {
    $('#export-result').innerHTML = '<div class="error">暂无多源报告，请先在「多源数据」页完成聚合</div>';
    return;
  }
  setBusy(event.currentTarget, true, '生成中…');
  try {
    const html = await buildStaticReportHtml(report);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `BiliLens-report-${report.target.value || 'report'}-${stamp}.html`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    $('#export-result').innerHTML = `<div class="card"><div class="card-title">静态网页报告已开始下载</div>${esc(name)} · ${num(html.length)} 字符 · 浏览器直接打开即可离线查看</div>`;
    setStatus('静态网页报告导出完成');
  } catch (err) {
    $('#export-result').innerHTML = `<div class="error">${esc((err && err.message) || String(err))}</div>`;
    setStatus('静态报告导出失败', 'error');
  } finally { setBusy(event.currentTarget, false); }
});

$('#clear-btn').addEventListener('click', async () => {
  if (!window.confirm('确认清除本机保存的全部设置、缓存与报告？此操作不可撤销。')) return;
  const res = await send({ type: 'CLEAR_DATA' });
  state.report = null;
  renderReportSummary();
  $('#export-result').innerHTML = `<div class="card">已清除 ${res.removed} 项本地数据。</div>`;
  setStatus('本地数据已清除');
});

/* ------------------------------ 多源数据事件 ------------------------------ */

async function runFederated(force) {
  const input = $('#federated-input').value.trim();
  const container = $('#federated-result');
  if (!input) { showError(container, '请输入 UID 或 space 主页链接'); return; }
  const siteIds = [...state.federatedSelected];
  if (!siteIds.length) { showError(container, '请至少勾选一个查询站点'); return; }
  const button = force ? $('#federated-force-btn') : $('#federated-btn');
  setBusy(button, true, '聚合中…');
  setProgress(0, 100, '正在采集官方画像并按站点串行查询', 'federated');
  container.innerHTML = '<div class="empty">正在查询第三方公开数据，请勿关闭弹窗…</div>';
  try {
    const res = await send({ type: 'ANALYZE_FEDERATED', input, force, siteIds });
    if (!res.ok) { showError(container, res.error); setStatus('多源聚合失败', 'error'); return; }
    state.report = res.report;
    state.federatedReport = res.report;
    container.innerHTML = renderFederated(res.report);
    renderReportSummary();
    setStatus(`多源聚合完成 · ${res.federated.sitesWithData}/${res.federated.sitesTotal} 个站点有数据`);
  } finally {
    setBusy(button, false);
    hideProgress();
  }
}

$('#federated-btn').addEventListener('click', () => runFederated(false));
$('#federated-force-btn').addEventListener('click', () => runFederated(true));
$('#federated-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') runFederated(false);
});

$('#federated-clear-btn').addEventListener('click', async (event) => {
  setBusy(event.currentTarget, true, '清除中…');
  try {
    const res = await send({ type: 'FEDERATED_CLEAR_CACHE' });
    setStatus(res.ok ? `已清除 ${res.removed} 项多源缓存（设置与报告保留）` : res.error, res.ok ? '' : 'error');
  } finally { setBusy(event.currentTarget, false); }
});

$('#federated-site-list').addEventListener('change', (event) => {
  const input = event.target.closest('input[data-fed-site]');
  if (!input) return;
  if (input.checked) state.federatedSelected.add(input.dataset.fedSite);
  else state.federatedSelected.delete(input.dataset.fedSite);
  renderFederatedSites();
  persistFederatedSites();
});

$('#fed-site-all-btn').addEventListener('click', () => {
  state.federatedSelected = new Set(state.federatedSites.map((s) => s.id));
  renderFederatedSites();
  persistFederatedSites();
});
$('#fed-site-default-btn').addEventListener('click', () => {
  const defaults = ['bilibili', 'danmakus', 'danmakus_live', 'aicu', 'aicu_mark', 'icu', 'zeroroku', 'vtbs'];
  state.federatedSelected = new Set(defaults.filter((id) => state.federatedSites.some((s) => s.id === id)));
  renderFederatedSites();
  persistFederatedSites();
});

$('#federated-result').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-fed-refresh]');
  if (!button || button.disabled) return;
  setBusy(button, true, '刷新中…');
  try {
    const res = await send({ type: 'FEDERATED_REFRESH_SITE', siteId: button.dataset.fedRefresh });
    if (!res.ok) { setStatus(res.error, 'error'); return; }
    state.report = res.report;
    state.federatedReport = res.report;
    $('#federated-result').innerHTML = renderFederated(res.report);
    renderReportSummary();
    setStatus('已强制刷新该站点并更新报告');
  } finally { setBusy(button, false); }
});

/* 频道表的「筛选主播 / 正则 / 隐藏仅 1 场」只影响显示，不改动统计结果。 */
function applyChannelFilter(container) {
  const rows = [...container.querySelectorAll('[data-channel-row]')];
  if (!rows.length) return;
  const filter = container.querySelector('[data-channel-filter]');
  const hideSingle = container.querySelector('[data-channel-hide-single]');
  let re = null;
  if (filter && filter.value.trim()) {
    try { re = new RegExp(filter.value.trim(), 'i'); }
    catch { re = null; }
  }
  rows.forEach((row) => {
    const name = row.dataset.name || '';
    const sessions = Number(String(row.dataset.sessions || '').replace(/[^\d]/g, '')) || 0;
    const nameOk = !re || re.test(name);
    const sessionOk = !(hideSingle && hideSingle.checked) || sessions > 1;
    row.style.display = nameOk && sessionOk ? '' : 'none';
  });
}

$('#federated-result').addEventListener('input', (event) => {
  if (event.target.matches('[data-channel-filter]')) applyChannelFilter($('#federated-result'));
});
$('#federated-result').addEventListener('change', (event) => {
  if (event.target.matches('[data-channel-hide-single]')) applyChannelFilter($('#federated-result'));
});

$('#settings-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#open-options-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'BILILENS_PROGRESS') {
    setProgress(message.done, message.total, message.message, message.phase);
  }
});

/* ------------------------------ 初始化 ------------------------------ */

(async function init() {
  const res = await send({ type: 'GET_STATE' });
  if (!res.ok) { setStatus('无法连接后台', 'error'); return; }
  state.settings = res.settings;
  state.report = res.report;
  state.federatedSelected = new Set(res.settings.federatedSiteIds || []);
  $('#video-pages').value = res.settings.commentPages;
  $('#video-maxusers').value = res.settings.maxBatchUsers;
  $('#storage-text').textContent = `${res.storage.keys} 项本地记录`;
  renderReportSummary();

  const fed = await send({ type: 'FEDERATED_SITES' });
  if (fed.ok) { state.federatedSites = fed.sites; renderFederatedSites(); }

  if (res.report) {
    const kind = res.report.target.kind;
    if (kind === 'federated') {
      state.federatedReport = res.report;
      $('#federated-input').value = res.report.target.value;
      $('#federated-result').innerHTML = renderFederated(res.report);
      switchTab('federated');
    } else if (kind === 'user') {
      $('#profile-result').innerHTML = renderProfile(res.report);
    } else {
      $('#comments-result').innerHTML = renderBatch(res.report);
      switchTab('comments');
    }
  }

  state.pageContext = await getPageContext();
  if (state.pageContext && state.pageContext.mid && !$('#federated-input').value) {
    $('#federated-input').value = state.pageContext.mid;
  }
  setStatus('就绪 · 数据仅存本机');
})();
