const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FIELDS = [
  ['minGapMs', 'number', 300, 5000],
  ['cacheTtlMin', 'number', 0, 1440],
  ['commentPages', 'number', 1, 10],
  ['commentPageSize', 'number', 5, 49],
  ['maxBatchUsers', 'number', 1, 60],
  ['videoPageSize', 'number', 5, 50],
  ['federatedTtlMin', 'number', 0, 1440],
  ['federatedTimeoutMs', 'number', 3000, 60000],
  ['federatedLiveMaxPages', 'number', 1, 5],
  ['federatedLivePageSize', 'number', 10, 50]
];
const TEXT_FIELDS = ['federatedLiveStart', 'federatedLiveEnd'];
const CHECKS = [
  'enableKeywordScoring', 'redactExport',
  'federatedRedact', 'enableFederatedScoring', 'federatedLiveHideOnlyEnter'
];
const DEFAULT_FED_SITES = ['bilibili', 'danmakus', 'danmakus_live', 'aicu', 'aicu_mark', 'icu', 'zeroroku', 'vtbs'];
let fedSites = [];

const send = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (response) => resolve(response || { ok: false, error: '后台无响应' }));
});

function renderFedSites(settings) {
  const box = $('#fed-site-list');
  if (!box) return;
  if (!fedSites.length) { box.textContent = '站点清单暂不可用（后台未响应）'; return; }
  const selected = new Set(settings.federatedSiteIds || DEFAULT_FED_SITES);
  box.innerHTML = fedSites.map((s) => `<label class="check fed-site-item" title="${esc(s.note)}">
    <input type="checkbox" data-fed-site="${esc(s.id)}" ${selected.has(s.id) ? 'checked' : ''} />
    <span>${esc(s.name)} · ${esc(s.label)}</span>
  </label>`).join('');
}

function fill(settings) {
  FIELDS.forEach(([id]) => { $('#' + id).value = settings[id]; });
  CHECKS.forEach((id) => { $('#' + id).checked = !!settings[id]; });
  $('#attackKeywords').value = (settings.attackKeywords || []).join('\n');
  TEXT_FIELDS.forEach((id) => { $('#' + id).value = settings[id] || ''; });
  renderFedSites(settings);
}

function collect() {
  const patch = {};
  for (const [id, type, min, max] of FIELDS) {
    const value = Number($('#' + id).value);
    if (!Number.isFinite(value)) throw new Error(`${id} 不是有效数字`);
    patch[id] = Math.max(min, Math.min(max, Math.round(value)));
  }
  CHECKS.forEach((id) => { patch[id] = $('#' + id).checked; });
  patch.attackKeywords = $('#attackKeywords').value
    .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  TEXT_FIELDS.forEach((id) => {
    const value = $('#' + id).value.trim();
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${id} 需为 YYYY-MM-DD 格式或留空`);
    patch[id] = value;
  });
  patch.federatedSiteIds = $$('#fed-site-list input[data-fed-site]:checked')
    .map((el) => el.dataset.fedSite);
  return patch;
}

function status(text, isError = false) {
  const el = $('#save-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--danger)' : 'var(--ok)';
}

async function refreshStorage() {
  const res = await send({ type: 'GET_STATE' });
  if (!res.ok) { $('#storage-info').textContent = '无法读取后台状态'; return; }
  const risks = (res.risk || []).length
    ? `；B 站接口冷却：${res.risk.map((r) => `${r.path} ${r.secondsLeft}s`).join('、')}`
    : '';
  const fedRisks = (res.federatedRisk || []).length
    ? `；多源站点冷却：${res.federatedRisk.map((r) => `${r.siteId} ${r.secondsLeft}s`).join('、')}`
    : '';
  $('#storage-info').textContent =
    `本地记录 ${res.storage.keys} 项 · 约 ${Math.round(res.storage.bytes / 1024)} KB · ${res.hasReport ? '已有报告' : '暂无报告'}${risks}${fedRisks}`;
}

$('#save-btn').addEventListener('click', async () => {
  try {
    const patch = collect();
    const res = await send({ type: 'SET_SETTINGS', patch });
    if (!res.ok) throw new Error(res.error || '保存失败');
    fill(res.settings);
    status('设置已保存');
    await refreshStorage();
  } catch (error) {
    status(String(error.message || error), true);
  }
});

$('#reset-btn').addEventListener('click', async () => {
  const res = await send({ type: 'RESET_SETTINGS' });
  if (!res.ok) { status(res.error || '恢复失败', true); return; }
  fill(res.settings);
  status('已恢复默认设置');
  await refreshStorage();
});

$('#clear-btn').addEventListener('click', async () => {
  if (!window.confirm('确认清除本机保存的全部设置、缓存与报告？此操作不可撤销。')) return;
  const res = await send({ type: 'CLEAR_DATA' });
  status(`已清除 ${res.removed} 项本地数据`);
  await refreshStorage();
});

$('#fed-clear-cache-btn').addEventListener('click', async () => {
  const res = await send({ type: 'FEDERATED_CLEAR_CACHE' });
  const box = $('#fed-cache-status');
  box.textContent = res.ok ? `已清除 ${res.removed} 项多源缓存，设置与报告保留` : (res.error || '清除失败');
  box.style.color = res.ok ? 'var(--ok)' : 'var(--danger)';
  await refreshStorage();
});

(async function init() {
  const sites = await send({ type: 'FEDERATED_SITES' });
  if (sites.ok) fedSites = sites.sites;
  const res = await send({ type: 'GET_STATE' });
  if (res.ok) fill(res.settings);
  await refreshStorage();
})();
