/* 当前页面目标识别（纯函数层）。
 *
 * 设计约束：
 *  1) 只依赖字符串与纯对象，不触碰 chrome.* / DOM，因此可离线单元测试；
 *  2) 优先读标签页 URL —— B 站是 SPA，content script 未必已注入或未必已上报，
 *     直接从地址识别才能做到「打开弹窗即自动填入」；
 *  3) URL 无目标时再回退到页面上下文（content script 识别到的 mid / mids）；
 *  4) 明确返回来源，界面据此显示「已自动识别 / 来源」，避免用户误以为是缓存或猜测值。
 */

const UID_PATTERNS = [
  /space\.bilibili\.com\/(\d{1,19})(?:[/?#]|$)/i,
  /[?&](?:mid|uid|host_mid|author_id|up_mid)=(\d{1,19})(?:[&#]|$)/i
];

export function uidFromUrl(url) {
  const raw = String(url || '');
  if (!isBiliPage(raw)) return '';
  for (const pattern of UID_PATTERNS) {
    const match = raw.match(pattern);
    if (match && /^\d{1,19}$/.test(match[1])) return match[1];
  }
  return '';
}

export function bvidFromUrl(url) {
  const raw = String(url || '');
  if (!isBiliPage(raw)) return '';
  const match = raw.match(/(BV[0-9A-Za-z]{10})/);
  return match ? match[1] : '';
}

export function isBiliPage(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === 'bilibili.com' || host.endsWith('.bilibili.com');
  } catch {
    return /(?:^|\.)bilibili\.com/i.test(String(url || ''));
  }
}

/** 汇总识别结果：URL 优先，页面上下文兜底。 */
export function pickUid({ url = '', context = null } = {}) {
  const fromUrl = uidFromUrl(url);
  if (fromUrl) return { uid: fromUrl, source: 'url' };
  const ctx = context || {};
  if (ctx.mid && /^\d{1,19}$/.test(String(ctx.mid))) {
    return { uid: String(ctx.mid), source: 'page' };
  }
  const first = (Array.isArray(ctx.mids) ? ctx.mids : [])
    .find((item) => /^\d{1,19}$/.test(String(item)));
  if (first) return { uid: String(first), source: 'page' };
  return { uid: '', source: 'none' };
}

export const UID_SOURCE_LABEL = {
  url: '页面地址',
  page: '页面内容',
  none: '未识别',
  manual: '手动输入'
};

/** 生成界面提示文案；force 表示用户主动点了「重新识别」。 */
export function describeDetection(det = {}, kind = 'uid') {
  if (kind === 'bvid') {
    return det.bvid
      ? `已自动识别当前页面视频 ${det.bvid}（来源：页面地址）`
      : '当前标签页未识别到 BV 号，可手动输入';
  }
  if (!det.uid) return '当前标签页未识别到 B 站 UID，可手动输入';
  const label = UID_SOURCE_LABEL[det.source] || '当前页面';
  return `已自动识别当前页面 UID ${det.uid}（来源：${label}）`;
}
