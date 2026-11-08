/* Bilibili Evolved 组件端到端校验（node verify-evolved.mjs）
 * 用 vm 模拟 loadFeatureCode() 的 with(window) 沙箱，注入 DOM stub 与真实研究样本，
 * 验证：UMD 导出形态、组件元数据、清洗口径、五维画像、五个标签页渲染。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(ROOT, 'dist/evolved/BiliLens.evolved.component.js');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const channel = read('.research/channel.json');
const hist1 = read('.research/hist_p1.json');
const hist2 = read('.research/hist_p2.json');

/* ------------------------------ DOM stub ------------------------------ */

function makeEl(tag = 'div') {
  const el = {
    tagName: tag, className: '', style: {}, attrs: {}, children: [], parentNode: null,
    disabled: false, hidden: false, value: '', checked: false, _html: '', _text: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    remove() {}, click() {}, matches() { return false; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); }
  };
  return el;
}

const bodyEl = makeEl();
const uidInput = makeEl('input');
uidInput.value = '100000001';
const runBtn = makeEl('button');
const toastEl = makeEl();
const panelEl = makeEl();
const tabEls = ['overview', 'portrait', 'federated', 'cleaning', 'settings'].map((id) => {
  const t = makeEl('button');
  t.attrs['data-tab'] = id;
  return t;
});
let clickHandler = null;
const shadow = {
  _html: '', _handlers: {},
  get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
  querySelector(sel) {
    if (sel === '[data-bl-body]') return bodyEl;
    if (sel === '[data-act="run"]') return runBtn;
    if (sel === '[data-bl-uid]') return uidInput;
    if (sel === '[data-bl-toast]') return toastEl;
    if (sel === '.bl-panel') return panelEl;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '[data-tab]') return tabEls;
    return [];
  },
  addEventListener(type, fn) { this._handlers[type] = fn; }
};
const host = makeEl();
host.shadowRoot = shadow;
host.attachShadow = () => shadow;

const documentStub = {
  body: {
    appendChild: () => {}, contains: () => true,
    removeChild(el) { el.parentNode = null; }
  },
  readyState: 'complete',
  createElement: (tag) => (tag === 'div' ? host : makeEl(tag)),
  querySelector: (sel) => (sel === '.bililens-evolved-root' ? host : null),
  addEventListener() {}
};
// 让 blMount 里的 appendChild 记录宿主
const appended = [];
documentStub.body.appendChild = (el) => { appended.push(el); el.parentNode = documentStub.body; };

/* ------------------------------ 网络 stub ------------------------------ */

let gmxCalls = 0;
function fakeGMX(opts) {
  gmxCalls++;
  const url = String(opts.url);
  let status = 200;
  let text = '{}';
  if (url.includes('/x/web-interface/card')) {
    text = JSON.stringify({ code: 0, data: { card: {
      name: '测试用户', mid: '100000001', sex: '保密', level_info: { current_level: 5 },
      fans: 1234, attention: 88, sign: '签名', face: '', article: 0, regtime: 0
    } } });
  } else if (url.includes('/x/relation/stat')) {
    text = JSON.stringify({ code: 0, data: { follower: 1234, following: 88 } });
  } else if (url.includes('/api/search/user/channel')) {
    text = channel;
  } else if (url.includes('/api/v3/users/') && url.includes('/history')) {
    const page = Number(new URL(url).searchParams.get('page'));
    text = page <= 1 ? hist1 : hist2;
  } else {
    // 其余站点按「不可达 / 未收录」处理，不进入解析器
    status = 404;
  }
  setTimeout(() => opts.onload({ status, responseText: text }), 0);
  return { abort() {} };
}

/* ------------------------------ 模拟 Evolved 沙箱 ------------------------------ */

const sandbox = {
  exports: {},                       // loadFeatureCode 会先注入空 exports
  GM_xmlhttpRequest: fakeGMX,
  document: documentStub,
  location: { href: 'https://space.bilibili.com/100000001' },
  unsafeWindow: { __INITIAL_STATE__: null },
  setTimeout, clearTimeout, URL, Blob, AbortController, TextEncoder, TextDecoder, console
};
const BUNDLE_TEXT = readFileSync(BUNDLE, 'utf8');
vm.createContext(sandbox);
const evalResult = vm.runInContext(BUNDLE_TEXT, sandbox, { filename: BUNDLE });

// loadFeatureCode: exportValues.length > 0 ? exportValues[0] : undefined
const exportedValues = Object.values(sandbox.exports);
assert.equal(exportedValues.length, 1, '注入的 exports 必须只产生一个导出值');
const component = exportedValues[0];
assert.ok(component, '导出值不能为空');
// 兜底路径：整段代码作为表达式时，eval 的完成值也必须就是组件
assert.ok(evalResult && evalResult.entry, '表达式完成值应同样导出组件元数据');
assert.equal(evalResult, component, '两种导出方式应指向同一个对象');

// 模拟 B 站页面上存在全局 module 对象（webpack chunk）的最坏情况：
// 经典 UMD 会误走 module.exports 分支，这里必须靠表达式完成值兜底。
const collision = {
  exports: {}, module: { exports: {} },
  GM_xmlhttpRequest: fakeGMX, document: documentStub,
  location: { href: 'https://space.bilibili.com/100000001' },
  unsafeWindow: { __INITIAL_STATE__: null },
  setTimeout, clearTimeout, URL, Blob, AbortController, TextEncoder, TextDecoder, console
};
vm.createContext(collision);
const collisionResult = vm.runInContext(BUNDLE_TEXT, collision, { filename: BUNDLE });
assert.ok(collisionResult && collisionResult.entry, '全局 module 冲突时仍应通过表达式拿到组件');
assert.ok(Object.values(collision.exports).length === 1, '冲突场景下也应写入注入的 exports');
console.log('OK  双导出路径 + 全局 module 冲突兜底');

// installFeature.isComponent / isPlugin / isStyle 判定
assert.ok(component.entry, '必须露出 entry 才会被判定为组件');
assert.ok(!component.setup, '不应被误判为插件');
assert.ok(!component.style, '不应被误判为样式');
assert.equal(component.name, 'bililensUserProfile');
assert.ok(component.displayName.includes('BiliLens'));
assert.ok(Array.isArray(component.tags) && component.tags[0].name === 'utils');
// vm 沙箱内的 RegExp 属于不同 realm，不用 instanceof
assert.ok(component.urlInclude.some((p) => Object.prototype.toString.call(p) === '[object RegExp]'));
assert.equal(typeof component.reload, 'function');
assert.equal(typeof component.unload, 'function');
assert.ok(component.options.maxPages && component.options.sites);
console.log('OK  UMD 导出与组件元数据');

// entry 注入 UI，返回可供外部调用的 analyze
const ctx = { settings: { options: { ...Object.fromEntries(
  Object.entries(component.options).map(([k, v]) => [k, v.defaultValue])
) } }, metadata: component, coreApis: {} };
const api = component.entry(ctx);
assert.equal(api.version, '1.5.4');
assert.equal(typeof api.analyze, 'function');
assert.equal(appended.length, 1, '浮动入口应注入一次');
console.log('OK  entry 注入与导出接口');

await api.analyze('100000001', true);
assert.ok(gmxCalls >= 4, `应至少发出 4 个请求，实际 ${gmxCalls}`);
const overview = bodyEl.innerHTML;
if (!overview.includes('测试用户')) console.log('DEBUG overview:', overview.slice(0, 1200));
assert.ok(overview.includes('测试用户'), '官方档案应渲染昵称');
assert.ok(overview.includes('基础档案'), '应渲染 facts 卡片');
assert.ok(!/>\s*undefined\s*</.test(overview), '概览页不应出现 undefined');
console.log('OK  官方档案 + 概览渲染');

function clickTab(id) {
  const el = { getAttribute: (k) => (k === 'data-tab' ? id : null) };
  const fakeEvent = { target: { closest: () => el } };
  assert.ok(shadow._handlers.click, '应注册 click 事件');
  shadow._handlers.click(fakeEvent);
  return bodyEl.innerHTML;
}

const portrait = clickTab('portrait');
const portraitSections = [
  '完整聚合画像', '互动画像 · 概览指标', '留痕构成', '活跃节律', '7×24 时段热力图',
  '活跃日历', '互动趋势', '频道偏好', '表达风格', '词云', '支持方式分类',
  '画像分类五维统计分组', '全部分类说明', '所涉直播间画像', '发言内容原始记录样本'
];
const missing = portraitSections.filter((s) => !portrait.includes(s));
assert.deepEqual(missing, [], '完整画像章节缺失: ' + missing.join(', '));
assert.ok(!/>\s*undefined\s*</.test(portrait), '画像页不应出现 undefined');
assert.ok(portrait.includes('不构成'), '应带合规边界说明');
console.log(`OK  完整弹幕画像 ${portraitSections.length} 个章节 (${portrait.length} chars)`);

const federated = clickTab('federated');
assert.ok(federated.includes('关注主播（去重后）'));
assert.ok(federated.includes('站点状态矩阵'));
assert.ok(federated.includes('43'), '去重后主播数应为 43');
assert.ok(federated.includes('59'), '重复行移除应为 59');
assert.ok(federated.includes('实际请求端点'));
console.log('OK  多源数据 + 去重口径 (102 → 43, 移除 59)');

const cleaning = clickTab('cleaning');
['字段规范化', '缺失值处理', '异常值处理', '数据去重', '清洗前后计数', '逐源清洗计数', '图表数据口径', 'cleaned']
  .forEach((s) => assert.ok(cleaning.includes(s), '清洗页缺少 ' + s));
console.log('OK  四道清洗工序与清洗报告');

const settings = clickTab('settings');
assert.ok(settings.includes('Bilibili Evolved 用户组件') && settings.includes('合规边界'));
console.log('OK  设置与导出页');

// 卸载
component.unload();
assert.equal(host.parentNode, null, 'unload 应移除宿主节点');
console.log('OK  unload 清理');

console.log('\nEVOLVED COMPONENT CHECKS PASSED');
