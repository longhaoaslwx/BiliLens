/* 多源数据聚合（BiliScope 风格「在 XXX 查看」+ 真实数据端点）。
 *
 * 站点 URL 与端点依据：
 *   - Ikaros-521/nonebot_plugin_searchBiliInfo（danmakus.com / zeroroku.com / vtbs.moe / matsuri.icu）
 *   - Huizs/bilibili-chengfen-query（api.aicu.cc）
 *   - 2026-11-08 逐个实测
 *
 * 实测结论：
 *   AICU       /api/v3/search/getreply  code 0，返回评论历史与 all_count
 *   Danmakus   /api/search/user/channel code 200，返回关注主播/标签/弹幕量
 *   ZeroRoku   页面为 Nuxt SSR，__NUXT_DATA__ 内含粉丝趋势序列
 *   VTBs       /v1/detail 与 /v1/guard 仅对已收录主播有效，普通 UID 返回 404
 *   ICU        matsuri.icu/channel 为纯客户端渲染，无 SSR 数据，只能人工核验
 *
 * 约束：站点级节流、遇风控只冷却不重试、只缓存裁剪后的事实与证据片段，
 * 不缓存整页 HTML，不保存任何登录凭证，不做去匿名化人肉。
 */
import { cacheGet, cacheSet } from './store.js';
import {
  DM_TYPES, mergeCleanReports, cleanChannels, cleanTrend,
  cleanReplies, cleanGuards, cleanSessions, sessionsOf
} from './clean.js';
import { buildLivePortrait } from './analyze.js';

// DM_TYPES / 归一化工具由清洗层统一提供，保持聚合层与清洗层口径一致
export { DM_TYPES } from './clean.js';
export { normalizePhrase } from './clean.js';

export const SITES = [
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    label: '官方档案',
    kind: 'official',
    pageUrl: 'https://space.bilibili.com/{uid}',
    endpoints: [],
    gapMs: 0,
    note: '官方公开接口已在主画像中采集，此处仅作交叉核对入口，不重复请求。'
  },
  {
    id: 'danmakus',
    name: 'Danmakus',
    label: '成分 / 关注主播',
    kind: 'json',
    pageUrl: 'https://danmakus.com/user/{uid}',
    endpoints: [
      { key: 'channel', url: 'https://danmakus.com/api/search/user/channel?uid={uid}' }
    ],
    gapMs: 600,
    note: '第三方直播互动聚合：关注主播、标签、累计弹幕量。数据可能有滞后或口径差异。'
  },
  {
    id: 'danmakus_live',
    name: 'Danmakus · 弹幕行为',
    label: '弹幕行为画像',
    kind: 'json',
    pageUrl: 'https://danmakus.com/analyze/{uid}',
    endpoints: [
      {
        key: 'history',
        url: 'https://api.ukamnads.icu/api/v3/users/{uid}/history?page={page}&pageSize={pageSize}&hideOnlyEnter={hideOnlyEnter}'
      }
    ],
    paged: true,
    gapMs: 900,
    note: '按 UID 取回该用户在各直播间留下的公开弹幕/事件记录，在扩展本地聚合为时段、活跃日、直播间分布与重复文本线索。实测服务端忽略 start/end 参数，日期范围由本工具在本地按记录时间戳筛选；不调用其 POST 分析任务接口。'
  },
  {
    id: 'aicu',
    name: 'AICU',
    label: '历史评论',
    kind: 'json',
    pageUrl: 'https://www.aicu.cc/?uid={uid}',
    endpoints: [
      { key: 'replies', url: 'https://api.aicu.cc/api/v3/search/getreply?uid={uid}&pn=1&ps=20&mode=0' }
    ],
    gapMs: 1100,
    note: '第三方评论聚合。实测存在 468 滑块与 HTTP 200 + code=-429 软限流；命中即冷却，不重试。'
  },
  {
    id: 'aicu_mark',
    name: 'AICU · 标注',
    label: '曾用名 / 粉丝牌',
    kind: 'json',
    pageUrl: 'https://www.aicu.cc/?uid={uid}',
    endpoints: [
      { key: 'mark', url: 'https://api.aicu.cc/api/v4/user/getusermark?uid={uid}' },
      { key: 'medal', url: 'https://api.aicu.cc/api/v4/user/getmedal?uid={uid}' }
    ],
    gapMs: 900,
    note: 'AICU 用户标注（v1.5.0 实测）：getusermark 返回曾用名 hname[]、公会 gh/gh2、设备、标签；getmedal 返回粉丝牌 {ruid, level, name}（免登录、免签名）。列表为空表示站点未收录该用户，属有效结论。'
  },
  {
    id: 'icu',
    name: 'ICU',
    label: 'matsuri.icu 频道',
    kind: 'page',
    pageUrl: 'https://matsuri.icu/channel/{uid}',
    endpoints: [
      { key: 'page', url: 'https://matsuri.icu/channel/{uid}', accept: 'text/html' }
    ],
    gapMs: 800,
    note: '实测页面为客户端渲染且无 SSR 数据，扩展无法可靠提取结构化数据，仅记录可达性并给出人工核验链接。'
  },
  {
    id: 'zeroroku',
    name: 'ZeroRoku',
    label: '粉丝趋势',
    kind: 'page',
    pageUrl: 'https://zeroroku.com/bilibili/author/{uid}',
    endpoints: [
      { key: 'page', url: 'https://zeroroku.com/bilibili/author/{uid}', accept: 'text/html' }
    ],
    gapMs: 1000,
    note: '实测 api.zeroroku.com 返回 502；改用页面内 __NUXT_DATA__ 解析粉丝趋势与打赏记录。页面较大，仅缓存解析结果。'
  },
  {
    id: 'vtbs',
    name: 'VTBs',
    label: 'vtbs.moe 收录',
    kind: 'json',
    pageUrl: 'https://vtbs.moe/detail/{uid}',
    endpoints: [
      { key: 'detail', url: 'https://api.vtbs.moe/v1/detail/{uid}' },
      { key: 'guard', url: 'https://api.vtbs.moe/v1/guard/{uid}' }
    ],
    gapMs: 700,
    note: '仅收录 V 圈主播。普通 UID 返回 404 属正常「未收录」，不是请求失败。'
  }
];

const RISK_STATUS = new Set([429, 451, 468, 503]);
const COOLDOWN_MS = 60_000;
// 机构字典逐个串行请求，必须限量，否则单站就可能拖满整个聚合窗口
const MAX_AGENCY_UUIDS = 8;
const cooldowns = new Map();

// 机构字典端点：v3 无此路由，实测 v2 提供（2026-11-08 验证）
const AGENCY_API_BASE = 'https://api.ukamnads.icu/api/v2';
const AGENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** 从已取回场次中收集需要解析的机构 UUID（independent / 未标注不需要）。 */
export function collectAgencyUuids(pages) {
  const out = new Set();
  for (const data of pages || []) {
    for (const s of sessionsOf(data)) {
      const u = s && s.channel && s.channel.agencyUuid;
      if (u && u !== 'independent') out.add(String(u).slice(0, 40));
    }
  }
  return [...out];
}

/** 逐个解析机构名；失败或风控时保留原始 UUID，绝不因字典缺失丢弃画像数据。
 *  机构数不设上限时，一次聚合可能派生出几十个串行请求，是「看似卡死」的常见来源。 */
export async function resolveAgencyNames(uuids, options = {}) {
  const names = {};
  const all = uuids || [];
  const list = all.slice(0, MAX_AGENCY_UUIDS);
  const failed = all.slice(MAX_AGENCY_UUIDS).slice();
  for (const uuid of list) {
    if (options.deadlineAt && Date.now() >= options.deadlineAt) { failed.push(uuid); continue; }
    const cacheKey = `fed:agency:${uuid}`;
    if (!options.force) {
      const hit = await cacheGet(cacheKey);
      if (hit) { names[uuid] = hit; continue; }
    }
    const url = `${AGENCY_API_BASE}/agencies/${encodeURIComponent(uuid)}`;
    const res = await fetchOne(url, { timeout: options.timeoutMs || 12_000 });
    if (res.ok && res.httpStatus === 200) {
      try {
        const json = JSON.parse(res.text);
        const name = json && json.code === 200 && json.data && json.data.name;
        if (name) {
          names[uuid] = String(name).slice(0, 60);
          await cacheSet(cacheKey, names[uuid], AGENCY_TTL_MS);
          await sleep(300);
          continue;
        }
      } catch { /* 非 JSON，按失败处理 */ }
    }
    failed.push(uuid);
    await sleep(300);
  }
  return { names, failed, capped: all.length > MAX_AGENCY_UUIDS };
}

export function publicSites() {
  return SITES.map(({ id, name, label, kind, pageUrl, note }) => ({ id, name, label, kind, pageUrl, note }));
}

/** 模板占位符替换；{uid} 与分页/筛选参数都走这里，统一做 URL 编码。 */
export const fill = (template, uid, vars = {}) => String(template).replace(/\{(\w+)\}/g, (match, key) => {
  const value = key === 'uid' ? uid : vars[key];
  return value === undefined || value === null ? match : encodeURIComponent(String(value));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 120) => String(s === null || s === undefined ? '' : s).slice(0, n);

/* ------------------------------ 纯解析函数 ------------------------------ */

/** Nuxt 3 devalue 扁平数组：对象/数组中的整数是节点索引，标量节点直接取值。 */
export function parseNuxtPayload(html, uid) {
  const match = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
    || html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { trend: [], sponsors: [], title: '', payloadFound: false };

  let arr;
  try { arr = JSON.parse(match[1]); } catch { return { trend: [], sponsors: [], title: '', payloadFound: false }; }
  if (!Array.isArray(arr)) return { trend: [], sponsors: [], title: '', payloadFound: false };

  const deref = (value) => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < arr.length) {
      const target = arr[value];
      return (target && typeof target === 'object') ? undefined : target;
    }
    return (value && typeof value === 'object') ? undefined : value;
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? clip(titleMatch[1].trim(), 120) : '';
  const trend = [];
  const sponsors = [];
  for (const node of arr) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if ('fans' in node && 'createdAt' in node) {
      const mid = deref(node.mid);
      if (mid !== undefined && mid !== null && String(mid) !== String(uid)) continue;
      const date = deref(node.createdAt);
      const fans = deref(node.fans);
      if (date === undefined || fans === undefined || fans === null) continue;
      trend.push({
        date: String(date).slice(0, 10),
        fans: Number(fans) || 0,
        rate1: Number(deref(node.rate1)) || 0,
        rate7: Number(deref(node.rate7)) || 0
      });
    }
    if ('amount' in node && 'sponsoredAt' in node) {
      const name = deref(node.name);
      const amount = deref(node.amount);
      const at = deref(node.sponsoredAt);
      if (name !== undefined && amount !== undefined) {
        sponsors.push({ name: clip(name, 40), amount: Number(amount) || 0, at: at === undefined ? '' : String(at).slice(0, 19) });
      }
    }
  }
  trend.sort((a, b) => a.date.localeCompare(b.date));
  return { trend, sponsors, title, payloadFound: true };
}

/**
 * Danmakus 关注主播列表。
 * 实测同一主播快照会按场次重复出现（102 行 / 43 个唯一 uId），
 * 因此先经 cleanChannels() 按 uId 去重，再做标签 / 累计量统计与可视化。
 */
function parseDanmakus(text) {
  let json;
  try { json = JSON.parse(text); } catch {
    return { status: 'error', message: '响应不是合法 JSON', facts: {}, evidence: [], cleaning: null };
  }
  if (json.code !== 200) {
    return { status: 'error', message: `站点返回 code=${json.code}`, facts: {}, evidence: [], cleaning: null };
  }
  const { rows, report } = cleanChannels(Array.isArray(json.data) ? json.data : []);
  const tagCounts = new Map();
  rows.forEach((item) => item.tags.forEach((t) => tagCounts.set(t, (tagCounts.get(t) || 0) + 1)));
  const top = [...rows]
    .sort((a, b) => (b.danmaku || 0) - (a.danmaku || 0))
    .slice(0, 10)
    .map((v) => ({
      name: clip(v.name, 30), uId: v.uId, tags: v.tags.slice(0, 4),
      danmaku: v.danmaku, liveCount: v.liveCount,
      income: v.income, lastLiveDate: v.lastLiveDate,
      duplicateCount: v.duplicateCount
    }));
  // 缺失的数值字段排除出求和，不当作 0 累加后再显示为 0
  const totalDanmaku = rows.reduce((a, v) => a + (v.danmaku || 0), 0);
  const totalLiveCount = rows.reduce((a, v) => a + (v.liveCount || 0), 0);
  const facts = {
    channelCount: rows.length,
    rawRowCount: report.inputRows,
    duplicateRowsDropped: report.counts.duplicatesRemoved,
    topChannels: top,
    tagCounts: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, count]) => ({ tag, count })),
    totalDanmaku, totalLiveCount,
    distinctTags: tagCounts.size,
    cleaning: report
  };
  return {
    status: 'data',
    message: rows.length
      ? `取得 ${rows.length} 个去重后主播（原始 ${report.inputRows} 行，去重 ${report.counts.duplicatesRemoved} 行）`
      : '该 UID 无关注主播记录',
    facts,
    evidence: top.slice(0, 5).map((v) => ({ label: v.name, value: `弹幕 ${v.danmaku ?? '—'} · 场次 ${v.liveCount ?? '—'}` })),
    cleaning: report
  };
}

function parseAicu(text, options = {}) {
  let json;
  try { json = JSON.parse(text); } catch { return { status: 'error', message: '响应不是合法 JSON', facts: {}, evidence: [], cleaning: null }; }
  if (json.code === -429) return { status: 'cooldown', message: 'AICU 软限流（code=-429）', facts: {}, evidence: [], cleaning: null };
  if (json.code !== 0) return { status: 'error', message: `站点返回 code=${json.code}`, facts: {}, evidence: [], cleaning: null };
  const data = json.data || {};
  // 先清洗：按 rpid 去重、时间单位规范化、越界剔除、缺失 oid 记空
  const { rows: replies, report } = cleanReplies(Array.isArray(data.replies) ? data.replies : []);
  const months = new Map();
  const hours = new Map();
  const oids = new Set();
  const samples = [];
  replies.forEach((r) => {
    const t = r.time;
    const shifted = new Date((t + 8 * 3600) * 1000);
    const month = shifted.toISOString().slice(0, 7);
    const hour = shifted.getUTCHours();
    months.set(month, (months.get(month) || 0) + 1);
    hours.set(hour, (hours.get(hour) || 0) + 1);
    if (r.oid) oids.add(r.oid);
    samples.push({
      rpid: r.rpid, time: t, oid: r.oid,
      message: options.redact ? '' : clip(r.message, 120)
    });
  });
  const facts = {
    replyTotal: Number((data.cursor || {}).all_count) || replies.length,
    sampleCount: replies.length,
    rawSampleCount: report.inputRows,
    monthBuckets: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count })),
    hourBuckets: Array.from({ length: 24 }, (_, h) => ({ key: String(h).padStart(2, '0'), count: hours.get(h) || 0 })),
    distinctOids: oids.size,
    latestTime: replies.reduce((a, r) => Math.max(a, r.time), 0),
    earliestTime: replies.reduce((a, r) => Math.min(a, r.time), Infinity),
    samples: samples.slice(0, 20),
    redacted: !!options.redact,
    cleaning: report
  };
  if (!Number.isFinite(facts.earliestTime)) facts.earliestTime = 0;
  return {
    status: 'data',
    message: `取得 ${facts.sampleCount} 条清洗后样本（原始 ${report.inputRows} 条），站点标注历史总量 ${facts.replyTotal}`,
    facts,
    evidence: samples.slice(0, 5).map((s) => ({ label: `rpid ${s.rpid}`, value: s.message || '（原文已按设置隐藏）' })),
    cleaning: report
  };
}

function parseAicuMark(key, text, options = {}) {
  let json;
  try { json = JSON.parse(text); } catch { return { status: 'error', message: '响应不是合法 JSON', facts: {}, evidence: [] }; }
  if (json.code === -429) return { status: 'cooldown', message: 'AICU 软限流（code=-429）', facts: {}, evidence: [] };
  if (json.code !== 0) return { status: 'error', message: `站点返回 code=${json.code}`, facts: {}, evidence: [] };
  const data = json.data || {};
  const clipList = (list) => [...new Set((Array.isArray(list) ? list : [])
    .map((x) => clip(String(x), 40)).filter(Boolean))];

  if (key === 'mark') {
    const facts = {
      formerNames: clipList(data.hname),
      guilds: clipList([data.gh && data.gh.name, data.gh2 && data.gh2.name].filter(Boolean)),
      devices: clipList(data.device),
      tags: clipList(data.tag),
      markText: clip(data.text, 120) || '',
      redacted: !!options.redact
    };
    const hit = facts.formerNames.length || facts.guilds.length || facts.devices.length || facts.tags.length || facts.markText;
    return {
      status: 'data',
      message: hit ? `取得标注：曾用名 ${facts.formerNames.length} 个、公会 ${facts.guilds.length} 个、设备 ${facts.devices.length} 个` : '站点未收录该用户的标注',
      facts,
      evidence: facts.formerNames.map((n) => ({ label: '曾用名', value: n }))
    };
  }
  // medal：粉丝牌 {ruid, level, name}；等级高的排前（清洗层按主播 mid 去重）
  const { rows: medals, report } = cleanGuards(Array.isArray(data.list) ? data.list.map((m) => ({
    mid: m.ruid, uname: m.name, level: m.level
  })) : [], 'aicu:medals', 'AICU 粉丝牌记录');
  const facts = {
    medals: medals.slice(0, 20).map((m) => ({
      name: m.uname, level: m.level, streamerMid: m.mid || ''
    })),
    medalCount: medals.length,
    medalRawCount: report.inputRows,
    cleaning: report
  };
  return {
    status: 'data',
    message: medals.length ? `取得 ${medals.length} 枚粉丝牌（按等级排序，原始 ${report.inputRows} 条）` : '站点未收录该用户的粉丝牌',
    facts,
    evidence: facts.medals.slice(0, 5).map((m) => ({ label: `${m.name} · Lv${m.level}`, value: `主播 UID ${m.streamerMid || '—'}` }))
  };
}

function parseZeroRoku(text, uid) {
  const parsed = parseNuxtPayload(text, uid);
  if (!parsed.payloadFound) return { status: 'page_only', message: '页面可达但未发现 Nuxt 序列化数据', facts: { pageReachable: true }, evidence: [], cleaning: null };
  // 按日期去重、剔除无效粉丝数后再进入趋势图
  const { rows: trend, report } = cleanTrend(parsed.trend);
  if (!trend.length) return { status: 'page_only', message: '页面可达但未解析出有效粉丝趋势', facts: { pageReachable: true, cleaning: report }, evidence: [], cleaning: report };
  const recent = trend.slice(-90);
  const latest = trend[trend.length - 1];
  const past = trend[Math.max(0, trend.length - 31)];
  const facts = {
    pageReachable: true,
    pageTitle: parsed.title,
    trendPoints: trend.length,
    rawTrendPoints: report.inputRows,
    trend: recent,
    fansLatest: latest.fans,
    fansStart: trend[0].fans,
    fansDelta30Points: latest.fans - (past ? past.fans : latest.fans),
    rate7: latest.rate7,
    rate1: latest.rate1,
    sponsorCount: parsed.sponsors.length,
    sponsors: parsed.sponsors.slice(0, 8),
    cleaning: report
  };
  return {
    status: 'data',
    message: `解析并清洗出 ${trend.length} 个粉丝趋势点（${trend[0].date} 起）`,
    facts,
    evidence: [
      { label: '最新粉丝', value: String(latest.fans) },
      { label: '页面标题', value: parsed.title },
      { label: '趋势点数', value: String(trend.length) }
    ],
    cleaning: report
  };
}

function parseIcu(text) {
  const hasSsr = /__NUXT_DATA__|__NEXT_DATA__|window\.__INITIAL_STATE__/.test(text);
  return {
    status: 'page_only',
    message: hasSsr ? '页面可达，含前端状态数据但未做结构化解析' : '页面可达，纯客户端渲染，无结构化数据可提取',
    facts: { pageReachable: true, ssrData: hasSsr },
    evidence: [{ label: '页面状态', value: hasSsr ? '含前端状态' : '需浏览器渲染' }]
  };
}

function parseVtbs(key, text) {
  let json;
  try { json = JSON.parse(text); } catch { return { status: 'error', message: '响应不是合法 JSON', facts: {}, evidence: [] }; }
  if (key === 'detail') {
    return {
      status: 'data',
      message: '该 UID 已被 vtbs.moe 收录',
      facts: {
        vtbsListed: true,
        vtbsName: clip(json.uname, 40),
        vtbsVideos: Number(json.video) || 0,
        vtbsRoomId: json.roomid || null,
        vtbsSign: clip(json.sign, 120)
      },
      evidence: [{ label: '收录名称', value: clip(json.uname, 40) }, { label: '投稿数', value: String(json.video || 0) }]
    };
  }
  const { rows: list, report } = cleanGuards(Array.isArray(json) ? json : []);
  return {
    status: 'data',
    message: `取得 ${list.length} 条清洗后舰团记录`,
    facts: {
      guardCount: list.length,
      guards: list.slice(0, 10),
      cleaning: report
    },
    evidence: list.slice(0, 3).map((g) => ({ label: clip(g.uname, 30), value: `等级 ${g.level ?? '—'}` })),
    cleaning: report
  };
}

/* ------------------- Danmakus 弹幕行为：清洗 → 完整聚合画像 ------------------- */

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

/**
 * 参考 Danmakus /analyze 页面结构，但完全在扩展本机计算。
 * 流程固定：cleanSessions()（规范化 / 缺失 / 异常 / 去重）
 *          → buildLivePortrait()（完整画像与所有可视化数据）。
 * 下游只消费清洗后的结果，绝不直接遍历站点原始响应。
 */
export function parseDanmakusHistory(pages, options = {}) {
  const cleaned = cleanSessions(pages, {
    start: options.start || '', end: options.end || ''
  });
  const portrait = buildLivePortrait(cleaned, {
    redact: !!options.redact,
    total: options.total,
    hasMore: options.hasMore,
    pagesFetched: (pages || []).length,
    start: options.start,
    end: options.end,
    hideOnlyEnter: options.hideOnlyEnter,
    agencyNames: options.agencyNames || {}
  });
  const facts = {
    ...portrait.legacy,
    // 完整 /analyze 聚合画像与清洗报告；所有可视化字段均来自清洗后数据
    portrait,
    cleaning: cleaned.report,
    rawSessionCount: cleaned.rawSessionCount,
    rawRecordCount: cleaned.rawRecordCount,
    dateFilteredCount: cleaned.dateFiltered,
    dataBasis: 'cleaned'
  };
  const cov = portrait.coverage;
  const rangeNote = cov.timeRange.filtered
    ? `，本地筛选 ${cov.timeRange.start || '不限'} ~ ${cov.timeRange.end || '不限'}` : '';
  const removed = cleaned.report.counts;
  const cleanNote = `清洗：去重 ${removed.duplicatesRemoved}、缺失处理 ${removed.missingHandled}、异常剔除 ${removed.anomaliesRemoved}、截断 ${removed.anomaliesClamped}`;
  const agencyResolved = Object.keys(options.agencyNames || {}).length;
  return {
    status: facts.recordCount > 0 ? 'data' : 'page_only',
    message: facts.recordCount
      ? `取回 ${cov.sessionFetched}/${cov.sessionTotal || cov.sessionFetched} 场、清洗后 ${facts.recordCount} 条记录（文本 ${facts.textCount} 条）${rangeNote}；${cleanNote}`
      : `取回 ${cov.sessionFetched} 场但清洗/筛选后无记录${rangeNote}`,
    facts,
    evidence: [
      { label: '场次数', value: `${cov.sessionFetched} / ${cov.sessionTotal || '未知'}` },
      { label: '清洗后记录', value: `${facts.recordCount} 条（原始 ${cleaned.rawRecordCount} 条）` },
      { label: '去重记录', value: `${removed.duplicatesRemoved} 条` },
      { label: '活跃天数', value: String(facts.activeDays) },
      { label: '涉及主播', value: `${facts.distinctChannels} 个（所涉直播间属性，非用户属性）` },
      { label: '机构名解析', value: agencyResolved ? `${agencyResolved} 个机构 UUID 已解析为名称` : '无机构或解析失败（保留原始 UUID）' },
      { label: '覆盖提示', value: cov.hasMore ? '还有未取回的场次，样本非全量' : '已取回可及的全部场次' }
    ],
    cleaning: cleaned.report
  };
}

export function parseEndpoint(siteId, key, text, uid, options = {}) {
  switch (siteId) {
    case 'danmakus': return parseDanmakus(text);
    case 'aicu': return parseAicu(text, options);
    case 'aicu_mark': return parseAicuMark(key, text, options);
    case 'zeroroku': return parseZeroRoku(text, uid);
    case 'icu': return parseIcu(text);
    case 'vtbs': return parseVtbs(key, text);
    default: return { status: 'error', message: '未定义的站点解析器', facts: {}, evidence: [] };
  }
}

/* ------------------------------ 请求与缓存 ------------------------------ */

async function fetchOne(url, options = {}) {
  const timeout = Math.max(1_000, Math.min(options.timeout || 12_000, 30_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: options.accept || 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    });
    const text = await res.text();
    return { ok: true, httpStatus: res.status, text, elapsedMs: Date.now() - started };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      timedOut,
      error: timedOut ? `请求超时（${Math.round(timeout / 1000)} 秒），未取得该站点数据` : String(error),
      elapsedMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

function cooldownResult(site, uid, seconds) {
  return {
    uid: String(uid), siteId: site.id, siteName: site.name, label: site.label,
    pageUrl: fill(site.pageUrl, uid), sourceUrls: [], status: 'cooldown',
    message: `该站点刚触发风控，冷却中（剩余 ${seconds}s），未发送请求`,
    facts: {}, evidence: [], httpStatus: null, fetchedAt: new Date().toISOString(),
    elapsedMs: 0, cached: false
  };
}

/** 多页站点：逐页 GET 原始记录，最后在本地一次性聚合，不触发对方的分析任务。 */
async function queryPagedSite(site, uid, options = {}) {
  const until = cooldowns.get(site.id) || 0;
  if (until > Date.now()) return cooldownResult(site, uid, Math.ceil((until - Date.now()) / 1000));

  const cacheKey = `fed:${site.id}:${uid}`;
  if (!options.force) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const result = {
    uid: String(uid), siteId: site.id, siteName: site.name, label: site.label,
    pageUrl: fill(site.pageUrl, uid), sourceUrls: [], status: 'error', message: '',
    facts: {}, evidence: [], httpStatus: null, fetchedAt: new Date().toISOString(),
    elapsedMs: 0, cached: false, note: site.note
  };
  const maxPages = clamp(options.federatedLiveMaxPages, 1, 5, 2);
  const pageSize = clamp(options.federatedLivePageSize, 10, 50, 50);
  const hideOnlyEnter = options.federatedLiveHideOnlyEnter === false ? 'false' : 'true';
  const pages = [];
  let sessionTotal = 0, hasMore = false, sawRisk = false, sawTimeout = false;

  for (let page = 1; page <= maxPages; page++) {
    if (options.deadlineAt && Date.now() >= options.deadlineAt) {
      result.status = 'timeout';
      result.message = '整轮时间上限已到，剩余分页未请求；可单独点「刷新」补查';
      break;
    }
    const url = fill(site.endpoints[0].url, uid, { page, pageSize, hideOnlyEnter });
    result.sourceUrls.push(url);
    const response = await fetchOne(url, { timeout: options.timeoutMs || 12_000 });
    result.elapsedMs += response.elapsedMs;
    if (!response.ok) {
      sawTimeout = sawTimeout || !!response.timedOut;
      result.message = response.error;
      break;
    }
    result.httpStatus = response.httpStatus;
    if (RISK_STATUS.has(response.httpStatus) || response.httpStatus >= 500) {
      sawRisk = true;
      cooldowns.set(site.id, Date.now() + COOLDOWN_MS);
      result.status = 'cooldown';
      result.message = `HTTP ${response.httpStatus}，触发站点风控/不可用，已冷却 60 秒`;
      break;
    }
    if (response.httpStatus >= 400) { result.status = 'error'; result.message = `HTTP ${response.httpStatus}`; break; }
    let json;
    try { json = JSON.parse(response.text); } catch { result.message = '响应不是合法 JSON'; break; }
    if (json.code !== 200 && json.code !== 0) { result.message = `站点返回 code=${json.code}`; break; }
    const data = json.data || {};
    pages.push(data);
    sessionTotal = Number(data.total) || sessionTotal;
    hasMore = !!data.hasMore;
    if (!hasMore) break;
    if (page < maxPages) await sleep(site.gapMs);
  }

  if (result.status === 'timeout') return result;
  if (sawRisk) return result;
  if (!pages.length) {
    result.status = sawTimeout ? 'timeout' : 'error';
    if (!result.message) result.message = '未取到可用数据';
    return result;
  }
  // 机构 UUID → 名称（Danmakus 记录里只有 agencyUuid；independent 已在清洗层归为「个人势」）
  const agency = await resolveAgencyNames(collectAgencyUuids(pages), options);
  const parsed = parseDanmakusHistory(pages, {
    redact: !!options.redact,
    start: options.federatedLiveStart || '',
    end: options.federatedLiveEnd || '',
    total: sessionTotal, hasMore,
    hideOnlyEnter: hideOnlyEnter === 'true',
    agencyNames: agency.names
  });
  result.facts = parsed.facts;
  result.facts.agencyNames = agency.names;
  result.facts.agencyUnresolved = agency.failed;
  result.facts = parsed.facts;
  result.evidence = parsed.evidence;
  // 取回场次但日期筛选后无记录时记为 page_only，避免把空样本算成「有数据」
  result.status = parsed.status;
  result.message = parsed.message;
  await cacheSet(cacheKey, result, (options.ttlMin || 60) * 60 * 1000);
  return result;
}

export async function querySite(site, uid, options = {}) {
  if (site.paged) return queryPagedSite(site, uid, options);
  const until = cooldowns.get(site.id) || 0;
  if (until > Date.now()) return cooldownResult(site, uid, Math.ceil((until - Date.now()) / 1000));

  const cacheKey = `fed:${site.id}:${uid}`;
  if (!options.force) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const result = {
    uid: String(uid),
    siteId: site.id,
    siteName: site.name,
    label: site.label,
    pageUrl: fill(site.pageUrl, uid),
    sourceUrls: [],
    status: site.kind === 'official' ? 'official' : 'error',
    message: site.kind === 'official' ? site.note : '',
    facts: {},
    evidence: [],
    httpStatus: null,
    fetchedAt: new Date().toISOString(),
    elapsedMs: 0,
    cached: false,
    note: site.note
  };
  if (site.kind === 'official') return result;

  let sawRisk = false;
  let sawSuccess = false;
  let sawTimeout = false;
  for (const endpoint of site.endpoints) {
    if (options.deadlineAt && Date.now() >= options.deadlineAt) {
      result.status = 'timeout';
      result.message = '整轮时间上限已到，本站点剩余端点未请求；可单独点「刷新」补查';
      break;
    }
    const url = fill(endpoint.url, uid);
    result.sourceUrls.push(url);
    const response = await fetchOne(url, { accept: endpoint.accept, timeout: options.timeoutMs || 12_000 });
    result.elapsedMs += response.elapsedMs;
    if (!response.ok) {
      sawTimeout = sawTimeout || !!response.timedOut;
      result.message = response.error;
      continue;
    }
    result.httpStatus = response.httpStatus;

    // 404 对 VTBs 表示「未收录」，是有效结论而非错误
    if (response.httpStatus === 404) {
      if (site.id === 'vtbs') {
        result.facts.vtbsListed = false;
        result.status = 'not_listed';
        result.message = '该 UID 未被 vtbs.moe 收录（正常情况）';
      } else {
        result.status = 'error';
        result.message = 'HTTP 404';
      }
      continue;
    }
    if (RISK_STATUS.has(response.httpStatus) || response.httpStatus >= 500) {
      sawRisk = true;
      cooldowns.set(site.id, Date.now() + COOLDOWN_MS);
      result.status = 'cooldown';
      result.message = `HTTP ${response.httpStatus}，触发站点风控/不可用，已冷却 60 秒`;
      break;
    }
    if (response.httpStatus >= 400) {
      result.status = 'error';
      result.message = `HTTP ${response.httpStatus}`;
      continue;
    }

    const parsed = parseEndpoint(site.id, endpoint.key, response.text, uid, { redact: !!options.redact });
    if (parsed.status === 'cooldown') {
      sawRisk = true;
      cooldowns.set(site.id, Date.now() + COOLDOWN_MS);
      result.status = 'cooldown';
      result.message = parsed.message;
      break;
    }
    Object.assign(result.facts, parsed.facts);
    result.evidence.push(...parsed.evidence.map((e) => ({ ...e, sourceUrl: url })));
    if (parsed.status === 'data') sawSuccess = true;
    if (result.status !== 'data' || parsed.status === 'page_only') {
      if (result.status !== 'data') result.status = parsed.status;
    }
    result.message = parsed.message;
    if (site.endpoints.length > 1) await sleep(site.gapMs);
  }

  if (!sawRisk && result.status !== 'error' && result.status !== 'timeout') {
    if (sawSuccess) result.status = 'data';
    else if (result.status === 'not_listed' || result.status === 'page_only') result.status = result.status;
  }
  if (sawTimeout && result.status === 'error') result.status = 'timeout';
  if (result.status === 'error' && !result.message) result.message = '未取到可用数据';

  if (!sawRisk && result.status !== 'timeout') {
    await cacheSet(cacheKey, result, (options.ttlMin || 60) * 60 * 1000);
  }
  return result;
}

function deadlineResult(site, uid) {
  return {
    uid: String(uid), siteId: site.id, siteName: site.name, label: site.label,
    pageUrl: fill(site.pageUrl, uid), sourceUrls: [], status: 'timeout',
    message: '整轮时间上限已到，本站点未发起请求；可在结果页单独点「刷新」补查',
    facts: {}, evidence: [], httpStatus: null, fetchedAt: new Date().toISOString(),
    elapsedMs: 0, cached: false, note: site.note
  };
}

export async function queryAll(uid, options = {}) {
  // 显式传入空数组表示「一个站点都不查」，不能回退成全站查询
  const selected = Array.isArray(options.siteIds)
    ? SITES.filter((s) => options.siteIds.includes(s.id))
    : SITES;
  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const site = selected[i];
    if (options.deadlineAt && Date.now() >= options.deadlineAt) {
      results.push(deadlineResult(site, uid));
      continue;
    }
    if (options.onSiteStart) options.onSiteStart(i, selected.length, site);
    // 剩余时间不足时收窄单次超时，保证整轮不会突破后台的总时限
    const remaining = options.deadlineAt ? options.deadlineAt - Date.now() : Infinity;
    const perSite = { ...options };
    if (Number.isFinite(remaining)) {
      perSite.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 12_000, remaining));
    }
    const result = await querySite(site, uid, perSite);
    results.push(result);
    if (options.onProgress) options.onProgress(i + 1, selected.length, result);
    if (i < selected.length - 1) await sleep(Math.max(250, site.gapMs));
  }
  return results;
}

/** 汇总为可视化与画像融合所需的统一结构。 */
export function summarizeFederated(results) {
  const byId = Object.fromEntries(results.map((r) => [r.siteId, r]));
  const aicu = byId.aicu ? byId.aicu.facts : {};
  const dan = byId.danmakus ? byId.danmakus.facts : {};
  const live = byId.danmakus_live ? byId.danmakus_live.facts : {};
  const zero = byId.zeroroku ? byId.zeroroku.facts : {};
  const vtbs = byId.vtbs ? byId.vtbs.facts : {};
  const mark = byId.aicu_mark ? byId.aicu_mark.facts : {};
  // 逐源清洗报告合并为整份报告；所有图表字段均来自各解析器输出的清洗后结果
  const cleaning = mergeCleanReports(results.map((r) => (r.facts && r.facts.cleaning) || null));
  return {
    uid: results[0] ? results[0].uid : '',
    collectedAt: new Date().toISOString(),
    sitesTotal: results.length,
    sitesWithData: results.filter((r) => r.status === 'data').length,
    sitesCached: results.filter((r) => r.cached).length,
    sitesFailed: results.filter((r) => r.status === 'error' || r.status === 'cooldown' || r.status === 'timeout').length,
    sitesTimedOut: results.filter((r) => r.status === 'timeout').length,
    statuses: results.map((r) => ({
      siteId: r.siteId, siteName: r.siteName, status: r.status, cached: r.cached,
      message: r.message, elapsedMs: r.elapsedMs, httpStatus: r.httpStatus,
      pageUrl: r.pageUrl, fetchedAt: r.fetchedAt
    })),
    replyTotal: aicu.replyTotal ?? null,
    replySampleCount: aicu.sampleCount ?? 0,
    monthBuckets: aicu.monthBuckets || [],
    hourBuckets: aicu.hourBuckets || [],
    distinctOids: aicu.distinctOids ?? null,
    replyLatestTime: aicu.latestTime ?? null,
    channelCount: dan.channelCount ?? null,
    topChannels: dan.topChannels || [],
    tagCounts: dan.tagCounts || [],
    totalDanmaku: dan.totalDanmaku ?? null,
    trend: zero.trend || [],
    trendPoints: zero.trendPoints ?? null,
    fansLatest: zero.fansLatest ?? null,
    fansDelta30Points: zero.fansDelta30Points ?? null,
    sponsorCount: zero.sponsorCount ?? null,
    vtbsListed: vtbs.vtbsListed ?? null,
    guardCount: vtbs.guardCount ?? null,
    // v1.5.0：AICU 标注（曾用名 / 公会 / 设备 / 标签）与粉丝牌（免登录公开接口）
    formerNames: mark.formerNames || [],
    guilds: mark.guilds || [],
    devices: mark.devices || [],
    tags: mark.tags || [],
    markText: mark.markText || '',
    medals: mark.medals || [],
    medalCount: mark.medalCount ?? null,
    medalRawCount: mark.medalRawCount ?? null,
    markNotes: mark.formerNames ? '' : '站点未收录该用户的标注',
    // v1.3.0：数据清洗报告 + 完整 /analyze 聚合画像（均基于清洗后数据）
    cleaning,
    dataBasis: 'cleaned',
    channelRawRowCount: dan.rawRowCount ?? null,
    channelDuplicateRowsDropped: dan.duplicateRowsDropped ?? null,
    livePortrait: live.portrait || null,
    liveCleaning: live.cleaning || null,
    liveRawRecordCount: live.rawRecordCount ?? null,
    liveDateFilteredCount: live.dateFilteredCount ?? null,
    liveDataBasis: live.dataBasis || null,
    liveAgencyNames: live.agencyNames || {},
    liveAgencyUnresolved: live.agencyUnresolved || [],
    // 弹幕行为画像（扩展本地聚合，非服务端画像结论）
    liveSessionTotal: live.sessionTotal ?? null,
    liveSessionFetched: live.sessionFetched ?? null,
    liveHasMore: live.hasMore ?? null,
    liveRecordCount: live.recordCount ?? null,
    liveTextCount: live.textCount ?? null,
    liveActiveDays: live.activeDays ?? null,
    liveLongestStreak: live.longestStreak ?? null,
    liveEarliestTs: live.earliestTs ?? null,
    liveLatestTs: live.latestTs ?? null,
    liveHourBuckets: live.hourBuckets || [],
    liveWeekdayBuckets: live.weekdayBuckets || [],
    liveMonthBuckets: live.monthBuckets || [],
    liveActiveDates: live.activeDates || [],
    liveEventTypes: live.eventTypes || [],
    liveTopChannels: live.topChannels || [],
    liveAreaCounts: live.areaCounts || [],
    liveRepeatedPhrases: live.repeatedPhrases || [],
    liveSamples: live.samples || [],
    liveTimeRange: live.timeRange || null,
    liveScopeNote: live.scopeNote || '',
    liveRedacted: !!live.redacted,
    liveHideOnlyEnter: live.hideOnlyEnter ?? null,
    liveChannelTags: live.channelTagCounts || [],
    liveAgencyCounts: live.agencyCounts || [],
    liveFansScale: live.fansScaleBuckets || [],
    liveScale: live.liveScale || null,
    liveDistinctChannels: live.distinctChannels ?? null,
    liveChannelMetaNote: live.channelMetaNote || '',
    evidence: results.flatMap((r) => r.evidence.map((e) => ({ site: r.siteName, ...e }))).slice(0, 40),
    rawResults: results
  };
}

export function riskState() {
  const now = Date.now();
  return [...cooldowns.entries()]
    .filter(([, until]) => until > now)
    .map(([siteId, until]) => ({ siteId, secondsLeft: Math.ceil((until - now) / 1000) }));
}
