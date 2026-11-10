/* 弹窗 DOM 桩测试：node test-popup-ui.mjs
 * 用最小 DOM / chrome.* 桩加载真实 popup.js，验证「打开弹窗即自动识别当前页面 UID」
 * 以及非 B 站页面不误填。不启动浏览器，不访问网络。
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const elements = new Map();

function makeElement() {
  return {
    value: '', innerHTML: '', textContent: '', className: '', disabled: false,
    dataset: {}, style: {}, children: [], scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, setAttribute() {}, getAttribute() { return null; },
    remove() {}, focus() {}
  };
}

const el = (selector) => {
  if (!elements.has(selector)) elements.set(selector, makeElement());
  return elements.get(selector);
};

globalThis.document = {
  querySelector: (selector) => el(selector),
  querySelectorAll: () => [],
  createElement: () => makeElement(),
  addEventListener() {}
};

let activeUrl = 'https://space.bilibili.com/1234567?spm_id_from=333.999';

globalThis.chrome = {
  runtime: {
    lastError: undefined,
    onMessage: { addListener() {} },
    openOptionsPage() {},
    sendMessage(message, callback) {
      if (message.type === 'GET_STATE') {
        callback({
          ok: true,
          settings: { federatedSiteIds: [], commentPages: 3, maxBatchUsers: 12 },
          report: null,
          storage: { keys: 0 }
        });
      } else if (message.type === 'FEDERATED_SITES') {
        callback({ ok: true, sites: [] });
      } else {
        callback({ ok: true });
      }
    }
  },
  tabs: {
    query: async () => [{ id: 1, url: activeUrl }],
    sendMessage: async () => ({ ok: true, context: { type: 'user', mid: '1234567', mids: [] } })
  }
};

const popupUrl = pathToFileURL(resolve('src/popup/popup.js')).href;
const settle = () => new Promise((done) => setTimeout(done, 150));

async function load(caseId) {
  elements.clear();
  await import(`${popupUrl}?case=${caseId}`);
  await settle();
}

// 场景 1：B 站用户空间页 → 三个标签页自动填入，提示条写明识别来源
await load('space');
assert.equal(el('#federated-input').value, '1234567', '多源数据页应自动填入 UID');
assert.equal(el('#user-input').value, '1234567', '画像页应自动填入 UID');
assert.ok(el('#fed-autofill').innerHTML.includes('1234567'), '提示条应显示已识别 UID');
assert.ok(el('#fed-autofill').innerHTML.includes('页面地址'), '提示条应写明来源为页面地址');
assert.ok(el('#profile-autofill').innerHTML.includes('已自动识别'), '画像页应有识别提示');
assert.ok(el('#status-text').textContent.includes('1234567'), '状态栏应显示识别结果');
console.log('OK  空间页：弹窗打开即自动识别 UID 1234567 并写入 3 个输入区');

// 场景 2：视频页 → 自动填入 BV 号；URL 无 UID 时回退页面上下文
activeUrl = 'https://www.bilibili.com/video/BV1xx411c7mD?t=10';
await load('video');
assert.equal(el('#video-input').value, 'BV1xx411c7mD', '评论区页应自动填入 BV 号');
assert.equal(el('#federated-input').value, '1234567', '多源页应回退到页面上下文的 mid');
assert.ok(el('#video-autofill').innerHTML.includes('BV1xx411c7mD'), '视频提示条应显示 BV 号');
console.log('OK  视频页：自动填入 BV 号，UID 回退到页面上下文');

// 场景 3：非 B 站页面 → 不误填，且明确提示需手动输入
activeUrl = 'https://example.com/some/page';
await load('external');
assert.equal(el('#federated-input').value, '', '非 B 站页面不应填入 UID');
assert.equal(el('#user-input').value, '', '非 B 站页面不应填入 UID');
assert.ok(el('#fed-autofill').innerHTML.includes('未识别') || el('#fed-autofill').innerHTML.includes('手动输入'),
  '应提示未识别 / 手动输入');
console.log('OK  非 B 站页面：不误填并给出手动输入提示');

console.log('POPUP UI CHECKS PASSED');
