# 移动端阅读重设计最终验收 · 2026-11-05

后续更新：缩写分句、存量学习记录迁移及英文语境帮助已完成，并于 2026-11-05 23:42 原位安装；实际英文请求、数据核对及场景口语重设计的最新状态见 [2026-11-06 收尾验收](mobile-reader-speaking-finish-2026-11-06.md)。下文记录 22:18 安装版本的历史验收，末尾两项实现边界已由后续记录更新。

本记录接续 [阅读重设计](reader-redesign-2026-11-05.md)。正式应用的书架、英文正文及按需帮助已落地，收尾版于 **2026-11-05 22:18（Asia/Shanghai）原位安装到 iPhone**。截至 22:21，已取得最终书架、正文、帮助面板截图；真机选词解释、实际释义查询、关闭返回和朗读面板展开均有实际操作证据。没有卸载应用或提交发版。

## 本次继续完成的工作

- 完成干净新闻副本的手机保存，核对正文、标题与原学习数据。
- 发现 07:42 安装包未包含晚两秒写入源码的 `!settled` 保护条件。最终重建已带入，取消后的旧翻译配置回调不会再更新阅读状态。
- 真机两次复现：选中 `domestic` 后点“解释”，选区与按钮消失，词典没有打开。原因是原生选区在 `click` 前折叠，文档级 `selectionchange` / `pointerup` 清掉 React 选文状态，使点击目标卸载。
- 修复后保留已确认的词句快照；明确点击解释才打开帮助，外部点击、滚动、关闭等清除快照。取消触摸不自动查询。词组、整句两个回归修改前失败、修改后通过，另覆盖取消触摸。
- 修正句子面板三处旧“点词”提示，统一为选中文字后点“解释”。给相邻的“查看中文意思”和“重新翻译”按钮增加 16px 间距，最终真机截图确认两者已分开。

## 手机实际操作

| 操作 | 观察结果 |
| --- | --- |
| 07:56 在导入确认页点击“保存并开始阅读” | 进入干净新闻正文，完整英文题名可见；数据新增一个独立副本，草稿清除 |
| 22:10 在正文双击选中 `domestic`，点击“解释” | 正确打开该词的词典，关联当前新闻第 1 句及已保存译文；修复前相同操作只会让按钮消失 |
| 在词典主动点击“查询释义” | 实际服务返回多项释义和例句；本次未点击收藏，不新增测试词条 |
| 关闭词典 | 返回同一英文正文和第 1 句位置，选文条清除 |
| 展开底部朗读控件 | 显示上下句、句子帮助、现有 0.85× 语速、手动查词和跟读；正文仍有可用阅读空间 |
| 打开“这句的意思”，主动查看已有中文意思 | 已保存译文正常显示，关闭面板回正文；整页英文没有切换为中文 |
| 22:19–22:21 打开最终安装版、续读、查看帮助后关闭 | 书架及正文正常；翻译按钮间距修正生效，退出面板后留在阅读页 |

22:10–22:16 的交互检查运行于 22:03 安装版；22:18 安装仅追加上述按钮间距。最后一版重新验签、核对全部内嵌资源，并直接检查了书架、正文、帮助及关闭链路。

截图均为真实 iPhone 镜像，不是原型：

- [最终书架](reader-redesign-2026-11-05/phone-library-final.jpg)
- [最终英文正文](reader-redesign-2026-11-05/phone-reader-final.jpg)
- [选词帮助](reader-redesign-2026-11-05/phone-word-help-final.jpg)
- [实际查询返回](reader-redesign-2026-11-05/phone-dictionary-result-final.jpg)
- [展开朗读](reader-redesign-2026-11-05/phone-player-final.jpg)
- [最终句子帮助](reader-redesign-2026-11-05/phone-sentence-help-final.jpg)

## 新闻副本与数据保留

干净新闻于 07:56:20 保存，ID 为 `import-24639361d293c7c076b5c810`。135 字符标题完全一致，正文为 **19 个句段、10 个自然段**；逐段及全文仅归一化 Unicode 空白后，与保存前的干净正文完全相等。原 19 篇章节 / 文章、13 个收藏、旧断点和译文均未改变。比对记录：`/tmp/codex-reader-redesign-saved-data-check-2026-11-05.json`。

晚上继续时用户已新增 5 篇内容并更新阅读进度，因此最终安装使用 **22:17:21 的最新备份**，不回退到早晨的 19 / 20 篇基线。22:19 安装后两个资料库全部 8 张表逐行相同，当前资料的 snapshot revision 均为 2637：

- 25 篇章节 / 文章、13 个收藏及全部原 ID 保留。
- 旧新闻仍为 30 个句段、断点索引 11；干净副本断点为 0，首句实际翻译结果保留。
- 阅读完成状态、个人译文、笔记、任务和录音数据均保留。
- 数据库章节 / 文章数量与书架按书籍聚合后的“12 项内容”是不同计数口径。

最终安装前备份：`/tmp/codex-reader-completion-final-before-2026-11-05/ApplicationSupport`。安装后备份：`/tmp/codex-reader-completion-final-after-2026-11-05/ApplicationSupport`。逐表证据：`/tmp/codex-reader-completion-final-data-2026-11-05.json`。这些是本机临时证据路径，截图和结论保存在本仓库文档中。

## 最终构建与安装

- 阅读回归 **35 / 35**，包括新增的词组、整句和取消触摸三项；`npx tsc --noEmit`、`npm run build` 及补丁检查通过。
- Xcode release 构建 `BUILD SUCCEEDED`；沿用原 DerivedData 与内部名称 `immersive-speaking`。构建日志：`/tmp/codex-reader-completion-native-build-final-2026-11-05.log`。
- 最终入口 `index-B1neyCGB.js`，样式 `index-BqRBaS1k.css`；全部 **8 项 JS / CSS 资源逐字节匹配 Brotli 解压内容，完整压缩 payload 均存在于最终可执行文件中**。`codesign --verify --deep --strict` 通过，通知桥仍在。证据：`/tmp/codex-reader-completion-final-assets-2026-11-05.json`。
- `devicectl` 返回 `App installed`，bundle ID 仍为 `com.kobejiasuoer.reader`；最终安装目录为 `870EF0F1-DB9B-4240-AB83-33611121ED44/immersive-speaking.app`。安装记录：`/tmp/codex-reader-completion-final-install-2026-11-05.json`；22:19 启动记录：`/tmp/codex-reader-completion-final-launch-2026-11-05.json`。
- [最终 IPA](../immersive-translator-mobile/src-tauri/gen/apple/build/arm64/沉浸口语.ipa) 已更新，全部 11 个 `.app` 文件与验签产物字节一致，ZIP 完整性通过。SHA-256：`9aa2660f5cb63f054c9f1c5aede0cf35d94bb3ef60dc3daeee966ba38ae1cffd`。证据：`/tmp/codex-reader-completion-final-ipa-2026-11-05.json`。

## 已知边界

- 新新闻的两处 `U.S.` 缩写被现有分句器错误拆开；完整正文及自然段未丢失，但逐句朗读和帮助可能在缩写处断开。本轮没有重新映射已保存的句子学习记录，仍需单独修复分句边界。因此“19 个句段”不表示 19 个正确语法句子。
- 当前词典主要提供中文释义，句子帮助提供按需中文意思；尚未集成原型设想中的完整英文语境解释 / 英文改述服务。
- 本轮验证了朗读面板操作及此前自动播放控制流，未将面板展开当作真实音质或完整连播听感验收。VoiceOver、每日定时通知实收仍没有新增实测证据。
- 好不好看仍需用户实际使用评价；这里记录已实现的设计及可复核操作，不把主观审美当成自动验收通过。
