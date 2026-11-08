/* Danmakus /analyze 完整聚合画像（v1.3.0）。
 *
 * 输入必须是 clean.js cleanSessions() 的输出；本模块不接触任何站点原始结构。
 * 维度与展示结构逐项对齐 danmakus.com/analyze/{uid} 页面（.research/_uid-ik0L2c33.js）：
 *   概览指标 / 留痕构成 / 活跃节律（7×24、活跃日历、互动趋势、活动节奏）/
 *   频道偏好（最亲密主播、亲密度、频道分布、分区偏好、跨房倾向与频道集中度）/
 *   表达风格（词云、高频词、复读指数、原创派、表情包达人、平均长度、深夜发言）/
 *   支持方式（打米总额/场次/主播/最多打给/打米构成/单笔最高/其他互动）/
 *   五维分类（核心粉丝光谱、发言表达风格、跨房倾向、活跃节律、支持方式）。
 *
 * 与站点的关键差异：本站不调用其 POST 分析任务接口，也不采用服务端的主观模型输出。
 * 五维分类由本机可复核规则 + 明确列出的驱动指标计算，并在每张卡上展示驱动值；
 * 仅用于描述这批清洗后样本的统计分布，不构成身份认定、性格判断或行为定性。
 */
import { DM_TYPES, normalizePhrase, asText, dateParts, agencyLabel } from './clean.js';
import { analyzeSpamBursts, collectAttackTargets, SPAM_RULES, SPAM_LEVEL_ORDER } from './spam.js';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const pct = (a, b) => (b > 0 ? a / b : 0);
const round = (n, d = 3) => Number((Number(n) || 0).toFixed(d));
const sum = (list, pick) => list.reduce((a, v) => a + (Number(pick(v)) || 0), 0);

export function longestStreak(dates) {
  let best = 0, run = 0, prev = NaN;
  for (const day of [...new Set(dates)].sort()) {
    const n = Date.parse(day + 'T00:00:00Z') / 86400000;
    run = n - prev === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = n;
  }
  return best;
}

/* ------------------------------ 分类字典（与页面一致） ------------------------------ */

export const DIMENSIONS = [
  { key: 'archetype', title: '核心粉丝光谱', note: '综合弹幕互动习惯、高频语句与玩梗倾向评估的核心观众角色' },
  { key: 'style', title: '发言表达风格', note: '基于发言用词、句式与情绪倾向归纳的表达风格' },
  { key: 'crossRoom', title: '跨房倾向', note: '根据频道分布集中度、跨分区跨度与互动权重评估的串门习惯' },
  { key: 'activityRhythm', title: '活跃节律', note: '按 7×24 小时活跃分布统计的主要出没时段' },
  { key: 'supportStyle', title: '支持方式', note: '结合礼物、醒目留言、大航海与日常互动统计的支持偏好' }
];

export const CLASS_NOTES = {
  troll_fun: '爱调侃主播下饭翻车、起哄看热闹、玩梗整活或围观节目效果',
  devoted_support: '高频夸赞、心疼护航、打call表白、真情实感支持主播',
  chill_companion: '日常问候早晚安、聊家常、温和互动陪伴、情绪稳定',
  sharp_critic: '爱挑刺吐槽、指点游戏操作、犀利点评或争论节奏',
  repeater_meme: '高复读指数、爱刷哈哈/草/问号/666/表情包跟风烘托直播间气氛',
  humorous_meme: '热衷网络热梗、谐音梗、抽象话或搞笑调侃',
  rational_chat: '围绕直播内容、游戏机制、杂谈话题进行有逻辑的提问或交流',
  warm_wholesome: '语气友善礼貌、多用祝贺感谢鼓励类表达、给人温暖感',
  sarcastic_edgy: '反话正说、带刺调侃、攻击性或挑衅感较强',
  single_oshi: '互动高度集中在单一主推频道，长期驻守同一直播间',
  circle_family: '主要在少数几个同分区或关联度高的主播间轮流常驻互动',
  topic_roamer: '跨多个分区流动发言，围绕热门事件、赛事或节目效果串门',
  wide_dd: '涉猎频道数量多且分布分散，在大量不同主播间打卡互动',
  late_night: '弹幕多集中于深夜至清晨（00:00~06:00），典型的夜猫子观众',
  daytime: '活跃时段主要分布在上午及下午（06:00~18:00）',
  evening: '黄金档晚间（18:00~24:00）发言最密集，下班下课后的常驻观众',
  super_chat: '主要通过醒目留言（SC）传达心意或提问互动',
  guard: '主要通过大航海（舰长/提督/总督）提供持续稳定的长效支持',
  gift: '主要通过常规付费礼物打赏支持主播',
  companionship: '以持续发弹幕、常驻陪伴为主要支持方式，少氪或纯白嫖',
  insufficient_sample: '当前统计区间内有效互动样本较少，暂不足以稳定归类'
};

/* 分类展示名（静态常量）。
 * Danmakus /analyze 页面的这组展示标签只存在于其前端 bundle 与服务端模型输出里，
 * 没有任何公开接口可以按 UID 取回，因此按「无法补全 → 静态常量内嵌」处理；
 * 标签文本为 2026-11-08 对官方页面实际展示名的记录，概率仍由本机可复核规则计算。 */
export const CLASS_LABELS = {
  chill_companion: '陪伴打卡 / 温和老粉', devoted_support: '结晶单推 / 全自定',
  repeater_meme: '复读机器 / 气氛组', troll_fun: '乐子人 / 拱火整活',
  sharp_critic: '毒舌锐评 / 压力指导',
  warm_wholesome: '温暖鼓励 / 体贴互动', humorous_meme: '造梗玩梗 / 抽象玩梗',
  rational_chat: '理性讨论 / 认真交流', sarcastic_edgy: '阴阳怪气 / 犀利调侃',
  circle_family: '同圈锚推 / 熟人串门', single_oshi: '专一单推 / 核心守门',
  wide_dd: '博爱DD / 广泛打卡', topic_roamer: '热点巡游 / 跨区乐子',
  late_night: '深夜活跃', daytime: '白天活跃', evening: '黄金档活跃',
  gift: '礼物支持', super_chat: '醒目留言支持', guard: '舰长支持',
  companionship: '陪伴发弹幕支持', insufficient_sample: '样本不足'
};

/* ------------------------------ 本地分词（仅用于词云 / 高频词） ------------------------------ */

const STOPWORDS = new Set([
  '这个', '那个', '一个', '什么', '怎么', '可以', '就是', '还是', '但是', '因为', '所以',
  '自己', '我们', '你们', '他们', '没有', '不是', '已经', '现在', '时候', '感觉', '真的',
  '一下', '有点', '这么', '那么', '而且', '然后', '其实', '一直', '应该', '可能', '只有',
  'the', 'and', 'for', 'with', 'you', 'are', 'not', 'but', 'this', 'that', 'have'
]);

/** 轻量本地分词：连续中文串（2–6 字保留整串，>6 字切二字组）+ ASCII 词。非服务端分词。 */
export function tokenize(text) {
  const out = [];
  const src = String(text || '');
  for (const m of src.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (run.length <= 6) out.push(run);
    else for (let i = 0; i + 2 <= run.length; i += 2) out.push(run.slice(i, i + 2));
  }
  for (const m of src.matchAll(/[a-zA-Z]{2,12}/g)) out.push(m[0].toLowerCase());
  return out.filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function wordFrequency(records) {
  const counter = new Map();
  records.forEach((r) => {
    if (!r.text) return;
    tokenize(r.text).forEach((t) => counter.set(t, (counter.get(t) || 0) + 1));
  });
  return [...counter.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

/* ------------------------------ 关键词规则（表达风格） ------------------------------ */

const LEXICON = [
  { key: 'warm', label: '祝贺 / 感谢 / 鼓励', words: ['谢谢', '感谢', '加油', '辛苦', '祝贺', '恭喜', '生日快乐', '早安', '晚安', '喜欢', '支持', '厉害', '好棒', '可爱', '棒棒', '心疼', '保重'] },
  { key: 'meme', label: '热梗 / 玩梗 / 起哄', words: ['哈哈', '草', '666', '233', 'awsl', '整活', '玩梗', '梗', '笑死', '节目效果', '乐', '难绷', '蚌埠', '典', '孝'] },
  { key: 'rational', label: '提问 / 讨论 / 机制', words: ['为什么', '怎么', '如何', '请问', '机制', '是不是', '求解', '求助', '讨论', '？', '?', '能不能', '是不是'] },
  { key: 'critical', label: '吐槽 / 挑刺 / 争论', words: ['翻车', '下饭', '菜', '吐槽', '离谱', '锐评', '难受', '寄', '摆烂', '太菜', '不行', '失误', '拉胯'] },
  { key: 'greeting', label: '问候 / 陪伴', words: ['来了', '前排', '打卡', '签到', '到啦', '在吗', '晚上好', '中午好', '早上好', '先走了', '下次见'] }
];

function lexiconHits(textRecords) {
  const hits = {};
  LEXICON.forEach(({ key }) => { hits[key] = 0; });
  textRecords.forEach((r) => {
    const t = String(r.text || '');
    LEXICON.forEach(({ key, words }) => {
      if (words.some((w) => t.includes(w))) hits[key]++;
    });
  });
  return hits;
}

/* ------------------------------ 分类构造 ------------------------------ */

function makeDimension(meta, scores, drivers, insufficient) {
  const active = Object.entries(scores).filter(([, v]) => v > 0);
  const total = active.reduce((a, [, v]) => a + v, 0);
  if (insufficient || !active.length || total <= 0) {
    return {
      ...meta, label: CLASS_LABELS.insufficient_sample, choice: 'insufficient_sample',
      choiceNote: CLASS_NOTES.insufficient_sample, confidence: 0,
      probabilities: [], drivers, ruleBased: true
    };
  }
  const probabilities = active
    .map(([key, value]) => ({ key, label: CLASS_LABELS[key] || key, probability: round(value / total), note: CLASS_NOTES[key] || '' }))
    .sort((a, b) => b.probability - a.probability);
  const top = probabilities[0];
  return {
    ...meta, label: top.label,
    choice: top.key, choiceNote: CLASS_NOTES[top.key] || '',
    confidence: round(top.probability),
    probabilities, drivers, ruleBased: true
  };
}

/* ------------------------------ 主入口 ------------------------------ */

/**
 * @param {object} input cleanSessions() 的返回值
 * @param {object} options { redact, total, hasMore, start, end, hideOnlyEnter, cleaning }
 * @returns {object} 完整画像；legacy 子对象保留 v1.2 字段，全部由清洗后数据重算
 */
export function buildLivePortrait(input, options = {}) {
  const sessions = Array.isArray(input && input.sessions) ? input.sessions : [];
  const allRecords = [];
  sessions.forEach((s) => s.records.forEach((r) => allRecords.push({ ...r, session: s })));
  const withRecords = sessions.filter((s) => s.records.length > 0);
  const interactive = allRecords.filter((r) => !r.isEnter);
  const textRecords = allRecords.filter((r) => r.isText);
  const paid = allRecords.filter((r) => r.isPaid);
  const redact = !!options.redact;
  // 机构 UUID → 名称解析表（由聚合层调用 /agencies/{uuid} 取得）；解析失败时保留原始 UUID
  const agencyNames = options.agencyNames || {};

  /* --- 概览指标 --- */
  const totalPayment = round(sum(paid, (r) => r.price), 2);
  const maxSinglePayment = paid.reduce((a, r) => Math.max(a, Number(r.price) || 0), 0);
  const paidChannels = new Set(paid.map((r) => r.session.channelUid)).size;
  const activeDays = new Set(allRecords.map((r) => r.day)).size;
  const dates = [...new Set(allRecords.map((r) => r.day))].sort();
  const longest = longestStreak(dates);
  const distinctChannels = new Set(withRecords.map((s) => s.channelUid)).size;
  const summary = {
    totalLives: sessions.length,
    appearanceLives: withRecords.length,
    interactiveLives: new Set(interactive.map((r) => r.session.liveId)).size,
    paidLives: new Set(paid.map((r) => r.session.liveId)).size,
    totalTraces: allRecords.length,
    totalInteractions: interactive.length,
    totalMessages: textRecords.length,
    uniqueMessages: new Set(textRecords.map((r) => normalizePhrase(r.text)).filter(Boolean)).size,
    totalPayment,
    paidChannels,
    activeDays,
    longestStreak: longest,
    avgPerActiveDay: round(pct(interactive.length, activeDays), 1),
    interactiveShare: round(pct(withRecords.length && interactive.length ? new Set(interactive.map((r) => r.session.liveId)).size : 0, Math.max(withRecords.length, 1))),
    distinctChannels,
    appearanceShareNote: `${new Set(interactive.map((r) => r.session.liveId)).size} / ${withRecords.length} 场有互动`
  };

  /* --- 留痕构成 --- */
  const LEAVE_GROUPS = [
    { label: '弹幕', types: [0] }, { label: '礼物', types: [1] },
    { label: '醒目留言', types: [3] }, { label: '大航海', types: [2] },
    { label: '入场', types: [4] }, { label: '禁言', types: [9] }
  ];
  const leaveTrace = LEAVE_GROUPS.map((g) => {
    const rows = allRecords.filter((r) => g.types.includes(r.type));
    return { label: g.label, count: rows.length, payment: round(sum(rows, (r) => r.price), 2), share: round(pct(rows.length, allRecords.length)) };
  });
  const covered = LEAVE_GROUPS.flatMap((g) => g.types);
  const otherRows = allRecords.filter((r) => !covered.includes(r.type));
  leaveTrace.push({ label: '其他', count: otherRows.length, payment: round(sum(otherRows, (r) => r.price), 2), share: round(pct(otherRows.length, allRecords.length)) });

  const eventTypes = Object.entries(
    allRecords.reduce((acc, r) => {
      const k = String(r.type);
      if (!acc[k]) acc[k] = { type: r.type, label: r.typeLabel || DM_TYPES[r.type] || '其他', count: 0, payment: 0 };
      acc[k].count++;
      acc[k].payment += Number(r.price) || 0;
      return acc;
    }, {})
  ).map(([, v]) => ({ ...v, payment: round(v.payment, 2) }))
    .sort((a, b) => b.count - a.count);

  /* --- 时段 / 活跃日历 / 7×24 热力图 / 互动趋势 --- */
  const hourBuckets = Array.from({ length: 24 }, (_, h) => ({ key: String(h).padStart(2, '0'), count: 0 }));
  const weekdayBuckets = WEEKDAYS.map((label, i) => ({ key: String(i), label, count: 0 }));
  const monthMap = new Map();
  const dayMap = new Map();
  const rhythmMatrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  // 时段 / 星期 / 月份分布按「全部清洗后留痕」统计（与 v1.2 口径一致，含入场）；
  // 7×24 热力图按「互动」统计（排除入场），用于活跃节律分类。
  allRecords.forEach((r) => {
    hourBuckets[r.hour].count++;
    weekdayBuckets[r.weekday].count++;
    monthMap.set(r.month, (monthMap.get(r.month) || 0) + 1);
  });
  interactive.forEach((r) => { rhythmMatrix[r.weekday][r.hour]++; });
  allRecords.forEach((r) => {
    if (!dayMap.has(r.day)) dayMap.set(r.day, { date: r.day, interactions: 0, messages: 0, lives: new Set(), payment: 0 });
    const d = dayMap.get(r.day);
    if (!r.isEnter) d.interactions++;
    if (r.isText) d.messages++;
    d.lives.add(r.session.liveId);
    d.payment += Number(r.price) || 0;
  });
  const activityDays = [...dayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, interactions: d.interactions, messages: d.messages, lives: d.lives.size, payment: round(d.payment, 2) }));
  const monthBuckets = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));

  let rhythmPeak = { weekday: 0, hour: 0, value: 0, label: '暂无' };
  rhythmMatrix.forEach((row, w) => row.forEach((v, h) => {
    if (v > rhythmPeak.value) rhythmPeak = { weekday: w, hour: h, value: v, label: `${WEEKDAYS[w]} ${String(h).padStart(2, '0')}:00` };
  }));
  if (!rhythmPeak.value) rhythmPeak.label = '暂无';

  const periodCounts = {
    late_night: interactive.filter((r) => r.hour < 6).length,
    daytime: interactive.filter((r) => r.hour >= 6 && r.hour < 18).length,
    evening: interactive.filter((r) => r.hour >= 18).length
  };
  const nightOwlRecords = textRecords.filter((r) => r.hour >= 1 && r.hour <= 5).length;
  const nightOwlRatio = round(pct(nightOwlRecords, textRecords.length));
  const lateNightRatio = round(pct(periodCounts.late_night, interactive.length));

  /* --- 频道偏好 / 分区偏好 / 集中度 --- */
  const channelMap = new Map();
  const areaMap = new Map();
  const tagMap = new Map(), agencyMap = new Map(), fansBuckets = new Map();
  withRecords.forEach((s) => {
    if (!channelMap.has(s.channelUid)) channelMap.set(s.channelUid, {
      channelUid: s.channelUid, channelName: s.channelName,
      fans: s.fans, tags: s.tags, agency: s.agency, agencyUuid: s.agencyUuid,
      records: 0, sessions: 0, payment: 0, messages: 0, days: new Set(), areas: new Set()
    });
    const c = channelMap.get(s.channelUid);
    c.records += s.records.length;
    c.sessions++;
    c.payment += sum(s.records, (r) => r.price);
    // 每主播活跃天数 / 弹幕条数（对齐官方 /analyze 排行页签的口径）
    s.records.forEach((r) => {
      c.days.add(r.day);
      if (r.isText) c.messages++;
    });
    c.areas.add(s.area);
    areaMap.set(s.area, (areaMap.get(s.area) || 0) + 1);
  });
  // 主播维度按主播去重（同一主播多场次只计一次）
  [...channelMap.values()].forEach((c) => {
    c.tags.forEach((t) => tagMap.set(t, (tagMap.get(t) || 0) + 1));
    agencyMap.set(agencyLabel(c.agencyUuid, agencyNames), (agencyMap.get(agencyLabel(c.agencyUuid, agencyNames)) || 0) + 1);
    const bucket = c.fans === null || c.fans === undefined ? '未公开'
      : c.fans < 10000 ? '1 万以下'
      : c.fans < 100000 ? '1–10 万'
      : c.fans < 1000000 ? '10–100 万' : '100 万以上';
    fansBuckets.set(bucket, (fansBuckets.get(bucket) || 0) + 1);
  });
  const maxAffinity = Math.max(1, ...[...channelMap.values()].map((c) => c.records));
  const maxSessions = Math.max(1, ...[...channelMap.values()].map((c) => c.sessions));
  const channelAffinities = [...channelMap.values()]
    .map((c) => ({
      channelUid: c.channelUid, channelName: c.channelName,
      fans: c.fans, tags: c.tags, agency: agencyLabel(c.agencyUuid, agencyNames),
      records: c.records, sessions: c.sessions, payment: round(c.payment, 2), areas: [...c.areas],
      // 对齐官方 /analyze 排行页签：每主播活跃天数与弹幕条数
      activeDays: c.days.size, textCount: c.messages,
      // 亲密度：记录占比与场次占比各半，相对最亲密主播归一到 10；纯统计量，非站点模型输出
      loyaltyScore: round(10 * (0.5 * pct(c.records, maxAffinity) + 0.5 * pct(c.sessions, maxSessions)), 1)
    }))
    .sort((a, b) => b.records - a.records || b.loyaltyScore - a.loyaltyScore);
  const topChannel = channelAffinities[0] || null;
  const areas = [...areaMap.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const totalChannelRecords = sum(channelAffinities, (c) => c.records);
  const shares = channelAffinities.map((c) => pct(c.records, totalChannelRecords));
  const top1Share = round(shares[0] || 0);
  const top3Share = round(shares.slice(0, 3).reduce((a, b) => a + b, 0));
  const hhi = round(shares.reduce((a, s) => a + s * s, 0));
  // 官方「涉及主播与频道集中度 X/Y」用的是互动（非入场）口径，这里同样补一份
  const interactiveChannels = new Set(interactive.map((r) => r.session.channelUid)).size;
  const interactiveAreas = new Set(interactive.map((r) => r.session.area)).size;
  const channelConcentration = {
    distinctChannels, spanAreas: areas.length, top1Share, top3Share, hhi,
    interactiveChannels, interactiveAreas,
    note: 'HHI 为各主播记录占比平方和，越接近 1 越集中；只描述本批样本。'
  };
  const channelTagCounts = [...tagMap.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count).slice(0, 12);
  const agencyCounts = [...agencyMap.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count).slice(0, 8);
  const fansScale = ['1 万以下', '1–10 万', '10–100 万', '100 万以上', '未公开']
    .filter((k) => fansBuckets.has(k)).map((key) => ({ key, count: fansBuckets.get(key) }));
  const liveScale = (() => {
    const s = { sessions: withRecords.length, watchCount: 0, maxOnlineMax: 0, payCount: 0, interactionCount: 0, totalIncome: 0 };
    withRecords.forEach((x) => {
      const m = x.live || {};
      s.watchCount += m.watchCount || 0;
      s.maxOnlineMax = Math.max(s.maxOnlineMax, m.maxOnlineCount || 0);
      s.payCount += m.payCount || 0;
      s.interactionCount += m.interactionCount || 0;
      s.totalIncome += m.totalIncome || 0;
    });
    return { ...s, avgWatchCount: s.sessions ? Math.round(s.watchCount / s.sessions) : 0 };
  })();

  /* --- 表达风格 --- */
  const phraseMap = new Map();
  textRecords.forEach((r) => {
    const norm = normalizePhrase(r.text);
    if (norm.length < 2) return;
    if (!phraseMap.has(norm)) phraseMap.set(norm, { key: norm, count: 0, example: r.text, firstTs: r.ts });
    phraseMap.get(norm).count++;
  });
  const repeatedPhrases = [...phraseMap.values()].filter((p) => p.count >= 2)
    .sort((a, b) => b.count - a.count).slice(0, 10)
    .map((p) => ({ ...p, example: redact ? '' : asText(p.example, 80) }));
  const uniqueMessageRatio = round(pct(phraseMap.size, textRecords.length));
  const repeaterIndex = round(textRecords.length / Math.max(1, phraseMap.size), 1);
  const avgMessageLength = round(pct(sum(textRecords, (r) => r.text.length), textRecords.length), 1);
  const EMOJI_RE = /\[[^\]]{1,12}\]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
  const emojiRecords = textRecords.filter((r) => r.isEmoji || EMOJI_RE.test(r.text)).length;
  const emojiRatio = round(pct(emojiRecords, textRecords.length));
  const roomEmojiRecords = allRecords.filter((r) => r.isEmoji).length;
  const roomEmojiRatio = round(pct(roomEmojiRecords, allRecords.length));
  const maxRepeated = repeatedPhrases[0] || null;
  const words = wordFrequency(textRecords);
  const highFreqWords = words.slice(0, 12).map((w) => ({ ...w, text: redact ? '（已隐藏）' : w.text }));
  const wordCloud = words.slice(0, 40).map((w) => ({ name: redact ? '（已隐藏）' : w.text, value: w.count }));
  const hits = lexiconHits(textRecords);
  const insights = {
    nightOwlRatio, lateNightRatio, nightOwlRecords,
    emojiRatio, roomEmojiRatio, emojiRecords, roomEmojiRecords,
    uniqueMessageRatio, repeaterIndex, avgMessageLength,
    maxRepeatedText: maxRepeated ? (redact ? '（已隐藏）' : asText(maxRepeated.example, 24)) : '',
    maxRepeatedCount: maxRepeated ? maxRepeated.count : 0,
    topRepeated: repeatedPhrases.slice(0, 5),
    highFreqWords, wordCloud,
    tokenizerNote: words.length
      ? '词云与高频词由扩展在本机做轻量中文分词统计，不是站点服务端分词结果，也不做语义或情绪判断。'
      : '没有可用的分词数据',
    lexicon: LEXICON.map(({ key, label, words: list }) => ({ key, label, count: hits[key], size: list.length }))
  };

  /* --- 支持方式 --- */
  const payByType = (types) => paid.filter((r) => types.includes(r.type));
  const breakdown = [
    { label: '付费礼物', types: [1] }, { label: '醒目留言', types: [3] },
    { label: '大航海', types: [2] }, { label: '其他付费', types: [-1, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0] }
  ].map((g) => {
    const rows = payByType(g.types);
    return { label: g.label, amount: round(sum(rows, (r) => r.price), 2), count: rows.length };
  }).filter((g) => g.count > 0);
  const paidByChannel = new Map();
  paid.forEach((r) => paidByChannel.set(r.session.channelUid,
    (paidByChannel.get(r.session.channelUid) || 0) + (Number(r.price) || 0)));
  const topPaid = [...paidByChannel.entries()].sort((a, b) => b[1] - a[1])[0];
  const topPaidChannel = topPaid
    ? { name: (channelMap.get(topPaid[0]) || {}).channelName || '未标注', amount: round(topPaid[1], 2) }
    : null;
  // 单笔最高清单（对齐官方「单笔最高」列表；脱敏时仅保留金额与时间）
  const topPayments = [...paid]
    .sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0))
    .slice(0, 8)
    .map((r) => ({
      day: r.day, hour: r.hour, channel: r.session.channelName,
      typeLabel: r.typeLabel, amount: round(r.price, 2),
      text: redact ? '' : asText(r.text || r.name, 60)
    }));
  const support = {
    totalPayment, paidLives: summary.paidLives, paidChannels,
    maxSinglePayment: round(maxSinglePayment, 2),
    topPaidChannel, breakdown, topPayments,
    otherInteractions: interactive.filter((r) => !r.isPaid).length,
    paidRecords: paid.length,
    note: '打米金额来自记录 payload.price，单位为元；只统计已取回且清洗后的样本。'
  };

  /* --- 五维分类（本机可复核规则） --- */
  const insufficient = interactive.length < 10 || textRecords.length < 5;
  const hitShare = (k) => pct(hits[k], textRecords.length);

  const activityRhythm = makeDimension(DIMENSIONS[3], periodCounts, [
    { label: '深夜至清晨（00–06）', value: `${periodCounts.late_night} 次 · ${(lateNightRatio * 100).toFixed(0)}%` },
    { label: '上午及下午（06–18）', value: `${periodCounts.daytime} 次` },
    { label: '黄金档晚间（18–24）', value: `${periodCounts.evening} 次` },
    { label: '常互动时段', value: rhythmPeak.label }
  ], insufficient);

  const crossRoomScores = {
    single_oshi: Math.max(0, (top1Share - 0.6) * 2) + (distinctChannels <= 1 ? 0.5 : 0),
    circle_family: (distinctChannels <= 4 && areas.length <= 2 ? 0.7 : 0.2) + top3Share * 0.3,
    topic_roamer: (areas.length >= 3 ? 0.5 : 0.1) + (1 - top3Share) * 0.5,
    wide_dd: (distinctChannels >= 8 ? 0.8 : distinctChannels >= 5 ? 0.4 : 0) + (1 - hhi) * 0.4
  };
  const crossRoom = makeDimension(DIMENSIONS[2], crossRoomScores, [
    { label: '涉及主播', value: `${distinctChannels} 个` },
    { label: '跨分区数', value: `${areas.length} 个` },
    { label: 'Top1 / Top3 记录占比', value: `${(top1Share * 100).toFixed(0)}% / ${(top3Share * 100).toFixed(0)}%` },
    { label: '频道集中度 HHI', value: String(hhi) }
  ], insufficient || distinctChannels === 0);

  const supportScores = {
    super_chat: support.breakdown.find((b) => b.label === '醒目留言')?.amount || 0,
    guard: support.breakdown.find((b) => b.label === '大航海')?.amount || 0,
    gift: support.breakdown.find((b) => b.label === '付费礼物')?.amount || 0,
    companionship: totalPayment > 0 ? 0 : Math.max(1, textRecords.length * 0.1)
  };
  const supportStyle = makeDimension(DIMENSIONS[4], supportScores, [
    { label: '打米总额', value: `${totalPayment} 元` },
    { label: '打米场次 / 主播', value: `${support.paidLives} 场 / ${paidChannels} 个` },
    { label: '单笔最高', value: `${support.maxSinglePayment} 元` },
    { label: '纯互动（未付费）', value: `${support.otherInteractions} 次` }
  ], insufficient || (totalPayment <= 0 && textRecords.length < 5));

  const styleScores = {
    warm_wholesome: hitShare('warm') * 1.2 + 0.02,
    chill_companion: hitShare('greeting') * 1.1 + 0.02,
    humorous_meme: hitShare('meme') * 0.9 + 0.02,
    rational_chat: hitShare('rational') * 1.0 + 0.02,
    sharp_critic: hitShare('critical') * 0.8 + 0.01,
    troll_fun: hitShare('critical') * 0.6 + hitShare('meme') * 0.4 + 0.01,
    sarcastic_edgy: hitShare('critical') * 0.5 + 0.005,
    repeater_meme: (1 - uniqueMessageRatio) * 0.8 + Math.min(1, emojiRatio) * 0.6 + 0.02
  };
  const style = makeDimension(DIMENSIONS[1], styleScores, [
    { label: '复读指数', value: `${repeaterIndex}x` },
    { label: '不重复弹幕', value: `${(uniqueMessageRatio * 100).toFixed(0)}%` },
    { label: '表情弹幕 / 房间表情', value: `${(emojiRatio * 100).toFixed(0)}% / ${roomEmojiRecords} 条` },
    { label: '平均长度', value: `${avgMessageLength} 字` },
    { label: '关键词命中', value: insights.lexicon.map((l) => `${l.label} ${l.count}`).join(' · ') }
  ], insufficient);

  const archetypeScores = {
    devoted_support: styleScores.warm_wholesome * 1.2 + (totalPayment > 0 ? 0.25 : 0),
    warm_wholesome: styleScores.warm_wholesome,
    chill_companion: styleScores.chill_companion,
    humorous_meme: styleScores.humorous_meme,
    repeater_meme: styleScores.repeater_meme,
    rational_chat: styleScores.rational_chat,
    troll_fun: styleScores.troll_fun,
    sharp_critic: styleScores.sharp_critic,
    sarcastic_edgy: styleScores.sarcastic_edgy
  };
  const archetype = makeDimension(DIMENSIONS[0], archetypeScores, [
    { label: '有效互动 / 弹幕', value: `${interactive.length} 次 / ${textRecords.length} 条` },
    { label: '活跃天数 / 最长连续', value: `${activeDays} 天 / ${longest} 天` },
    { label: '最常说', value: maxRepeated ? `${redact ? '（已隐藏）' : asText(maxRepeated.example, 12)} ×${maxRepeated.count}` : '暂无' },
    { label: '打米总额', value: `${totalPayment} 元` }
  ], insufficient);

  const personalityProfile = { archetype, style, crossRoom, activityRhythm, supportStyle };

  /* --- 原始记录样本 --- */
  const samples = allRecords.slice(0, 20).map((r) => ({
    ts: r.ts, day: r.day, hour: r.hour,
    type: r.type, typeLabel: r.typeLabel,
    channel: r.session.channelName, area: r.session.area,
    liveTitle: r.session.liveTitle,
    message: redact ? '' : asText(r.text || r.name, 120),
    price: r.price
  }));

  const earliestTs = allRecords.length ? Math.min(...allRecords.map((r) => r.ts)) : 0;
  const latestTs = allRecords.length ? Math.max(...allRecords.map((r) => r.ts)) : 0;
  const coverage = {
    sessionTotal: Number(options.total) || 0,
    sessionFetched: sessions.length,
    pagesFetched: Number(options.pagesFetched) || 0,
    hasMore: !!options.hasMore,
    earliestTs, latestTs,
    timeRange: { start: String(options.start || ''), end: String(options.end || ''), filtered: !!(options.start || options.end) },
    hideOnlyEnter: options.hideOnlyEnter !== false,
    redacted: redact,
    scopeNote: '服务端 /history 实测忽略 start/end 参数；日期范围由本工具在本地按清洗后的记录时间戳筛选，且只覆盖已取回的前 N 页场次。'
  };

  // v1.5.4：刷屏 / 独轮车判定。单账号历史看不到同场他人，因此这里只可能得出 solo 结论；
  // 跨用户协同由评论区多用户样本走同一函数（context: 'comment'）。
  const spam = analyzeSpamBursts(
    textRecords.map((r) => ({ ts: r.ts, text: r.text, uid: 'self', name: r.name })),
    { redact, context: 'live', config: options.spamConfig }
  );
  /* v1.5.4：独轮车是「针对某个主播」的行为，把多个主播的弹幕合并会稀释浓度、也会掩盖
   * 「只在 A 直播间刷、在 B 直播间正常」的情况，所以按主播各判一次，结论挂到对应主播上。 */
  const spamCfg = { ...SPAM_RULES, ...(options.spamConfig || {}) };
  const channelGroups = new Map();
  textRecords.forEach((r) => {
    const key = String((r.session && r.session.channelUid) || '');
    if (!channelGroups.has(key)) {
      channelGroups.set(key, {
        channelUid: key,
        channelName: (r.session && r.session.channelName) || '未标注',
        list: []
      });
    }
    channelGroups.get(key).list.push({ ts: r.ts, text: r.text, uid: 'self', name: r.name });
  });
  const channelSpam = [...channelGroups.values()]
    .filter((g) => g.list.length >= spamCfg.minMessages)
    .map((g) => {
      const res = analyzeSpamBursts(g.list, { redact, context: 'live', config: options.spamConfig });
      const b = res.best || {};
      return {
        channelUid: g.channelUid,
        channelName: g.channelName,
        textMessages: g.list.length,
        ok: res.ok,
        level: res.level,
        levelLabel: res.levelLabel,
        behaviour: res.behaviour,
        behaviourLabel: res.behaviourLabel,
        intent: res.intent,
        intentLabel: res.intentLabel,
        repeats: b.repeats || 0,
        windowMessages: b.messages || 0,
        share: b.share || 0,
        medianGapMs: b.medianGapMs === undefined ? null : b.medianGapMs,
        burstCount: b.burstCount || 0,
        caps: b.caps || []
      };
    })
    .sort((a, b) => (SPAM_LEVEL_ORDER[b.level] - SPAM_LEVEL_ORDER[a.level]) || (b.repeats - a.repeats));
  spam.channels = channelSpam;
  spam.channelJudged = channelSpam.length;
  spam.channelTotal = channelGroups.size;
  /* 被攻击的主播：用于把「最喜爱主播」里的候选剔掉（见 buildPortraitSummary），
   * 只做候选过滤，不改任何统计口径（频道分布 / 亲密度 / Top 占比都不动）。 */
  spam.attackTargets = collectAttackTargets(channelSpam, options.spamConfig);

  const portrait = {
    dataBasis: 'cleaned',
    sourceSite: 'Danmakus /api/v3/users/{uid}/history',
    computedAt: new Date().toISOString(),
    coverage,
    summary, leaveTrace, eventTypes,
    hourBuckets, weekdayBuckets, monthBuckets,
    activityDays, rhythmMatrix, rhythmPeak,
    periodCounts, activeDates: activityDays.map((d) => ({ key: d.date, count: d.interactions })),
    longestStreak: longest,
    areas, channelAffinities, channelConcentration,
    channelTagCounts, agencyCounts, fansScale, liveScale,
    insights, repeatedPhrases, support,
    personalityProfile, dimensions: [archetype, style, crossRoom, activityRhythm, supportStyle],
    spam,
    classNotes: CLASS_NOTES, classLabels: CLASS_LABELS,
    samples,
    topChannels: channelAffinities.slice(0, 10),
    areaCounts: areas.slice(0, 8).map((a) => ({ key: a.name, count: a.count })),
    classificationNote: '五维分类的展示名称为 Danmakus /analyze 页面的公开展示文案，因无接口可按 UID 取回而作为静态常量内嵌（CLASS_LABELS）；各分组的概率与最终选择由本工具在本机按可复核统计规则计算，不是该站服务端的模型输出，不构成身份认定、性格判断或行为定性。',
    channelMetaNote: '主播标签、粉丝量级、机构与直播规模均取自记录中附带的主播与场次字段，描述的是该用户出现过的主播与直播间，不是该用户自身的属性；不能用来推断用户身份、消费能力或立场。'
  };

  /* --- v1.2 兼容字段：全部由清洗后的数据重算，保证旧调用方也只消费清洗结果 --- */  portrait.legacy = {
    sessionTotal: coverage.sessionTotal,
    sessionFetched: coverage.sessionFetched,
    pagesFetched: coverage.pagesFetched,
    hasMore: coverage.hasMore,
    recordCount: summary.totalTraces,
    textCount: summary.totalMessages,
    hourBuckets, weekdayBuckets, monthBuckets,
    activeDates: portrait.activeDates,
    activeDays,
    longestStreak: longest,
    eventTypes: eventTypes.map((e) => ({ type: e.type, label: e.label, count: e.count })),
    topChannels: channelAffinities.slice(0, 10).map((c) => ({
      uid: c.channelUid, name: c.channelName, fans: c.fans, tags: c.tags,
      sessions: c.sessions, records: c.records
    })),
    areaCounts: portrait.areaCounts,
    repeatedPhrases: repeatedPhrases.map((p) => ({ key: p.key, count: p.count, example: p.example, firstTs: p.firstTs })),
    channelTagCounts, agencyCounts, fansScaleBuckets: fansScale,
    liveScale,
    distinctChannels,
    channelMetaNote: portrait.channelMetaNote,
    samples,
    earliestTs, latestTs,
    timeRange: coverage.timeRange,
    hideOnlyEnter: coverage.hideOnlyEnter,
    redacted: redact,
    scopeNote: coverage.scopeNote
  };

  // v1.4.0 一屏总结卡：供弹窗首卡与静态网页报告复用
  portrait.summaryCard = buildPortraitSummary(portrait);

  return portrait;
}

/* ------------------------------ 画像总结卡（v1.4.0） ------------------------------ */

/**
 * 从清洗后画像提炼一屏可读的多维总结：综合评价一句话 + 兴趣爱好 / 最喜爱主播 /
 * 评论风格 / 活跃节律 / 支持方式 / 跨房倾向。纯统计描述，不引入新的推断模型；
 * 字段缺失回退为「—」，不推断为 0；脱敏开启时高频词与最常说已被上游替换为占位符。
 */
export function buildPortraitSummary(P) {
  if (!P || P.dataBasis !== 'cleaned') return null;
  const S = P.summary || {}, I = P.insights || {}, SUP = P.support || {},
    CC = P.channelConcentration || {}, dims = P.personalityProfile || {};
  const labelOf = (d) => (d && d.label) ? d.label : '样本不足';
  const fmt = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('zh-CN');
  const pctText = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

  /* 最喜爱主播 = 亲密度最高的**非攻击目标**主播。
   * 若某主播已被判定为「在该直播间被刷屏攻击」（spam.attackTargets，含刷屏式引战与填充），
   * 它就退出候选——否则总结卡会同时出现「在 X 直播间刷屏攻击」和「最喜爱主播 X」。
   * 只过滤候选，不改动频道分布 / 亲密度 / Top 占比 / HHI 等任何统计口径。 */
  const attackTargets = (P.spam && P.spam.attackTargets) || [];
  const targetIds = new Set(attackTargets.map((t) => String(t.channelUid)));
  const affinityAll = (P.channelAffinities && P.channelAffinities.length)
    ? P.channelAffinities
    : (P.topChannels || []);
  const favPool = affinityAll.filter((c) => !targetIds.has(String(c.channelUid)));
  const excludedFav = affinityAll.filter((c) => targetIds.has(String(c.channelUid)));
  const topChannel = favPool[0] || null;
  const excludedNames = excludedFav.map((c) => c.channelName || '未标注');
  const excludedNote = excludedNames.length
    ? `已排除被判定为刷屏攻击的「${excludedNames.join('、')}」`
    : '';
  const excludedField = excludedFav.map((c) => ({
    channelUid: String(c.channelUid || ''), channelName: c.channelName || '未标注'
  }));
  // 占比要按「选中的这个主播」算：默认是 Top1 时等于 CC.top1Share，发生剔除后必须换成被选中主播自己的占比
  const affinityTotal = affinityAll.reduce((a, c) => a + (Number(c.records) || 0), 0);
  const shareOf = (c) => (affinityTotal ? (Number(c.records) || 0) / affinityTotal : 0);
  const favorite = topChannel ? {
    name: topChannel.channelName || '未标注',
    loyaltyScore: topChannel.loyaltyScore,
    recordShare: shareOf(topChannel),
    top1Share: CC.top1Share,
    excluded: excludedField,
    text: `${topChannel.channelName || '未标注'} · 亲密度 ${fmt(topChannel.loyaltyScore)} · 留痕 ${fmt(topChannel.records)} 条 / ${fmt(topChannel.sessions)} 场 · 记录占比 ${pctText(shareOf(topChannel))}${excludedNote ? ' · ' + excludedNote : ''}`
  } : (attackTargets.length
    ? {
      name: '—', loyaltyScore: null, recordShare: null, top1Share: null, excluded: excludedField,
      text: `候选主播均被判定为刷屏攻击（${attackTargets.map((t) => t.channelName).join('、')}），已全部排除；详见「恶意刷屏判定」`
    }
    : { name: '—', loyaltyScore: null, recordShare: null, top1Share: null, excluded: [], text: '样本中无可识别的主播频道' });

  const areaNames = (P.areaCounts || []).slice(0, 3).map((a) => a.key).filter(Boolean);
  const hotWords = (I.highFreqWords || []).filter((w) => w.text && w.text !== '（已隐藏）')
    .slice(0, 5).map((w) => w.text);
  const hotLexicon = (I.lexicon || []).filter((l) => l.count > 0)
    .sort((a, b) => b.count - a.count).slice(0, 3).map((l) => `${l.label}×${l.count}`);
  const interests = {
    text: [
      areaNames.length ? `常驻分区：${areaNames.join(' / ')}` : '常驻分区：—',
      hotWords.length ? `常提词汇：${hotWords.join('、')}` : null,
      hotLexicon.length ? `语言倾向：${hotLexicon.join(' · ')}` : null
    ].filter(Boolean).join('；') || '—'
  };

  const styleBits = [
    `复读指数 ${I.repeaterIndex ?? '—'}x`,
    `不重复弹幕 ${pctText(I.uniqueMessageRatio)}`,
    `平均 ${I.avgMessageLength ?? '—'} 字`,
    `表情弹幕 ${pctText(I.emojiRatio)}`
  ];
  if (I.maxRepeatedText) styleBits.push(`最常说「${I.maxRepeatedText}」×${I.maxRepeatedCount}`);
  const commentStyle = { label: labelOf(dims.style), text: `${labelOf(dims.style)}；${styleBits.join(' · ')}` };

  const rhythm = {
    label: labelOf(dims.activityRhythm),
    text: `${labelOf(dims.activityRhythm)}${P.rhythmPeak && P.rhythmPeak.value ? `，峰值 ${P.rhythmPeak.label}` : ''}；活跃 ${fmt(S.activeDays)} 天 / 最长连续 ${fmt(S.longestStreak)} 天`
  };

  const supportBits = [`打米 ${fmt(SUP.totalPayment ?? S.totalPayment ?? 0)} 元 / ${fmt(SUP.paidLives ?? S.paidLives ?? 0)} 场`];
  if (SUP.topPaidChannel && SUP.topPaidChannel.name) supportBits.push(`最多打给「${SUP.topPaidChannel.name}」${fmt(SUP.topPaidChannel.amount)} 元`);
  const support = { label: labelOf(dims.supportStyle), text: `${labelOf(dims.supportStyle)}；${supportBits.join(' · ')}` };

  const crossRoom = {
    label: labelOf(dims.crossRoom),
    text: `${labelOf(dims.crossRoom)}；互动口径涉及主播 ${fmt(CC.interactiveChannels ?? CC.distinctChannels)} 个 / 分区 ${fmt(CC.interactiveAreas ?? CC.spanAreas)} 个`
  };

  const headlineBits = [labelOf(dims.archetype)];
  if (favorite.name !== '—') headlineBits.push(`最喜爱「${favorite.name}」`);
  if (areaNames.length) headlineBits.push(`主驻${areaNames[0]}分区`);
  const headline = `${headlineBits.join('，')}。基于 ${fmt(S.activeDays)} 天 / ${fmt(S.totalTraces)} 条留痕的清洗后样本。`;

  // v1.5.4：把「独轮车 / 刷屏」结论放进总结卡（最高优先级结果之一）；
  // 结论要能回答「在谁的直播间」，所以优先引用最严重的那个主播的判定。
  const SP = P.spam || null;
  const worst = ((SP && SP.channels) || []).find((c) => c.level !== 'none') || null;
  const spam = (SP && SP.ok)
    ? {
      level: worst && SPAM_LEVEL_ORDER[worst.level] > SPAM_LEVEL_ORDER[SP.level] ? worst.level : SP.level,
      label: worst && SPAM_LEVEL_ORDER[worst.level] > SPAM_LEVEL_ORDER[SP.level] ? worst.levelLabel : SP.levelLabel,
      behaviour: SP.behaviour,
      intent: SP.intent,
      channel: worst ? worst.channelName : '',
      text: SP.level === 'none' && !worst
        ? `未发现按主播分组的密集重复窗口（已判定 ${fmt((SP && SP.channelJudged) || 0)} 个主播）`
        : [
          worst ? `集中在「${worst.channelName}」直播间` : '',
          worst ? worst.behaviourLabel : SP.behaviourLabel,
          worst
            ? `${(worst.windowMessages || 0)} 条窗口内同簇 ${worst.repeats} 条（${Math.round((worst.share || 0) * 100)}%）`
            : (SP.best ? `${SP.best.windowMs / 1000}s 内 ${SP.best.messages} 条、同簇 ${SP.best.repeats} 条（${Math.round(SP.best.share * 100)}%）` : ''),
          worst && worst.medianGapMs !== null ? `间隔中位数 ${(worst.medianGapMs / 1000).toFixed(1)}s` : '',
          (worst ? worst.intent : SP.intent) !== 'none' ? `内容：${worst ? worst.intentLabel : SP.intentLabel}` : ''
        ].filter(Boolean).join(' · ')
    }
    : { level: 'none', label: '样本不足', behaviour: 'none', intent: 'none', channel: '', text: (SP && SP.note) || '文本样本不足，未做刷屏判定' };

  return {
    generatedAt: P.computedAt,
    headline,
    spam,
    coverageLine: `有留痕 ${fmt(S.appearanceLives)} 场 · 有互动 ${fmt(S.interactiveLives)} 场 · 弹幕 ${fmt(S.totalMessages)} 条（不重复 ${fmt(S.uniqueMessages)}）`,
    favorite, interests, commentStyle, rhythm, support, crossRoom,
    caveat: '以上为清洗后样本的统计描述，不构成身份认定、性格判断或行为定性；分类标签为静态常量，概率由本机规则计算。'
  };
}
