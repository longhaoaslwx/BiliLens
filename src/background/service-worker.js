/* BiliLens 后台编排：采集、缓存、节流、评分、导出。
 * 所有数据只在本地 chrome.storage.local 流转，不发送到任何第三方服务。 */
import {
  configure, getCard, getRelationStat, getViewByBvid, getUserVideos,
  searchUsers, getReplies, getMedalWall, parseUserInput, parseVideoInput, riskState
} from '../lib/bili-api.js';
import {
  buildProfile, scoreProfiles, analyzeCohort, toCsv, mergeFederated
} from '../lib/profiler.js';
import {
  SITES, publicSites, querySite, queryAll, summarizeFederated,
  riskState as federatedRiskState
} from '../lib/federated.js';
import {
  getSettings, setSettings, getReport, saveReport, cacheGet, cacheSet,
  clearAll, clearCacheByPrefix, storageInfo, DEFAULTS
} from '../lib/store.js';
import { fetchAnnotations } from '../lib/annotation.js';
import { analyzeSpamBursts } from '../lib/spam.js';

let pageContext = null;

// 整轮聚合硬上限：任何一层卡住，后台都必须在弹窗超时之前给出明确回包。
const FEDERATED_DEADLINE_MS = 120_000;

function progress(phase, done, total, message) {
  chrome.runtime.sendMessage({ type: 'BILILENS_PROGRESS', phase, done, total, message })
    .catch(() => {});
}

/** 阶段性提示（不改变进度条数值）：通道回退、超时、跳过站点等都要让用户看见。 */
function notice(phase, text, level = 'info') {
  chrome.runtime.sendMessage({ type: 'BILILENS_NOTICE', phase, text, level, at: Date.now() })
    .catch(() => {});
}

function withDeadline(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout()), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function cached(key, ttlMs, producer) {
  const hit = await cacheGet(key);
  if (hit) return { ...hit, __cached: true };
  const value = await producer();
  if (value && value.ok) await cacheSet(key, value, ttlMs);
  return value;
}

function flatReply(reply, aid) {
  const member = reply.member || {};
  return {
    rpid: reply.rpid,
    oid: aid,
    mid: String(reply.mid || member.mid || ''),
    uname: member.uname || '',
    ctime: reply.ctime,
    message: (reply.content || {}).message || '',
    like: reply.like || 0,
    avatar: member.avatar || '',
    sign: member.sign || '',
    member
  };
}

async function fetchComments(videoInput, pages, settings) {
  const parsed = parseVideoInput(videoInput);
  if (parsed.kind === 'invalid') return { ok: false, error: '请输入 BV 号、av 号或视频链接' };

  let aid = parsed.value;
  let videoTitle = '';
  let viewSource = null;
  if (parsed.kind === 'bvid') {
    const view = await getViewByBvid(parsed.value);
    if (!view.ok) {
      return { ok: false, error: `无法解析视频：${view.code} ${view.message}`, source: view.source };
    }
    aid = view.data.aid;
    videoTitle = view.data.title || '';
    viewSource = view.source;
  }

  const comments = [];
  const errors = [];
  let lastSource = null;
  let cursor = 0; // 服务端返回的 cursor.next 才是正确的下一页游标，不能简单按页数自增
  for (let page = 0; page < pages; page++) {
    const res = await getReplies({
      oid: aid, type: 1, mode: 3, next: cursor, ps: settings.commentPageSize
    });
    lastSource = res.source;
    if (!res.ok) {
      errors.push(`第 ${page + 1} 页：${res.code} ${res.message}`);
      break;
    }
    const replies = (res.data && res.data.replies) || [];
    replies.forEach((r) => comments.push(flatReply(r, aid)));
    const pageCursor = res.data.cursor || {};
    if (!replies.length || pageCursor.is_end === true) break;
    const nextCursor = Number(pageCursor.next);
    cursor = Number.isFinite(nextCursor) && nextCursor > cursor ? nextCursor : cursor + 1;
    progress('comments', page + 1, pages, `已读取第 ${page + 1} 页评论`);
  }
  return {
    ok: comments.length > 0,
    aid, videoTitle, comments, errors,
    source: viewSource || lastSource,
    commentsSource: lastSource,
    error: comments.length ? null : (errors[0] || '该视频评论区无可见评论')
  };
}

async function collectUser(mid, options = {}) {
  const settings = await getSettings();
  configure({ minGapMs: settings.minGapMs });
  const ttl = settings.cacheTtlMin * 60 * 1000;

  const [card, relation] = await Promise.all([
    cached(`card:${mid}`, ttl, () => getCard(mid)),
    cached(`relation:${mid}`, ttl, () => getRelationStat(mid))
  ]);
  const videos = options.withVideos
    ? await cached(`videos:${mid}`, ttl, () => getUserVideos(mid, 1, settings.videoPageSize))
    : null;
  // 粉丝牌 + 曾用名：仅单目标画像与多源聚合时取，批量/评论区画像省略以控制请求量。
  // 官方勋章墙走 bili-api 的页面通道（同源 Referer + 登录 Cookie），失败由 annotation.js 回落 AICU。
  const annotations = options.withAnnotations
    ? await cached(`anno:${mid}`, ttl, () => fetchAnnotations(mid, {
        timeoutMs: settings.federatedTimeoutMs,
        fetchMedalWall: async () => {
          const res = await getMedalWall(mid);
          return res.ok
            ? { ok: true, status: 200, json: { code: 0, data: res.data } }
            : { ok: false, status: 0, json: { code: res.code, message: res.message }, error: res.message };
        }
      }))
    : null;

  return {
    mid: String(mid),
    card,
    relation,
    videos,
    annotations,
    member: options.member || null,
    comments: options.comments || [],
    commentsAvailable: !!options.commentsAvailable,
    commentsCode: options.commentsCode,
    commentsSource: options.commentsSource || null,
    collectedAt: new Date().toISOString()
  };
}

function makeReport({ kind, value, label, profiles, clusters, comments, settings, extra }) {
  const bands = { '低关注': 0, '需人工复核': 0, '高关注线索': 0, '重点复核': 0 };
  profiles.forEach((p) => { if (p.inference) bands[p.inference.band]++; });
  return {
    schema: 'bililens-report/1.0',
    generatedAt: new Date().toISOString(),
    target: { kind, value, label },
    settingsEcho: {
      minGapMs: settings.minGapMs,
      commentPages: settings.commentPages,
      commentPageSize: settings.commentPageSize,
      videoPageSize: settings.videoPageSize,
      maxBatchUsers: settings.maxBatchUsers,
      enableKeywordScoring: settings.enableKeywordScoring,
      keywordCount: (settings.attackKeywords || []).length,
      federatedLiveMaxPages: settings.federatedLiveMaxPages,
      federatedLivePageSize: settings.federatedLivePageSize,
      federatedLiveHideOnlyEnter: settings.federatedLiveHideOnlyEnter,
      federatedLiveStart: settings.federatedLiveStart,
      federatedLiveEnd: settings.federatedLiveEnd
    },
    summary: {
      profileCount: profiles.length,
      averageScore: profiles.length
        ? Number((profiles.reduce((a, p) => a + (p.inference ? p.inference.score : 0), 0) / profiles.length).toFixed(1))
        : 0,
      bands,
      insufficientCount: profiles.filter((p) => p.inference && !p.inference.sufficient).length,
      clusterCount: clusters ? clusters.length : 0
    },
    profiles,
    clusters: clusters || [],
    comments: comments || [],
    extra: extra || {},
    limitations: [
      '仅使用 B 站公开接口与用户自身浏览器上下文；未登录或触发风控时部分字段缺失，缺失不计入风险。',
      'card.regtime 在绝大多数账号返回 0，平台未公开注册时间，本工具不据此推断账号年龄。',
      '评分是可解释的线索优先级，不是身份认定、不是事实结论，所有命中项须回到证据人工核验。',
      '第三方聚合数据（含弹幕行为记录）只描述站点已收录的样本，口径与时效性不受本工具控制，不构成身份认定或行为定性。',
      '所有可视化图表只消费去重、缺失值处理、异常值处理与字段规范化之后的清洗数据；缺失不等于 0，被剔除或截断的条目逐项计入清洗报告。'
    ]
  };
}

async function profileSingle(input, settings) {
  const parsed = parseUserInput(input);
  let mid = parsed.value;
  let resolution = null;
  if (parsed.kind === 'keyword') {
    const search = await searchUsers(parsed.value, 1);
    if (!search.ok) {
      return { ok: false, error: `昵称检索失败：${search.code} ${search.message}。可直接输入 UID 或 space 主页链接。`, source: search.source };
    }
    const list = (search.data && search.data.result) || [];
    resolution = list.slice(0, 10).map((u) => ({ mid: String(u.mid), name: u.uname, fans: u.fans, level: u.level }));
    if (!resolution.length) return { ok: false, error: '未检索到匹配用户，请改用 UID 或主页链接。' };
    mid = resolution[0].mid;
  }
  progress('profile', 0, 1, `正在采集 UID ${mid}`);
  const raw = await collectUser(mid, { withVideos: true, withAnnotations: true });
  const profile = buildProfile(raw);
  scoreProfiles([profile], settings);
  const report = makeReport({
    kind: 'user', value: mid, label: profile.facts.name || mid,
    profiles: [profile], settings
  });
  report.extra.resolution = resolution;
  await saveReport(report);
  progress('profile', 1, 1, '采集完成');
  return { ok: true, report };
}

async function profileBatch(mids, settings) {
  const profiles = [];
  const unique = [...new Set(mids.map(String))].filter((m) => /^\d+$/.test(m)).slice(0, settings.maxBatchUsers);
  for (let i = 0; i < unique.length; i++) {
    const raw = await collectUser(unique[i], { withVideos: false });
    profiles.push(buildProfile(raw));
    progress('batch', i + 1, unique.length, `已采集 ${i + 1}/${unique.length} 个账号`);
  }
  scoreProfiles(profiles, settings);
  const report = makeReport({
    kind: 'batch', value: unique.join(','), label: `${unique.length} 个账号`,
    profiles, settings
  });
  await saveReport(report);
  return { ok: true, report };
}

async function analyzeVideo(payload, settings) {
  const pages = Math.max(1, Math.min(10, Number(payload.pages || settings.commentPages)));
  const maxUsers = Math.max(1, Math.min(60, Number(payload.maxUsers || settings.maxBatchUsers)));
  const fetched = await fetchComments(payload.videoInput, pages, settings);
  if (!fetched.ok) return { ok: false, error: fetched.error, source: fetched.source, errors: fetched.errors };

  const byMid = new Map();
  fetched.comments.forEach((c) => {
    if (!c.mid) return;
    if (!byMid.has(c.mid)) byMid.set(c.mid, []);
    byMid.get(c.mid).push(c);
  });
  const selected = [...byMid.keys()].slice(0, maxUsers);
  const profiles = [];
  for (let i = 0; i < selected.length; i++) {
    const mid = selected[i];
    const list = byMid.get(mid);
    const raw = await collectUser(mid, {
      withVideos: false,
      comments: list.map(({ member, ...rest }) => rest),
      member: list[0].member,
      commentsAvailable: true,
      commentsCode: 0,
      commentsSource: fetched.commentsSource
    });
    profiles.push(buildProfile(raw));
    progress('profiles', i + 1, selected.length, `已画像 ${i + 1}/${selected.length} 个评论者`);
  }

  const cohort = analyzeCohort(profiles, fetched.comments);
  // v1.5.4：评论区是多用户样本，可判定「跨用户协同刷屏」；口径按评论时间，不是直播间弹幕
  const commentSpam = analyzeSpamBursts(
    fetched.comments.map((c) => ({
      ts: Number(c.ctime) * 1000 || 0,
      text: c.message,
      uid: c.mid,
      name: (c.member && c.member.uname) || ''
    })),
    { context: 'comment', redact: settings.federatedRedact }
  );
  scoreProfiles(profiles, { ...settings, cohortReady: true });
  const report = makeReport({
    kind: 'video', value: String(fetched.aid), label: fetched.videoTitle || `av${fetched.aid}`,
    profiles, clusters: cohort.clusters, comments: fetched.comments, settings,
    extra: {
      videoTitle: fetched.videoTitle,
      commentCount: fetched.comments.length,
      uniqueCommenters: byMid.size,
      analysedCommenters: selected.length,
      commentsSkipped: byMid.size - selected.length,
      namePatterns: cohort.namePatterns,
      spam: commentSpam,
      errors: fetched.errors
    }
  });
  await saveReport(report);
  return { ok: true, report };
}

/* ------------------------------ 多源画像 ------------------------------ */

/** 统一的查询参数：聚合与单站刷新必须走同一套口径，避免刷新后样本范围悄悄变化。 */
function federatedOptions(settings, extra = {}) {
  return {
    ttlMin: settings.federatedTtlMin,
    redact: settings.federatedRedact,
    timeoutMs: settings.federatedTimeoutMs,
    federatedLiveMaxPages: settings.federatedLiveMaxPages,
    federatedLivePageSize: settings.federatedLivePageSize,
    federatedLiveHideOnlyEnter: settings.federatedLiveHideOnlyEnter,
    federatedLiveStart: settings.federatedLiveStart,
    federatedLiveEnd: settings.federatedLiveEnd,
    ...extra
  };
}

async function analyzeFederated(payload, settings) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + FEDERATED_DEADLINE_MS;
  const parsed = parseUserInput(payload.input);
  if (parsed.kind !== 'uid') {
    return { ok: false, error: '多源站点只接受 UID 或 space 主页链接，请先确认目标 UID。' };
  }
  const mid = parsed.value;
  const siteIds = (payload.siteIds && payload.siteIds.length)
    ? payload.siteIds
    : settings.federatedSiteIds;
  if (!siteIds || !siteIds.length) {
    return { ok: false, error: '未勾选任何查询站点，请在弹窗或设置页至少选择一个站点。' };
  }
  const totalSteps = siteIds.length + 1;

  progress('federated', 0, totalSteps, `正在采集 UID ${mid} 的官方画像`);
  notice('federated', `开始聚合 ${siteIds.length} 个站点，整轮上限 ${FEDERATED_DEADLINE_MS / 1000} 秒；B 站页面通道 4 秒无响应会自动回退后台直连。`, 'info');
  const raw = await collectUser(mid, { withVideos: true, withAnnotations: true });
  const profile = buildProfile(raw);
  progress('federated', 1, totalSteps, '官方画像采集完成，开始逐站查询');

  const results = await queryAll(mid, federatedOptions(settings, {
    siteIds,
    force: !!payload.force,
    deadlineAt,
    onSiteStart: (index, total, site) =>
      progress('federated', index + 1, total + 1, `正在查询 ${site.name}（${index + 1}/${total}）`),
    onProgress: (done, total, result) =>
      progress('federated', done + 1, total + 1, `${result.siteName}：${result.message}`)
  }));
  const summary = summarizeFederated(results);
  mergeFederated(profile, summary);
  scoreProfiles([profile], {
    ...settings,
    federatedScoring: settings.enableFederatedScoring,
    federatedReady: true
  });

  const report = makeReport({
    kind: 'federated', value: mid, label: profile.facts.name || mid,
    profiles: [profile], settings,
    extra: {
      federated: {
        ...summary,
        // 原始逐站结果体积较大，导出时保留但界面只展示汇总
        rawResults: results
      },
      cleaning: summary.cleaning,
      federatedDisclaimer: '第三方聚合数据仅作证据与可视化，不作为事实结论；同名/同 UID 关联不等于同一自然人。'
    }
  });
  await saveReport(report);
  const timedOut = results.filter((r) => r.status === 'timeout');
  if (timedOut.length) {
    notice('federated', `已到整轮时间上限，${timedOut.map((r) => r.siteName).join('、')} 未查询；可在结果页对这些站点单独点「刷新」。`, 'warn');
  }
  return {
    ok: true, report, federated: summary, cleaning: summary.cleaning,
    elapsedMs: Date.now() - startedAt,
    timedOutSites: timedOut.map((r) => r.siteName)
  };
}

/* ------------------------------ 导出 ------------------------------ */

function redactFederated(fed) {
  if (!fed) return;
  // 弹幕行为画像的样本、重复文本示例与直播间名称都可能含原文或可识别信息
  fed.evidence = [];
  fed.liveSamples = [];
  fed.liveRepeatedPhrases = [];
  fed.liveTopChannels = [];
  fed.rawResults = [];
  // v1.3.0：完整画像里含词云、高频词、重复语句与主播名，脱敏时一并清空
  if (fed.livePortrait) {
    fed.livePortrait.samples = [];
    fed.livePortrait.repeatedPhrases = [];
    fed.livePortrait.topChannels = [];
    fed.livePortrait.channelAffinities = [];
    if (fed.livePortrait.insights) {
      fed.livePortrait.insights.highFreqWords = [];
      fed.livePortrait.insights.wordCloud = [];
      fed.livePortrait.insights.topRepeated = [];
      fed.livePortrait.insights.maxRepeatedText = '';
    }
  }
}

function redact(report) {
  const clone = JSON.parse(JSON.stringify(report));
  clone.profiles.forEach((p) => {
    p.facts.name = '[已脱敏]';
    p.comments = [];
    p.videos = [];
    redactFederated(p.federated);
  });
  clone.comments = [];
  clone.clusters.forEach((c) => { c.evidence = []; });
  redactFederated(clone.extra && clone.extra.federated);
  return clone;
}

async function exportReport(format) {
  const report = await getReport();
  if (!report) return { ok: false, error: '还没有可导出的报告，请先完成一次分析。' };
  const settings = await getSettings();
  const data = settings.redactExport ? redact(report) : report;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let content, filename, mime;
  if (format === 'csv') {
    content = '\uFEFF' + toCsv(data.profiles);
    filename = `BiliLens_${stamp}.csv`;
    mime = 'text/csv';
  } else {
    content = JSON.stringify(data, null, 2);
    filename = `BiliLens_${stamp}.json`;
    mime = 'application/json';
  }
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  await chrome.downloads.download({ url, filename, saveAs: true });
  return { ok: true, filename, bytes: content.length };
}

/* ------------------------------ 消息路由 ------------------------------ */

async function handle(message) {
  const settings = await getSettings();
  configure({
    minGapMs: settings.minGapMs,
    onNotice: (text) => notice(message.type === 'ANALYZE_FEDERATED' ? 'federated' : 'profile', text, 'warn')
  });

  switch (message.type) {
    case 'GET_STATE':
      return {
        ok: true,
        settings,
        hasReport: !!(await getReport()),
        report: await getReport(),
        storage: await storageInfo(),
        risk: riskState(),
        federatedRisk: federatedRiskState()
      };

    case 'GET_PAGE_CONTEXT':
      return { ok: true, context: pageContext };

    case 'SET_PAGE_CONTEXT':
      pageContext = message.context || null;
      return { ok: true };

    case 'PROFILE_USER':
      return profileSingle(message.input, settings);

    case 'PROFILE_BATCH':
      return profileBatch(message.mids || [], settings);

    case 'FETCH_COMMENTS':
      return fetchComments(message.videoInput, Number(message.pages || settings.commentPages), settings);

    case 'ANALYZE_VIDEO':
      return analyzeVideo(message, settings);

    case 'FEDERATED_SITES':
      return { ok: true, sites: publicSites(), risk: federatedRiskState() };

    case 'ANALYZE_FEDERATED':
      return withDeadline(analyzeFederated(message, settings), FEDERATED_DEADLINE_MS + 5_000, () => ({
        ok: false,
        code: 'AGGREGATION_TIMEOUT',
        error: `聚合超过 ${FEDERATED_DEADLINE_MS / 1000} 秒上限，已中止本次等待。多半是第三方站点连接挂起或页面通道被冻结；后台可能仍在收尾，稍后重新打开弹窗可查看已保存的报告。`
      }));

    case 'FEDERATED_CLEAR_CACHE': {
      const removed = await clearCacheByPrefix('fed:');
      return { ok: true, removed };
    }

    case 'FEDERATED_REFRESH_SITE': {
      const report = await getReport();
      if (!report || report.target.kind !== 'federated' || !report.extra || !report.extra.federated) {
        return { ok: false, error: '请先完成一次多源聚合，再刷新单个站点。' };
      }
      const site = SITES.find((s) => s.id === message.siteId);
      if (!site) return { ok: false, error: '未知站点 ID' };
      const result = await querySite(site, report.target.value,
        federatedOptions(settings, { force: true, deadlineAt: Date.now() + 25_000 }));
      const previous = report.extra.federated.rawResults || [];
      const merged = previous.some((r) => r.siteId === site.id)
        ? previous.map((r) => (r.siteId === site.id ? result : r))
        : [...previous, result];
      const summary = summarizeFederated(merged);
      const profile = report.profiles[0];
      mergeFederated(profile, summary);
      scoreProfiles([profile], {
        ...settings,
        federatedScoring: settings.enableFederatedScoring,
        federatedReady: true
      });
      report.extra.federated = summary;
      report.extra.cleaning = summary.cleaning;
      report.summary.averageScore = profile.inference.score;
      report.summary.bands = { '低关注': 0, '需人工复核': 0, '高关注线索': 0, '重点复核': 0 };
      report.summary.bands[profile.inference.band]++;
      report.summary.insufficientCount = profile.inference.sufficient ? 0 : 1;
      await saveReport(report);
      return { ok: true, report, federated: summary };
    }

    case 'EXPORT':
      return exportReport(message.format);

    case 'SET_SETTINGS': {
      const next = await setSettings(message.patch || {});
      configure({ minGapMs: next.minGapMs });
      return { ok: true, settings: next };
    }

    case 'RESET_SETTINGS': {
      const next = await setSettings({ ...DEFAULTS });
      configure({ minGapMs: next.minGapMs });
      return { ok: true, settings: next };
    }

    case 'CLEAR_DATA': {
      const removed = await clearAll();
      return { ok: true, removed };
    }

    default:
      return { ok: false, error: `未知消息类型：${message.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type || message.type === 'BILILENS_PROGRESS') return;
  handle(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  configure({ minGapMs: settings.minGapMs });
});

getSettings().then((settings) => configure({ minGapMs: settings.minGapMs }));
