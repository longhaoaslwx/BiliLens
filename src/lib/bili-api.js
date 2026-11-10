/* B 站公开接口层。
 *
 * 实测结论（2026-11-08，未登录浏览器上下文）：
 *   /x/web-interface/card          裸请求 code 0，字段最完整，画像主数据源
 *   /x/relation/stat               裸请求 code 0
 *   /x/web-interface/view          裸请求 code 0（BV -> aid）
 *   /x/v2/reply/main               需要来自 www.bilibili.com 的 Referer，页面通道可用
 *   /x/web-interface/wbi/search/type   WBI 签名后可用
 *   /x/space/wbi/arc/search        WBI 签名后可用，但触发风控概率高
 *   /x/space/wbi/acc/info          -352，不作依赖
 *   /x/polymer/web-dynamic/...    412，不作依赖
 *
 * 请求优先走 B 站页面内的 content script（Referer / Cookie / UA 与站内一致），
 * 无可用页面时降级到 service worker 直接请求。遇 -352/-412 只做冷却，不重试、不绕过。
 */
import { plainQuery, signQuery, extractWbiKeys, mixinKey } from './wbi.js';

const BASE = 'https://api.bilibili.com';
const RISK_CODES = new Set([-352, -412, -403, -509, -429]);
const COOLDOWN_MS = 60_000;
// 页面通道单次上限、串行队列单任务上限、坏标签页拉黑时长。
// 三层上限保证任何一次请求挂起都不会让整轮聚合无限等待。
const PAGE_TIMEOUT_MS = 4_000;
const QUERY_TIMEOUT_MS = 3_000;
const QUEUE_TIMEOUT_MS = 15_000;
const BAD_TAB_MS = 60_000;

let config = { minGapMs: 900, onNotice: null };
let chain = Promise.resolve();
let lastAt = 0;
const cooldowns = new Map();
const wbiCache = { mixin: null, at: 0 };
const badTabs = new Map();

export function configure(partial) {
  config = { ...config, ...partial };
}

function notice(text) {
  if (typeof config.onNotice === 'function') {
    try { config.onNotice(text); } catch { /* 提示失败不影响取数 */ }
  }
}

/** 与 Promise.race 等价，但一定清理定时器，避免 MV3 service worker 被悬挂的 timer 拖住。 */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(task) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastAt + config.minGapMs + Math.floor(Math.random() * 220) - Date.now());
    if (wait) await sleep(wait);
    lastAt = Date.now();
    // 单任务硬超时：即使某个 fetch/messaging 永久 pending，串行链也能继续推进。
    return withTimeout(Promise.resolve().then(task), QUEUE_TIMEOUT_MS, {
      ok: false,
      error: `QUEUE_TIMEOUT：单个请求超过 ${QUEUE_TIMEOUT_MS / 1000} 秒未返回`,
      via: 'queue'
    });
  });
  chain = run.catch(() => {});
  return run;
}

async function workerFetch(url) {
  const init = {
    method: 'GET',
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json, text/plain, */*' }
  };
  const withReferrer = {
    ...init,
    referrer: 'https://www.bilibili.com/',
    referrerPolicy: 'unsafe-url'
  };
  for (const options of [withReferrer, init]) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status, via: 'worker' };
      return { ok: true, json: await res.json(), via: 'worker' };
    } catch (error) {
      // referrer 选项在部分运行时不被接受，降级为不带 referrer 的请求
      if (options === init) {
        notice(`B 站接口直连失败（${String(error && error.message || error)}），该字段将记为缺失`);
        return { ok: false, error: String(error), via: 'worker' };
      }
    }
  }
  return { ok: false, error: 'unreachable', via: 'worker' };
}

async function tryPageChannel(url) {
  if (!chrome.tabs || typeof chrome.tabs.sendMessage !== 'function') return null;
  let tabs = [];
  try {
    tabs = await withTimeout(chrome.tabs.query({
      url: [
        'https://www.bilibili.com/*',
        'https://space.bilibili.com/*',
        'https://search.bilibili.com/*',
        'https://t.bilibili.com/*'
      ]
    }), QUERY_TIMEOUT_MS, []);
  } catch {
    return null;
  }
  const now = Date.now();
  for (const tab of (tabs || []).slice(0, 3)) {
    if ((badTabs.get(tab.id) || 0) > now) continue;
    let res;
    try {
      res = await withTimeout(
        chrome.tabs.sendMessage(tab.id, { type: 'BILILENS_PAGE_FETCH', url }),
        PAGE_TIMEOUT_MS,
        { __pageTimeout: true }
      );
    } catch {
      // 该标签页未注入脚本或已失效，尝试下一个
      continue;
    }
    if (res && res.__pageTimeout) {
      badTabs.set(tab.id, now + BAD_TAB_MS);
      notice(`B 站页面通道 ${PAGE_TIMEOUT_MS / 1000} 秒无响应（标签页可能被冻结），已跳过并改用后台直连`);
      continue;
    }
    if (res && res.ok) return { ok: true, json: res.json, status: res.status, via: 'page' };
    // 明确的 HTTP 响应直接采用，不重复请求；网络层错误则回退到后台直连
    if (res && res.status) return { ok: false, error: `HTTP ${res.status}`, status: res.status, via: 'page' };
    if (res && res.error) return { ok: false, error: String(res.error), via: 'page' };
  }
  return null;
}

async function execute(url, preferPage = true) {
  if (preferPage) {
    const page = await tryPageChannel(url);
    if (page && page.ok) return page;
    if (page && page.status) return page;
  }
  return workerFetch(url);
}

function normalize(response, url, path) {
  const source = {
    path,
    url: url.replace(/w_rid=[^&]+/, 'w_rid=<redacted>'),
    via: response.via || 'unknown',
    fetchedAt: new Date().toISOString()
  };
  if (!response.ok) {
    return { ok: false, code: 'TRANSPORT', message: response.error || '请求失败', data: null, source };
  }
  const json = response.json;
  if (!json || typeof json.code === 'undefined') {
    return { ok: false, code: 'BAD_JSON', message: '响应不是 B 站标准 JSON', data: null, source };
  }
  if (json.code !== 0) {
    if (RISK_CODES.has(json.code)) cooldowns.set(path, Date.now() + COOLDOWN_MS);
    return {
      ok: false,
      code: json.code,
      message: json.message || '',
      data: json.data || null,
      source
    };
  }
  return { ok: true, code: 0, data: json.data, source };
}

async function ensureWbi() {
  if (wbiCache.mixin && Date.now() - wbiCache.at < 24 * 3600 * 1000) return wbiCache.mixin;
  const url = `${BASE}/x/web-interface/nav`;
  const response = await queue(() => execute(url));
  if (!response.ok || !response.json) return null;
  const keys = extractWbiKeys(response.json.data);
  if (!keys || keys.imgKey.length !== 32 || keys.subKey.length !== 32) return null;
  wbiCache.mixin = mixinKey(keys.imgKey, keys.subKey);
  wbiCache.at = Date.now();
  return wbiCache.mixin;
}

async function jsonRequest(path, params = {}, options = {}) {
  if ((cooldowns.get(path) || 0) > Date.now()) {
    const left = Math.ceil((cooldowns.get(path) - Date.now()) / 1000);
    return {
      ok: false,
      code: 'COOLDOWN',
      message: `该接口刚触发风控，冷却中（剩余 ${left}s）`,
      data: null,
      source: { path, url: '', via: 'none', fetchedAt: new Date().toISOString() }
    };
  }
  let query;
  if (options.signed) {
    const mixin = await ensureWbi();
    if (!mixin) {
      return {
        ok: false, code: 'NO_WBI', message: '无法获取 WBI 密钥（nav 接口不可用）',
        data: null,
        source: { path, url: '', via: 'none', fetchedAt: new Date().toISOString() }
      };
    }
    query = signQuery(params, mixin);
  } else {
    query = plainQuery(params);
  }
  const url = path.startsWith('http') ? `${path}?${query}` : `${BASE}${path}?${query}`;
  const response = await queue(() => execute(url, options.preferPage !== false));
  return normalize(response, url, path);
}

/* ------------------------------ 具体接口 ------------------------------ */

export const getCard = (mid) => jsonRequest('/x/web-interface/card', { mid, photo: 'false' });
export const getRelationStat = (mid) => jsonRequest('/x/relation/stat', { vmid: mid });
export const getViewByBvid = (bvid) => jsonRequest('/x/web-interface/view', { bvid });
export const getViewByAid = (aid) => jsonRequest('/x/web-interface/view', { aid });

// 粉丝勋章墙（v1.5.0 备选通道，未接线）：api.live.bilibili.com 域，需登录 Cookie（SESSDATA）。
// 当前版本粉丝牌走 AICU 免登录标注接口（lib/federated.js aicu_mark 站点）；
// 若后续需要官方实时勋章墙，可用此端点——页面通道自带登录态，未登录返回 -101。
export const getMedalWall = (mid) =>
  jsonRequest('https://api.live.bilibili.com/xlive/web-ucenter/user/MedalWall', { target_id: mid });

export const getUserVideos = (mid, pn = 1, ps = 20) =>
  jsonRequest('/x/space/wbi/arc/search', {
    mid, pn, ps, index: 1, order: 'pubdate', platform: 'web', web_location: 1550101
  }, { signed: true });

export const searchUsers = (keyword, page = 1) =>
  jsonRequest('/x/web-interface/wbi/search/type', {
    search_type: 'bili_user', keyword, page
  }, { signed: true, preferPage: false });

export const getReplies = ({ oid, type = 1, mode = 3, next = 0, ps = 20 }) =>
  jsonRequest('/x/v2/reply/main', { oid, type, mode, next, ps });

/* ------------------------------ 输入解析 ------------------------------ */

export function parseUserInput(input) {
  const raw = String(input || '').trim();
  const space = raw.match(/space\.bilibili\.com\/(\d+)/i);
  if (space) return { kind: 'uid', value: space[1] };
  // B 站 mid 是 int64（最长 19 位），不能按「10~12 位」这种经验值卡死：
  // 16 位以上的合法 UID 会被误判成昵称去走 search，表现就是「网站能查、插件不支持」。
  if (/^\d{1,19}$/.test(raw)) return { kind: 'uid', value: raw };
  const midParam = raw.match(/[?&]mid=(\d+)/i);
  if (midParam) return { kind: 'uid', value: midParam[1] };
  return { kind: 'keyword', value: raw };
}

export function parseVideoInput(input) {
  const raw = String(input || '').trim();
  const bv = raw.match(/(BV[0-9A-Za-z]{10})/);
  if (bv) return { kind: 'bvid', value: bv[0] };
  const avInUrl = raw.match(/bilibili\.com\/video\/av(\d+)/i);
  if (avInUrl) return { kind: 'aid', value: avInUrl[1] };
  if (/^av\d+$/i.test(raw)) return { kind: 'aid', value: raw.slice(2) };
  if (/^\d+$/.test(raw)) return { kind: 'aid', value: raw };
  return { kind: 'invalid', value: raw };
}

export function riskState() {
  const now = Date.now();
  return [...cooldowns.entries()]
    .filter(([, until]) => until > now)
    .map(([path, until]) => ({ path, secondsLeft: Math.ceil((until - now) / 1000) }));
}
