/* 画像构建与线索评分。
 *
 * 严格区分三层：
 *   facts      —— 接口返回的可复核原始事实
 *   derived    —— 由 facts 计算的统计量
 *   inference  —— 规则命中（线索优先级），不构成身份认定或事实结论
 *
 * 数据缺失时规则跳过并记入 skipped，绝不把「取不到」当成「风险信号」。
 */

export function normalizeText(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@[^\s@]+/g, '')
    .replace(/[\s\u200b-\u200d\ufeff]/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\d+/g, '#')
    .toLowerCase();
}

function hourCN(timestampSec) {
  const d = new Date(Number(timestampSec) * 1000 + 8 * 3600 * 1000);
  return d.getUTCHours();
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function percent(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function titleTemplateRate(videos) {
  if (!videos || videos.length < 3) return 0;
  const keys = videos.map((v) => normalizeText(v.title).slice(0, 24));
  const counts = new Map();
  keys.forEach((k) => { if (k) counts.set(k, (counts.get(k) || 0) + 1); });
  const duplicated = [...counts.values()].filter((n) => n >= 2).reduce((a, b) => a + b, 0);
  const prefixGroups = new Map();
  keys.forEach((k) => {
    const p = k.slice(0, 4);
    if (p) prefixGroups.set(p, (prefixGroups.get(p) || 0) + 1);
  });
  const dominantPrefix = Math.max(0, ...prefixGroups.values());
  return Math.max(percent(duplicated, keys.length), dominantPrefix >= Math.ceil(keys.length * 0.6) ? dominantPrefix / keys.length : 0);
}

function burstCount(videos) {
  if (!videos || videos.length < 2) return 0;
  const times = videos.map((v) => safeNum(v.created)).filter(Boolean).sort((a, b) => a - b);
  let count = 0;
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= 600) count++;
  return count;
}

function commentBurst(comments) {
  if (!comments || comments.length < 2) return 0;
  const times = comments.map((c) => safeNum(c.ctime)).filter(Boolean).sort((a, b) => a - b);
  let maxRun = 0;
  let run = 1;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] <= 300) run++;
    else run = 1;
    maxRun = Math.max(maxRun, run);
  }
  return maxRun;
}

/** 由采集结果构建画像。raw 结构见 service-worker.js collectUser()。 */
export function buildProfile(raw) {
  const cardOk = !!(raw.card && raw.card.ok && raw.card.data && raw.card.data.card);
  const relOk = !!(raw.relation && raw.relation.ok && raw.relation.data);
  const vidOk = !!(raw.videos && raw.videos.ok && raw.videos.data);
  const card = cardOk ? raw.card.data.card : {};
  const rel = relOk ? raw.relation.data : {};
  const member = raw.member || {};

  const videoList = vidOk
    ? ((raw.videos.data.list || {}).vlist || []).map((v) => ({
        aid: v.aid,
        bvid: v.bvid,
        title: v.title || '',
        description: v.description || '',
        created: safeNum(v.created),
        play: safeNum(v.play),
        comment: safeNum(v.comment),
        typeid: v.typeid,
        length: v.length || ''
      }))
    : [];
  const comments = Array.isArray(raw.comments) ? raw.comments : [];

  // v1.5.2 标注（粉丝牌 / 曾用名）：来自 lib/annotation.js，官方勋章墙优先、AICU 兜底
  const anno = raw.annotations || null;
  const medalSet = anno && anno.medals && anno.medals.ok ? anno.medals : null;
  const markSet = anno && anno.mark && anno.mark.ok ? anno.mark : null;

  const followers = relOk ? safeNum(rel.follower) : safeNum(card.fans);
  const following = relOk ? safeNum(rel.following) : safeNum(card.attention);
  const regtime = safeNum(card.regtime);

  const facts = {
    mid: String(raw.mid),
    name: card.name || member.uname || '',
    sex: card.sex || member.sex || '',
    level: safeNum((card.level_info || member.level_info || {}).current_level),
    follower: followers,
    following: following,
    sign: card.sign || member.sign || '',
    avatar: card.face || member.avatar || '',
    officialTitle: (card.Official || {}).title || (card.official_verify || {}).desc || '',
    vipLabel: (card.vip || {}).label ? card.vip.label.text : '',
    nameplate: (card.nameplate || {}).name || '',
    rank: card.rank || '',
    regtime: regtime > 0 ? regtime : null,
    regtimeAvailable: regtime > 0,
    archiveCount: vidOk ? safeNum((raw.videos.data.page || {}).count) : null,
    articleCount: safeNum(card.article),
    // 标注：曾用名与粉丝牌（缺数据时为 null / []，界面按「未取得」展示而不是 0）
    formerNames: markSet ? markSet.formerNames : [],
    medalCount: medalSet && medalSet.list.length ? medalSet.list.length : null,
    medalSource: medalSet ? medalSet.source : '',
    medalTop: medalSet && medalSet.list[0] ? `${medalSet.list[0].name} Lv${medalSet.list[0].level}` : ''
  };

  // 标注明细（供画像页直接渲染粉丝牌表 / 曾用名 chip）：归一化后只保留展示所需字段
  const annotations = anno ? {
    fetchedAt: anno.fetchedAt || '',
    medal: {
      ok: !!(medalSet && medalSet.list.length),
      source: medalSet ? medalSet.source : '',
      sourceLabel: medalSet && medalSet.source === 'medalwall' ? 'B 站官方勋章墙' : 'AICU 第三方标注',
      count: medalSet ? medalSet.list.length : null,
      closed: !!(medalSet && medalSet.closed),
      onlyShowWearing: !!(medalSet && medalSet.onlyShowWearing),
      message: medalSet
        ? (medalSet.fallbackNote || medalSet.message || '')
        : ((anno.medals && anno.medals.message) || ''),
      list: medalSet ? medalSet.list.slice(0, 20) : []
    },
    mark: {
      ok: !!markSet,
      formerNames: markSet ? markSet.formerNames : [],
      guilds: markSet ? markSet.guilds : [],
      devices: markSet ? markSet.devices : [],
      tags: markSet ? markSet.tags : [],
      markText: markSet ? markSet.markText : '',
      message: markSet ? '' : ((anno.mark && anno.mark.message) || '')
    }
  } : null;

  const avgPlay = percent(videoList.reduce((a, v) => a + v.play, 0), videoList.length);
  const avgComment = percent(videoList.reduce((a, v) => a + v.comment, 0), videoList.length);
  const createdTimes = videoList.map((v) => v.created).filter(Boolean);
  const spanDays = createdTimes.length >= 2
    ? (Math.max(...createdTimes) - Math.min(...createdTimes)) / 86400
    : 0;

  const derived = {
    followerFollowingRatio: following > 0 ? followers / following : null,
    videoSampleCount: videoList.length,
    avgPlay: Math.round(avgPlay),
    avgComment: Math.round(avgComment),
    zeroPlayRate: percent(videoList.filter((v) => v.play === 0).length, videoList.length),
    titleTemplateRate: Number(titleTemplateRate(videoList).toFixed(3)),
    burstCount: burstCount(videoList),
    nightPostRate: percent(videoList.filter((v) => hourCN(v.created) < 6).length, videoList.length),
    activeSpanDays: Number(spanDays.toFixed(1)),
    commentCount: comments.length,
    commentBurst: commentBurst(comments),
    keywordHits: [],
    cohortWordingClusters: 0,
    cohortHomogeneousClusters: 0
  };

  const sources = [
    { field: '基础档案', endpoint: '/x/web-interface/card', ok: cardOk, code: raw.card ? raw.card.code : 'NOT_CALLED', source: raw.card ? raw.card.source : null },
    { field: '粉丝/关注', endpoint: '/x/relation/stat', ok: relOk, code: raw.relation ? raw.relation.code : 'NOT_CALLED', source: raw.relation ? raw.relation.source : null },
    { field: '投稿列表', endpoint: '/x/space/wbi/arc/search', ok: vidOk, code: raw.videos ? raw.videos.code : 'NOT_CALLED', source: raw.videos ? raw.videos.source : null },
    { field: '评论样本', endpoint: '/x/v2/reply/main', ok: raw.commentsAvailable === true, code: raw.commentsCode || 'NOT_CALLED', source: raw.commentsSource || null },
    {
      field: '粉丝牌 / 曾用名',
      endpoint: '/xlive/web-ucenter/user/MedalWall + api.aicu.cc/v4/user',
      ok: !!(medalSet || markSet),
      code: anno ? ((medalSet || markSet) ? 0 : (anno.medals && anno.medals.code) || 'EMPTY') : 'NOT_CALLED',
      source: null
    }
  ];

  const coverage = (cardOk ? 0.5 : 0) + (relOk ? 0.2 : 0) + (vidOk ? 0.2 : 0) + (raw.commentsAvailable ? 0.1 : 0);

  return {
    mid: facts.mid,
    collectedAt: raw.collectedAt || new Date().toISOString(),
    facts,
    derived,
    videos: videoList,
    comments,
    annotations,
    sources,
    availability: {
      card: cardOk ? 'ok' : 'failed',
      relation: relOk ? 'ok' : 'failed',
      videos: raw.videos ? (vidOk ? 'ok' : 'failed') : 'not_called',
      comments: raw.commentsAvailable ? 'ok' : 'not_called'
    },
    coverage: Number(coverage.toFixed(2))
  };
}

/* ------------------------------ 规则表 ------------------------------ */

export const RULES = [
  {
    id: 'R01', label: '低等级且粉丝极少', weight: 12,
    needs: ['card'],
    test: (p) => p.facts.level <= 2 && p.facts.follower < 50,
    evidence: (p) => `Lv${p.facts.level}，粉丝 ${p.facts.follower}`
  },
  {
    id: 'R02', label: '无公开投稿记录', weight: 10,
    needs: ['videos'],
    test: (p) => p.availability.videos === 'ok' && p.facts.archiveCount === 0,
    evidence: (p) => `投稿总数 ${p.facts.archiveCount}`
  },
  {
    id: 'R03', label: '投稿标题高度模板化', weight: 18,
    needs: ['videos'],
    test: (p) => p.derived.videoSampleCount >= 3 && p.derived.titleTemplateRate >= 0.5,
    evidence: (p) => `归一化重复率 ${(p.derived.titleTemplateRate * 100).toFixed(0)}%，样本 ${p.derived.videoSampleCount} 条`
  },
  {
    id: 'R04', label: '短时集中投稿', weight: 14,
    needs: ['videos'],
    test: (p) => p.derived.burstCount >= 2,
    evidence: (p) => `10 分钟内连续投稿 ${p.derived.burstCount} 次`
  },
  {
    id: 'R05', label: '关注/粉丝结构倒挂', weight: 10,
    needs: ['relation'],
    test: (p) => p.facts.follower < 5 && p.facts.following > 100,
    evidence: (p) => `粉丝 ${p.facts.follower}，关注 ${p.facts.following}`
  },
  {
    id: 'R06', label: '内容长期零互动', weight: 8,
    needs: ['videos'],
    test: (p) => p.facts.archiveCount >= 5 && p.derived.avgPlay < 50,
    evidence: (p) => `平均播放 ${p.derived.avgPlay}，投稿 ${p.facts.archiveCount} 条`
  },
  {
    id: 'R07', label: '公开资料高度稀薄', weight: 6,
    needs: ['card', 'videos'],
    test: (p) => !p.facts.sign && !p.facts.officialTitle && p.facts.archiveCount === 0,
    evidence: () => '无签名、无认证、无投稿'
  },
  {
    id: 'R08', label: '评论时间聚集', weight: 8,
    needs: ['comments'],
    test: (p) => p.derived.commentBurst >= 2,
    evidence: (p) => `5 分钟窗口内连续评论 ${p.derived.commentBurst} 条`
  },
  {
    id: 'R09', label: '命中自定义关键词', weight: 0,
    needs: ['comments'],
    test: (p) => p.derived.keywordHits.length > 0,
    evidence: (p) => `命中 ${p.derived.keywordHits.length} 次：${p.derived.keywordHits.slice(0, 4).join('、')}`
  },
  {
    id: 'R10', label: '参与跨账号重复话术簇', weight: 22,
    needs: ['cohort'],
    test: (p) => p.derived.cohortWordingClusters > 0,
    evidence: (p) => `参与 ${p.derived.cohortWordingClusters} 个共享话术簇`
  },
  {
    id: 'R11', label: '位于同质账号簇', weight: 8,
    needs: ['cohort'],
    test: (p) => p.derived.cohortHomogeneousClusters > 0,
    evidence: (p) => `位于 ${p.derived.cohortHomogeneousClusters} 个属性同质簇`
  },
  {
    id: 'F01', label: '第三方评论样本时段高度集中', weight: 8,
    needs: ['federated'],
    test: (p) => p.federated.hourPeakShare >= 0.6 && p.federated.replySampleCount >= 10,
    evidence: (p) => `AICU 样本 ${p.federated.replySampleCount} 条，峰值时段占比 ${(p.federated.hourPeakShare * 100).toFixed(0)}%（第三方数据，需核验）`
  },
  {
    id: 'F02', label: '第三方评论量与官方产出不匹配', weight: 6,
    needs: ['federated'],
    test: (p) => p.federated.replyTotal >= 100 && p.facts.archiveCount !== null && p.facts.archiveCount <= 1 && p.facts.level <= 3,
    evidence: (p) => `第三方标注历史评论 ${p.federated.replyTotal} 条，官方投稿 ${p.facts.archiveCount}（第三方数据，需核验）`
  }
];

/** 评分。keywords 为空或开关关闭时 R09 不参与。 */
export function scoreProfiles(profiles, options = {}) {
  const keywords = options.enableKeywordScoring
    ? (options.attackKeywords || []).map((k) => String(k).trim()).filter(Boolean)
    : [];
  const available = (p, needs) => needs.every((n) => {
    if (n === 'card') return p.availability.card === 'ok';
    if (n === 'relation') return p.availability.relation === 'ok';
    if (n === 'videos') return p.availability.videos === 'ok';
    if (n === 'comments') return p.availability.comments === 'ok';
    if (n === 'cohort') return options.cohortReady === true;
    if (n === 'federated') return options.federatedScoring === true && options.federatedReady === true && !!p.federated;
    return false;
  });

  return profiles.map((p) => {
    p.derived.keywordHits = keywords.length
      ? p.comments.flatMap((c) => keywords.filter((k) => String(c.message || '').includes(k)))
      : [];
    const hits = [];
    const skipped = [];
    for (const rule of RULES) {
      if (!available(p, rule.needs)) {
        skipped.push({
          id: rule.id,
          reason: rule.needs.includes('federated') && !options.federatedScoring
            ? '多源佐证计分未启用（默认关闭）'
            : '所需数据不可用'
        });
        continue;
      }
      if (!rule.test(p)) continue;
      const weight = rule.id === 'R09' ? Math.min(20, 7 * p.derived.keywordHits.length) : rule.weight;
      if (weight <= 0) continue;
      hits.push({ id: rule.id, label: rule.label, weight, evidence: rule.evidence(p) });
    }
    const score = Math.min(100, hits.reduce((a, h) => a + h.weight, 0));
    const band = score >= 75 ? '重点复核' : score >= 50 ? '高关注线索' : score >= 25 ? '需人工复核' : '低关注';
    p.inference = {
      score,
      band,
      hits,
      skipped,
      sufficient: p.coverage >= 0.5,
      disclaimer: '线索优先级，不是身份认定、不是事实结论；所有命中项需回到原始证据人工核验。'
    };
    return p;
  });
}

/* ------------------------------ 群体线索 ------------------------------ */

export function analyzeCohort(profiles, comments = []) {
  const clusters = [];
  const caveat = '关联线索，不构成同一主体或组织化行为的认定，需人工核验。';

  // 1. 跨账号重复话术
  const wording = new Map();
  comments.forEach((c) => {
    const key = normalizeText(c.message);
    if (key.length < 8) return;
    if (!wording.has(key)) wording.set(key, []);
    wording.get(key).push(c);
  });
  for (const [key, list] of wording) {
    const mids = [...new Set(list.map((c) => String(c.mid)))];
    if (mids.length < 2) continue;
    clusters.push({
      type: 'shared_wording', label: '跨账号重复话术', key: key.slice(0, 40),
      members: mids,
      evidence: list.slice(0, 6).map((c) => ({ mid: String(c.mid), rpid: c.rpid, ctime: c.ctime, message: c.message })),
      caveat
    });
  }

  // 2. 相同头像 / 相同签名
  for (const [field, label, type] of [['avatar', '相同头像 URL', 'same_avatar'], ['sign', '相同个性签名', 'same_sign']]) {
    const groups = new Map();
    profiles.forEach((p) => {
      const v = String(p.facts[field] || '').trim();
      if (!v) return;
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v).push(p.mid);
    });
    for (const [value, members] of groups) {
      if (members.length < 2) continue;
      clusters.push({
        type, label, key: value.slice(0, 80), members: [...new Set(members)],
        evidence: [{ field, value: value.slice(0, 120), count: members.length }], caveat
      });
    }
  }

  // 3. 评论时间聚集（5 分钟窗口内 >= 3 个不同账号）
  const buckets = new Map();
  comments.forEach((c) => {
    if (!c.ctime) return;
    const bucket = Math.floor(Number(c.ctime) / 300);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(c);
  });
  for (const [bucket, list] of buckets) {
    const mids = [...new Set(list.map((c) => String(c.mid)))];
    if (mids.length < 3) continue;
    clusters.push({
      type: 'time_cluster', label: '评论时间聚集', key: `UTC+8 ${new Date(bucket * 300 * 1000 + 8 * 3600 * 1000).toISOString()}`,
      members: mids,
      evidence: list.slice(0, 8).map((c) => ({ mid: String(c.mid), rpid: c.rpid, ctime: c.ctime })),
      caveat
    });
  }

  // 4. 属性同质（弱线索）
  const homogeneous = profiles.filter(
    (p) => p.availability.card === 'ok' && p.facts.level <= 3 && p.facts.follower < 50 && !p.facts.officialTitle
  );
  if (homogeneous.length >= 3) {
    clusters.push({
      type: 'homogeneous', label: '低等级低粉丝同质账号', key: `共 ${homogeneous.length} 个账号`,
      members: homogeneous.map((p) => p.mid),
      evidence: homogeneous.slice(0, 8).map((p) => ({ mid: p.mid, level: p.facts.level, follower: p.facts.follower })),
      caveat: caveat + ' 该簇为弱线索，普通新用户亦会命中。'
    });
  }

  const membership = new Map();
  clusters.forEach((c) => c.members.forEach((mid) => {
    const cur = membership.get(mid) || { wording: 0, homogeneous: 0 };
    if (c.type === 'shared_wording') cur.wording++;
    if (c.type === 'homogeneous') cur.homogeneous++;
    membership.set(mid, cur);
  }));
  profiles.forEach((p) => {
    const m = membership.get(p.mid) || { wording: 0, homogeneous: 0 };
    p.derived.cohortWordingClusters = m.wording;
    p.derived.cohortHomogeneousClusters = m.homogeneous;
  });

  const namePatterns = {
    pureDigits: profiles.filter((p) => /^\d{6,}$/.test(p.facts.name)).length,
    noCJK: profiles.filter((p) => p.facts.name && !/[\u4e00-\u9fff]/.test(p.facts.name)).length,
    total: profiles.length
  };

  return { clusters, namePatterns };
}

/** 把多源汇总写入画像的证据层。不改动官方 facts，也不自动影响评分。 */
export function mergeFederated(profile, summary) {
  if (!profile || !summary) return profile;
  const hours = summary.hourBuckets || [];
  const total = hours.reduce((a, h) => a + (Number(h.count) || 0), 0);
  const peak = hours.reduce((a, h) => Math.max(a, Number(h.count) || 0), 0);
  const peakBucket = hours.find((h) => Number(h.count) === peak);
  profile.federated = {
    collectedAt: summary.collectedAt,
    sitesTotal: summary.sitesTotal,
    sitesWithData: summary.sitesWithData,
    sitesCached: summary.sitesCached,
    sitesFailed: summary.sitesFailed,
    statuses: summary.statuses || [],
    evidence: (summary.evidence || []).slice(0, 40),
    replyTotal: summary.replyTotal,
    replySampleCount: summary.replySampleCount,
    monthBuckets: summary.monthBuckets || [],
    hourBuckets: hours,
    hourPeakShare: total > 0 ? peak / total : 0,
    hourPeak: peakBucket ? peakBucket.key : null,
    distinctOids: summary.distinctOids,
    channelCount: summary.channelCount,
    tagCounts: summary.tagCounts || [],
    totalDanmaku: summary.totalDanmaku,
    trendPoints: summary.trendPoints,
    fansLatest: summary.fansLatest,
    fansDelta30Points: summary.fansDelta30Points,
    vtbsListed: summary.vtbsListed,
    guardCount: summary.guardCount,
    // Danmakus 弹幕行为画像：扩展本地聚合的统计，不是服务端画像结论，也不参与评分
    liveSessionTotal: summary.liveSessionTotal ?? null,
    liveSessionFetched: summary.liveSessionFetched ?? null,
    liveHasMore: summary.liveHasMore ?? null,
    liveRecordCount: summary.liveRecordCount ?? null,
    liveTextCount: summary.liveTextCount ?? null,
    liveActiveDays: summary.liveActiveDays ?? null,
    liveLongestStreak: summary.liveLongestStreak ?? null,
    liveEarliestTs: summary.liveEarliestTs ?? null,
    liveLatestTs: summary.liveLatestTs ?? null,
    liveHourBuckets: summary.liveHourBuckets || [],
    liveWeekdayBuckets: summary.liveWeekdayBuckets || [],
    liveMonthBuckets: summary.liveMonthBuckets || [],
    liveActiveDates: summary.liveActiveDates || [],
    liveEventTypes: summary.liveEventTypes || [],
    liveTopChannels: summary.liveTopChannels || [],
    liveAreaCounts: summary.liveAreaCounts || [],
    liveRepeatedPhrases: summary.liveRepeatedPhrases || [],
    liveSamples: summary.liveSamples || [],
    liveTimeRange: summary.liveTimeRange || null,
    liveScopeNote: summary.liveScopeNote || '',
    liveRedacted: !!summary.liveRedacted,
    liveHideOnlyEnter: summary.liveHideOnlyEnter ?? null,
    liveChannelTags: summary.liveChannelTags || [],
    liveAgencyCounts: summary.liveAgencyCounts || [],
    liveFansScale: summary.liveFansScale || [],
    liveScale: summary.liveScale || null,
    liveDistinctChannels: summary.liveDistinctChannels ?? null,
    liveChannelMetaNote: summary.liveChannelMetaNote || '',
    liveAgencyNames: summary.liveAgencyNames || {},
    liveAgencyUnresolved: summary.liveAgencyUnresolved || [],
    // v1.3.0：清洗报告与完整 /analyze 聚合画像（全部基于清洗后数据）
    cleaning: summary.cleaning || null,
    dataBasis: summary.dataBasis || null,
    livePortrait: summary.livePortrait || null,
    liveRawRecordCount: summary.liveRawRecordCount ?? null,
    liveDateFilteredCount: summary.liveDateFilteredCount ?? null,
    channelRawRowCount: summary.channelRawRowCount ?? null,
    channelDuplicateRowsDropped: summary.channelDuplicateRowsDropped ?? null,
    disclaimer: '第三方聚合数据，口径与时效性不受本工具控制，仅作证据与可视化，不作为事实结论；所有图表只消费去重、缺失/异常处理与字段规范化之后的清洗结果；弹幕行为统计与分类均由扩展在本机按可复核规则计算，不构成行为定性。'
  };
  return profile;
}

/* ------------------------------ 导出 ------------------------------ */

export function toCsv(profiles) {
  const columns = [
    ['mid', 'UID'], ['name', '昵称'], ['level', '等级'], ['follower', '粉丝数'],
    ['following', '关注数'], ['officialTitle', '认证'], ['archiveCount', '投稿数'],
    ['commentCount', '评论样本数'], ['score', '线索分'], ['band', '分档'],
    ['hits', '命中规则'], ['coverage', '数据覆盖'], ['collectedAt', '采集时间'],
    ['fedReplyTotal', '第三方历史评论'], ['fedChannels', '关注主播数'],
    ['fedFans', '粉丝趋势最新'], ['fedCoverage', '多源覆盖'],
    ['fedLiveSessions', '弹幕取回场次'], ['fedLiveRecords', '弹幕记录数'],
    ['fedLiveTexts', '弹幕文本数'], ['fedLiveActiveDays', '弹幕活跃天数'],
    ['fedLiveChannels', '涉及主播数'], ['fedLiveWatch', '所涉场次观看人次'],
    ['fedLiveScope', '弹幕样本范围'],
    ['cleanInput', '清洗前记录数'], ['cleanDuplicates', '去重条数'],
    ['cleanMissing', '缺失处理条数'], ['cleanAnomalies', '异常剔除条数'],
    ['cleanOutput', '清洗后记录数'], ['livePayment', '打米总额(元)'],
    ['livePaidLives', '打米场次'], ['liveRhythm', '活跃节律分组'],
    ['liveSupport', '支持方式分组'], ['homepage', '主页链接']
  ];
  const fedVal = (v) => (v === null || v === undefined ? '不可用' : v);
  const escape = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => c[1]).join(',')];
  profiles.forEach((p) => {
    const row = {
      mid: p.mid, name: p.facts.name, level: p.facts.level,
      follower: p.facts.follower, following: p.facts.following,
      officialTitle: p.facts.officialTitle,
      archiveCount: p.facts.archiveCount === null ? '不可用' : p.facts.archiveCount,
      commentCount: p.derived.commentCount,
      score: p.inference ? p.inference.score : '',
      band: p.inference ? p.inference.band : '',
      hits: p.inference ? p.inference.hits.map((h) => h.id).join(' ') : '',
      coverage: p.coverage, collectedAt: p.collectedAt,
      fedReplyTotal: p.federated ? (p.federated.replyTotal === null ? '不可用' : p.federated.replyTotal) : '',
      fedChannels: p.federated ? (p.federated.channelCount === null ? '不可用' : p.federated.channelCount) : '',
      fedFans: p.federated ? (p.federated.fansLatest === null ? '不可用' : p.federated.fansLatest) : '',
      fedCoverage: p.federated ? `${p.federated.sitesWithData}/${p.federated.sitesTotal}` : '',
      fedLiveSessions: p.federated
        ? `${fedVal(p.federated.liveSessionFetched)}/${fedVal(p.federated.liveSessionTotal)}` : '',
      fedLiveRecords: p.federated ? fedVal(p.federated.liveRecordCount) : '',
      fedLiveTexts: p.federated ? fedVal(p.federated.liveTextCount) : '',
      fedLiveActiveDays: p.federated ? fedVal(p.federated.liveActiveDays) : '',
      fedLiveChannels: p.federated ? fedVal(p.federated.liveDistinctChannels) : '',
      fedLiveWatch: p.federated
        ? fedVal(p.federated.liveScale ? p.federated.liveScale.watchCount : null) : '',
      fedLiveScope: p.federated
        ? `${p.federated.liveTimeRange && p.federated.liveTimeRange.filtered
            ? `${p.federated.liveTimeRange.start || '不限'}~${p.federated.liveTimeRange.end || '不限'} · ` : ''}${p.federated.liveHasMore ? '样本非全量' : '已取回可及场次'}`
        : '',
      cleanInput: p.federated && p.federated.cleaning ? p.federated.cleaning.totals.inputRows : '',
      cleanDuplicates: p.federated && p.federated.cleaning ? p.federated.cleaning.totals.duplicatesRemoved : '',
      cleanMissing: p.federated && p.federated.cleaning ? p.federated.cleaning.totals.missingHandled : '',
      cleanAnomalies: p.federated && p.federated.cleaning ? p.federated.cleaning.totals.anomaliesRemoved : '',
      cleanOutput: p.federated && p.federated.cleaning ? p.federated.cleaning.totals.outputRows : '',
      livePayment: p.federated && p.federated.livePortrait ? p.federated.livePortrait.support.totalPayment : '',
      livePaidLives: p.federated && p.federated.livePortrait ? p.federated.livePortrait.support.paidLives : '',
      liveRhythm: p.federated && p.federated.livePortrait ? p.federated.livePortrait.personalityProfile.activityRhythm.choice : '',
      liveSupport: p.federated && p.federated.livePortrait ? p.federated.livePortrait.personalityProfile.supportStyle.choice : '',
      homepage: `https://space.bilibili.com/${p.mid}`
    };
    lines.push(columns.map(([key]) => escape(row[key])).join(','));
  });
  return lines.join('\r\n');
}
