/* 核心逻辑离线校验：node verify.mjs
 * 不依赖浏览器环境，覆盖 MD5 / WBI 签名 / 输入解析 / 画像评分 / 群体线索 /
 * 多源解析、Danmakus 弹幕行为聚合、F 规则开关与 CSV 导出，
 * v1.3.0 新增：统一数据清洗层、完整 /analyze 聚合画像与清洗报告断言。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { md5 } from './src/lib/md5.js';
import { extractWbiKeys, mixinKey, signQuery, plainQuery } from './src/lib/wbi.js';
import { buildProfile, scoreProfiles, analyzeCohort, toCsv, mergeFederated } from './src/lib/profiler.js';
import {
  publicSites, fill, DM_TYPES, parseNuxtPayload, parseEndpoint,
  parseDanmakusHistory, summarizeFederated, queryAll
} from './src/lib/federated.js';
import {
  CLEAN_STAGES, DM_TYPES as CLEAN_DM_TYPES, cleanChannels, cleanTrend,
  cleanReplies, cleanGuards, cleanSessions, mergeCleanReports,
  asTimestamp, asMetric, normalizePhrase, dateParts
} from './src/lib/clean.js';
import { DIMENSIONS, CLASS_NOTES, CLASS_LABELS, tokenize, buildLivePortrait } from './src/lib/analyze.js';
import { parseUserInput, parseVideoInput } from './src/lib/bili-api.js';
import { parseMedalWall, fetchAnnotations } from './src/lib/annotation.js';
import { analyzeSpamBursts, similarity, normalizeForCompare, SPAM_RULES } from './src/lib/spam.js';

// 1. MD5 对照 Node crypto（含 UTF-8 / 长文本 / 特殊字符）
for (const s of ['', 'abc', '中文测试🙂', 'a'.repeat(1000), "!'()* abc", '碧诗']) {
  assert.equal(md5(s), crypto.createHash('md5').update(s, 'utf8').digest('hex'), 'md5: ' + s.slice(0, 8));
}
console.log('OK  md5 (6 vectors incl. UTF-8)');

// 2. WBI 密钥与签名
const nav = { wbi_img: {
  img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
} };
const keys = extractWbiKeys(nav);
assert.equal(keys.imgKey, '7cd084941338484aae1ad9425b84077c');
assert.equal(keys.subKey, '4932caff0ff746eab6f01bf08b70ac45');
const mixin = mixinKey(keys.imgKey, keys.subKey);
assert.equal(mixin, 'ea1db124af3c7062474693fa704f4ff8');
const enc = (v) => encodeURIComponent(String(v).replace(/[!'()*]/g, ''));
const q = signQuery({ mid: 2 }, mixin, 1700000000);
const expected = crypto.createHash('md5').update('mid=2&wts=1700000000' + mixin).digest('hex');
assert.ok(q.includes('w_rid=' + expected), 'wbi simple signature');
const q2 = signQuery({ keyword: '碧诗 测试!' }, mixin, 1700000000);
const expected2 = crypto.createHash('md5')
  .update('keyword=' + enc('碧诗 测试') + '&wts=1700000000' + mixin).digest('hex');
assert.ok(q2.includes('w_rid=' + expected2), 'wbi unicode/special-char signature');
assert.ok(plainQuery({ keyword: '碧诗' }).includes('%E7%A2%A7'));
console.log('OK  WBI keys, mixin key, signed query (ASCII + CJK)');

// 3. 输入解析
assert.equal(parseUserInput('https://space.bilibili.com/12345/dynamic').value, '12345');
assert.equal(parseUserInput('碧诗').kind, 'keyword');
// B 站 mid 是 int64：16 位以上的合法 UID 不能被当成昵称（否则会去 search 然后「查不到」）
assert.deepEqual(parseUserInput('3494373062871721'), { kind: 'uid', value: '3494373062871721' });
assert.equal(parseUserInput(' 3494373062871721 ').kind, 'uid', '前后空格要 trim');
assert.equal(parseUserInput('https://space.bilibili.com/3494373062871721').kind, 'uid');
assert.equal(parseUserInput('https://api.bilibili.com/x?mid=3494373062871721').value, '3494373062871721');
assert.equal(parseUserInput('12345678901234567890').kind, 'keyword', '超出 int64 位数按昵称处理');
assert.equal(parseVideoInput('BV1xx411c7mD').kind, 'bvid');
assert.equal(parseVideoInput('https://www.bilibili.com/video/av170001').value, '170001');
console.log('OK  target parsers');

// 4. 画像 / 规则 / 群体线索 / CSV
const source = { path: '/x/web-interface/card', url: '', via: 'page', fetchedAt: new Date().toISOString() };
const ok = (data) => ({ ok: true, code: 0, data, source });
const vlist = Array.from({ length: 5 }, (_, i) => ({
  aid: 100 + i, bvid: 'BVTEST0000' + i, title: '同一标题 第' + (i + 1) + '期',
  description: '', created: 1700000000 + i * 60, play: 3, comment: 0, typeid: 1, length: '00:30'
}));
const comments = [
  { mid: '123', uname: '甲', message: '这是一段完全相同的组织化话术模板内容', ctime: 1700000100, rpid: 1 },
  { mid: '456', uname: '乙', message: '这是一段完全相同的组织化话术模板内容', ctime: 1700000120, rpid: 2 }
];
const rawFor = (mid, name) => ({
  mid, collectedAt: new Date().toISOString(),
  card: ok({ card: { name, sex: '保密', level_info: { current_level: 1 }, fans: 2, attention: 300,
    sign: '', face: 'https://i0.hdslb.com/bfs/face/a.jpg', Official: {}, official_verify: {}, vip: {},
    regtime: 0, article: 0, rank: '10000' } }),
  relation: ok({ follower: 2, following: 300 }),
  videos: ok({ page: { count: 5 }, list: { vlist } }),
  comments: comments.filter((c) => c.mid === mid),
  commentsAvailable: true, commentsCode: 0, commentsSource: source
});
const p = buildProfile(rawFor('123', '甲'));
const p2 = buildProfile(rawFor('456', '乙'));
assert.equal(p.facts.level, 1);
assert.equal(p.facts.follower, 2);
assert.equal(p.facts.regtimeAvailable, false, 'regtime=0 must be treated as unavailable');
assert.equal(p.coverage, 1);
assert.equal(p.derived.titleTemplateRate, 1);
assert.equal(p.derived.burstCount, 4);
const cohort = analyzeCohort([p, p2], comments);
assert.ok(cohort.clusters.some((c) => c.type === 'shared_wording'), 'shared wording cluster');
scoreProfiles([p, p2], { enableKeywordScoring: true, attackKeywords: ['话术'], cohortReady: true });
assert.ok(p.inference.hits.some((h) => h.id === 'R10'), 'R10 cohort rule');
assert.ok(p.inference.hits.some((h) => h.id === 'R09'), 'R09 keyword rule');
assert.ok(p.inference.score > 0 && p.inference.score <= 100);
assert.ok(toCsv([p, p2]).includes('线索分'));
const missing = buildProfile({ mid: '789', card: { ok: false, code: -352, source },
  relation: { ok: false, code: -352, source }, videos: null, comments: [],
  commentsAvailable: false, collectedAt: new Date().toISOString() });
scoreProfiles([missing], { enableKeywordScoring: false, attackKeywords: [] });
assert.equal(missing.inference.score, 0, 'unavailable data must not be scored as risk');
assert.equal(missing.inference.sufficient, false);
assert.ok(missing.inference.skipped.length >= 8);
console.log('OK  profiler + cohort + rules + CSV + no-data guard');

// 5. 多源聚合：站点清单、模板与各站解析
const fedSites = publicSites();
assert.equal(fedSites.length, 8, 'eight federated query entries');
assert.ok(fedSites.every((s) => s.id && s.label && s.pageUrl));
assert.ok(fedSites.some((s) => s.id === 'danmakus_live'), 'danmakus_live must be registered');
assert.equal(fill('https://danmakus.com/user/{uid}', '123'), 'https://danmakus.com/user/123');
assert.equal(
  fill('https://x/api/users/{uid}/history?page={page}&pageSize={pageSize}&hideOnlyEnter={hideOnlyEnter}',
    '12 3', { page: 2, pageSize: 50, hideOnlyEnter: 'true' }),
  'https://x/api/users/12%203/history?page=2&pageSize=50&hideOnlyEnter=true',
  'fill must replace non-uid placeholders and URL-encode values'
);
assert.equal(fill('https://x/{uid}/{missing}', '7'), 'https://x/7/{missing}');

const danText = JSON.stringify({ code: 200, data: [
  { name: '主播A', tags: ['歌势', '游戏'], totalDanmakuCount: 120, totalLiveCount: 30 },
  { name: '主播B', tags: ['歌势'], totalDanmakuCount: 80, totalLiveCount: 10 }
] });
const dan = parseEndpoint('danmakus', 'channel', danText);
assert.equal(dan.status, 'data');
assert.equal(dan.facts.channelCount, 2);
assert.equal(dan.facts.totalDanmaku, 200);
assert.equal(dan.facts.tagCounts[0].tag, '歌势');
assert.equal(dan.facts.tagCounts[0].count, 2);

assert.equal(parseEndpoint('aicu', 'replies', JSON.stringify({ code: -429 })).status, 'cooldown');
const replies = Array.from({ length: 12 }, (_, i) => ({
  rpid: 1000 + i, time: 1700000000 + i * 3600, dyn: { oid: 500 + i }, message: '样本' + i
}));
const aicuText = JSON.stringify({ code: 0, data: { cursor: { all_count: 137 }, replies } });
const aicu = parseEndpoint('aicu', 'replies', aicuText);
assert.equal(aicu.facts.replyTotal, 137);
assert.equal(aicu.facts.sampleCount, 12);
assert.equal(aicu.facts.hourBuckets.length, 24);
assert.equal(aicu.facts.distinctOids, 12);
const redacted = parseEndpoint('aicu', 'replies', aicuText, '123', { redact: true });
assert.equal(redacted.facts.samples[0].message, '');
assert.equal(redacted.facts.redacted, true);

const nuxtArray = [
  '2020-01-01T00:00:00.000Z', 1000, '123', 0,
  { fans: 1, createdAt: 0, mid: 2, rate1: 3, rate7: 3 },
  '2021-01-01T00:00:00.000Z', 5000,
  { fans: 6, createdAt: 5, mid: 2, rate1: 3, rate7: 3 },
  12.5, '2024-01-01T00:00:00', '某用户',
  { amount: 8, sponsoredAt: 9, name: 10 }
];
const nuxtHtml = `<title>粉丝趋势</title><script id="__NUXT_DATA__" type="application/json">${JSON.stringify(nuxtArray)}</script>`;
const nuxt = parseNuxtPayload(nuxtHtml, '123');
assert.equal(nuxt.payloadFound, true);
assert.equal(nuxt.trend.length, 2);
assert.equal(nuxt.trend[1].fans, 5000);
assert.equal(nuxt.sponsors.length, 1);
assert.equal(nuxt.sponsors[0].amount, 12.5);
const zero = parseEndpoint('zeroroku', 'page', nuxtHtml, '123');
assert.equal(zero.status, 'data');
assert.equal(zero.facts.fansLatest, 5000);
assert.equal(zero.facts.fansStart, 1000);
assert.equal(zero.facts.trendPoints, 2);
assert.equal(zero.facts.sponsorCount, 1);
assert.equal(parseEndpoint('icu', 'page', '<html><div id="app"></div></html>').status, 'page_only');
assert.equal(parseEndpoint('vtbs', 'guard', '[{"mid":1,"uname":"x","level":3}]').facts.guardCount, 1);
assert.equal(parseEndpoint('mystery', 'x', '{}').status, 'error');
assert.equal(parseNuxtPayload('<html></html>', '123').payloadFound, false);

// 6. Danmakus 弹幕行为聚合（扩展本地计算，不调用服务端 POST 分析任务）
const T = (iso) => Date.parse(iso);
const rec = (iso, text, type = 0) => ({
  ts: T(iso), type, actorId: 'u1', payloadKind: 'text', payload: { rawText: text }
});
const session = (uId, uName, area, records, liveId) => ({
  channel: { uId, uName },
  live: { liveId, title: '测试直播', parentArea: area, area },
  danmakus: { actors: [], roomEmojis: [], records }
});
const livePages = [
  { total: 4, page: 1, pageSize: 50, hasMore: true, items: [
    session('101', '直播间甲', '虚拟主播', [
      rec('2024-03-03T19:00:00Z', '来了来了'),
      rec('2024-03-03T19:10:00Z', '来了来了'),
      rec('2024-03-03T19:20:00Z', '666', 1)
    ], 1),
    session('102', '直播间乙', '网游', [rec('2024-03-05T02:00:00Z', '前排')], 2)
  ] },
  { total: 4, page: 2, pageSize: 50, hasMore: false, items: [
    session('101', '直播间甲', '虚拟主播', [
      rec('2024-03-10T19:00:00Z', '来了来了'),
      rec('2025-01-02T00:00:00Z', '范围外')
    ], 3)
  ] }
];
const liveOptions = { total: 4, hasMore: false, hideOnlyEnter: true, start: '', end: '' };
const live = parseDanmakusHistory(livePages, liveOptions);
assert.equal(live.status, 'data');
assert.equal(live.facts.sessionTotal, 4);
assert.equal(live.facts.sessionFetched, 3);
assert.equal(live.facts.pagesFetched, 2);
assert.equal(live.facts.recordCount, 6);
assert.equal(live.facts.textCount, 6);
assert.equal(live.facts.hourBuckets.length, 24);
assert.equal(live.facts.hourBuckets[3].count, 4, 'UTC+8 03:00 bucket');
assert.equal(live.facts.hourBuckets[10].count, 1, 'UTC+8 10:00 bucket');
assert.equal(live.facts.weekdayBuckets[0].count, 4, 'Monday bucket in UTC+8');
assert.equal(live.facts.activeDays, 4);
assert.equal(live.facts.longestStreak, 2);
assert.equal(live.facts.eventTypes[0].label, DM_TYPES[0]);
assert.equal(live.facts.eventTypes[0].count, 5);
assert.equal(live.facts.topChannels[0].uid, '101');
assert.equal(live.facts.topChannels[0].records, 5);
assert.equal(live.facts.repeatedPhrases[0].key, '来了来了');
assert.equal(live.facts.repeatedPhrases[0].count, 3);
assert.equal(live.facts.samples.length, 6);
assert.equal(live.facts.timeRange.filtered, false);
assert.equal(live.facts.hideOnlyEnter, true);
assert.ok(live.facts.scopeNote.includes('start/end'));
// 场次附带的 channel / live 维度（v3 与 v2 共有）
assert.equal(live.facts.distinctChannels, 2);
assert.equal(live.facts.liveScale.sessions, 3);
assert.deepEqual(live.facts.fansScaleBuckets, [{ key: '未公开', count: 2 }]);
assert.equal(live.facts.agencyCounts[0].key, '未标注');
assert.equal(live.facts.channelTagCounts.length, 0);
assert.ok(live.facts.channelMetaNote.includes('不是该用户自身的属性'));

const liveFiltered = parseDanmakusHistory(livePages, { ...liveOptions, start: '2024-03-01', end: '2024-03-31' });
assert.equal(liveFiltered.facts.recordCount, 5, 'local date filter excludes out-of-range records');
assert.equal(liveFiltered.facts.timeRange.filtered, true);
assert.equal(liveFiltered.facts.activeDays, 3);
const liveRedacted = parseDanmakusHistory(livePages, { ...liveOptions, redact: true });
assert.equal(liveRedacted.facts.redacted, true);
assert.equal(liveRedacted.facts.samples[0].message, '');
assert.equal(liveRedacted.facts.repeatedPhrases[0].example, '');
const liveEmpty = parseDanmakusHistory([], {});
assert.equal(liveEmpty.status, 'page_only');
assert.equal(liveEmpty.facts.recordCount, 0);
assert.equal(DM_TYPES[3], '醒目留言');

// 官方组件 danmaku-history.js 使用的 v2 端点结构：
// data.data.records[] 为场次，每场 danmakus 是扁平数组 {sendDate,type,message}
const v2Pages = [{
  total: 2, pageNum: 0, pageSize: 50, hasMore: false,
  data: { records: [
    {
      channel: { uId: 101, uName: '主播甲', fansCount: 250000, tags: ['Vtuber', '虚拟主播'], agencyUuid: 'independent' },
      live: { liveId: 'L1', parentArea: '虚拟主播', area: '虚拟日常', watchCount: 50000,
        maxOnlineCount: 7000, payCount: 100, interactionCount: 3000, totalIncome: 8000 },
      danmakus: [
        { uId: 123, uName: '目标用户', type: 0, sendDate: T('2024-03-03T19:00:00Z'), message: '来了来了' },
        { uId: 123, uName: '目标用户', type: 4, sendDate: T('2024-03-03T19:10:00Z') }
      ]
    },
    {
      channel: { uId: 102, uName: '主播乙', fansCount: 5000, tags: ['游戏'], agencyUuid: 'agency-x' },
      live: { liveId: 'L2', parentArea: '网游', watchCount: 1000, maxOnlineCount: 200, payCount: 0 },
      danmakus: [{ uId: 123, type: 0, sendDate: T('2024-03-05T02:00:00Z'), message: '前排' }]
    }
  ] }
}];
const v2Options = { total: 2, hasMore: false, hideOnlyEnter: false };
const v2 = parseDanmakusHistory(v2Pages, v2Options);
assert.equal(v2.status, 'data');
assert.equal(v2.facts.sessionFetched, 2);
assert.equal(v2.facts.recordCount, 3);
assert.equal(v2.facts.textCount, 2, 'v2 扁平结构里无 message 的入场记录不计入文本');
assert.equal(v2.facts.hourBuckets[3].count, 2);
assert.equal(v2.facts.distinctChannels, 2);
assert.equal(v2.facts.topChannels[0].fans, 250000);
assert.deepEqual(v2.facts.topChannels[0].tags, ['Vtuber', '虚拟主播']);
assert.ok(v2.facts.channelTagCounts.some((t) => t.key === 'Vtuber' && t.count === 1));
assert.equal(v2.facts.agencyCounts.find((a) => a.key === '个人势').count, 1, 'independent 已归一化为「个人势」');
assert.deepEqual(v2.facts.fansScaleBuckets.map((b) => b.key), ['1 万以下', '10–100 万']);
assert.equal(v2.facts.liveScale.watchCount, 51000);
assert.equal(v2.facts.liveScale.avgWatchCount, 25500);
assert.equal(v2.facts.liveScale.maxOnlineMax, 7000);
assert.equal(v2.facts.liveScale.payCount, 100);
const v2Filtered = parseDanmakusHistory(v2Pages, { ...v2Options, start: '2024-03-05', end: '2024-03-05' });
assert.equal(v2Filtered.facts.recordCount, 1);
assert.equal(v2Filtered.facts.distinctChannels, 1);
assert.equal(v2Filtered.facts.liveScale.sessions, 1);
console.log('OK  Danmakus aggregation (UTC+8 / streak / types / repeats / filter / redact / v2+v3 / channel meta)');

// 7. 汇总、画像融合与 F 规则开关
const mk = (siteId, status, facts = {}, extra = {}) => ({
  uid: '123', siteId, siteName: siteId, label: siteId, status, cached: false,
  message: '', facts, evidence: [{ label: '证据', value: '值' }],
  pageUrl: 'https://example.com/' + siteId, sourceUrls: [], httpStatus: 200,
  elapsedMs: 12, fetchedAt: new Date().toISOString(), ...extra
});
const fedResults = [
  mk('bilibili', 'official'), mk('danmakus', 'data', dan.facts),
  mk('danmakus_live', 'data', live.facts),
  mk('aicu', 'data', aicu.facts), mk('icu', 'page_only', { pageReachable: true }),
  mk('zeroroku', 'data', zero.facts, { cached: true }),
  mk('vtbs', 'not_listed', { vtbsListed: false })
];
const summary = summarizeFederated(fedResults);
assert.equal(summary.sitesTotal, 7);
assert.equal(summary.sitesWithData, 4);
assert.equal(summary.sitesCached, 1);
assert.equal(summary.replyTotal, 137);
assert.equal(summary.channelCount, 2);
assert.equal(summary.fansLatest, 5000);
assert.equal(summary.vtbsListed, false);
assert.equal(summary.statuses.length, 7);
assert.equal(summary.trend.length, 2);
assert.ok(summary.evidence.length > 0);
assert.equal(summary.liveRecordCount, 6);
assert.equal(summary.liveActiveDays, 4);
assert.equal(summary.liveSessionFetched, 3);
assert.equal(summary.liveHasMore, false);
assert.equal(summary.liveHourBuckets.length, 24);
assert.equal(summary.liveTopChannels[0].uid, '101');
assert.equal(summary.liveRepeatedPhrases[0].count, 3);
assert.equal(summary.liveHideOnlyEnter, true);
assert.equal(summary.liveRedacted, false);
assert.equal(summary.liveDistinctChannels, 2);
assert.equal(summary.liveScale.sessions, 3);
assert.deepEqual(summary.liveFansScale, [{ key: '未公开', count: 2 }]);
assert.ok(summary.liveChannelMetaNote.includes('不是该用户自身的属性'));

const fedProfile = buildProfile(rawFor('999', '丙'));
mergeFederated(fedProfile, summary);
assert.equal(fedProfile.federated.sitesWithData, 4);
assert.equal(fedProfile.federated.hourBuckets.length, 24);
assert.equal(fedProfile.federated.liveRecordCount, 6);
assert.equal(fedProfile.federated.liveActiveDays, 4);
assert.equal(fedProfile.federated.liveHourBuckets.length, 24);
assert.equal(fedProfile.federated.liveRedacted, false);
assert.equal(fedProfile.federated.liveDistinctChannels, 2);
assert.equal(fedProfile.federated.liveScale.sessions, 3);
const peakSummary = {
  ...summary,
  hourBuckets: Array.from({ length: 24 }, (_, h) => ({ key: String(h).padStart(2, '0'), count: h === 3 ? 12 : 0 })),
  replySampleCount: 12
};
mergeFederated(fedProfile, peakSummary);
assert.equal(fedProfile.federated.hourPeakShare, 1);
assert.equal(fedProfile.federated.hourPeak, '03');
scoreProfiles([fedProfile], { federatedReady: true, federatedScoring: false, enableKeywordScoring: false, attackKeywords: [] });
assert.ok(fedProfile.inference.skipped.some((s) => s.id === 'F01'), 'F01 disabled by default');
assert.ok(!fedProfile.inference.hits.some((h) => h.id === 'F01'));
scoreProfiles([fedProfile], { federatedReady: true, federatedScoring: true, enableKeywordScoring: false, attackKeywords: [] });
assert.ok(fedProfile.inference.hits.some((h) => h.id === 'F01'), 'F01 enabled');
const fedCsv = toCsv([fedProfile]);
assert.ok(fedCsv.includes('第三方历史评论'));
assert.ok(fedCsv.includes('弹幕记录数'));
assert.ok(fedCsv.includes('弹幕活跃天数'));
assert.ok(fedCsv.includes('弹幕样本范围'));
assert.ok(fedCsv.includes('涉及主播数'));
assert.ok(fedCsv.includes('所涉场次观看人次'));
assert.ok(fedCsv.includes('已取回可及场次'));
const noSiteQuery = await queryAll('123', { siteIds: [] });
assert.equal(noSiteQuery.length, 0, 'explicit empty siteIds must not fall back to all sites');
console.log('OK  federated parsers + live aggregation + summary + F rules gate + CSV columns');

// 8. 统一数据清洗层：四道工序、去重、缺失、异常、字段规范化
assert.equal(CLEAN_STAGES.length, 4, 'four fixed cleaning stages');
assert.deepEqual(CLEAN_STAGES.map((s) => s.id), ['normalize', 'missing', 'anomaly', 'dedupe']);
assert.equal(CLEAN_DM_TYPES[3], DM_TYPES[3], 'event enum shared by clean and federated layers');
assert.equal(normalizePhrase('晚安，兄弟们[dog]666'), '晚安,兄弟们#', 'phrase normalization');
assert.equal(asTimestamp(1700000000).value, 1700000000000, 'seconds -> milliseconds');
assert.equal(asTimestamp('not-a-number').value, null, 'invalid timestamp -> null');
assert.deepEqual(asMetric(-5), { value: 0, clamped: true, missing: false }, 'negative metric clamped');
assert.deepEqual(asMetric(undefined), { value: null, clamped: false, missing: true }, 'missing metric stays null, not 0');

// 关注主播：实测同一主播快照按场次重复出现，必须按 uId 去重
const dupChannelRows = Array.from({ length: 5 }, () => ({
  uId: 2094031249, name: '示例主播', tags: ['Vtuber'],
  totalDanmakuCount: 4323081, totalLiveCount: 1100,
  totalIncome: 3470980.3, totalLiveSecond: 12580257,
  lastLiveDate: 1794070986001
})).concat([{ uId: 407106379, name: '另一主播', tags: ['游戏'], totalDanmakuCount: 100 }]);
const cleanedChannels = cleanChannels(dupChannelRows);
assert.equal(cleanedChannels.rows.length, 2, 'five duplicate rows collapse into one channel');
assert.equal(cleanedChannels.rows[0].duplicateCount, 5, 'duplicateCount keeps provenance');
assert.equal(cleanedChannels.report.counts.duplicatesRemoved, 4);
assert.equal(cleanedChannels.report.inputRows, 6);
const dupDan = parseEndpoint('danmakus', 'channel', JSON.stringify({ code: 200, data: dupChannelRows }));
assert.equal(dupDan.facts.channelCount, 2, 'parser consumes deduplicated channels only');
assert.equal(dupDan.facts.duplicateRowsDropped, 4);
assert.equal(dupDan.facts.totalDanmaku, 4323181, 'sum excludes duplicated rows');
assert.equal(dupDan.facts.cleaning.sourceId, 'danmakus:channel');

// 通用序列清洗
const cleanedTrend = cleanTrend([
  { date: '2024-01-01', fans: 100 }, { date: '2024-01-01', fans: 100 },
  { date: '2024-01-02', fans: -3 }, { date: 'bad', fans: 5 }, { date: '2024-01-03', fans: null }
]);
assert.equal(cleanedTrend.rows.length, 2, 'duplicate + invalid trend points removed');
assert.equal(cleanedTrend.rows[1].fans, 0, 'negative fans clamped');
assert.equal(cleanedTrend.report.counts.duplicatesRemoved, 1);
const cleanedReplies = cleanReplies([
  { rpid: 1, time: 1700000000, dyn: { oid: 10 }, message: '甲' },
  { rpid: 1, time: 1700000000, dyn: { oid: 10 }, message: '甲' },
  { rpid: 2, time: -1, message: '越界' },
  { rpid: 3, time: 1700003600000, dyn: {}, message: '' }
]);
assert.equal(cleanedReplies.rows.length, 2, 'duplicate + invalid replies removed');
assert.equal(cleanedReplies.rows[1].time, 1700003600, 'millisecond reply time normalized to seconds');
assert.equal(cleanGuards([{ mid: 1, uname: 'a', level: 3 }, { mid: 1, uname: 'a', level: 3 }]).rows.length, 1);

// 弹幕历史：重复记录 / 缺失 payload / 异常时间戳 / 负数 / 秒级时间 / v2 扁平字段
const CLEAN_PAGES = [{ total: 2, hasMore: false, items: [
  { channel: { uId: 101, uName: '甲', tags: ['Vtuber'] },
    live: { liveId: 'L1', parentArea: '虚拟主播', watchCount: 100 },
    danmakus: { records: [
      { ts: 1709506800000, type: 4, payloadKind: 0 },                                    // 无 payload（入场）
      { ts: 1709506800000, type: 4, payloadKind: 0 },                                    // 完全重复
      { ts: 1709506801000, type: 0, payloadKind: 1, payload: { rawText: '来了' } },
      { ts: 1709506802000, type: 1, payloadKind: 3, payload: { name: '小花', count: -2, price: -1 } },
      { ts: 1, type: 0, payloadKind: 1, payload: { rawText: '越界' } },                  // 异常时间戳
      { ts: 4102444800000, type: 0, payloadKind: 1, payload: { rawText: '未来' } }         // 异常时间戳
    ] } },
  { channel: { uId: 102, uName: '乙' }, live: { liveId: 'L2', parentArea: '网游' },
    danmakus: [ { type: 0, sendDate: 1709604000, message: '前排' } ] }                     // v2 秒级 + 扁平字段
] }];
const cleanedHistory = cleanSessions(CLEAN_PAGES, {});
assert.equal(cleanedHistory.rawRecordCount, 7);
assert.equal(cleanedHistory.report.counts.duplicatesRemoved, 1, 'exact duplicate record removed');
assert.equal(cleanedHistory.report.counts.anomaliesRemoved, 2, 'out-of-range timestamps dropped');
assert.ok(cleanedHistory.report.details.missing['payload 缺失（入场等事件无内容）'] >= 2, 'missing payload tracked');
assert.ok(cleanedHistory.report.details.normalize['记录时间秒 → 毫秒'] >= 1, 'v2 second timestamp scaled');
assert.equal(cleanedHistory.sessions[1].records[0].ts, 1709604000000, 'v2 second timestamp kept as ms');
assert.equal(cleanedHistory.sessions[1].records[0].text, '前排', 'v2 message normalized');
assert.equal(cleanedHistory.sessions[0].records[0].isText, false, 'enter record has no text');
assert.equal(cleanedHistory.sessions[0].records.find((r) => r.name === '小花').price, 0, 'negative price clamped');
const mergedClean = mergeCleanReports([dupDan.facts.cleaning, cleanedHistory.report]);
assert.equal(mergedClean.sources.length, 2);
assert.equal(mergedClean.totals.duplicatesRemoved, 5);
assert.equal(mergedClean.chartDataBasis, 'cleaned');
console.log('OK  cleaning layer (normalize / missing / anomaly / dedupe / v2+v3 / provenance)');

// 9. 完整 /analyze 聚合画像：所有统计维度、指标与展示结构
assert.equal(DIMENSIONS.length, 5);
assert.ok(CLASS_NOTES.insufficient_sample && CLASS_LABELS.late_night);
assert.ok(tokenize('晚安，兄弟们[dog] 哈哈 666').includes('晚安'));
const portrait = buildLivePortrait(cleanedHistory, { total: 2, hasMore: false, hideOnlyEnter: true });
assert.equal(portrait.dataBasis, 'cleaned', 'portrait only consumes cleaned sessions');
for (const key of [
  'summary', 'leaveTrace', 'eventTypes', 'hourBuckets', 'weekdayBuckets', 'monthBuckets',
  'activityDays', 'rhythmMatrix', 'rhythmPeak', 'periodCounts', 'activeDates', 'longestStreak',
  'areas', 'channelAffinities', 'channelConcentration', 'channelTagCounts', 'agencyCounts',
  'fansScale', 'liveScale', 'insights', 'repeatedPhrases', 'support', 'personalityProfile',
  'dimensions', 'classNotes', 'classLabels', 'samples', 'topChannels', 'coverage', 'legacy'
]) assert.ok(portrait[key] !== undefined, 'portrait missing dimension: ' + key);
assert.equal(portrait.leaveTrace.length, 7, '弹幕/礼物/SC/大航海/入场/禁言/其他');
assert.equal(portrait.hourBuckets.length, 24);
assert.equal(portrait.weekdayBuckets.length, 7);
assert.equal(portrait.rhythmMatrix.length, 7);
assert.equal(portrait.rhythmMatrix[0].length, 24, '7x24 heatmap');
assert.equal(portrait.dimensions.length, 5);
assert.ok(portrait.dimensions.every((d) => d.title && d.note && d.choice && Array.isArray(d.drivers) && Array.isArray(d.probabilities)));
assert.equal(portrait.personalityProfile.activityRhythm.key, 'activityRhythm');
assert.equal(Object.keys(portrait.classNotes).length, Object.keys(CLASS_NOTES).length);
for (const key of ['nightOwlRatio', 'emojiRatio', 'roomEmojiRatio', 'uniqueMessageRatio',
  'repeaterIndex', 'avgMessageLength', 'maxRepeatedText', 'maxRepeatedCount',
  'highFreqWords', 'wordCloud', 'tokenizerNote', 'lexicon'])
  assert.ok(portrait.insights[key] !== undefined, 'insights missing: ' + key);
for (const key of ['totalPayment', 'paidLives', 'paidChannels', 'maxSinglePayment',
  'topPaidChannel', 'breakdown', 'otherInteractions'])
  assert.ok(portrait.support[key] !== undefined, 'support missing: ' + key);
assert.equal(portrait.summary.totalTraces, cleanedHistory.report.outputRows, 'summary counts cleaned rows only');
assert.equal(portrait.legacy.recordCount, portrait.summary.totalTraces, 'legacy fields also cleaned');
const redactedPortrait = buildLivePortrait(cleanedHistory, { redact: true });
assert.equal(redactedPortrait.samples[0].message, '', 'redaction hides sample text');
assert.equal(redactedPortrait.insights.maxRepeatedText, '', 'redaction hides repeated phrase text');
assert.equal(redactedPortrait.insights.wordCloud[0].name, '（已隐藏）', 'redaction hides word cloud');
// v1.4.0 画像总结卡：弹窗首卡与静态报告首卡共用
const sc = portrait.summaryCard;
assert.ok(sc && sc.headline && sc.headline.includes('清洗后样本'), 'summaryCard headline built from cleaned sample');
for (const key of ['favorite', 'interests', 'commentStyle', 'rhythm', 'support', 'crossRoom', 'coverageLine', 'caveat'])
  assert.ok(sc[key] !== undefined && (typeof sc[key] !== 'object' || sc[key].text), 'summaryCard field: ' + key);
assert.ok(!/undefined/.test(JSON.stringify(sc)), 'summaryCard has no undefined leaks');
assert.equal(redactedPortrait.summaryCard.interests.text.includes('常提词汇'), false, 'redaction hides hot words in summary');
console.log('OK  summary card (multi-dimension digest on cleaned portrait)');
console.log('OK  full /analyze portrait (all dimensions + 7x24 + word cloud + 5 classifications + redaction)');

// 10. 汇总 / 画像融合 / CSV 必须携带清洗报告与完整画像
const fullSummary = summarizeFederated([
  mk('danmakus', 'data', dupDan.facts),
  mk('danmakus_live', 'data', { ...live.facts, portrait, cleaning: cleanedHistory.report }),
  mk('bilibili', 'official', {})
]);
assert.equal(fullSummary.dataBasis, 'cleaned');
assert.equal(fullSummary.cleaning.stages.length, 4);
assert.equal(fullSummary.livePortrait.dataBasis, 'cleaned');
assert.equal(fullSummary.channelRawRowCount, 6);
assert.equal(fullSummary.channelDuplicateRowsDropped, 4);
mergeFederated(fedProfile, fullSummary);
assert.equal(fedProfile.federated.cleaning.stages.length, 4);
assert.equal(fedProfile.federated.livePortrait.dataBasis, 'cleaned');
assert.ok(fedProfile.federated.disclaimer.includes('清洗结果'));
const cleanCsv = toCsv([fedProfile]);
for (const col of ['清洗前记录数', '去重条数', '缺失处理条数', '异常剔除条数', '清洗后记录数',
  '打米总额(元)', '打米场次', '活跃节律分组', '支持方式分组'])
  assert.ok(cleanCsv.includes(col), 'CSV missing cleaning column: ' + col);
console.log('OK  summary + mergeFederated + CSV carry cleaning report and full portrait');

// 11. 机构 UUID → 名称解析（v1.3.1）：标签归一化 + 聚合层解析与失败兜底
import { INDEPENDENT_AGENCY, AGENCY_INDEPENDENT_LABEL, agencyLabel } from './src/lib/clean.js';
import { collectAgencyUuids, resolveAgencyNames } from './src/lib/federated.js';
// resolveAgencyNames 走扩展缓存（chrome.storage.local），离线环境给内存桩
globalThis.chrome = globalThis.chrome || { storage: { local: {
  _m: new Map(),
  async get(keys) {
    const out = {};
    for (const k of [].concat(keys)) if (this._m.has(k)) out[k] = this._m.get(k);
    return out;
  },
  async set(obj) { Object.entries(obj).forEach(([k, v]) => this._m.set(k, v)); },
  async remove(keys) { for (const k of [].concat(keys)) this._m.delete(k); }
} } };
assert.equal(agencyLabel('independent'), '个人势');
assert.equal(agencyLabel(''), '未标注');
assert.equal(agencyLabel(null), '未标注');
assert.equal(agencyLabel('ad652370-a736-537f-aa70-6ee528138364',
  { 'ad652370-a736-537f-aa70-6ee528138364': 'chucolala' }), 'chucolala');
assert.equal(agencyLabel('ad652370-a736-537f-aa70-6ee528138364', {}), 'ad652370-a736-537f-aa70-6ee528138364', '解析失败保留 UUID');
// collectAgencyUuids 兼容 v3 items 与 v2 records，并过滤 independent
const agencyPages = [{ items: [
  { channel: { agencyUuid: 'independent' } },
  { channel: { agencyUuid: 'uuid-a' } },
  { channel: { agencyUuid: 'uuid-a' } },
  { channel: {} }
] }, { data: { records: [{ channel: { agencyUuid: 'uuid-b' } }] } }];
assert.deepEqual(collectAgencyUuids(agencyPages), ['uuid-a', 'uuid-b']);
// resolveAgencyNames：mock 全局 fetch，验证解析成功与失败兜底
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('uuid-a')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { uuid: 'uuid-a', name: 'chucolala' } }) };
  }
  return { ok: true, status: 404, text: async () => JSON.stringify({ code: 404 }) };
};
const resolved = await resolveAgencyNames(['uuid-a', 'uuid-b']);
globalThis.fetch = realFetch;
assert.deepEqual(resolved.names, { 'uuid-a': 'chucolala' });
assert.deepEqual(resolved.failed, ['uuid-b']);
// 清洗层：independent 归一化为「个人势」，UUID 原样保留
const agencySessions = cleanSessions([{ items: [
  { liveId: 'L1', channel: { uId: 1, uName: 'A', agencyUuid: 'independent' }, danmakus: { records: [{ ts: 1794067947000, type: 0, payload: { rawText: 'hi' } }] } },
  { liveId: 'L2', channel: { uId: 2, uName: 'B', agencyUuid: 'uuid-a' }, danmakus: { records: [{ ts: 1794067947001, type: 0, payload: { rawText: 'yo' } }] } },
  { liveId: 'L3', channel: { uId: 3, uName: 'C' }, danmakus: { records: [{ ts: 1794067947002, type: 0, payload: { rawText: 'hey' } }] } }
] }], {});
const agencyOf = (uid) => agencySessions.sessions.find((s) => s.channelUid === String(uid));
assert.equal(agencyOf(1).agency, '个人势');
assert.equal(agencyOf(2).agency, 'uuid-a');
assert.equal(agencyOf(2).agencyUuid, 'uuid-a');
assert.equal(agencyOf(3).agency, '未标注');
// 画像层：agencyNames 命中时机构分布用名称，未命中保留 UUID
const agencyPortrait = buildLivePortrait(agencySessions, { agencyNames: { 'uuid-a': 'chucolala' } });
const agencyKeys = agencyPortrait.agencyCounts.map((x) => x.key).sort();
assert.deepEqual(agencyKeys, ['chucolala', '个人势', '未标注']);
console.log('OK  agency UUID resolution (independent → 个人势 / name lookup / fallback to UUID)');

// 12. AICU 标注：曾用名 / 公会 / 粉丝牌（v1.5.0，2026-11-08 实测样本 uid=2）
// fixture 直接内联，保证仓库不需要任何 .research 样本（那里是真实用户数据，不入库）
const aicuMarkRaw = JSON.stringify({
  code: 0,
  data: { gh: { id: '', name: '' }, gh2: { id: '', name: '' }, device: [], text: '', tag: [], hname: ['碧诗'] },
  message: '', ttl: 1
});
const aicuMedalRaw = JSON.stringify({
  code: 0,
  data: {
    list: [
      { ruid: '867152', level: 29, name: '叛忍' },
      { ruid: '548076', level: 28, name: '樱怪' },
      { ruid: '270317383', level: 27, name: '撸猫猫' },
      { ruid: '1437582453', level: 21, name: '棺人痴' },
      { ruid: '11121031', level: 16, name: '胖次喵' },
      { ruid: '39627524', level: 13, name: '甜甜O' }
    ]
  },
  message: '', ttl: 1
});
const markParsed = parseEndpoint('aicu_mark', 'mark', aicuMarkRaw, '2');
assert.equal(markParsed.status, 'data');
assert.deepEqual(markParsed.facts.formerNames, ['碧诗'], 'former names from hname[]');
const medalParsed = parseEndpoint('aicu_mark', 'medal', aicuMedalRaw, '2');
assert.equal(medalParsed.status, 'data');
assert.equal(medalParsed.facts.medalCount, 6, 'medal count after cleaning');
assert.equal(medalParsed.facts.medals[0].name, '叛忍');
assert.equal(medalParsed.facts.medals[0].level, 29);
assert.equal(medalParsed.facts.medals[0].streamerMid, '867152');
assert.ok(medalParsed.facts.medals[0].level >= medalParsed.facts.medals[1].level, 'medals sorted by level');
const markSummary = summarizeFederated([
  mk('aicu_mark', 'data', { ...markParsed.facts, ...medalParsed.facts, cleaning: medalParsed.cleaning }),
  mk('bilibili', 'official', {})
]);
assert.deepEqual(markSummary.formerNames, ['碧诗'], 'summary carries former names');
assert.equal(markSummary.medalCount, 6, 'summary carries medal count');
console.log('OK  AICU mark (former names / guild / devices / fan medals)');

// 13. 官方勋章墙 + 标注接线（v1.5.2）：官方优先 → AICU 兜底 → 写清「为什么没有」
const wallOk = parseMedalWall({
  code: 0,
  data: {
    count: 9, close_space_medal: 0, only_show_wearing: 0,
    list: [
      { medal_info: { medal_name: '叛忍', level: 29, target_id: 867152, guard_level: 3, wearing_status: 1 }, target_name: '某主播' },
      { medal_info: { medal_name: 'DD', level: 12, target_id: 2 }, target_name: '碧诗' }
    ]
  }
});
assert.equal(wallOk.ok, true);
assert.equal(wallOk.source, 'medalwall');
assert.equal(wallOk.count, 9, 'official count = 站点标注的 9 枚');
assert.equal(wallOk.list[0].name, '叛忍');
assert.equal(wallOk.list[0].streamer, '某主播', 'official carries streamer name');
assert.equal(wallOk.list[0].streamerMid, '867152');
assert.equal(wallOk.list[0].wearing, true, 'wearing_status → wearing');
assert.ok(wallOk.list[0].level >= wallOk.list[1].level, 'medals sorted desc');
assert.equal(parseMedalWall({ code: -101 }).message, '需要登录 B 站才能读取勋章墙');

// AICU 兜底：官方 -101 时用 AICU 的 6 枚（stub 掉 AICU 的 fetch）
const realFetchAnno = globalThis.fetch;
globalThis.fetch = async (url) => ({
  ok: true, status: 200,
  text: async () => (/getmedal/.test(url) ? aicuMedalRaw : (/getusermark/.test(url) ? aicuMarkRaw : '{}'))
});
const viaAicu = await fetchAnnotations('2', { fetchMedalWall: async () => ({ ok: false, json: { code: -101 } }) });
assert.equal(viaAicu.medals.source, 'aicu');
assert.equal(viaAicu.medals.list.length, 6);
assert.deepEqual(viaAicu.mark.formerNames, ['碧诗']);

// 官方可用时优先官方，不再看 AICU
const viaWall = await fetchAnnotations('2', { fetchMedalWall: async () => ({ ok: true, json: wallOkRaw() }) });
function wallOkRaw() { return { code: 0, data: { count: 9, list: [{ medal_info: { medal_name: '叛忍', level: 29, target_id: 867152 }, target_name: '某主播' }] } }; }
assert.equal(viaWall.medals.source, 'medalwall');

// 两路皆空：保留双方原因，界面据此写「未取得的原因」
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{"code":0,"data":{"list":[]}}' });
const viaNone = await fetchAnnotations('2', { fetchMedalWall: async () => ({ ok: false, json: { code: -101 } }) });
assert.equal(viaNone.medals.ok, false);
assert.match(viaNone.medals.fallbackNote, /需要登录/);
globalThis.fetch = realFetchAnno;

// 画像层：annotations → facts（曾用名 / 粉丝牌数量 / 最高牌）+ 明细
const annoProfile = buildProfile({
  mid: '2', collectedAt: new Date().toISOString(),
  card: { ok: true, code: 0, data: { card: { mid: 2, name: '碧诗', level_info: { current_level: 6 }, fans: 100, attention: 3 } } },
  relation: { ok: true, code: 0, data: { follower: 100, following: 3 } },
  annotations: viaAicu
});
assert.deepEqual(annoProfile.facts.formerNames, ['碧诗']);
assert.equal(annoProfile.facts.medalCount, 6);
assert.equal(annoProfile.facts.medalSource, 'aicu');
assert.equal(annoProfile.facts.medalTop, '叛忍 Lv29');
assert.equal(annoProfile.annotations.medal.count, 6);
assert.equal(annoProfile.annotations.medal.list.length, 6);
assert.ok(annoProfile.sources.some((x) => x.field === '粉丝牌 / 曾用名' && x.ok), 'sources records annotation channel');
console.log('OK  annotation (official MedalWall → AICU fallback → profile facts)');

/* ==========================================================================================
 * 14. 独轮车 / 刷屏判定（v1.5.4）
 * 关键要求：同一时间窗口内大量「重复或高度相似」才算刷屏；必须区分单人主导与多人跟风；
 * 正常的高频互动（内容各异 / 情绪弹幕 / 慢速重复）不得被判成攻击。
 * ======================================================================================== */
const SPAM_T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const sg = (uid, text, ts) => ({ ts: SPAM_T0 + ts, text, uid: String(uid), name: 'U' + uid });

// 归一化与相似度：表情/标点/数字不参与区分，「同模板换一个字」不能被判成同一句
assert.equal(normalizeForCompare('主播今天状态真好！'), normalizeForCompare('主播今天状态真好'));
assert.equal(normalizeForCompare('[doge]主播牛'), normalizeForCompare('主播牛[doge]'));
assert.equal(normalizeForCompare('打卡第1234天'), '打卡第#天', '数字归一化，模板刷屏才可比');
assert.equal(similarity('主播今天状态真好', '主播今天状态真好'), 1);
assert.ok(similarity('主播今天状态真好', '主播今天状态真好啊啊') >= SPAM_RULES.similarity, '同一句+尾缀仍属同簇');
assert.equal(similarity('主播今天状态真好', '这把游戏打得不错'), 0, '无关内容必须为 0');
// 关键防误判：结构相同、只换一个词的两条，不得越过 0.82（仅靠 LCS 时会越线）
assert.ok(similarity('这波操作很强', '这波操作很秀') < SPAM_RULES.similarity, '同结构换词不算重复');

// 1) 单人 15 条完全重复 / 8s → 高度疑似独轮车 + 无意义填充
const spamSolo = analyzeSpamBursts(
  Array.from({ length: 15 }, (_, i) => sg(1, '主播今天状态真好', i * 570))
);
assert.equal(spamSolo.ok, true);
assert.equal(spamSolo.level, 'high');
assert.equal(spamSolo.behaviour, 'solo', '单人主导 → 独轮车');
assert.equal(spamSolo.intent, 'spam');
assert.equal(spamSolo.best.messages, 15);
assert.equal(spamSolo.best.repeats, 15);
assert.equal(spamSolo.best.share, 1);
assert.equal(spamSolo.best.users, 1);
assert.equal(spamSolo.best.medianGapMs, 570, '间隔中位数按实际时间算');
assert.ok(spamSolo.rules.some((r) => r.id === 'S4' && r.ok), '机器节奏规则命中');
assert.equal(spamSolo.samples.length, 6, '同簇样本最多 6 条');

// 2) 含辱骂 → 内容定性为攻击
const spamAttack = analyzeSpamBursts(
  Array.from({ length: 16 }, (_, i) => sg(1, '主播就是个垃圾人', i * 500))
);
assert.equal(spamAttack.level, 'high');
assert.equal(spamAttack.intent, 'attack');

// 3) 情绪弹幕连刷「哈哈」/「冲冲冲」→ 只到观察，定性玩梗
const spamMeme = analyzeSpamBursts(Array.from({ length: 12 }, (_, i) => sg(1, '哈哈', i * 1800)));
assert.equal(spamMeme.level, 'watch', '纯情绪弹幕量不大时降级为观察');
assert.equal(spamMeme.intent, 'meme');
assert.ok(spamMeme.best.caps.length > 0, '降级原因要写进边界修正');
const spamChong = analyzeSpamBursts(Array.from({ length: 12 }, (_, i) => sg(1, '冲冲冲', i * 1500)));
assert.equal(spamChong.level, 'watch');
assert.equal(spamChong.intent, 'meme', '单字符重复属情绪表达，不是「无意义填充」');
// 3.5) 齐刷短句祝福（生日快乐）→ 重复成立但按情绪 / 应援定性，不能读成「非喜爱表达」
const spamBday = analyzeSpamBursts([
  ...Array.from({ length: 8 }, (_, i) => sg(1, '生日快乐', i * 900)),
  ...['来了', '晚上好', '好看', '第一次看'].map((t, i) => sg(1, t, 7200 + i * 900))
]);
assert.equal(spamBday.ok, true);
assert.equal(spamBday.level, 'watch', '短句齐刷封顶到观察，不升级成疑似独轮车');
assert.equal(spamBday.intent, 'meme', '短句祝福按情绪 / 应援处理');
assert.ok(spamBday.boundaryNotes.some((n) => /短句/.test(n)), '边界说明要写清短句口径');

// 4) 慢速重复（间隔 12s）在 60s 窗口内根本凑不满 8 条 → 不判定；放宽窗口后由慢速上限压到观察
const slowList = Array.from({ length: 15 }, (_, i) => sg(1, '主播今天状态真好', i * 12000));
assert.equal(analyzeSpamBursts(slowList).level, 'none', '慢速重复不算刷屏');
const slowWide = analyzeSpamBursts(slowList, { config: { windowMs: 300000 } });
assert.equal(slowWide.level, 'watch');
assert.ok(slowWide.best.caps.some((c) => /节奏慢/.test(c)), '慢速降级原因可复核');

// 5) 6 人各 3 条同一句 → 多人复读，绝不判独轮车
const groupList = [];
for (let i = 0; i < 18; i++) groupList.push(sg(10 + (i % 6), '生日快乐生日快乐', i * 1100));
const spamGroup = analyzeSpamBursts(groupList);
assert.equal(spamGroup.behaviour, 'group');
assert.notEqual(spamGroup.level, 'high', '多人跟风不得升到高度疑似');
assert.equal(spamGroup.best, null, '没有单人主导的密集窗口');
assert.equal(spamGroup.group.users, 6);
assert.equal(spamGroup.group.kind, 'group');
assert.equal(spamGroup.intent, 'meme', '多人齐刷同一句无攻击特征 → 玩梗，不是填充');

// 6) 单人主导 + 路人跟风：仍判独轮车（不能因为人多就洗白单人）
const dominateList = Array.from({ length: 15 }, (_, i) => sg(1, '这也太顶了吧', i * 520));
for (let i = 0; i < 5; i++) dominateList.push(sg(30 + i, '这也太顶了吧', 1000 + i * 2100));
const spamDominate = analyzeSpamBursts(dominateList);
assert.equal(spamDominate.behaviour, 'solo', '单人 15 条 vs 路人各 1 条 → 仍是独轮车');
assert.equal(spamDominate.level, 'high');
assert.equal(spamDominate.group.kind, 'group');

// 7) 正常高频互动：10 条内容各异的连发弹幕不得被判刷屏
const normalBurst = ['这波操作真秀', '刚来 发生了什么', '主播唱歌好听', '晚上好呀各位', '这个皮肤好好看',
  '笑死我了哈哈哈哈', '前面的弹幕别剧透', '今天播到几点', '关注了关注了', '这个梗我懂了']
  .map((t, i) => sg(1, t, i * 1000));
const spamNormal = analyzeSpamBursts(normalBurst);
assert.equal(spamNormal.ok, true);
assert.equal(spamNormal.level, 'none', '内容各异的高频发言不是刷屏');
assert.equal(spamNormal.best, null);

// 8) 8 条分散在 90s（任何 60s 窗口都凑不满）→ 不判定
assert.equal(analyzeSpamBursts(Array.from({ length: 8 }, (_, i) => sg(1, '确实', i * 12800))).level, 'none');

// 9) 样本不足直接不下结论，并给出原因
const spamFew = analyzeSpamBursts(Array.from({ length: 5 }, (_, i) => sg(1, '主播今天状态真好', i * 500)));
assert.equal(spamFew.ok, false);
assert.match(spamFew.note, /样本 5 条.*8 条/);
assert.equal(analyzeSpamBursts([]).ok, false);

// 10) 跨用户协同：30s 内 6 人各 2 条同意句 + 引流特征 → 协同刷屏
const coordList = [];
for (let i = 0; i < 6; i++) { coordList.push(sg(50 + i, '加群领福利看主页', i * 1200)); coordList.push(sg(50 + i, '加群领福利看主页', 7200 + i * 1200)); }
const spamCoord = analyzeSpamBursts(coordList, { context: 'comment' });
assert.equal(spamCoord.level, 'coordinated');
assert.equal(spamCoord.behaviour, 'coordinated');
assert.equal(spamCoord.intent, 'attack');
assert.equal(spamCoord.group.users, 6);
assert.ok(spamCoord.rules.some((r) => r.id === 'S6' && r.ok), '协同规则命中');
assert.ok(spamCoord.rules.some((r) => r.id === 'S9'), '评论口径要显式提示');
assert.equal(spamCoord.boundaryNotes.length, 5);
assert.match(spamCoord.disclaimer, /不是平台处罚结论/);

// 11) 脱敏：样本与昵称不落原文，但结论与阈值照常
const spamRedacted = analyzeSpamBursts(
  Array.from({ length: 15 }, (_, i) => sg(1, '主播今天状态真好', i * 570)), { redact: true }
);
assert.equal(spamRedacted.level, 'high');
assert.equal(spamRedacted.best.userName, '');
assert.ok(spamRedacted.samples.every((s) => s.text === '' && s.name === ''));

// 12) 阈值可整体覆盖，且默认值就是产品里写死的那套
assert.equal(SPAM_RULES.windowMs, 60000);
assert.equal(SPAM_RULES.similarity, 0.82);
assert.equal(SPAM_RULES.minMessages, 8);
assert.equal(SPAM_RULES.coordUsers, 5);
const customCfg = analyzeSpamBursts(
  Array.from({ length: 6 }, (_, i) => sg(1, '主播今天状态真好', i * 500)),
  { config: { minMessages: 6, minRepeats: 4, repeatShare: 0.5 } }
);
assert.equal(customCfg.ok, true, '放宽阈值后 6 条即可参与判定');
assert.equal(customCfg.level, 'suspect', '阈值整体覆盖后按新阈值定档');

/* 13) 结论必须落到「对应直播间主播」上：按主播分组再判，而不是把多个主播混在一起判一次。
 *     构造：A 主播间 15 条辱骂（8s）＋ B 主播间 10 条内容各异 —— 只有 A 该被判，且结论指明 A。 */
const spamRec = (ts, text) => ({
  ts, type: 1, typeLabel: '弹幕', payloadKind: 'text',
  ...dateParts(ts), text, name: '某用户', price: null, count: null,
  roomEmojiId: null, isText: true, isEmoji: false, isPaid: false, isEnter: false
});
const SPAM_T = Date.UTC(2026, 0, 5, 12, 0, 0);
const spamInput = {
  sessions: [
    {
      liveId: 'L1', channelUid: 'C1', channelName: '刷屏主播', tags: [], fans: null,
      agency: null, agencyUuid: null, area: '虚拟', liveTitle: '', live: {},
      records: Array.from({ length: 15 }, (_, i) => spamRec(SPAM_T + i * 500, '主播就是个垃圾人'))
    },
    {
      liveId: 'L2', channelUid: 'C2', channelName: '正常主播', tags: [], fans: null,
      agency: null, agencyUuid: null, area: '虚拟', liveTitle: '', live: {},
      records: ['好看', '好听', '晚上好', '来了', '这波很强', '关注了', '哈哈', '笑死', '第一次看', '加油']
        .map((t, i) => spamRec(SPAM_T + i * 1000, t))
    }
  ]
};
const spamPortrait = buildLivePortrait(spamInput, { hideOnlyEnter: true });
// 全局合并会把 A 主播间的浓度稀释（15/25 = 60%，够不到高度疑似的 70%），这正是要按主播拆的原因
assert.equal(spamPortrait.spam.level, 'suspect', '跨主播合并会稀释浓度');
assert.equal(spamPortrait.spam.channels.length, 2, '两个主播文本都够判定线');
assert.equal(spamPortrait.spam.channelJudged, 2);
assert.equal(spamPortrait.spam.channelTotal, 2);
// 按严重度排序，异常主播排第一，且结论能读出「是哪个主播」
assert.equal(spamPortrait.spam.channels[0].channelName, '刷屏主播');
assert.equal(spamPortrait.spam.channels[0].level, 'high', '单独看这个主播间才是高度疑似');
assert.equal(spamPortrait.spam.channels[0].repeats, 15);
assert.equal(spamPortrait.spam.channels[1].channelName, '正常主播');
assert.equal(spamPortrait.spam.channels[1].level, 'none', '内容各异的那个主播间不得被连带判成刷屏');
// 总结卡要能回答「在谁的直播间」，并按最严重的那个主播定档
assert.equal(spamPortrait.summaryCard.spam.channel, '刷屏主播');
assert.match(spamPortrait.summaryCard.spam.text, /刷屏主播/);
assert.equal(spamPortrait.summaryCard.spam.level, 'high');
// 脱敏只隐藏弹幕原文与用户昵称，主播名属于公开直播间信息，保留
const spamRedactPortrait = buildLivePortrait(spamInput, { redact: true, hideOnlyEnter: true });
assert.equal(spamRedactPortrait.spam.channels[0].channelName, '刷屏主播');
assert.ok(spamRedactPortrait.spam.channels.every((c) => !/垃圾人/.test(JSON.stringify(c))), 'redaction keeps verdict text out');

/* 14) 攻击目标 → 退出「最喜爱主播」候选
 * 条件：该主播间判定成立 + 内容为 attack（命中攻击词）+ 单人主导 + 同簇 ≥ 6 条，四条同时成立。 */
assert.equal(spamPortrait.spam.attackTargets.length, 1, '只有被攻击的那个主播进攻击目标');
assert.equal(spamPortrait.spam.attackTargets[0].channelName, '刷屏主播');
assert.equal(spamPortrait.spam.attackTargets[0].level, 'high');
assert.equal(spamPortrait.summaryCard.favorite.name, '正常主播', '最喜爱主播自动顺延到下一个候选');
assert.equal(spamPortrait.summaryCard.favorite.excluded.length, 1);
assert.equal(spamPortrait.summaryCard.favorite.excluded[0].channelName, '刷屏主播');
assert.match(spamPortrait.summaryCard.favorite.text, /已排除被判定为刷屏攻击/);
// 统计口径不受影响：频道分布仍然是 2 个主播，Top1 仍是原第一名
assert.equal(spamPortrait.channelAffinities.length, 2, '候选过滤不动频道分布');
assert.equal(spamPortrait.channelAffinities[0].channelName, '刷屏主播', 'Top1 排名不改写');
assert.equal(spamPortrait.summaryCard.favorite.recordShare, 10 / 25, '占比改按选中的主播计算');

// 反例 1：齐刷短句祝福（meme）不是刷屏攻击 → 不剔除，最喜爱主播不变
const bdaySess = (i, name, texts) => ({
  liveId: 'B' + i, channelUid: 'D' + i, channelName: name, tags: [], fans: null,
  agency: null, agencyUuid: null, area: '虚拟', liveTitle: '', live: {},
  records: texts.map((t, k) => spamRec(SPAM_T + k * 600, t))
});
const normalList = ['好看', '好听', '晚上好', '来了', '这波很强', '关注了', '哈哈', '笑死', '第一次看', '加油'];
const bdayPortrait = buildLivePortrait({
  sessions: [
    bdaySess(1, '生日主播', Array.from({ length: 15 }, () => '生日快乐')),
    bdaySess(2, '另一直播间', normalList)
  ]
}, { hideOnlyEnter: true });
assert.equal(bdayPortrait.spam.attackTargets.length, 0, '情绪 / 应援类重复不是刷屏攻击');
assert.equal(bdayPortrait.summaryCard.favorite.name, '生日主播', '未被判定为刷屏攻击的主播不受影响');
assert.equal(bdayPortrait.summaryCard.favorite.excluded.length, 0);

// 反例 2 已改成正例：填充 / 引流式刷屏（intent=spam，不含辱骂词）同样剔除。
// 实测形态：在别人直播间连刷同一句引流话术「关注示例主播喵…」——判定是 spam 而非 attack，
// 但刷屏行为本身就是在攻击该直播间（污染弹幕 + 导流），不能因为「没有脏字」就放过。
const spamSessPortrait = buildLivePortrait({
  sessions: [
    bdaySess(1, '引流主播间', Array.from({ length: 15 }, () => '主播今天状态真好呀')),
    bdaySess(2, '另一直播间', normalList)
  ]
}, { hideOnlyEnter: true });
assert.equal(spamSessPortrait.spam.intent, 'spam');
assert.equal(spamSessPortrait.spam.attackTargets.length, 1, 'spam 型刷屏也算被刷屏攻击');
assert.equal(spamSessPortrait.summaryCard.favorite.name, '另一直播间', '填充式刷屏的主播同样退出候选');
assert.match(spamSessPortrait.summaryCard.favorite.text, /已排除被判定为刷屏攻击/);

// 反例 3：候选全被剔除时给出明确文案，不留空字段
const allTargetPortrait = buildLivePortrait({
  sessions: [bdaySess(1, '唯一主播', Array.from({ length: 15 }, () => '主播就是个垃圾人'))]
}, { hideOnlyEnter: true });
assert.equal(allTargetPortrait.spam.attackTargets.length, 1);
assert.equal(allTargetPortrait.summaryCard.favorite.name, '—');
assert.match(allTargetPortrait.summaryCard.favorite.text, /均被判定为刷屏攻击/);
assert.ok(!/undefined/.test(JSON.stringify(allTargetPortrait.summaryCard)), 'no undefined leak when all excluded');
console.log('OK  attack target excluded from favorite (attack / spam 都剔，meme 不受影响，全剔除兜底)');
console.log('OK  spam by channel (结论落到对应直播间主播，不跨主播合并判定)');
console.log('OK  spam (独轮车判定：单人重复 / 多人复读 / 情绪弹幕 / 慢速 / 协同 / 正常连发不误判)');

console.log('ALL CHECKS PASSED');
