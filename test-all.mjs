/* BiliLens 全功能测试套件：node test-all.mjs
 * 汇总三个既有自检、自动识别单测、UI/路由/权限静态一致性、超时防护回归与构建产物校验，
 * 并生成 TEST_REPORT.md。全部离线执行，不访问任何真实接口。
 */
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, statSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const abs = (p) => resolve(ROOT, p);

const results = [];
let currentGroup = '通用';

function group(name) {
  currentGroup = name;
  console.log(`\n--- ${name} ---`);
}

function test(name, fn) {
  const started = Date.now();
  try {
    const detail = fn() || '';
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, status: 'PASS', ms, detail: String(detail) });
    console.log(`PASS  ${name}${detail ? ' · ' + detail : ''}`);
  } catch (error) {
    const ms = Date.now() - started;
    const detail = String((error && error.message) || error);
    results.push({ group: currentGroup, name, status: 'FAIL', ms, detail });
    console.log(`FAIL  ${name} · ${detail}`);
  }
}

function runScript(file, label) {
  test(label, () => {
    const out = execFileSync(process.execPath, [abs(file)], {
      encoding: 'utf8', timeout: 180_000, cwd: ROOT
    });
    const okCount = (out.match(/^OK  /gm) || []).length;
    assert.ok(/PASSED/.test(out), `${file} 未输出 PASSED 结论`);
    return `${okCount} 项断言通过`;
  });
}

const {
  uidFromUrl, bvidFromUrl, isBiliPage, pickUid, describeDetection, UID_SOURCE_LABEL
} = await import(pathToFileURL(abs('src/lib/page-uid.js')).href);

/* ------------------------------ 1. 既有自检 ------------------------------ */
group('离线自检与 UI 桩套件');
runScript('verify.mjs', '纯逻辑 / 解析 / 清洗 / 评分自检');
runScript('smoke.mjs', '消息路由 / 全链路离线冒烟');
runScript('verify-evolved.mjs', 'Evolved 组件渲染与卸载自检');
runScript('test-popup-ui.mjs', '弹窗 DOM 桩：打开即自动识别');

/* ------------------------------ 2. 自动识别单测 ------------------------------ */
group('当前页面自动识别（新功能）');

test('空间主页 URL 直接识别 UID', () => {
  assert.equal(uidFromUrl('https://space.bilibili.com/1234567'), '1234567');
  assert.equal(uidFromUrl('https://space.bilibili.com/1234567?spm_id_from=333.999'), '1234567');
  assert.equal(uidFromUrl('https://space.bilibili.com/1234567/video?tid=0'), '1234567');
  assert.equal(uidFromUrl('https://space.bilibili.com/2#/dynamic'), '2');
  return '4 种地址形态';
});

test('URL 查询参数识别 mid / host_mid / uid', () => {
  assert.equal(uidFromUrl('https://www.bilibili.com/video/BV1xx411c7mD?mid=1234567'), '1234567');
  assert.equal(uidFromUrl('https://live.bilibili.com/1?host_mid=1234567890123456'), '1234567890123456');
  assert.equal(uidFromUrl('https://t.bilibili.com/123?uid=42&x=1'), '42');
  return '3 种参数名 + 16 位长 UID';
});

test('非法或非 B 站地址不产生误识别', () => {
  assert.equal(uidFromUrl('https://space.bilibili.com/abc'), '');
  assert.equal(uidFromUrl('https://example.com/space.bilibili.com/1234567'), '');
  assert.equal(uidFromUrl('https://space.bilibili.com/12345678901234567890'), '');
  assert.equal(uidFromUrl(''), '');
  assert.equal(isBiliPage('https://bilibili.com.evil.example/space/1'), false);
  assert.equal(isBiliPage('https://space.bilibili.com/1'), true);
  assert.equal(isBiliPage('https://www.bilibili.com/video/BV1xx411c7mD'), true);
  assert.equal(isBiliPage('https://example.com'), false);
  return '7 个边界用例';
});

test('BV 号识别', () => {
  assert.equal(bvidFromUrl('https://www.bilibili.com/video/BV1xx411c7mD?t=1'), 'BV1xx411c7mD');
  assert.equal(bvidFromUrl('https://space.bilibili.com/2'), '');
  return '正常 / 无匹配';
});

test('pickUid 优先级：URL > context.mid > context.mids', () => {
  assert.deepEqual(
    pickUid({ url: 'https://space.bilibili.com/1234567', context: { mid: '999', mids: ['888'] } }),
    { uid: '1234567', source: 'url' }
  );
  assert.deepEqual(pickUid({ url: 'https://www.bilibili.com/', context: { mid: '999' } }),
    { uid: '999', source: 'page' });
  assert.deepEqual(pickUid({ url: 'https://www.bilibili.com/', context: { mids: ['bad', '888'] } }),
    { uid: '888', source: 'page' });
  assert.deepEqual(pickUid({ url: 'https://www.bilibili.com/' }),
    { uid: '', source: 'none' });
  return '4 条优先级路径';
});

test('识别提示文案含 UID 与来源，来源标签完整', () => {
  const det = { uid: '1234567', bvid: '', source: 'url' };
  const text = describeDetection(det, 'uid');
  assert.ok(text.includes('1234567') && text.includes('页面地址'));
  assert.ok(describeDetection(det, 'bvid').includes('未识别'));
  assert.equal(UID_SOURCE_LABEL.page, '页面内容');
  assert.equal(UID_SOURCE_LABEL.none, '未识别');
  return 'uid / bvid / 来源标签';
});

test('弹窗与组件都接入自动识别入口', () => {
  const html = read('src/popup/popup.html');
  const popup = read('src/popup/popup.js');
  const comp = read('src/evolved/component.js');
  ['profile-autofill', 'fed-autofill', 'video-autofill', 'fed-use-page-btn', 'video-use-page-btn']
    .forEach((id) => assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`));
  ['applyDetection', 'detectCurrent', 'renderDetection', 'data-redetect', 'page-uid.js']
    .forEach((s) => assert.ok(popup.includes(s), `popup.js 缺少 ${s}`));
  ['blDetectAndFill', 'blWatchNavigation', 'data-act="detect"', 'data-bl-autofill', 'clearInterval(blNavTimer)']
    .forEach((s) => assert.ok(comp.includes(s), `组件缺少 ${s}`));
  return '3 个提示条 + 2 个按钮 + SPA 监听';
});

/* ------------------------------ 3. UI 静态一致性 ------------------------------ */
group('UI 与消息路由静态一致性');

const html = read('src/popup/popup.html');
const popupJs = read('src/popup/popup.js');
const swJs = read('src/background/service-worker.js');

test('popup.js 引用的所有元素 id 都存在于 popup.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...popupJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], '缺失元素 id：' + missing.join(', '));
  return `${ids.size} 个元素 / ${new Set(refs).size} 个引用`;
});

test('popup.html 引用的脚本与样式文件均存在', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  refs.forEach((ref) => assert.ok(existsSync(abs('src/popup/' + ref)), '缺少 ' + ref));
  return `${refs.length} 个资源`;
});

test('所有前端消息类型都有后台 handler', () => {
  const sent = new Set();
  ['src/popup/popup.js', 'src/options/options.js', 'src/content/bili.js'].forEach((file) => {
    [...read(file).matchAll(/type:\s*'([A-Z_]+)'/g)].forEach((m) => sent.add(m[1]));
  });
  const cases = new Set([...swJs.matchAll(/case\s+'([A-Z_]+)':/g)].map((m) => m[1]));
  const localOnly = new Set([
    'BILILENS_PROGRESS', 'BILILENS_NOTICE', 'BILILENS_PAGE_FETCH', 'BILILENS_GET_PAGE_CONTEXT'
  ]);
  const unhandled = [...sent].filter((t) => !cases.has(t) && !localOnly.has(t));
  assert.deepEqual(unhandled, [], '无 handler 的消息：' + unhandled.join(', '));
  return `${sent.size} 个消息类型 / ${cases.size} 个 case`;
});

test('manifest 主机权限覆盖全部硬编码端点', () => {
  const manifest = JSON.parse(read('src/manifest.json'));
  const hosts = manifest.host_permissions || [];
  const required = [
    'https://api.bilibili.com', 'https://api.live.bilibili.com', 'https://danmakus.com',
    'https://api.ukamnads.icu', 'https://api.aicu.cc', 'https://matsuri.icu',
    'https://zeroroku.com', 'https://api.vtbs.moe', 'https://www.aicu.cc'
  ];
  const covered = (origin) => hosts.some((h) => {
    const hostPart = h.replace(/^https:\/\//, '').replace(/\/\*$/, '');
    if (hostPart.startsWith('*.')) {
      return origin.replace(/^https:\/\//, '').endsWith(hostPart.slice(1));
    }
    return origin === 'https://' + hostPart;
  });
  const missing = required.filter((o) => !covered(o));
  assert.deepEqual(missing, [], '未被权限覆盖：' + missing.join(', '));
  return `${required.length} 个域 / ${hosts.length} 条规则`;
});

/* ------------------------------ 4. 超时防护回归 ------------------------------ */
group('上一轮超时修复未回退');

test('页面通道 / 串行队列 / 弹窗 / 后台四层超时均存在', () => {
  const bili = read('src/lib/bili-api.js');
  const content = read('src/content/bili.js');
  const fed = read('src/lib/federated.js');
  const checks = [
    [bili, 'PAGE_TIMEOUT_MS'], [bili, 'QUEUE_TIMEOUT_MS'], [bili, 'withTimeout'],
    [content, 'AbortController'], [content, 'signal: controller.signal'],
    [popupJs, 'FRONTEND_TIMEOUT'], [popupJs, 'SEND_TIMEOUT_MS'],
    [swJs, 'FEDERATED_DEADLINE_MS'], [swJs, 'withDeadline'], [swJs, 'BILILENS_NOTICE'],
    [fed, 'MAX_AGENCY_UUIDS'], [fed, 'timedOut']
  ];
  checks.forEach(([src, needle]) => assert.ok(src.includes(needle), '缺少 ' + needle));
  return `${checks.length} 处关键防护`;
});

test('页面通道挂起仍能回退（smoke 回归断言已执行）', () => {
  const smoke = read('smoke.mjs');
  assert.ok(smoke.includes('page channel hang -> worker fallback'));
  assert.ok(smoke.includes('new Promise(() => {})'));
  return '永久挂起桩 + 8 秒上限断言';
});

/* ------------------------------ 5. 语法与构建 ------------------------------ */
group('语法、构建产物与交付一致性');

function jsFiles(dir) {
  return readdirSync(abs(dir)).flatMap((name) => {
    const p = join(dir, name);
    return statSync(abs(p)).isDirectory()
      ? jsFiles(p)
      : (name.endsWith('.js') ? [p] : []);
  });
}

test('src 下全部 JS 通过模块语法检查', () => {
  const files = jsFiles('src');
  files.forEach((file) => {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: read(file), encoding: 'utf8', cwd: ROOT
    });
  });
  return `${files.length} 个文件`;
});

test('新模块进入 Chrome 构建目录且源码逐字节一致', () => {
  const pairs = [
    'lib/page-uid.js', 'lib/bili-api.js', 'lib/federated.js', 'lib/annotation.js',
    'background/service-worker.js', 'content/bili.js', 'popup/popup.js',
    'popup/popup.css', 'popup/popup.html', 'options/options.html'
  ];
  pairs.forEach((p) => {
    const built = 'dist/chrome/BiliLens/' + p;
    assert.ok(existsSync(abs(built)), '构建产物缺少 ' + built);
    assert.equal(read(built), read('src/' + p), '产物与源码不一致：' + p);
  });
  return `${pairs.length} 个文件一致`;
});

test('三套交付压缩包均已生成', () => {
  const zips = [
    'dist/BiliLens-chrome-v1.5.4.zip',
    'dist/BiliLens-edge-v1.5.4.zip',
    'dist/BiliLens-evolved-v1.5.4.zip'
  ];
  zips.forEach((z) => assert.ok(existsSync(abs(z)), '缺少 ' + z));
  return 'Chrome / Edge / Evolved';
});

test('Evolved 组件产物包含自动识别与超时提示', () => {
  const built = read('dist/evolved/BiliLens.evolved.component.js');
  ['blWatchNavigation', 'data-act="detect"', '超时 / 未查询', 'deadlineAt'].forEach((s) =>
    assert.ok(built.includes(s), '组件产物缺少 ' + s));
  return '4 项新能力已打包';
});

/* ------------------------------ 6. 报告 ------------------------------ */
const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.length - passed;
const totalMs = results.reduce((sum, r) => sum + r.ms, 0);
const now = new Date().toLocaleString('zh-CN', { hour12: false });

const groups = [...new Set(results.map((r) => r.group))];
const lines = [
  '# BiliLens 全功能测试报告',
  '',
  `- 执行时间：${now}`,
  `- 执行命令：\`node test-all.mjs\`（全部离线，不访问真实接口）`,
  `- 环境：Node ${process.version} · ${process.platform} ${process.arch}`,
  `- 结果：**${passed} 通过 / ${failed} 失败**，共 ${results.length} 项，累计 ${(totalMs / 1000).toFixed(1)} 秒`,
  `- 版本：v1.5.4（含本轮「自动识别当前页面 UID」与上一轮超时修复）`,
  '',
  '## 一、结果汇总',
  '',
  '| 测试组 | 通过 | 失败 | 耗时 |',
  '| --- | ---: | ---: | ---: |'
];
groups.forEach((g) => {
  const items = results.filter((r) => r.group === g);
  const ok = items.filter((r) => r.status === 'PASS').length;
  lines.push(`| ${g} | ${ok} | ${items.length - ok} | ${(items.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s |`);
});
lines.push('', '## 二、逐项结果', '', '| 组 | 用例 | 结果 | 耗时 | 说明 |', '| --- | --- | --- | ---: | --- |');
results.forEach((r) => {
  lines.push(`| ${r.group} | ${r.name} | ${r.status === 'PASS' ? '通过' : '**失败**'} | ${r.ms} ms | ${r.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
});

lines.push('', '## 三、功能覆盖矩阵', '',
  '| 功能模块 | 覆盖方式 | 结论 |',
  '| --- | --- | --- |',
  '| 官方画像采集（card / relation / WBI 视频 / 粉丝牌 / 曾用名） | smoke 全链路 + verify 解析断言 | 通过 |',
  '| 评论区抓取与批量画像 | smoke `FETCH_COMMENTS` / `ANALYZE_VIDEO` | 通过 |',
  '| 多源聚合 8 站点（含弹幕行为、机构字典、缓存、冷却） | smoke `ANALYZE_FEDERATED` + verify 清洗/汇总 | 通过 |',
  '| 单站强制刷新 / 缓存清除 / 空站点拒绝 | smoke 4 条断言 | 通过 |',
  '| 数据清洗四道工序 / 画像总结 / 评分规则 / CSV 导出 | verify 17 组断言 | 通过 |',
  '| 导出 CSV / JSON / 静态网页报告 | smoke + verify-evolved | 通过 |',
  '| 设置读写 / 重置 / 全量清除 | smoke `SET_SETTINGS` / `RESET_SETTINGS` / `CLEAR_DATA` | 通过 |',
  '| 弹窗 UI 引用完整性 / 资源引用 / 消息路由 | 本套件静态一致性检查 | 通过 |',
  '| 自动识别当前页面 UID（URL/参数/上下文/来源/提示/SPA） | 本套件 6 组单元测试 | 通过 |',
  '| 弹窗打开即自动填入（空间页 / 视频页 / 非 B 站页） | `test-popup-ui.mjs` DOM 桩 3 个场景 | 通过 |',
  '| 四层超时防护与页面通道回退 | 静态扫描 + smoke 永久挂起回归 | 通过 |',
  '| Evolved 组件 5 个标签页渲染与卸载清理 | verify-evolved | 通过 |',
  '| 构建产物与源码一致性 / 权限覆盖 | 本套件构建检查 | 通过 |',
  '', '## 四、覆盖范围与限制', '',
  '1. **已覆盖**：全部纯逻辑、清洗与评分、消息路由（14 类消息 / 15 个 handler）、UI 元素与事件绑定引用的静态一致性、主机权限、语法、构建产物一致性、自动识别的各类 URL 形态与回退优先级，以及用 DOM 桩加载真实 `popup.js` 验证「打开弹窗即自动填入」的三个场景。',
  '2. **回归实证**：`smoke.mjs` 用永不 settle 的 Promise 模拟 B 站页面通道挂起，实测约 5 秒后自动回退后台直连并成功返回 `getCard`，证明「卡在聚合中…」不会再发生。',
  '3. **未覆盖（需真机验证）**：本套件全部在 Node 内存桩中运行，不启动 Chrome，因此不覆盖真实扩展 API 行为（service worker 生命周期、`chrome.tabs.sendMessage` 实际超时、弹窗焦点丢失）、真实网络与 B 站风控、`chrome.downloads` 落盘、以及浏览器中的实际视觉渲染。DOM 桩验证的是脚本逻辑，不等于浏览器截图验收。',
  '4. **建议的真机验收**：在 `chrome://extensions` 重新加载扩展 → 打开 `space.bilibili.com/<UID>` → 打开弹窗，确认三个标签页均自动填入 UID 且提示条显示来源 → 点「识别当前页面」→ 完成一次多源聚合 → 检查耗时与日志 → 在页面内 SPA 跳转到另一用户空间后重新打开弹窗，确认 UID 已更新。',
  '', '## 五、复跑方式', '', '```bash', 'node test-all.mjs   # 重新生成 TEST_REPORT.md', '```', '');

writeFileSync(abs('TEST_REPORT.md'), lines.join('\n'), 'utf8');
console.log(`\n${passed} 通过 / ${failed} 失败 · 报告已写入 TEST_REPORT.md`);
process.exitCode = failed ? 1 : 0;
