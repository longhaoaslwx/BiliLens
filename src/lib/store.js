/* 本地存储：全部数据仅保存在扩展自身的 chrome.storage.local，不上传。 */

export const DEFAULTS = {
  // 采集节流
  minGapMs: 900,
  cacheTtlMin: 10,
  commentPages: 3,
  commentPageSize: 20,
  videoPages: 1,
  videoPageSize: 20,
  maxBatchUsers: 12,
  // 画像评分
  enableKeywordScoring: false,
  attackKeywords: [],
  // 多源数据（BiliScope 风格站点聚合）
  federatedTtlMin: 60,
  federatedRedact: false,
  enableFederatedScoring: false,
  federatedTimeoutMs: 12000,
  federatedSiteIds: ['bilibili', 'danmakus', 'danmakus_live', 'aicu', 'aicu_mark', 'icu', 'zeroroku', 'vtbs'],
  // Danmakus 弹幕行为画像：纯 GET 取原始记录，本地聚合
  federatedLiveMaxPages: 2,
  federatedLivePageSize: 50,
  federatedLiveHideOnlyEnter: true,
  federatedLiveStart: '',
  federatedLiveEnd: '',
  // 导出
  redactExport: false
};

const PREFIX = 'bililens:';

async function read(key, fallback) {
  const result = await chrome.storage.local.get(PREFIX + key);
  const value = result[PREFIX + key];
  return value === undefined ? fallback : value;
}

async function write(key, value) {
  await chrome.storage.local.set({ [PREFIX + key]: value });
}

export async function getSettings() {
  const saved = await read('settings', {});
  return { ...DEFAULTS, ...saved };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await write('settings', next);
  return next;
}

export async function cacheGet(key) {
  const entry = await read('cache:' + key, null);
  if (!entry || !entry.expiresAt || entry.expiresAt < Date.now()) return null;
  return entry.value;
}

export async function cacheSet(key, value, ttlMs) {
  await write('cache:' + key, { value, expiresAt: Date.now() + ttlMs });
}

export async function saveReport(report) {
  await write('report', report);
  return report;
}

export async function getReport() {
  return read('report', null);
}

export async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

/** 只清除某一类缓存，保留设置与报告。 */
export async function clearCacheByPrefix(cachePrefix) {
  const all = await chrome.storage.local.get(null);
  const prefix = `${PREFIX}cache:${cachePrefix}`;
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

export async function storageInfo() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  return { keys: keys.length, bytes: JSON.stringify(all).length };
}
