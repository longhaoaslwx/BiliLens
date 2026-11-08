/* 统一数据清洗层（v1.3.0）。
 *
 * 设计约束：
 *   1. 所有第三方原始数据在进入聚合 / 可视化之前，必须先经过本模块；
 *      下游只消费 cleaning 产出的规范化行，不再直接遍历站点原始响应。
 *   2. 四道工序固定顺序：字段规范化 → 缺失值处理 → 异常值处理 → 去重。
 *      每一道工序都计数并写入「清洗报告」，可逐项复核，不做隐式丢弃。
 *   3. 缺失 ≠ 0。数值缺失一律记为 null 并在汇总时排除；文本缺失记为空串，
 *      只在确实需要文本的指标里不计入分母，绝不把「取不到」写成 0。
 *   4. 异常值不做统计意义上的「修正」，只做「剔除 / 截断 + 标记」，
 *      并在报告里同时保留原始值与处理后值的计数。
 *   5. 去重保留信息最完整的一条，并把被合并行的次数记在 duplicateCount 上，
 *      保证「去重前后可回溯」，而不是静默消失。
 *
 * 实测依据（.research/，2026-11-08）：
 *   channel.json        102 行 / 43 个唯一 uId / 59 行完全重复（同一主播快照按场次重复）
 *   hist_p1+p2.json     100 场 / 512 条记录 / 6 条完全相同的合并场次礼物记录
 *                       117 条记录无 payload（type=4 入场）、176 条无 rawText
 *                       payload 字段：count / name / price / rawText / roomEmojiId / text
 */
/** 实测事件类型枚举（保留数字，站点改版时可追溯）。放在清洗层，供聚合层复用。 */
/** Danmakus 对「无机构个人势」的固定枚举值（实测 agencyUuid='independent'，非真实机构 UUID）。 */
export const INDEPENDENT_AGENCY = 'independent';
export const AGENCY_INDEPENDENT_LABEL = '个人势';
export const AGENCY_UNLABELED = '未标注';

/** 机构展示名：independent → 个人势；命中解析表 → 机构名；解析失败保留原始 UUID 便于追溯。 */
export function agencyLabel(agencyUuid, names = {}) {
  const raw = asText(agencyUuid, 40);
  if (!raw) return AGENCY_UNLABELED;
  if (raw === INDEPENDENT_AGENCY) return AGENCY_INDEPENDENT_LABEL;
  return names[raw] || raw;
}

export const DM_TYPES = {
  0: '弹幕', 1: '礼物', 2: '大航海', 3: '醒目留言', 4: '入场',
  5: '标题变更', 6: '分区变更', 7: '直播暂停', 8: '直播继续',
  9: '禁言', 10: '警告', 11: '录制开始', 12: '录制中断', 13: '主播'
};

/** 供本模块使用的站点名（不反向依赖聚合层）。 */

/* ------------------------------ 规则与边界 ------------------------------ */

export const CLEAN_STAGES = [
  { id: 'normalize', label: '字段规范化', detail: '统一 v2/v3 结构、ID 类型、时间戳单位、文本全半角与数组字段' },
  { id: 'missing', label: '缺失值处理', detail: '缺失数值记为 null 并排除出汇总；缺失文本记为空串；不把缺失推断为 0' },
  { id: 'anomaly', label: '异常值处理', detail: '越界时间戳剔除、负数与非有限数截断、超长文本截断，全部计数留痕' },
  { id: 'dedupe', label: '数据去重', detail: '关注主播按 uId、场次按 liveId、记录按内容签名去重；保留 duplicateCount' }
];

// B 站直播弹幕收录不可能早于 2015 年；允许 30 天时钟偏差以容纳站点时间偏移
const TS_MIN = Date.parse('2015-01-01T00:00:00Z');
const TS_FUTURE_SLACK = 30 * 86400_000;
const MAX_TEXT_LEN = 500;
const MAX_PRICE = 1_000_000;
const MAX_COUNT = 100_000;
const MAX_METRIC = 1e12;
const MAX_EVENT_TYPE = 13;

/* ------------------------------ 通用规范化 ------------------------------ */

export const asText = (value, maxLen = MAX_TEXT_LEN) => {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r?\n/g, ' ').trim().slice(0, maxLen);
};

/** 兼容数字 / 数字字符串；非有限值返回 fallback，绝不返回 NaN。 */
export const asNumber = (value, fallback = null) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** 规范化非负整数指标：缺失返回 null（不是 0），越界截断并回报是否发生截断。 */
export function asMetric(value, cap = MAX_METRIC) {
  const n = asNumber(value, null);
  if (n === null) return { value: null, clamped: false, missing: true };
  if (!Number.isFinite(n) || n < 0) return { value: 0, clamped: n < 0, missing: false };
  if (n > cap) return { value: cap, clamped: true, missing: false };
  return { value: n, clamped: false, missing: false };
}

export const asId = (value) => {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return (s === '0' || s === 'null' || s === 'undefined') ? '' : s;
};

export const asTags = (value) => {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? value.split(/[,，/、|]/) : []);
  return [...new Set(list.map((t) => asText(t, 30)).filter(Boolean))];
};

/** 时间戳统一为毫秒；秒级输入自动放大 1000 倍。 */
export function asTimestamp(value) {
  const n = asNumber(value, null);
  if (n === null || n <= 0) return { value: null, scaled: false };
  const ms = n < 1e11 ? Math.round(n * 1000) : Math.round(n);
  return { value: ms, scaled: n < 1e11 };
}

/** UTC+8 自然日 / 小时 / 星期（0=周一）。 */
export function dateParts(ts) {
  const shifted = new Date(ts + 8 * 3600 * 1000);
  return {
    day: shifted.toISOString().slice(0, 10),
    month: shifted.toISOString().slice(0, 7),
    hour: shifted.getUTCHours(),
    weekday: (shifted.getUTCDay() + 6) % 7
  };
}

export const dayStart = (value, isEnd) => {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return isEnd ? Infinity : 0;
  const base = Date.parse(s + 'T00:00:00+08:00');
  return Number.isFinite(base) ? (isEnd ? base + 86400000 - 1 : base) : (isEnd ? Infinity : 0);
};

/** 只用于识别「同一账号是否反复发送同一句」，不做语义或倾向判断。 */
export function normalizePhrase(text) {
  return String(text || '')
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\[[^\]]{1,12}\]/g, '')
    .replace(/\s+/g, '')
    .replace(/\d+/g, '#')
    .toLowerCase()
    .slice(0, 80);
}

/* ------------------------------ 清洗报告 ------------------------------ */

export function newSourceReport(sourceId, label, inputRows) {
  return {
    sourceId, label,
    inputRows, outputRows: 0,
    counts: {
      fieldsNormalized: 0, missingHandled: 0,
      anomaliesRemoved: 0, anomaliesClamped: 0, duplicatesRemoved: 0
    },
    details: { normalize: {}, missing: {}, anomaly: {}, dedupe: {} },
    notes: []
  };
}

function bump(report, bucket, key, n = 1) {
  if (!n) return;
  report.details[bucket][key] = (report.details[bucket][key] || 0) + n;
  if (bucket === 'normalize') report.counts.fieldsNormalized += n;
  else if (bucket === 'missing') report.counts.missingHandled += n;
  else if (bucket === 'anomaly') report.counts.anomaliesClamped += n;
  else if (bucket === 'dedupe') report.counts.duplicatesRemoved += n;
}

function remove(report, key, n = 1) {
  bump(report, 'anomaly', key, n);
  report.counts.anomaliesClamped -= n;
  report.counts.anomaliesRemoved += n;
}

function finish(report, outputRows) {
  report.outputRows = outputRows;
  return report;
}

/** 把逐数据源报告合并为整份报告的顶层结构。 */
export function mergeCleanReports(parts) {
  const sources = (parts || []).filter(Boolean).map((p) => JSON.parse(JSON.stringify(p)));
  const totals = {
    inputRows: 0, outputRows: 0, duplicatesRemoved: 0,
    missingHandled: 0, anomaliesRemoved: 0, anomaliesClamped: 0, fieldsNormalized: 0
  };
  sources.forEach((s) => {
    totals.inputRows += s.inputRows;
    totals.outputRows += s.outputRows;
    Object.keys(totals).forEach((k) => {
      if (k === 'inputRows' || k === 'outputRows') return;
      totals[k] += s.counts[k] || 0;
    });
  });
  return {
    schema: 'bililens-cleaning/1.0',
    generatedAt: new Date().toISOString(),
    stages: CLEAN_STAGES,
    sources,
    totals,
    // 可视化层据此断言：所有图表只允许消费 cleaning 之后的数据
    chartDataBasis: 'cleaned',
    appliedTo: [
      '关注主播标签 / 关注主播表', '粉丝趋势', '评论月份 / 小时分布',
      '站点状态矩阵', '弹幕行为完整聚合画像', '所有图表与分类卡'
    ],
    disclaimer: '清洗只做结构化纠错与去重，不补全、不推断、不修改原始事实；被剔除或截断的条目均在上方逐项计数，完整原始逐站结果仍保留在导出的 JSON 证据链中。'
  };
}

/* ------------------------------ 关注主播列表 ------------------------------ */

/**
 * Danmakus /api/search/user/channel：实测同一主播快照会按场次重复出现，
 * 必须按 uId 去重，否则 channelCount / totalDanmaku / 标签分布全部被放大。
 */
export function cleanChannels(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const report = newSourceReport('danmakus:channel', 'Danmakus 关注主播列表', list.length);
  const normalized = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { remove(report, '非对象行'); continue; }
    const name = asText(raw.name ?? raw.uName, 60) || '未标注';
    const rawId = asId(raw.uId ?? raw.uid ?? raw.mid);
    // 缺少 uId 时不丢弃数据，退化为按名称去重，并在报告中显式记录
    const uId = rawId || `name:${name}`;
    if (!rawId) bump(report, 'missing', '缺少 uId → 退化为按名称去重');
    else if (typeof raw.uId !== 'string') bump(report, 'normalize', 'uId 统一为字符串');
    if (!asText(raw.name ?? raw.uName)) bump(report, 'missing', '主播名为空 → 未标注');
    const tags = asTags(raw.tags);
    if (!Array.isArray(raw.tags) || !raw.tags.length) bump(report, 'missing', '标签列表为空');

    const metrics = {};
    for (const [key, cap] of [
      ['totalDanmakuCount', MAX_METRIC], ['totalLiveCount', MAX_METRIC],
      ['totalIncome', MAX_METRIC], ['totalLiveSecond', MAX_METRIC]
    ]) {
      const m = asMetric(raw[key], cap);
      metrics[key] = m.value;
      if (m.missing) bump(report, 'missing', `${key} 缺失 → null（不计入汇总）`);
      else if (m.clamped) bump(report, 'anomaly', `${key} 为负或越界 → 截断`);
    }
    const roomId = asId(raw.roomId);
    const lastLive = asTimestamp(raw.lastLiveDate);
    const lastLiveDate = lastLive.value;
    if (raw.lastLiveDate !== null && raw.lastLiveDate !== undefined && lastLiveDate === null)
      bump(report, 'missing', 'lastLiveDate 无效 → null');
    if (lastLive.scaled) bump(report, 'normalize', 'lastLiveDate 秒 → 毫秒');

    normalized.push({
      uId, name, roomId, tags,
      danmaku: metrics.totalDanmakuCount,
      liveCount: metrics.totalLiveCount,
      income: metrics.totalIncome,
      liveSecond: metrics.totalLiveSecond,
      lastLiveDate: lastLiveDate && lastLiveDate >= TS_MIN ? lastLiveDate : null,
      isLiving: raw.isLiving === true,
      duplicateCount: 1
    });
  }

  // 去重：同 uId 保留信息最完整的一条，标签取并集，累计被合并次数
  const byId = new Map();
  for (const row of normalized) {
    const prev = byId.get(row.uId);
    if (!prev) { byId.set(row.uId, row); continue; }
    bump(report, 'dedupe', `uId 重复（${prev.name}）`);
    prev.duplicateCount += 1;
    prev.tags = [...new Set([...prev.tags, ...row.tags])].slice(0, 12);
    const score = (r) => (r.danmaku !== null ? 1 : 0) + (r.liveCount !== null ? 1 : 0) + (r.lastLiveDate ? 1 : 0) + r.tags.length;
    if (score(row) > score(prev)) {
      row.duplicateCount = prev.duplicateCount;
      row.tags = prev.tags;
      byId.set(row.uId, row);
    } else if (row.lastLiveDate && (!prev.lastLiveDate || row.lastLiveDate > prev.lastLiveDate)) {
      prev.lastLiveDate = row.lastLiveDate;
    }
  }
  const rows = [...byId.values()];
  report.notes.push('按 uId 去重后，关注主播数、标签分布与累计弹幕量均基于唯一主播计算。');
  return { rows, report: finish(report, rows.length) };
}

/* ------------------------------ 通用序列清洗 ------------------------------ */

/** ZeroRoku 粉丝趋势：按日期去重、剔除无效粉丝数、非负值截断。 */
export function cleanTrend(points) {
  const list = Array.isArray(points) ? points : [];
  const report = newSourceReport('zeroroku:trend', 'ZeroRoku 粉丝趋势点', list.length);
  const rows = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { remove(report, '非对象趋势点'); continue; }
    const date = asText(raw.date, 10).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { remove(report, '日期格式无效'); continue; }
    const fans = asMetric(raw.fans, MAX_METRIC);
    if (fans.missing) { remove(report, '粉丝数缺失'); continue; }
    if (fans.clamped) bump(report, 'anomaly', '粉丝数为负或越界 → 截断');
    const key = date;
    if (seen.has(key)) { bump(report, 'dedupe', '同一日期重复趋势点'); continue; }
    seen.add(key);
    rows.push({ date, fans: fans.value, rate1: asNumber(raw.rate1, 0) || 0, rate7: asNumber(raw.rate7, 0) || 0 });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, report: finish(report, rows.length) };
}

/** AICU 评论：按 rpid 去重、时间戳规范化、越界剔除、缺失 oid 记空。 */
export function cleanReplies(replies) {
  const list = Array.isArray(replies) ? replies : [];
  const report = newSourceReport('aicu:replies', 'AICU 第三方评论样本', list.length);
  const rows = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { remove(report, '非对象评论'); continue; }
    const rpid = asId(raw.rpid);
    const time = asNumber(raw.time, null);
    if (time === null || time <= 0) { remove(report, '评论时间缺失或无效'); continue; }
    const tsSec = time > 1e11 ? Math.round(time / 1000) : Math.round(time);
    if (tsSec * 1000 < TS_MIN || tsSec * 1000 > Date.now() + TS_FUTURE_SLACK) {
      remove(report, '评论时间越界'); continue;
    }
    if (time > 1e11) bump(report, 'normalize', '评论时间毫秒 → 秒');
    const key = rpid || `${tsSec}:${asText(raw.message, 40)}`;
    if (seen.has(key)) { bump(report, 'dedupe', '重复评论（rpid 或内容+时间）'); continue; }
    seen.add(key);
    const oid = asId((raw.dyn || {}).oid);
    if (!oid) bump(report, 'missing', '动态 oid 缺失 → 空');
    const message = asText(raw.message, 200);
    if (!message) bump(report, 'missing', '评论正文为空');
    rows.push({ rpid, time: tsSec, oid, message });
  }
  return { rows, report: finish(report, rows.length) };
}

/** VTBs 舰团：按 mid 去重、等级负数截断。 */
export function cleanGuards(guards, sourceKey = 'vtbs:guards', sourceLabel = 'vtbs.moe 舰团记录') {
  const list = Array.isArray(guards) ? guards : [];
  const report = newSourceReport(sourceKey, sourceLabel, list.length);
  const rows = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') { remove(report, '非对象记录'); continue; }
    const mid = asId(raw.mid);
    if (!mid) { remove(report, '缺少 mid'); continue; }
    if (seen.has(mid)) { bump(report, 'dedupe', '同一 mid 重复舰团记录'); continue; }
    seen.add(mid);
    const level = asMetric(raw.level, 100000);
    if (level.missing) bump(report, 'missing', '等级缺失 → null');
    else if (level.clamped) bump(report, 'anomaly', '等级为负或越界 → 截断');
    rows.push({ mid, uname: asText(raw.uname, 40), level: level.value });
  }
  return { rows, report: finish(report, rows.length) };
}

/* ------------------------------ 弹幕历史清洗 ------------------------------ */

/** 兼容 v3 data.items[] 与 v2 data.data.records[] 两种场次容器。 */
export function sessionsOf(page) {
  if (!page || typeof page !== 'object') return [];
  const list = Array.isArray(page.items)
    ? page.items
    : (page.data && Array.isArray(page.data.records) ? page.data.records : []);
  return list.filter((item) => item && typeof item === 'object');
}

/** 兼容 v3 danmakus.records[] 与 v2 扁平 danmakus[]。 */
function rawRecordsOf(session) {
  const dm = session.danmakus;
  const list = Array.isArray(dm) ? dm : (dm && Array.isArray(dm.records) ? dm.records : []);
  return list.filter((r) => r && typeof r === 'object');
}

/**
 * 弹幕历史主清洗入口：返回规范化场次 + 清洗报告。
 * 下游（聚合画像、图表、样本）一律只消费这里返回的 sessions。
 */
export function cleanSessions(pages, options = {}) {
  const pageList = Array.isArray(pages) ? pages : [];
  const rawSessions = [];
  pageList.forEach((page) => rawSessions.push(...sessionsOf(page)));
  const report = newSourceReport('danmakus:history', 'Danmakus 弹幕/事件记录', 0);
  const startMs = dayStart(options.start, false);
  const endMs = dayStart(options.end, true);
  const hasDateFilter = !!(options.start || options.end);

  const sessions = [];
  const seenSessions = new Set();
  const seenRecords = new Set();
  let rawRecordCount = 0, keptRecordCount = 0, dateFiltered = 0;

  for (const raw of rawSessions) {
    const channel = (raw.channel && typeof raw.channel === 'object') ? raw.channel : {};
    const live = (raw.live && typeof raw.live === 'object') ? raw.live : {};
    const liveId = asId(live.liveId ?? live.id ?? raw.liveId);
    if (!liveId) { remove(report, '场次缺少 liveId'); continue; }
    if (seenSessions.has(liveId)) { bump(report, 'dedupe', `场次重复（liveId ${liveId.slice(0, 12)}）`); continue; }
    seenSessions.add(liveId);

    const channelUid = asId(channel.uId ?? channel.uid) || `unknown:${liveId.slice(0, 8)}`;
    const channelName = asText(channel.uName ?? channel.name, 40) || '未标注';
    const tags = asTags(channel.tags);
    const fans = asMetric(channel.fansCount, MAX_METRIC);
    if (fans.missing) bump(report, 'missing', '主播粉丝数缺失 → null');
    const agencyUuid = asText(channel.agencyUuid, 40) || '';
    // independent 是站点对「无机构个人势」的固定枚举值，不是真实机构名；
    // 机构 UUID 由聚合层调用 /agencies/{uuid} 解析成名称，这里先保留原值以便追溯
    const agency = agencyUuid === INDEPENDENT_AGENCY ? AGENCY_INDEPENDENT_LABEL
      : (agencyUuid || '未标注');
    const area = asText(live.parentArea || live.area, 30) || '未标注';

    const liveMetrics = {};
    for (const key of ['watchCount', 'maxOnlineCount', 'payCount', 'interactionCount', 'totalIncome']) {
      const m = asMetric(live[key], MAX_METRIC);
      liveMetrics[key] = m.value;
      if (m.missing) bump(report, 'missing', `场次 ${key} 缺失 → null（不计入汇总）`);
      else if (m.clamped) bump(report, 'anomaly', `场次 ${key} 为负或越界 → 截断`);
    }

    const records = [];
    for (const r of rawRecordsOf(raw)) {
      rawRecordCount++;
      // ① 字段规范化：v2 / v3 不同字段名统一
      const payload = (r.payload && typeof r.payload === 'object') ? r.payload : {};
      if (!r.payload && (r.message !== undefined || r.price !== undefined))
        bump(report, 'normalize', 'v2 扁平弹幕字段 → 统一 payload 结构');
      const time = asTimestamp(r.ts ?? r.sendDate);
      if (time.scaled) bump(report, 'normalize', '记录时间秒 → 毫秒');

      // ② 缺失值：payload 整体缺失、文本缺失都按「不适用」处理，不推断为 0
      if (!r.payload || typeof r.payload !== 'object') bump(report, 'missing', 'payload 缺失（入场等事件无内容）');
      const text = asText(payload.rawText ?? payload.text ?? r.message, MAX_TEXT_LEN);
      const name = asText(payload.name, 60);
      if (!text) bump(report, 'missing', '无文本（礼物 / 入场 / 表情等），不计入文本类指标');
      const priceM = payload.price === undefined && payload.price !== 0 && r.price === undefined
        ? { value: null, missing: true, clamped: false }
        : asMetric(payload.price ?? r.price, MAX_PRICE);
      const countM = payload.count === undefined
        ? { value: null, missing: true, clamped: false }
        : asMetric(payload.count, MAX_COUNT);

      // ③ 异常值
      if (time.value === null) { remove(report, '时间戳缺失或非数值'); continue; }
      if (time.value < TS_MIN || time.value > Date.now() + TS_FUTURE_SLACK) {
        remove(report, '时间戳超出合理范围（2015 至今 +30 天）'); continue;
      }
      if (priceM.missing) bump(report, 'missing', '价格缺失 → null');
      else if (priceM.clamped) bump(report, 'anomaly', '价格为负或越界 → 截断');
      if (countM.missing) bump(report, 'missing', '数量缺失 → null');
      else if (countM.clamped) bump(report, 'anomaly', '数量为负或越界 → 截断');
      let type = Number(r.type);
      if (!Number.isFinite(type) || type < 0 || type > MAX_EVENT_TYPE || !Number.isInteger(type)) {
        bump(report, 'anomaly', `未知事件 type=${String(r.type)} → 归入「其他」`);
        type = -1;
      }

      // ④ 本地日期范围筛选（服务端忽略 start/end）
      if (hasDateFilter && (time.value < startMs || time.value > endMs)) { dateFiltered++; continue; }

      const roomEmojiId = payload.roomEmojiId === undefined || payload.roomEmojiId === null
        ? null : asText(payload.roomEmojiId, 20);
      const parts = dateParts(time.value);

      // ⑤ 去重：内容签名相同即视为重复记录（合并场次里同一事件常出现多次）
      const signature = [
        time.value, type, asText(r.payloadKind ?? r.actorId, 20),
        normalizePhrase(text), name, priceM.value, countM.value, roomEmojiId
      ].join('|');
      if (seenRecords.has(signature)) { bump(report, 'dedupe', '完全相同的弹幕/事件记录'); continue; }
      seenRecords.add(signature);

      records.push({
        ts: time.value,
        type,
        typeLabel: DM_TYPES[type] || (type === -1 ? '其他' : `type=${type}`),
        payloadKind: asText(r.payloadKind, 20),
        ...parts,
        text, name,
        price: priceM.value,
        count: countM.value,
        roomEmojiId,
        isText: !!text,
        isEmoji: roomEmojiId !== null,
        isPaid: (priceM.value || 0) > 0,
        isEnter: type === 4
      });
    }

    sessions.push({
      liveId, channelUid, channelName, tags,
      fans: fans.value, agency, agencyUuid, area,
      liveTitle: asText(live.title, 80),
      live: liveMetrics,
      records
    });
    keptRecordCount += records.length;
  }

  report.inputRows = rawRecordCount;
  report.notes.push(
    `取回 ${rawSessions.length} 场、${rawRecordCount} 条原始记录；清洗后 ${sessions.length} 场、${keptRecordCount} 条记录。`,
    hasDateFilter ? `本地日期筛选排除 ${dateFiltered} 条记录（服务端 /history 实测忽略 start/end）。` : '未启用本地日期筛选。',
    '数值字段缺失记为 null 并在汇总时排除，不会被当作 0 计入分母。'
  );
  return {
    sessions, report: finish(report, keptRecordCount),
    rawSessionCount: rawSessions.length, rawRecordCount, dateFiltered,
    startMs, endMs, hasDateFilter
  };
}

/** 只保留清洗后仍有记录的场次，用于「有留痕场次」口径。 */
export function sessionsWithRecords(sessions) {
  return (sessions || []).filter((s) => s.records.length > 0);
}
