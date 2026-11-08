/* 直播间刷屏 / 独轮车判定（v1.5.4）
 *
 * 目标：把「同一时间窗口内大量发送重复或高度相似弹幕」识别为**刷屏/独轮车**，
 * 而不是当成「喜爱主播」。判定只看可复核的统计证据，不做语义定罪。
 *
 * 结论分两层：
 *   行为（behaviour）：solo 单人重复刷屏（独轮车）/ group 多人复读（集体玩梗）/ coordinated 跨用户同步刷屏
 *   内容（intent）：attack 攻击性（辱骂·引战·引流）/ spam 无意义填充 / meme 情绪玩梗（哈哈、6、问号）
 * 单账号的 Danmakus 历史只能判定 solo；group / coordinated 需要「同场多用户」样本（评论区抓取）。
 *
 * 判定要素（阈值集中在 SPAM_RULES，可整体覆盖）：
 *   1) 时间窗口：主窗口 60s（滑动），另设 10s 连发窗口与 30s 协同窗口
 *   2) 重复/相似：归一化（全角→半角、去表情/标点、数字占位 #、折叠 3+ 重复字符）后完全相等 = 1.0；
 *      否则用字符二元组 Dice 系数，短文本（≤24 字）与 LCS 取**平均**（两者都要像，
 *      避免「同模板换一个字」被 LCS 单独判成同一句），≥ 0.82 视为同一簇；
 *      前缀一致时仅在「短句整体是长句前缀」的情况下给 0.85 兜底，覆盖「同一句 + 尾部加语气词」
 *   3) 发送量：窗口内该用户消息数 ≥ 8 且同簇 ≥ 6 且占比 ≥ 0.6 → 疑似；≥ 15 / ≥ 12 / ≥ 0.7 且
 *      （间隔中位数 ≤ 1.5s 或 1s 内连发 ≥ 5 次）→ 高度疑似
 *   4) 用户数：同簇跨 ≥ 3 个用户且单人占比 < 0.5 → 判为多人复读（不是独轮车）；
 *      跨 ≥ 5 个用户、每人 ≥ 2 条、30s 内且内容带攻击/引流特征 → 跨用户协同
 *   5) 边界修正（防误判）：节奏慢（间隔中位数 > 10s）最高只到「观察」；
 *      纯情绪弹幕且总量不大（< 20 条）最高只到「观察」；无文本/单条样本不判定
 *
 * 注意：「重复」本身不是罪证。多人跟风复读同一句梗、粉丝齐刷「生日快乐」都会命中重复，
 * 因此必须同时看**是否单人主导**与**发送速率**，否则一律不下结论。
 */

export const SPAM_RULES = {
  windowMs: 60_000,        // 主判定窗口
  quickWindowMs: 10_000,   // 连发窗口（用于「1s 内连发」以外的密集度参考）
  coordWindowMs: 30_000,   // 跨用户协同窗口
  minMessages: 8,          // 窗口内消息数下限（低于此不判定）
  minRepeats: 6,           // 同簇条数下限
  repeatShare: 0.6,        // 同簇占窗口消息比例下限
  strongMessages: 15,      // 高度疑似：窗口内消息数
  strongRepeats: 12,       // 高度疑似：同簇条数
  strongShare: 0.7,        // 高度疑似：同簇占比
  machineGapMs: 1500,      // 高度疑似：相邻间隔中位数（机器节奏）
  burstGapMs: 1000,        // 「连发」的间隔定义
  burstCount: 5,           // 高度疑似：1s 内连发次数
  slowGapMs: 10_000,       // 慢速上限：间隔中位数超过它，最高只到「观察」
  similarity: 0.82,        // 同一簇的相似度阈值
  groupUsers: 3,           // 多人复读：同簇涉及用户数
  coordUsers: 5,           // 跨用户协同：同簇涉及用户数
  coordPerUser: 2,         // 跨用户协同：每人在窗口内的最少条数
  maxMessagesPerUser: 1500,// 单用户参与判定的样本上限（取最近）
  maxWindowMessages: 80    // 单窗口参与聚类的消息上限（取最近）
};

const LEVEL_ORDER = { none: 0, watch: 1, suspect: 2, high: 3, coordinated: 4 };
/** 等级强弱序号（供分组排序复用，避免各调用方各写一份） */
export const SPAM_LEVEL_ORDER = LEVEL_ORDER;
const LEVEL_LABEL = {
  none: '未见异常',
  watch: '高频重复 · 观察',
  suspect: '疑似独轮车刷屏',
  high: '高度疑似独轮车刷屏',
  coordinated: '疑似跨用户协同刷屏'
};
const BEHAVIOUR_LABEL = {
  none: '无集中刷屏',
  solo: '单人重复刷屏（独轮车）',
  group: '多人复读（集体玩梗）',
  coordinated: '跨用户同步刷屏'
};
const INTENT_LABEL = {
  none: '—',
  attack: '攻击性内容（辱骂 / 引战 / 引流）',
  spam: '无意义填充（刷屏，非喜爱表达）',
  meme: '情绪 / 玩梗弹幕（哈哈、6、问号等）'
};

/* 低信息量弹幕：这些内容重复属正常情绪表达，不能单独当作攻击证据 */
const LOW_INFO = new Set([
  '哈', '哈哈', '哈哈哈', '草', '6', '66', '666', '6666', '？', '??', '?', '？？',
  '+1', '1', '顶', '牛', '好', '啊', '这', 'awsl', '笑死', 'hhh', '233', '2333', '妙', '绝了'
]);

/* 攻击/引战/引流词汇：命中只作为「内容倾向」加权，不单独构成判定 */
const ATTACK_PATTERNS = [
  /(傻逼|傻b|傻子|傻叉|傻狗|sb|脑残|弱智|智障|废物|垃圾人|恶心人|狗东西|贱|滚出|滚蛋|闭嘴|去死|该死|你妈|尼玛|操你|妈的)/i,
  /(举报|封杀|塌房|黑料|锤死|洗地|水军|恰烂钱|割韭菜|带节奏|退网|网暴)/,
  /(加群|加微信|加v|私信我|看主页|代练|代打|刷礼物|返现|兼职|日结|引流|刷单)/i
];

/* ------------------------------ 基础工具 ------------------------------ */

const pct = (a, b) => (b ? a / b : 0);
const round = (v, n = 3) => Number((Number(v) || 0).toFixed(n));

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** 归一化：全角转半角、去表情标记/标点/空白、数字占位、折叠 3+ 连续相同字符。只用于「比较是否同一句」。
 *  数字归一化是为了识别「打卡第 N 天」这类只改数字的模板刷屏；副作用由 lowInfo 判定兜住。 */
export function normalizeForCompare(text) {
  let s = String(text === null || text === undefined ? '' : text);
  try { s = s.normalize('NFKC'); } catch { /* 老运行时忽略 */ }
  s = s.toLowerCase()
    .replace(/\[[^\]]{1,12}\]/g, '')                                    // B 站表情标记 [doge]
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F]/gu, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .replace(/\d+/g, '#')                                               // 数字归一：第1234天 / 第9876天 → 同一句
    .replace(/(.)\1{2,}/gu, '$1$1');                                    // 哈哈哈哈哈哈 → 哈哈
  return s.slice(0, 60);
}

function bigramCounts(s) {
  const map = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    map.set(g, (map.get(g) || 0) + 1);
  }
  return map;
}

function lcsLength(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

/** 相似度 0~1：相等 1；否则二元组 Dice；短文本（≤24 字）与 LCS 取平均，避免「同模板换一个字」
 *  仅靠 LCS 单独越线；前缀高度一致（≥80%）再给 0.85 兜底，覆盖「同一句 + 尾部加语气词」。 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < 2) return 0;
  if (longer.length / shorter.length > 3) return 0;

  const A = bigramCounts(shorter);
  const B = bigramCounts(longer);
  let inter = 0, total = 0;
  for (const [g, n] of A) { total += n; inter += Math.min(n, B.get(g) || 0); }
  for (const [, n] of B) total += n;
  const dice = total ? (2 * inter) / total : 0;

  let best = dice;
  if (shorter.length <= 24) {
    // 必须「二元组与子序列同时像」才算同一簇：单靠 LCS 会把「同模板、换一个词」的
    // 正常弹幕连成一簇（实测 10 条各不相同的弹幕曾因此被误判为重复刷屏）。
    const lcs = (2 * lcsLength(shorter, longer)) / (shorter.length + longer.length);
    best = Math.max(dice, (dice + lcs) / 2);
  }
  let prefix = 0;
  while (prefix < shorter.length && shorter[prefix] === longer[prefix]) prefix++;
  // 只有「短句整体就是长句的前缀」（同一句 + 尾部语气词 / 编号）才兜底；
  // 等长但末字不同（这波操作很强 / 很秀）属不同内容，不能被抬过阈值。
  if (prefix === shorter.length && longer.length / shorter.length <= 2) best = Math.max(best, 0.85);
  return round(best, 3);
}

const isLowInfo = (norm) => {
  if (!norm) return true;
  if (LOW_INFO.has(norm)) return true;
  if (/^[哈草6?？!！~～。.、\d#]+$/.test(norm)) return true;
  // 单字符重复（冲冲 / 贴贴 / 啊啊 / 66）属情绪表达，不构成刷屏证据
  if (norm.length <= 8 && new Set(norm).size === 1) return true;
  return false;
};
const hasAttack = (raw) => ATTACK_PATTERNS.some((re) => re.test(String(raw || '')));

/* ------------------------------ 聚类与窗口打分 ------------------------------ */

/** 在一个窗口内按相似度做并查集聚类，返回最大的同簇消息。 */
function largestCluster(list, threshold) {
  const n = list.length;
  if (!n) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (similarity(list[i].norm, list[j].norm) >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(list[i]);
  }
  let best = [];
  for (const g of groups.values()) if (g.length > best.length) best = g;
  return best;
}

const capLevel = (level, cap) => (LEVEL_ORDER[level] > LEVEL_ORDER[cap] ? cap : level);

/**
 * 给一个窗口打分。slice 已按 ts 升序、只含带文本的消息。
 * 返回 { level, messages, repeats, share, medianGapMs, burstCount, lowInfoShare, attackHits, users, cluster }
 */
export function scoreWindow(slice, config = {}) {
  const cfg = { ...SPAM_RULES, ...config };
  const sample = slice.slice(-cfg.maxWindowMessages);
  const cluster = largestCluster(sample, cfg.similarity);
  const messages = sample.length;
  const repeats = cluster.length;
  const share = round(pct(repeats, messages));

  const gaps = [];
  for (let i = 1; i < sample.length; i++) gaps.push(sample[i].ts - sample[i - 1].ts);
  const medianGapMs = median(gaps);
  const burstCount = gaps.filter((g) => g <= cfg.burstGapMs).length;

  const clusterUsers = [...new Set(cluster.map((m) => m.uid))];
  const lowInfoShare = round(pct(cluster.filter((m) => m.lowInfo).length, repeats));
  const attackHits = cluster.filter((m) => m.attack).length;
  // 同簇的平均字数：短句重复（生日快乐 / 冲冲冲 / 好听）基本是情绪与应援，不是填充内容
  const avgLen = repeats
    ? round(cluster.reduce((a, m) => a + (m.norm || '').length, 0) / repeats, 1)
    : 0;
  const caps = [];
  let level = 'none';

  if (messages >= cfg.strongMessages && repeats >= cfg.strongRepeats && share >= cfg.strongShare
    && ((medianGapMs !== null && medianGapMs <= cfg.machineGapMs) || burstCount >= cfg.burstCount)) {
    level = 'high';
  } else if (messages >= cfg.minMessages && repeats >= cfg.minRepeats && share >= cfg.repeatShare) {
    level = 'suspect';
  } else if (messages >= 6 && repeats >= 4 && share >= 0.5) {
    level = 'watch';
  }

  if (level !== 'none' && medianGapMs !== null && medianGapMs > cfg.slowGapMs) {
    level = capLevel(level, 'watch');
    caps.push(`相邻间隔中位数 ${Math.round(medianGapMs / 1000)}s，节奏慢，不按刷屏处理`);
  }
  // 情绪弹幕 / 短句（齐刷「生日快乐」「好听」「冲冲冲」）且量不大时按应援处理；
  // 带攻击特征时不降级，避免把「滚出直播间」这类短句攻击洗成观察。
  if (level !== 'none' && attackHits === 0 && messages < 20 && (lowInfoShare === 1 || (avgLen > 0 && avgLen <= 5))) {
    level = capLevel(level, 'watch');
    caps.push('同簇全是情绪 / 短句弹幕且总量不大，按情绪应援观察');
  }
  if (level !== 'none' && repeats > 1 && attackHits === 0 && clusterUsers.length >= cfg.groupUsers
    && share < 0.5) {
    level = capLevel(level, 'watch');
    caps.push(`同簇涉及 ${clusterUsers.length} 个用户且单人占比不足一半，按多人复读处理`);
  }

  return {
    level, messages, repeats, share, medianGapMs, burstCount,
    lowInfoShare, attackHits, avgLen, users: clusterUsers.length, caps,
    cluster: cluster.map((m) => ({ ts: m.ts, uid: m.uid, name: m.name, text: m.text, norm: m.norm, lowInfo: m.lowInfo, attack: m.attack }))
  };
}

/* ------------------------------ 对外入口 ------------------------------ */

function emptyResult(note) {
  return {
    ok: false, level: 'none', levelLabel: LEVEL_LABEL.none,
    behaviour: 'none', behaviourLabel: BEHAVIOUR_LABEL.none,
    intent: 'none', intentLabel: INTENT_LABEL.none,
    totals: { messages: 0, textMessages: 0, users: 0, spanMs: 0 },
    best: null, group: null, users: [], rules: [],
    note, boundaryNotes: [], disclaimer: ''
  };
}

/**
 * 判定主入口。
 * @param {Array<{ts:number, text:string, uid?:string, name?:string}>} messages 已清洗的消息（ts 毫秒）
 * @param {object} options { config, redact, context: 'live'|'comment', limit }
 */
export function analyzeSpamBursts(messages, options = {}) {
  const cfg = { ...SPAM_RULES, ...(options.config || {}) };
  const redact = !!options.redact;
  const context = options.context === 'comment' ? 'comment' : 'live';
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && Number.isFinite(Number(m.ts)) && String(m.text || '').trim())
    .map((m) => ({
      ts: Number(m.ts),
      uid: String(m.uid || 'self'),
      name: String(m.name || ''),
      text: String(m.text).slice(0, 120),
      norm: normalizeForCompare(m.text),
      lowInfo: false,
      attack: false
    }))
    .map((m) => ({ ...m, lowInfo: isLowInfo(m.norm), attack: hasAttack(m.text) }))
    .sort((a, b) => a.ts - b.ts);

  if (!list.length) return emptyResult('没有可判定的文本消息');
  if (list.length < cfg.minMessages) {
    const r = emptyResult(`文本样本 ${list.length} 条，低于判定下限 ${cfg.minMessages} 条，不下结论`);
    r.totals = {
      messages: list.length, textMessages: list.length,
      users: new Set(list.map((m) => m.uid)).size,
      spanMs: list[list.length - 1].ts - list[0].ts
    };
    return r;
  }

  /* 逐用户扫描：单人主导的重复刷屏 = 独轮车 */
  const byUser = new Map();
  list.forEach((m) => {
    if (!byUser.has(m.uid)) byUser.set(m.uid, []);
    byUser.get(m.uid).push(m);
  });

  const perUser = [];
  for (const [uid, arr] of byUser) {
    const msgs = arr.slice(-cfg.maxMessagesPerUser);
    let best = null;
    let start = 0;
    for (let end = 0; end < msgs.length; end++) {
      while (msgs[end].ts - msgs[start].ts > cfg.windowMs) start++;
      const slice = msgs.slice(start, end + 1);
      if (slice.length < cfg.minMessages) continue;
      // 抽样：密集样本里隔条评估即可，避免 O(n³)
      if (end % 2 && end !== msgs.length - 1) continue;
      const scored = scoreWindow(slice, cfg);
      if (!best
        || LEVEL_ORDER[scored.level] > LEVEL_ORDER[best.level]
        || (scored.level === best.level && scored.repeats > best.repeats)) {
        best = { ...scored, uid, userName: arr[0].name || '' };
      }
    }
    if (best && best.level !== 'none') perUser.push(best);
  }
  perUser.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || b.repeats - a.repeats);

  /* 跨用户：同簇涉及多个用户 = 多人复读；带攻击特征且人数够多 = 协同刷屏 */
  const group = detectCoordination(list, cfg);

  const top = perUser[0] || null;
  let level = top ? top.level : 'none';
  let behaviour = top ? 'solo' : 'none';

  if (group && LEVEL_ORDER[group.level] > LEVEL_ORDER[level]) {
    level = group.level;
    behaviour = group.kind;
  } else if (level === 'none' && group) {
    level = group.level;
    behaviour = group.kind;
  } else if (top && group && group.kind === 'group' && top.repeats <= group.repeats) {
    behaviour = 'group';
  }

  // 独轮车只在「单人主导」时成立：若最大同簇里单人占比不足一半，改判多人复读
  if (top && level !== 'none' && top.users >= cfg.groupUsers && top.share < 0.5) {
    behaviour = 'group';
    level = capLevel(level, 'watch');
  }

  const intentSource = behaviour === 'solo' ? top : (group || top);
  const attackHits = intentSource ? intentSource.attackHits : 0;
  let intent = 'none';
  if (level !== 'none') {
    if (attackHits > 0) intent = 'attack';
    // 多人复读同一句且无攻击特征 → 集体跟风 / 齐刷祝福，不按「无意义填充」定性
    else if (behaviour === 'group' || behaviour === 'coordinated') intent = 'meme';
    // 情绪弹幕，或同簇全是短句（≤ 5 字：生日快乐 / 好听 / 冲冲冲）→ 情绪与应援，不是填充
    else if (top && top.repeats && (top.lowInfoShare === 1 || (top.avgLen || 99) <= 5)) intent = 'meme';
    else intent = 'spam';
  }

  const rules = buildRules(top, group, level, intent, cfg, context);
  const samples = (top ? top.cluster : (group ? group.cluster : []))
    .slice(0, 6)
    .map((m) => ({ ts: m.ts, uid: m.uid, name: redact ? '' : m.name, text: redact ? '' : m.text }));

  return {
    ok: true,
    level,
    levelLabel: LEVEL_LABEL[level],
    behaviour,
    behaviourLabel: BEHAVIOUR_LABEL[behaviour],
    intent,
    intentLabel: INTENT_LABEL[intent],
    context,
    totals: {
      messages: list.length,
      textMessages: list.length,
      users: byUser.size,
      spanMs: list[list.length - 1].ts - list[0].ts
    },
    best: top ? {
      uid: top.uid,
      userName: redact ? '' : top.userName,
      messages: top.messages,
      repeats: top.repeats,
      share: top.share,
      users: top.users,
      medianGapMs: top.medianGapMs,
      burstCount: top.burstCount,
      lowInfoShare: top.lowInfoShare,
      attackHits: top.attackHits,
      windowMs: cfg.windowMs,
      caps: top.caps
    } : null,
    group: group ? {
      kind: group.kind,
      level: group.level,
      users: group.users,
      messages: group.messages,
      share: group.share,
      attackHits: group.attackHits,
      windowMs: group.windowMs,
      text: redact ? '' : group.text
    } : null,
    users: perUser.slice(0, 5).map((u) => ({
      uid: u.uid, userName: redact ? '' : u.userName,
      level: u.level, messages: u.messages, repeats: u.repeats, share: u.share
    })),
    samples,
    rules,
    boundaryNotes: [
      '多人同时复读同一句梗、齐刷「生日快乐」等会命中「重复」，但只要不是单人主导就不判独轮车。',
      '同簇全是短句（≤ 5 字，如「生日快乐」「好听」「冲冲冲」）按情绪 / 应援处理，只有命中攻击词才升级为攻击性内容。',
      '纯情绪弹幕（哈哈 / 6 / 问号 / 表情）重复属正常互动，量不大时最高只到「观察」。',
      '慢速重复（间隔中位数 > 10s）不算刷屏，哪怕文本完全一样。',
      context === 'live'
        ? '单账号弹幕历史看不到同场其他观众，跨用户协同只在此样本含多用户时才判定。'
        : '评论区样本是多用户口径（不是直播间弹幕），结论只描述本批评论样本。'
    ],
    disclaimer: '判定基于本机统计规则（时间窗口 / 相似度 / 发送速率 / 用户数），是可解释的线索排序，不是平台处罚结论，也不构成对账号动机的事实认定。'
  };
}

/** 跨用户协同：30s 窗口内同一簇涉及 ≥5 个用户、每人 ≥2 条，且带攻击/引流特征才算。 */
function detectCoordination(list, cfg) {
  let best = null;
  const users = new Set(list.map((m) => m.uid));
  if (users.size < cfg.groupUsers) return null;

  for (let end = 0; end < list.length; end++) {
    let start = end;
    while (start > 0 && list[end].ts - list[start - 1].ts <= cfg.coordWindowMs) start--;
    const slice = list.slice(start, end + 1);
    if (slice.length < cfg.coordUsers * cfg.coordPerUser) continue;
    if (end % 2 && end !== list.length - 1) continue;

    const cluster = largestCluster(slice.slice(-cfg.maxWindowMessages), cfg.similarity);
    if (cluster.length < cfg.coordUsers * cfg.coordPerUser) continue;
    const byUser = new Map();
    cluster.forEach((m) => { byUser.set(m.uid, (byUser.get(m.uid) || 0) + 1); });
    if (byUser.size < cfg.groupUsers) continue;
    const maxPerUser = Math.max(...byUser.values());
    const dominantShare = round(pct(maxPerUser, cluster.length));
    const attackHits = cluster.filter((m) => m.attack).length;
    const distinctUsers = byUser.size;

    let kind = 'group';
    let level = 'watch';
    if (distinctUsers >= cfg.coordUsers
      && [...byUser.values()].filter((n) => n >= cfg.coordPerUser).length >= cfg.coordUsers
      && attackHits > 0) {
      kind = 'coordinated';
      level = 'coordinated';
    } else if (attackHits / cluster.length >= 0.6 && distinctUsers >= cfg.groupUsers) {
      kind = 'group';
      level = 'suspect';
    }

    const candidate = {
      kind, level, users: distinctUsers, messages: cluster.length,
      share: dominantShare, attackHits, windowMs: cfg.coordWindowMs,
      text: cluster[0] ? cluster[0].text : '', cluster
    };
    if (!best || LEVEL_ORDER[candidate.level] > LEVEL_ORDER[best.level]
      || (candidate.level === best.level && candidate.messages > best.messages)) {
      best = candidate;
    }
  }
  return best;
}

/** 生成「为什么这样判」的条目，供界面逐条展示。 */function buildRules(top, group, level, intent, cfg, context) {
  const rules = [];
  const add = (id, label, ok, detail) => rules.push({ id, label, ok, detail });
  add('S1', `时间窗口 ${Math.round(cfg.windowMs / 1000)}s`, !!top,
    top ? `窗口内 ${top.messages} 条，同簇 ${top.repeats} 条（占比 ${(top.share * 100).toFixed(0)}%）` : '未形成密集窗口');
  add('S2', `相似度阈值 ${cfg.similarity}`, !!top,
    top ? `最大同簇 ${top.repeats} 条，含 ${top.users} 个用户` : '无同簇');
  add('S3', `发送量 ≥ ${cfg.minMessages} 条 / 同簇 ≥ ${cfg.minRepeats} 条`, !!top && LEVEL_ORDER[top.level] >= LEVEL_ORDER.suspect,
    top ? `实际 ${top.messages} / ${top.repeats}` : '样本不足');
  add('S4', '机器节奏（间隔中位数 ≤ 1.5s 或 1s 内连发 ≥ 5 次）', !!top && LEVEL_ORDER[top.level] >= LEVEL_ORDER.high,
    top ? `间隔中位数 ${top.medianGapMs === null ? '—' : Math.round(top.medianGapMs) + 'ms'}，1s 内连发 ${top.burstCount} 次` : '—');
  add('S5', `多人复读（同簇 ≥ ${cfg.groupUsers} 人且单人占比 < 50%）`, !!group && group.kind === 'group',
    group ? `同簇 ${group.users} 人 / ${group.messages} 条，最大单人占比 ${(group.share * 100).toFixed(0)}%` : '不适用');
  add('S6', `跨用户协同（≥ ${cfg.coordUsers} 人各 ≥ ${cfg.coordPerUser} 条 + 攻击/引流特征）`, !!group && group.kind === 'coordinated',
    group ? `${group.users} 人同步，攻击特征 ${group.attackHits} 条` : '不适用');
  add('S7', '内容倾向（攻击 / 填充 / 玩梗）', intent !== 'none', INTENT_LABEL[intent]);
  add('S8', '边界修正（节奏 / 情绪弹幕 / 非单人主导）', !!top && top.caps.length > 0,
    top && top.caps.length ? top.caps.join('；') : '无（未触发降级）');
  if (context === 'comment') {
    add('S9', '口径提示', true, '评论区样本，不是直播间弹幕；时间窗口按评论时间计算。');
  }
  return rules;
}

/* ------------------------------ 攻击目标归属 ------------------------------ */

/**
 * 从「按主播判定」里挑出**被该用户刷屏攻击的主播**。
 *
 * 判定条件（必须同时成立，缺一不可）：
 *   1. 该主播直播间有足够文本、且按主播判定成立（level ∈ suspect / high）；
 *   2. 行为为 solo —— 单人主导；多人跟风复读同一句不归到「某人攻击某主播」；
 *   3. 同簇条数 ≥ minRepeats（默认 6 条），避免一两条情绪话被当成攻击目标；
 *   4. 内容倾向 **不是 meme** —— 即 attack（辱骂 / 引战 / 引流词表命中）或 spam（同一句
 *      填充式刷屏，例如在别人直播间连刷 630 条「关注某某喵」这种引流话术）。
 *
 * 为什么 spam 也算：v1.5.4 的立论就是「同一时间窗口内大量重复 = 刷屏 / 独轮车，而非喜爱表达」。
 * 刷屏行为本身就是在攻击那个直播间（污染弹幕、给别的主播导流），内容是否带脏字不改变性质。
 * 只有纯情绪应援（meme：哈哈 / 6 / 问号 / 单字符重复 / ≤5 字短句）不剔除，
 * 因为那才是真实的粉丝互动（齐刷「生日快乐」）。
 *
 * 用途：把这类主播从「最喜爱主播」候选里剔除，避免出现「在人家直播间刷屏，
 * 同时又被列为最喜爱」的自相矛盾。只影响候选与总结文案，不改动任何统计口径。
 *
 * @param {Array} channels analyzeSpamBursts().channels / portrait.spam.channels
 * @param {object} config 可覆盖 SPAM_RULES（一般为 options.spamConfig）
 */
export function collectAttackTargets(channels, config = {}) {
  const cfg = { ...SPAM_RULES, ...config };
  return (Array.isArray(channels) ? channels : [])
    .filter((c) => c
      && (c.level === 'suspect' || c.level === 'high')
      && c.behaviour === 'solo'
      && c.intent !== 'meme'
      && (Number(c.repeats) || 0) >= cfg.minRepeats)
    .sort((a, b) => (LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level]) || ((Number(b.repeats) || 0) - (Number(a.repeats) || 0)))
    .map((c) => ({
      channelUid: String(c.channelUid || ''),
      channelName: c.channelName || '未标注',
      level: c.level,
      levelLabel: c.levelLabel,
      repeats: Number(c.repeats) || 0,
      windowMessages: Number(c.windowMessages) || 0,
      share: Number(c.share) || 0,
      intentLabel: c.intentLabel || ''
    }));
}
