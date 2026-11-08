/* BiliLens for Bilibili Evolved — 运行时适配层。
 *
 * 这一段由 build-evolved.mjs 注入到 UMD 工厂函数的最前面。
 * 这里的 const 声明位于工厂函数作用域，会「遮蔽」页面全局同名符号，
 * 使打包进来的 src/lib/*.js 无需任何改动即可在用户组件环境里运行：
 *   fetch      -> GM_xmlhttpRequest（跨域）/ 原生 fetch（降级）
 *   cacheGet   -> 内存 + localStorage，TTL 语义与扩展 store.js 一致
 *   cacheSet   -> 同上
 *
 * 注意：组件代码由 Bilibili Evolved 的 loadFeatureCode() 在 with(window) 沙箱里
 * eval 执行。所有未声明的自由标识符都会经代理落到 window 上，因此这里对
 * GM_xmlhttpRequest / unsafeWindow / coreApis 一律用 typeof 保护后再取用。
 */
'use strict';

const BL_VERSION = '1.5.4';
const BL_CACHE_PREFIX = 'bililens:evolved:';

function blResolveGM() {
  try {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
  } catch (_) { /* 沙箱未注入 */ }
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow &&
        typeof unsafeWindow.GM_xmlhttpRequest === 'function') {
      return unsafeWindow.GM_xmlhttpRequest;
    }
  } catch (_) { /* 忽略 */ }
  return null;
}

function blNativeFetch() {
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow &&
        typeof unsafeWindow.fetch === 'function') return unsafeWindow.fetch;
  } catch (_) { /* 忽略 */ }
  return globalThis.fetch;
}

/* 供 src/lib/federated.js 的 fetchOne() 使用的最小 Response 兼容实现。
 * 只实现它真正用到的成员：status / ok / text()。 */
const fetch = function blFetch(url, options = {}) {
  const gmx = blResolveGM();
  if (!gmx) return blNativeFetch()(String(url), options);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    let handle = null;
    try {
      handle = gmx({
        method: options.method || 'GET',
        url: String(url),
        headers: options.headers || {},
        timeout: 15000,
        anonymous: false,
        onload: (res) => done(resolve, {
          status: Number(res.status) || 0,
          ok: Number(res.status) >= 200 && Number(res.status) < 400,
          text: () => Promise.resolve(String(res.responseText == null ? '' : res.responseText))
        }),
        onerror: () => done(reject, new Error('GM_xmlhttpRequest 请求失败')),
        ontimeout: () => done(reject, new Error('GM_xmlhttpRequest 请求超时'))
      });
    } catch (error) {
      done(reject, error);
    }
    const signal = options.signal;
    if (signal) {
      const onAbort = () => {
        try { if (handle && typeof handle.abort === 'function') handle.abort(); } catch (_) { /* 忽略 */ }
        done(reject, new Error('请求已取消'));
      };
      if (signal.aborted) onAbort();
      else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
};

/* ------------------------------ 本地缓存 ------------------------------ */

const blMemCache = new Map();

function blLocalStorage() {
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.localStorage) {
      return unsafeWindow.localStorage;
    }
  } catch (_) { /* 跨域或隐私模式 */ }
  try { return localStorage; } catch (_) { return null; }
}

const cacheGet = async function blCacheGet(key) {
  const now = Date.now();
  const mem = blMemCache.get(key);
  if (mem && mem.expires > now) return mem.value;
  if (mem) blMemCache.delete(key);
  const store = blLocalStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(BL_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.expires || parsed.expires <= now) return null;
    blMemCache.set(key, parsed);
    return parsed.value;
  } catch (_) { return null; }
};

const cacheSet = async function blCacheSet(key, value, ttlMs) {
  const entry = { expires: Date.now() + (Number(ttlMs) || 3600000), value };
  blMemCache.set(key, entry);
  const store = blLocalStorage();
  if (!store) return;
  try { store.setItem(BL_CACHE_PREFIX + key, JSON.stringify(entry)); } catch (_) { /* 配额满 */ }
};

function blClearCache() {
  blMemCache.clear();
  const store = blLocalStorage();
  if (!store) return;
  try {
    const doomed = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(BL_CACHE_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => store.removeItem(k));
  } catch (_) { /* 忽略 */ }
}

/* ------------------------------ 下载 / 提示 ------------------------------ */

function blDownload(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

function blToast(message, kind = 'info') {
  try {
    if (typeof coreApis !== 'undefined' && coreApis && coreApis.toast && coreApis.toast.Toast) {
      const t = coreApis.toast.Toast;
      if (typeof t[kind] === 'function') { t[kind](message, 'BiliLens', 3000); return; }
      if (typeof t.info === 'function') { t.info(message, 'BiliLens', 3000); return; }
    }
  } catch (_) { /* 忽略 */ }
  // 面板内兜底提示
  const box = document.querySelector('.bililens-evolved-root');
  if (box && box.shadowRoot) {
    const note = box.shadowRoot.querySelector('[data-bl-toast]');
    if (note) {
      note.textContent = message;
      note.classList.add('show');
      setTimeout(() => note.classList.remove('show'), 3200);
    }
  }
}
