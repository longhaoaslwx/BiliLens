/* BiliLens 详细报告载入页（v1.4.2 外置脚本：MV3 扩展页面 CSP 禁止内联 <script>） */
(async () => {
  const KEY = 'bl:reportTab';
  const status = document.getElementById('bl-status');
  const tip = document.getElementById('bl-tip');
  const hideSpin = () => { const s = document.getElementById('bl-spin'); if (s) s.style.display = 'none'; };
  try {
    const got = await chrome.storage.local.get(KEY);
    const html = got && got[KEY];
    if (!html) {
      hideSpin();
      status.textContent = '没有待展示的报告。';
      tip.textContent = '请回到扩展弹窗，在「多源数据」页完成聚合后点击「打开详细网页报告 ↗」。';
      return;
    }
    await chrome.storage.local.remove(KEY);
    // 用弹窗内联生成的完整 HTML 替换本页；CSS 已内嵌，无外部依赖。
    // 报告 HTML 不含任何脚本，仅内联样式，不违反本页 CSP。
    document.open();
    document.write(html);
    document.close();
  } catch (err) {
    hideSpin();
    status.textContent = '报告载入失败：' + (err && err.message ? err.message : String(err));
    tip.textContent = '请回到扩展弹窗重新点击「打开详细网页报告 ↗」。';
  }
})();
