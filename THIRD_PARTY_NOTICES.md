# 第三方声明

本项目 v1.2.0 起**不再打包任何第三方站点清单或源码副本**。早期版本中曾使用的跨站用户名枚举数据与相关声明已随模块一并移除；运行时只读取下列已列明的公开端点，不附带任何第三方数据文件。

v1.3.0 新增 Bilibili Evolved 兼容组件，它是**同一套自研源码的另一种打包形态**：不引入、不复制、不执行任何第三方组件源码；仅按 Evolved 官方公开的组件元数据规范导出一个带 `entry` 的对象。完整 `/analyze` 聚合画像的维度与展示结构是对公开页面统计项的事实性清点，统计与分类逻辑全部由本项目 `lib/clean.js` / `lib/analyze.js` 在本机按可复核规则自行实现。

## 参考来源（仅用于确认端点与数据结构，未复制代码或数据）

- `SocialSisterYi/bilibili-API-collect`：WBI 签名算法与映射表的公开文档，仅用于实现签名逻辑。
- B 站公开 Web 接口：本插件运行时按用户主动操作读取公开数据，接口行为以平台实际返回为准；接口不属于本项目资产，也不受本项目许可约束。
- `Ikaros-521/nonebot_plugin_searchBiliInfo`：仅用于确认 Danmakus / ZeroRoku / vtbs.moe / matsuri.icu 的公开页面与接口 URL，未复制其源码或数据。
- `Huizs/bilibili-chengfen-query` 与 GreasyFork 用户脚本 599894：仅用于确认 `api.aicu.cc` 的评论检索路径，未复制其源码或数据。
- BiliScope 生态：仅参考「在 XXX 查看」这一交互形态；扩展未使用 BiliScope 源码、未打包其任何资源。
- `https://files.danmakus.com/danmaku-history.js`：Danmakus 提供的 B 站「弹幕历史」组件（基于 `@bevo/core` 组件机制，`commitHash b08ebfb…`、`coreVersion 2.7.0`）。仅用于核对 v2 端点形态与弹幕记录字段；**未复制、未打包、未在扩展中执行该脚本的任何代码**。核对结论见下节。
- Danmakus `/analyze` 页面前端 bundle（`index-Gs-v99FY.js`、`constants-D0n6zQLI.js`、`AnalyzeRangeMenu-lgDPV_W6.js`、`_uid-ik0L2c33.js`）：仅用于确认 API 基址、分析任务机制，以及页面**展示了哪些统计维度 / 指标名称**（概览、留痕构成、7×24 节律、频道偏好、表达风格、支持方式、五维分类、所涉直播间、原始样本）。未复制源码、未调用其 POST 分析任务、未采用其服务端模型输出或主观性格标签；分类由本项目在本机按公开统计规则计算，并逐项列出驱动指标。
- `the1812/Bilibili-Evolved`（`master` 分支）的 `CONTRIBUTING.md`、`src/components/types.ts`、`define.ts`、`component.ts`、`user-component.ts`、`src/core/external-input/load-feature-code.ts`、`src/core/install-feature.ts` 及 `registry/dist/components/utils/active-video-links.js`：仅用于确认用户组件的元数据字段、UMD 导出约定与加载机制。**未复制、未打包、未链接其任何源码或运行时**；组件不依赖 `coreApis`，`defineComponentMetadata` 为恒等函数，故直接导出普通对象。Evolved 的商标、源码与组件生态归其作者所有，本项目与其无隶属或授权关系。

## 多源站点公开数据

`src/lib/federated.js` 在用户主动点击「聚合画像」时，按 UID 读取以下站点的公开数据：Danmakus（`danmakus.com`、`api.ukamnads.icu`）、AICU（`api.aicu.cc`）、matsuri.icu、ZeroRoku（`zeroroku.com`）、vtbs.moe（`api.vtbs.moe`），以及 B 站官方资料（已在主画像采集，不重复请求）。v1.3.1 起为解析机构名，另读取 Danmakus 公开字典端点 `GET https://api.ukamnads.icu/api/v2/agencies/{uuid}`（24 小时本地缓存，间隔 300ms，失败保留原始 UUID 不重试）。

- 只做 GET 读取，不登录、不携带 Cookie（`credentials: 'omit'`）、不提交任何表单、不调用第三方 POST 分析任务、不绕过风控；命中 429 / 451 / 468 / 503 或 HTTP ≥ 500 时该站点冷却 60 秒且不重试。
- 只在本机缓存裁剪后的事实与证据片段（默认 60 分钟），不缓存整页 HTML，可一键清除；`federatedRedact` 开启后连第三方评论与弹幕原文也不写入缓存。
- 各站点的名称、商标与数据权益归各自运营方所有；数据口径、时效性与可用性不受本项目控制，本工具不对其准确性作任何担保，也不据此作身份认定。
- 上述站点与本项目无隶属或授权关系；使用前请自行评估其服务条款与适用法律的约束。
- **Evolved 组件形态**读取与上表完全相同的公开端点，但由用户已安装的脚本管理器通过 `GM_xmlhttpRequest` 发出，遵循其 `@connect` 授权策略；缓存写入本机 `localStorage`（`bililens:evolved:*`），不上传、不与扩展缓存同步。组件不申请扩展权限、不使用 `chrome.*`、不请求 `ukamnads.icu`。

## Danmakus 弹幕历史：官方组件核对结论（2026-11-08 实测）

`danmaku-history.js` 会在 B 站用户卡片、个人主页、动态主播卡与直播弹幕菜单注入「弹幕历史」面板，其请求为：

```text
GET https://ukamnads.icu/api/v2/user?uid={uid}&useEmoji=true&pageSize={n}&pageNum={page}   // pageNum 从 0 起
```

实测与本项目所用 v3 端点的关系：

| 项目 | v2 `/api/v2/user` | v3 `/api/v3/users/{uid}/history` |
| --- | --- | --- |
| 域名 | `ukamnads.icu` | `api.ukamnads.icu` |
| 场次列表 | `data.data.records[]` | `data.items[]` |
| 每场弹幕 | `danmakus[]` 扁平数组 `{uId, uName, type, sendDate, message, price?}` | `danmakus` 对象 `{actors, roomEmojis, records:[{ts, type, payload.rawText}]}` |
| 分页 | `pageNum`（0-based） | `page`（1-based） |
| `hideOnlyEnter` | 实测同样生效 | 生效 |
| `start/end` / `startTime/endTime` | 实测不生效 | 实测不生效 |
| 某样本 UID 的 `total` | 102（默认）/ 33（hideOnlyEnter=true） | 102（false）/ 33（true） |
| `channel` / `live` 字段 | 完全一致（`tags`、`fansCount`、`agencyUuid`、`watchCount`、`payCount` 等） | 完全一致 |

两者返回的是**同一批数据的不同序列化**：首条场次的主播、liveId、时间与弹幕文本逐字一致，总量口径也一致。

同时确认该组件脚本本身**已过时**，因此不能直接搬运：

- 它把 `data.data.records` 当作「弹幕数组」渲染，但服务端现在返回的是**场次列表**；弹幕文本在每场的 `danmakus` 数组里。
- 它读取 `data.data.watchedChannels`，实测该字段已不存在。
- 其 `DanmakuType` 枚举只到 9（`Block`），缺少 v3 的 10–13（警告 / 录制开始 / 录制中断 / 主播）。

本项目据此采取的处理：

1. 主通道继续使用 v3（枚举更完整、字段更规范），**不请求 `ukamnads.icu`，因此不新增该域名的 host permission**。
2. `parseDanmakusHistory()` 同时兼容 v2 的 `data.data.records` 容器与扁平 `danmakus[]` 结构，服务端改版或将来切换端点时解析器不会失效。
3. 从两个版本共有的 `channel` / `live` 字段中提取主播标签、粉丝量级、机构类型与直播规模，作为「所涉直播间画像」；界面与导出均明确标注**这些是目标用户出现过的主播与直播间的属性，不是该用户自身属性**。
4. 未使用 `useEmoji` 表情替换逻辑，也未采用任何服务端主观性格标签。
