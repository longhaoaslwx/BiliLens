/* BiliLens · Bilibili Evolved 组件打包器（零依赖，node build-evolved.mjs）
 *
 * Bilibili Evolved 的 loadFeatureCode() 把用户组件代码放进 with(window) 沙箱 eval，
 * 支持两种导出方式：① UMD 写入注入的 exports，取第一项；② 整段代码作为表达式，
 * 取 eval 的完成值。installComponent() 用 metadata.entry 判定它是组件。
 *
 * 这里两种都做，且刻意不写经典 UMD 的 `module.exports` 分支：B 站页面上可能存在
 * 全局 module 对象（webpack chunk），一旦误判成 CommonJS 就会把组件挂到别处，
 * loadFeatureCode 反而拿不到导出值。表达式返回值在这种情况仍能兜底。
 *
 * 本脚本把 src/lib/*.js 的 ES 模块按拓扑顺序改写成同一作用域里的 IIFE 模块，
 * 与 src/evolved/runtime.js（网络/缓存适配）、src/evolved/component.js（UI 与元数据）
 * 拼成一个 UMD 包。这样组件与 Chrome/Edge 扩展共用完全相同的清洗、画像、
 * 多源解析与规则评分代码，不会出现两套口径。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(ROOT, 'dist/evolved/BiliLens.evolved.component.js');
const VERSION = '1.5.4';

const MODULES = [
  { id: 'md5', file: 'src/lib/md5.js', dep: {} },
  { id: 'wbi', file: 'src/lib/wbi.js', dep: { './md5.js': 'md5' } },
  { id: 'clean', file: 'src/lib/clean.js', dep: {} },
  { id: 'spam', file: 'src/lib/spam.js', dep: {} },
  { id: 'analyze', file: 'src/lib/analyze.js', dep: { './clean.js': 'clean', './spam.js': 'spam' } },
  { id: 'profiler', file: 'src/lib/profiler.js', dep: {} },
  { id: 'federated', file: 'src/lib/federated.js', dep: {
    './store.js': 'store', './clean.js': 'clean', './analyze.js': 'analyze'
  } }
];

const DEP_VAR = (id) => `__m_${id}`;
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** 扫描源码里的 import / export，返回改写后的模块体与导出名表。 */
function transform(id, source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  const names = new Set();
  const reExports = [];
  const imported = new Map(); // name -> dep module id
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 多行 / 单行 import { ... } from './x.js';
    if (/^import\b/.test(trimmed)) {
      let block = line;
      while (!/from\s+['"][^'"]+['"]\s*;?\s*$/.test(block.trim()) && i + 1 < lines.length) {
        i++;
        block += '\n' + lines[i];
      }
      const from = block.match(/from\s+['"]([^'"]+)['"]/);
      const clause = block.match(/import\s*\{([\s\S]*?)\}\s*from/);
      if (!from || !clause) throw new Error(`${id}: 无法解析 import 语句 -> ${block.slice(0, 120)}`);
      const depId = MODULES.find((m) => m.id === id).dep[from[1]];
      if (!depId) throw new Error(`${id}: 未登记的依赖 ${from[1]}`);
      clause[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((entry) => {
        const parts = entry.split(/\s+as\s+/).map((s) => s.trim());
        const original = parts[0];
        const local = parts[1] || original;
        imported.set(local, { depId, original });
      });
      i++;
      continue;
    }

    // export { X } from './y.js'; —— 只出现在 federated.js
    let re = trimmed.match(/^export\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*from\s*['"]([^'"]+)['"]\s*;?$/);
    if (re) {
      const depId = MODULES.find((m) => m.id === id).dep[re[2]];
      if (!depId) throw new Error(`${id}: re-export 依赖未登记 ${re[2]}`);
      reExports.push({ name: re[1], depId });
      i++;
      continue;
    }

    // export const / function / async function NAME
    re = trimmed.match(/^export\s+(const|function|async\s+function)\s+([A-Za-z_$][\w$]*)/);
    if (re) {
      names.add(re[2]);
      out.push(line.replace(/^(\s*)export\s+/, '$1'));
      i++;
      continue;
    }
    if (/^export\b/.test(trimmed)) {
      throw new Error(`${id}: 未支持的 export 形态 -> ${trimmed.slice(0, 120)}`);
    }
    out.push(line);
    i++;
  }

  // 生成 import 与 re-export 的解构声明
  const byDep = new Map();
  imported.forEach((info, local) => {
    if (!byDep.has(info.depId)) byDep.set(info.depId, []);
    byDep.get(info.depId).push(`${info.original}: ${local}`);
  });
  reExports.forEach(({ name, depId }) => {
    if (!byDep.has(depId)) byDep.set(depId, []);
    if (!byDep.get(depId).some((x) => x.split(':')[1].trim() === name)) {
      byDep.get(depId).push(`${name}: ${name}`);
    }
    names.add(name);
  });
  const prelude = [...byDep.entries()].map(([depId, pairs]) =>
    `const { ${pairs.join(', ')} } = ${DEP_VAR(depId)};`).join('\n');

  const body = `${prelude ? prelude + '\n' : ''}${out.join('\n')}\nreturn { ${[...names].join(', ')} };`;
  return { body, names: [...names] };
}

const parts = [];
parts.push(`/* BiliLens for Bilibili Evolved v${VERSION} — 单文件用户组件
 * 安装：Bilibili Evolved 设置 → 组件 → 安装组件 → 从 URL/文件导入本 js。
 * 与 Chrome / Edge 扩展共用同一套清洗层、完整弹幕画像引擎与规则画像，统计口径一致。
 * 生成方式：node build-evolved.mjs（请勿手工编辑本文件）。
 *
 * 导出方式：写入 loadFeatureCode 注入的 exports（第一项）+ 整段表达式的返回完成值。
 */
(function () {`);

parts.push('\n/* ===== 运行时适配层 ===== */\n');
parts.push(read('src/evolved/runtime.js'));
parts.push('\n/* store.js 的组件端替身：只暴露 federated.js 需要的两个函数 */\n');
parts.push('const __m_store = { cacheGet, cacheSet };\n');

for (const mod of MODULES) {
  const { body, names } = transform(mod.id, read(mod.file));
  parts.push(`\n/* ===== bundled: ${mod.file} (${names.length} exports) ===== */\n`);
  parts.push(`const ${DEP_VAR(mod.id)} = (() => {\n${body}\n})();\n`);
}

parts.push('\n/* ===== 依赖汇总 ===== */\n');
parts.push(`const __M = { ${MODULES.map((m) => `${m.id}: ${DEP_VAR(m.id)}`).join(', ')} };\n`);
parts.push('\n/* ===== 组件主体 ===== */\n');
parts.push(read('src/evolved/component.js'));
parts.push(`
const __blMetadata = component;
// ① loadFeatureCode 注入的 exports：取 Object.values(exports)[0]
try {
  if (typeof exports === 'object' && exports) exports['bililens/user-profile'] = __blMetadata;
} catch (_) { /* 未注入 exports，走 ② */ }
// ② 整段代码作为表达式：eval 的完成值同样会被 loadFeatureCode 采用（exported || returned）
return __blMetadata;
})();
`);

const bundle = parts.join('\n');
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bundle, 'utf8');
console.log(`built ${OUT}`);
console.log(`  ${bundle.split('\n').length} lines, ${Buffer.byteLength(bundle, 'utf8').toLocaleString()} bytes`);
MODULES.forEach((m) => {
  const { names } = transform(m.id, read(m.file));
  console.log(`  ${m.file.padEnd(26)} -> ${names.length} exports`);
});
