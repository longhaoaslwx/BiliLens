/* 用户标注采集（v1.5.2）：粉丝牌 + 曾用名。
 *
 * 粉丝牌（两路，按可靠性排序）：
 *   1. B 站官方勋章墙 GET api.live.bilibili.com/xlive/web-ucenter/user/MedalWall?target_id=
 *      —— 需登录 Cookie（SESSDATA）。扩展的页面通道在 bilibili.com 上下文里发请求，
 *         自带登录态与 Referer；未登录返回 code=-101。
 *         返回字段最全：medal_name / level / target_name（主播名）/ guard_level / wearing_status。
 *   2. AICU 免登录标注 GET api.aicu.cc/api/v4/user/getmedal?uid=
 *      —— 免登录，但只覆盖 AICU 采集过的用户；字段较简 {ruid, level, name}。
 *
 * 曾用名：AICU GET api.aicu.cc/api/v4/user/getusermark?uid= → data.hname[]（另有公会/设备/标签）。
 *   B 站官方无公开曾用名接口（空间 SPA 全部分包、顶栏、搜索 API、API 文档均无此字段），
 *   2026-11-08 多渠道排查结论；因此曾用名唯一来源是第三方标注，「未收录」≠「没有」。
 *
 * 本模块只做取数与归一化，不做推断；任何失败都返回带原因的 committed 结构，绝不抛错。
 */

const MEDAL_WALL = 'https://api.live.bilibili.com/xlive/web-ucenter/user/MedalWall';
const AICU_MEDAL = 'https://api.aicu.cc/api/v4/user/getmedal';
const AICU_MARK = 'https://api.aicu.cc/api/v4/user/getusermark';

async function getJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' }
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    try { return { ok: true, status: res.status, json: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, error: '响应不是合法 JSON' }; }
  } catch (error) {
    return { ok: false, status: 0, error: String(error && error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

const text = (v, max = 60) => String(v === null || v === undefined ? '' : v).trim().slice(0, max);
const level = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null;
};

/** 官方勋章墙 → 统一结构；失败时返回 { ok:false, code, message }。
 *  既能吃原始响应 { code, data }，也能吃 bili-api 归一化后的 { code:0, data }。 */
export function parseMedalWall(json) {
  if (!json || typeof json !== 'object') return { ok: false, code: 'BAD_JSON', message: '响应为空' };
  if (json.code === -101) return { ok: false, code: -101, message: '需要登录 B 站才能读取勋章墙' };
  if (json.code !== 0) return { ok: false, code: json.code, message: json.message || `code=${json.code}` };
  const data = json.data || {};
  const list = (Array.isArray(data.list) ? data.list : []).map((item) => {
    const info = item.medal_info || {};
    return {
      name: text(info.medal_name, 30),
      level: level(info.level),
      streamer: text(item.target_name || info.target_name, 40),
      streamerMid: text(info.target_id || item.target_id, 20),
      guardLevel: level(info.guard_level),
      wearing: Number(info.wearing_status) === 1
    };
  }).filter((m) => m.name || m.level);
  list.sort((a, b) => (b.level || 0) - (a.level || 0));
  const closed = !!Number(data.close_space_medal);
  return {
    ok: true,
    source: 'medalwall',
    count: Number(data.count) || list.length,
    closed,
    onlyShowWearing: !!Number(data.only_show_wearing),
    // 空列表是有效结论，但要写清是「不公开」还是「确实没有」，避免被读成取数失败
    message: list.length ? '' : (closed ? '该用户已隐藏勋章墙（close_space_medal）' : '该用户没有公开的粉丝勋章'),
    list
  };
}

/** AICU 勋章列表 → 与官方同构（无主播名，只有 ruid）。 */
export function parseAicuMedals(json) {
  if (!json || typeof json !== 'object') return { ok: false, code: 'BAD_JSON', message: '响应为空' };
  if (json.code !== 0) return { ok: false, code: json.code, message: json.message || `code=${json.code}` };
  const list = ((json.data && json.data.list) || []).map((m) => ({
    name: text(m.name, 30),
    level: level(m.level),
    streamer: '',
    streamerMid: text(m.ruid, 20),
    guardLevel: null,
    wearing: false
  })).filter((m) => m.name || m.level);
  list.sort((a, b) => (b.level || 0) - (a.level || 0));
  return { ok: true, source: 'aicu', count: list.length, closed: false, onlyShowWearing: false, list };
}

export function parseUserMark(json) {
  if (!json || typeof json !== 'object') return { ok: false, code: 'BAD_JSON', message: '响应为空' };
  if (json.code !== 0) return { ok: false, code: json.code, message: json.message || `code=${json.code}` };
  const d = json.data || {};
  const clean = (list) => [...new Set((Array.isArray(list) ? list : [])
    .map((x) => text(x, 40)).filter(Boolean))];
  const guilds = clean([d.gh && d.gh.name, d.gh2 && d.gh2.name].filter(Boolean));
  return {
    ok: true,
    formerNames: clean(d.hname),
    guilds,
    devices: clean(d.device),
    tags: clean(d.tag),
    markText: text(d.text, 120)
  };
}

/** 一次取回粉丝牌（官方优先 → AICU 兜底）与曾用名（AICU）。三个请求互不阻塞。
 *  options.fetchMedalWall(uid, timeoutMs) 可由调用方注入：service-worker 传入走页面通道的
 *  官方请求器（自带登录 Cookie 与 Referer，成功率最高）；未注入时用本模块直连。 */
export async function fetchAnnotations(uid, options = {}) {
  const timeoutMs = options.timeoutMs || 12_000;
  const officialTask = typeof options.fetchMedalWall === 'function'
    ? Promise.resolve(options.fetchMedalWall(uid, timeoutMs)).catch((error) => ({ ok: false, error: String(error && error.message || error) }))
    : getJson(`${MEDAL_WALL}?target_id=${encodeURIComponent(uid)}`, timeoutMs);
  const [official, aicuMedal, mark] = await Promise.all([
    officialTask,
    getJson(`${AICU_MEDAL}?uid=${encodeURIComponent(uid)}`, timeoutMs),
    getJson(`${AICU_MARK}?uid=${encodeURIComponent(uid)}`, timeoutMs)
  ]);

  // 官方：有 JSON 就交给 parseMedalWall（-101 会翻译成「需要登录」），否则记网络错误
  const wallParsed = official && official.json
    ? parseMedalWall(official.json)
    : { ok: false, code: (official && official.status) || 'NETWORK', message: (official && official.error) || '请求失败' };

  let medals = wallParsed;
  if (!medals.ok) {
    const aicuParsed = aicuMedal.ok
      ? parseAicuMedals(aicuMedal.json)
      : { ok: false, code: aicuMedal.error, message: aicuMedal.error };
    // 官方失败时用 AICU；AICU 也空则保留双方原因，便于界面写清「为什么没有」
    const reason = `官方勋章墙不可用（${wallParsed.message}）；AICU 也未收录该用户`;
    medals = (aicuParsed.ok && aicuParsed.list.length) ? aicuParsed : {
      ...aicuParsed,
      ok: false,
      count: 0,
      list: [],
      message: reason,
      fallbackNote: reason,
      officialError: wallParsed.message
    };
  }
  const markParsed = mark.ok ? parseUserMark(mark.json) : { ok: false, code: mark.error, message: mark.error };

  return {
    medals,
    mark: markParsed,
    fetchedAt: new Date().toISOString()
  };
}
