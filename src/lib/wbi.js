/* B 站 WBI 签名：算法与映射表依据 bilibili-API-collect / docs/misc/sign/wbi.md。
 * 密钥每日轮换，签名失效由业务层降级处理，不在此重试。 */
import { md5 } from './md5.js';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

/** 从 /x/web-interface/nav 的 data 中提取 img_key / sub_key。未登录时 code=-101 但 data 仍有效。 */
export function extractWbiKeys(navData) {
  const wbi = navData && navData.wbi_img;
  if (!wbi || !wbi.img_url || !wbi.sub_url) return null;
  const filename = (url) => rsplitSlash(String(url).split('?')[0]).replace(/\.[a-z0-9]+$/i, '');
  return { imgKey: filename(wbi.img_url), subKey: filename(wbi.sub_url) };
}

function rsplitSlash(value) {
  const parts = String(value).split('/');
  return parts[parts.length - 1];
}

export function mixinKey(imgKey, subKey) {
  const raw = String(imgKey) + String(subKey);
  let out = '';
  for (let i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) out += raw[MIXIN_KEY_ENC_TAB[i]] || '';
  return out.slice(0, 32);
}

/** WBI 规定：参数值需先过滤 !'()*，再按 UTF-8 百分号编码（大写 hex，空格 %20）。 */
const enc = (value) => encodeURIComponent(String(value).replace(/[!'()*]/g, ''));

/**
 * 生成已签名的 query string。
 * @param {Record<string, string|number>} params 业务参数（不含 wts / w_rid）
 * @param {string} mixin 32 位 mixin_key
 * @param {number} wts Unix 秒；允许注入以便测试
 */
export function signQuery(params, mixin, wts = Math.floor(Date.now() / 1000)) {
  const signed = { ...params, wts };
  const body = Object.keys(signed)
    .sort()
    .map((k) => `${enc(k)}=${enc(signed[k])}`)
    .join('&');
  const wRid = md5(body + mixin);
  const final = { ...signed, w_rid: wRid };
  return Object.keys(final)
    .sort()
    .map((k) => `${enc(k)}=${enc(final[k])}`)
    .join('&');
}

export function plainQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}
