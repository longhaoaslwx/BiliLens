/* 后台编排离线冒烟测试：node smoke.mjs
 * 用内存版 chrome.* mock 与固定接口响应，跑通消息路由全链路，不访问真实网络。
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const memory = new Map();
let handler = null;
let lastDownload = null;

const storage = {
  async get(keys) {
    if (keys === null || keys === undefined) return Object.fromEntries(memory);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach((k) => { if (memory.has(k)) out[k] = memory.get(k); });
    return out;
  },
  async set(obj) { Object.entries(obj).forEach(([k, v]) => memory.set(k, v)); },
  async remove(keys) {
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => memory.delete(k));
  }
};

globalThis.chrome = {
  storage: { local: storage },
  runtime: {
    onMessage: { addListener: (fn) => { handler = fn; } },
    onInstalled: { addListener: () => {} },
    sendMessage: () => Promise.resolve(),
    getURL: (p) => 'file:///' + p
  },
  tabs: { query: async () => [] },
  downloads: { download: async (opts) => { lastDownload = opts; return 1; } }
};

const NAV = { code: -101, message: '账号未登录', data: { wbi_img: {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
} } };
const CARD = { code: 0, data: { card: {
  mid: '123', name: '甲', sex: '保密', level_info: { current_level: 1 }, fans: 2,
  attention: 300, sign: '', face: 'https://i0.hdslb.com/bfs/face/a.jpg',
  Official: {}, official_verify: {}, vip: {}, regtime: 0, article: 0, rank: '10000'
} } };
const RELATION = { code: 0, data: { follower: 2, following: 300 } };
const VIDEOS = { code: 0, data: { page: { count: 1 }, list: { vlist: [{
  aid: 1, bvid: 'BVTEST00001', title: '测试标题', description: '',
  created: 1700000000, play: 3, comment: 0, typeid: 1, length: '00:30'
}] } } };
const VIEW = { code: 0, data: { aid: 170001, title: '测试视频' } };
const REPLIES = { code: 0, data: {
  cursor: { is_end: true, next: 2 },
  replies: [
    { rpid: 1, mid: 123, member: { mid: '123', uname: '甲', level_info: { current_level: 1 } },
      content: { message: '这是一段用于测试的评论话术内容' }, ctime: 1700000000, like: 0 },
    { rpid: 2, mid: 456, member: { mid: '456', uname: '乙', level_info: { current_level: 1 } },
      content: { message: '这是一段用于测试的评论话术内容' }, ctime: 1700000060, like: 0 }
  ]
} };
const SEARCH = { code: 0, data: { result: [{ mid: 123, uname: '甲', fans: 2, level: 1 }] } };

const DANMAKUS = { code: 200, data: [
  { name: '主播A', uId: 1, tags: ['歌势', '游戏'], totalDanmakuCount: 120, totalLiveCount: 30, totalIncome: 0, lastLiveDate: null },
  { name: '主播B', uId: 2, tags: ['歌势'], totalDanmakuCount: 80, totalLiveCount: 10, totalIncome: 0, lastLiveDate: null }
] };
const AICU = { code: 0, data: {
  cursor: { all_count: 137 },
  replies: Array.from({ length: 12 }, (_, i) => ({
    rpid: 1000 + i, time: 1700000000 + i * 3600,
    dyn: { oid: 500 + i }, message: '样本评论' + i
  }))
} };
// Nuxt 3 devalue 扁平数组：对象中的整数是节点索引
const NUXT_ARRAY = [
  '2020-01-01T00:00:00.000Z', 1000, '123', 0,
  { fans: 1, createdAt: 0, mid: 2, rate1: 3, rate7: 3 },
  '2021-01-01T00:00:00.000Z', 5000,
  { fans: 6, createdAt: 5, mid: 2, rate1: 3, rate7: 3 },
  12.5, '2024-01-01T00:00:00', '某用户',
  { amount: 8, sponsoredAt: 9, name: 10 }
];
const NUXT_HTML = `<html><head><title>测试用户粉丝趋势</title></head><body><script id="__NUXT_DATA__" type="application/json">${JSON.stringify(NUXT_ARRAY)}</script></body></html>`;
const ICU_HTML = '<html><body><div id="app"></div></body></html>';

// Danmakus /history 实测结构：danmakus 是对象 {actors, roomEmojis, records}，不是数组
const HISTORY_REC = (iso, text, type = 0) => ({
  ts: Date.parse(iso), type, actorId: 'u1', payloadKind: 'text', payload: { rawText: text }
});
const HISTORY_SESSIONS = [
  {
    channel: { uId: 101, uName: '直播间甲', fansCount: 250000, tags: ['Vtuber', '歌势'], agencyUuid: 'independent' },
    live: { liveId: 1, title: '歌回', parentArea: '虚拟主播', area: '歌势',
      watchCount: 50000, maxOnlineCount: 7000, payCount: 100, interactionCount: 3000 },
    danmakus: { actors: [], roomEmojis: [], records: [
      HISTORY_REC('2024-03-03T19:00:00Z', '来了来了'),
      HISTORY_REC('2024-03-03T19:10:00Z', '来了来了'),
      HISTORY_REC('2024-03-03T19:20:00Z', '666', 1)
    ] }
  },
  {
    channel: { uId: 102, uName: '直播间乙', fansCount: 5000, tags: ['游戏'], agencyUuid: 'agency-x' },
    live: { liveId: 2, title: '游戏', parentArea: '网游', area: '网游', watchCount: 1000, maxOnlineCount: 200 },
    danmakus: { actors: [], roomEmojis: [], records: [HISTORY_REC('2024-03-05T02:00:00Z', '前排')] }
  }
];

const requested = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  requested.push(u);
  let json;
  let text;
  let status = 200;
  if (u.includes('/x/web-interface/nav')) json = NAV;
  else if (u.includes('/x/web-interface/card')) json = CARD;
  else if (u.includes('/x/relation/stat')) json = RELATION;
  else if (u.includes('/x/space/wbi/arc/search')) json = VIDEOS;
  else if (u.includes('/x/web-interface/view')) json = VIEW;
  else if (u.includes('/x/v2/reply/main')) json = REPLIES;
  else if (u.includes('wbi/search/type')) json = SEARCH;
  else if (u.includes('danmakus.com/api/search/user/channel')) json = DANMAKUS;
  else if (u.includes('/api/v3/users/') && u.includes('/history')) {
    const page = Number(new URL(u).searchParams.get('page') || 1);
    json = { code: 200, data: { total: 2, page, pageSize: 50, hasMore: false, items: page === 1 ? HISTORY_SESSIONS : [] } };
  } else if (u.includes('api.aicu.cc') && u.includes('getreply')) json = AICU;
  else if (u.includes('matsuri.icu/channel')) text = ICU_HTML;
  else if (u.includes('zeroroku.com/bilibili/author')) text = NUXT_HTML;
  else if (u.includes('api.vtbs.moe/v1/')) { status = 404; text = ''; }
  else json = { code: -404, message: 'unmocked' };
  return {
    ok: status < 400, status, url: u,
    json: async () => json,
    text: async () => (text === undefined ? JSON.stringify(json) : text)
  };
};

await import(pathToFileURL(resolve('src/background/service-worker.js')).href);
assert.ok(handler, 'service worker registered a message handler');

const call = (message) => new Promise((resolve) => handler(message, {}, resolve));

// 缩短节流，避免测试等待
const configured = await call({ type: 'SET_SETTINGS', patch: { minGapMs: 1 } });
assert.equal(configured.ok, true);
assert.equal(configured.settings.minGapMs, 1);
console.log('OK  SET_SETTINGS / GET_STATE route');

const state = await call({ type: 'GET_STATE' });
assert.equal(state.ok, true);
assert.equal(state.hasReport, false);
console.log('OK  GET_STATE returns settings + empty report');

const single = await call({ type: 'PROFILE_USER', input: '123' });
assert.equal(single.ok, true, single.error);
assert.equal(single.report.profiles.length, 1);
assert.equal(single.report.profiles[0].facts.name, '甲');
assert.ok(single.report.profiles[0].inference.score > 0);
assert.equal(single.report.profiles[0].availability.videos, 'ok');
console.log('OK  PROFILE_USER (card + relation + WBI videos + scoring)');

const byName = await call({ type: 'PROFILE_USER', input: '甲' });
assert.equal(byName.ok, true, byName.error);
assert.equal(byName.report.extra.resolution[0].mid, '123');
console.log('OK  PROFILE_USER by nickname (WBI search)');

const video = await call({ type: 'ANALYZE_VIDEO', videoInput: 'BV1xx411c7mD', pages: 1, maxUsers: 5 });
assert.equal(video.ok, true, video.error);
assert.equal(video.report.comments.length, 2);
assert.equal(video.report.profiles.length, 2);
assert.ok(video.report.clusters.some((c) => c.type === 'shared_wording'));
assert.equal(video.report.summary.profileCount, 2);
console.log('OK  ANALYZE_VIDEO (view -> replies -> profiles -> cohort)');

const exported = await call({ type: 'EXPORT', format: 'csv' });
assert.equal(exported.ok, true, exported.error);
assert.ok(exported.filename.endsWith('.csv'));
const exportedJson = await call({ type: 'EXPORT', format: 'json' });
assert.equal(exportedJson.ok, true);
console.log('OK  EXPORT csv + json (evidence chain)');

// v1.3.0：导出内容携带清洗列（解码 data: URL）
const exportedCsv2 = await call({ type: 'EXPORT', format: 'csv' });
assert.equal(exportedCsv2.ok, true);
const csvText = decodeURIComponent(String(lastDownload.url).replace(/^data:text\/csv;charset=utf-8,/, ''));
assert.ok(csvText.includes('去重条数') && csvText.includes('清洗后记录数'), 'CSV has cleaning columns');

// 多源聚合：七个查询项（含弹幕行为画像）、本地缓存、弹幕参数下发、单站强制刷新、缓存清理
const ALL_SITES = ['bilibili', 'danmakus', 'danmakus_live', 'aicu', 'aicu_mark', 'icu', 'zeroroku', 'vtbs'];
const fedSites = await call({ type: 'FEDERATED_SITES' });
assert.equal(fedSites.ok, true);
assert.equal(fedSites.sites.length, 8);
assert.ok(fedSites.sites.some((s) => s.id === 'danmakus_live'));
console.log('OK  FEDERATED_SITES (8 query entries incl. danmakus_live and aicu_mark)');

const federated = await call({ type: 'ANALYZE_FEDERATED', input: '123', siteIds: ALL_SITES });
assert.equal(federated.ok, true, federated.error);
assert.equal(federated.report.target.kind, 'federated');
assert.ok(federated.report.profiles[0].federated);
assert.equal(federated.report.extra.federated.rawResults.length, 8);
assert.ok(federated.federated.sitesWithData >= 4, 'Danmakus / danmakus_live / AICU / ZeroRoku parsed');
assert.equal(federated.federated.replyTotal, 137);
assert.equal(federated.federated.fansLatest, 5000);
assert.equal(federated.federated.vtbsListed, false);
assert.equal(federated.federated.liveSessionFetched, 2);
assert.equal(federated.federated.liveRecordCount, 4);
assert.equal(federated.federated.liveActiveDays, 2);
assert.equal(federated.federated.liveTopChannels[0].uid, '101');
assert.equal(federated.federated.liveRepeatedPhrases[0].count, 2);
assert.equal(federated.federated.liveHideOnlyEnter, true);
assert.equal(federated.federated.liveDistinctChannels, 2);
assert.equal(federated.federated.liveScale.watchCount, 51000);
assert.ok(federated.federated.liveChannelTags.some((t) => t.key === 'Vtuber'));
assert.equal(federated.report.profiles[0].federated.liveRecordCount, 4, 'live stats merged into evidence layer');
assert.equal(federated.report.profiles[0].federated.liveDistinctChannels, 2);
assert.equal(federated.report.settingsEcho.federatedLiveMaxPages, 2);
const liveResult = federated.report.extra.federated.rawResults.find((r) => r.siteId === 'danmakus_live');
assert.equal(liveResult.status, 'data');
assert.ok(liveResult.sourceUrls[0].includes('pageSize=50'));
assert.ok(liveResult.sourceUrls[0].includes('hideOnlyEnter=true'));
assert.ok(federated.report.extra.federated.evidence.length > 0);
// v1.3.0：清洗报告与完整 /analyze 画像必须贯穿后台编排
assert.equal(federated.federated.dataBasis, 'cleaned');
assert.equal(federated.report.extra.cleaning.stages.length, 4);
assert.equal(federated.federated.cleaning.chartDataBasis, 'cleaned');
assert.ok(federated.federated.cleaning.totals.inputRows > 0);
assert.equal(federated.federated.livePortrait.dataBasis, 'cleaned');
for (const key of ['summary', 'leaveTrace', 'rhythmMatrix', 'activityDays', 'channelAffinities',
  'insights', 'support', 'personalityProfile', 'dimensions', 'classNotes', 'samples'])
  assert.ok(federated.federated.livePortrait[key] !== undefined, 'portrait missing ' + key);
assert.equal(federated.federated.livePortrait.rhythmMatrix.length, 7);
assert.equal(federated.federated.livePortrait.rhythmMatrix[0].length, 24);
assert.equal(federated.federated.livePortrait.dimensions.length, 5);
assert.equal(federated.federated.channelRawRowCount, 2);
assert.equal(federated.federated.channelDuplicateRowsDropped, 0);
assert.equal(federated.report.profiles[0].federated.livePortrait.dataBasis, 'cleaned');
assert.equal(federated.report.profiles[0].federated.cleaning.stages.length, 4);
assert.ok(federated.report.limitations.some((x) => x.includes('清洗')));
console.log('OK  ANALYZE_FEDERATED (official profile + 7 entries -> clean -> full portrait -> merge)');

// 修改弹幕设置后强制刷新该站：验证设置经后台传到端点，且日期筛选在本机生效
await call({ type: 'SET_SETTINGS', patch: {
  federatedLiveMaxPages: 1,
  federatedLivePageSize: 10,
  federatedLiveHideOnlyEnter: false,
  federatedLiveStart: '2024-03-05',
  federatedLiveEnd: '2024-03-05'
} });
const liveRefresh = await call({ type: 'FEDERATED_REFRESH_SITE', siteId: 'danmakus_live' });
assert.equal(liveRefresh.ok, true, liveRefresh.error);
assert.equal(liveRefresh.federated.sitesCached, 0);
assert.equal(liveRefresh.federated.liveRecordCount, 1, 'local date filter keeps only 2024-03-05 records');
assert.equal(liveRefresh.federated.liveActiveDays, 1);
assert.equal(liveRefresh.federated.liveDistinctChannels, 1, 'filtered-out sessions must not count channel metadata');
assert.equal(liveRefresh.federated.liveScale.sessions, 1);
assert.equal(liveRefresh.federated.liveTimeRange.filtered, true);
assert.equal(liveRefresh.federated.liveHideOnlyEnter, false);
const refreshedLive = liveRefresh.report.extra.federated.rawResults.find((r) => r.siteId === 'danmakus_live');
assert.ok(refreshedLive.sourceUrls[0].includes('pageSize=10'), 'pageSize setting reached the endpoint');
assert.ok(refreshedLive.sourceUrls[0].includes('hideOnlyEnter=false'), 'hideOnlyEnter setting reached the endpoint');
assert.equal(refreshedLive.facts.timeRange.start, '2024-03-05');
assert.equal(liveRefresh.report.extra.cleaning.stages.length, 4, 'refresh keeps cleaning report');
assert.equal(liveRefresh.federated.livePortrait.dataBasis, 'cleaned');
console.log('OK  FEDERATED_REFRESH_SITE propagates live settings + applies local date filter');

await call({ type: 'RESET_SETTINGS' });
await call({ type: 'SET_SETTINGS', patch: { minGapMs: 1 } });

const fedCached = await call({ type: 'ANALYZE_FEDERATED', input: '123', siteIds: ['aicu'] });
assert.equal(fedCached.ok, true, fedCached.error);
assert.ok(fedCached.federated.sitesCached >= 1, 'second run hits the local cache');
console.log('OK  federated cache hit');

const refreshed = await call({ type: 'FEDERATED_REFRESH_SITE', siteId: 'aicu' });
assert.equal(refreshed.ok, true, refreshed.error);
assert.equal(refreshed.report.extra.federated.rawResults.length, 1);
assert.equal(refreshed.federated.sitesCached, 0, 'force refresh bypasses cache');
console.log('OK  FEDERATED_REFRESH_SITE (force, no cache)');

const fedClear = await call({ type: 'FEDERATED_CLEAR_CACHE' });
assert.equal(fedClear.ok, true);
assert.ok(fedClear.removed >= 2);
const afterFedClear = await call({ type: 'GET_STATE' });
assert.ok(afterFedClear.hasReport, 'clearing federated cache keeps settings + report');
console.log('OK  FEDERATED_CLEAR_CACHE (keeps settings + report)');

await call({ type: 'SET_SETTINGS', patch: { federatedSiteIds: [] } });
const noSites = await call({ type: 'ANALYZE_FEDERATED', input: '123' });
assert.equal(noSites.ok, false, 'no selected sites must not silently fall back to all sites');
console.log('OK  empty site selection is rejected (no silent full-site query)');

const reset = await call({ type: 'RESET_SETTINGS' });
assert.equal(reset.ok, true);
assert.equal(reset.settings.minGapMs, 900);
const cleared = await call({ type: 'CLEAR_DATA' });
assert.equal(cleared.ok, true);
const after = await call({ type: 'GET_STATE' });
assert.equal(after.hasReport, false);
console.log('OK  RESET_SETTINGS + CLEAR_DATA');

// 回归：B 站页面通道永久挂起时，官方请求必须在页面通道超时后回退后台直连，
// 而不是让整轮聚合卡在「聚合中…」（v1.5.4 的故障现场）。
const { getCard } = await import(pathToFileURL(resolve('src/lib/bili-api.js')).href);
globalThis.chrome.tabs = {
  query: async () => [{ id: 901 }],
  sendMessage: () => new Promise(() => {})
};
const hangStarted = Date.now();
const hangCard = await getCard('123');
const hangElapsed = Date.now() - hangStarted;
assert.equal(hangCard.ok, true, 'page channel hang must fall back to worker fetch');
assert.ok(hangElapsed < 8_000, `page channel timeout should be about 4s, got ${hangElapsed}ms`);
console.log(`OK  page channel hang -> worker fallback (${hangElapsed} ms)`);

console.log('SMOKE CHECKS PASSED');
