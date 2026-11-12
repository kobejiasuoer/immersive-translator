# 沉浸口语官网

2026-11-05 重新设计后的升级预览在 `upgrade.html`，配套 `upgrade.css`、`mobile.css`、`upgrade.js`、`downloads.js`、`reading-demo.js`、`pretext-layout.js`、`pretext.js` 与 `assets/`。通过本地 HTTP 静态服务器预览，无需构建。直接双击分模块页面时，浏览器会阻止外部 ES module，普通交互仍有回退，Pretext 需要 HTTP 或独立内联设计稿。预览页带 `noindex`，尚未替换正式首页或部署。

当前版以可操作书摘为首屏，原有阅读、口语、复习改为可切换的界面细节。正文排版由本地 vendored Pretext 辅助计算，默认不可编辑，`?edit=1` 供设计稿改文案。支持深色与减少动态效果。设计、素材裁切与验证记录见 `../docs/website-reading-redesign-2026-11-05.md`。

用户视觉审查后的修正版：手机学习空间使用独立窄幅图并按自然比例完整显示；阅读、书架、口语与复习重新拍摄，清理旧素材中的浮层、裁字与空区；手机原型修正采集滚动与底栏模糊。中文字距改为0并用真实粗体，标题直白化，跟读／下载恢复深色，移动预告降为次级展示，演示说明集中到页脚。当前验收依据见 `../docs/website-visual-review-fixes-2026-11-05.md`，此前美感自评不作为验收结论。

第二版已按反馈精简：阅读、口语、复习合为可切换的实界面舞台，删除重复短语教学与长段功能说明，保留跟读反馈和个人材料。Windows 与 macOS 均有已核实的正式资产直链；可选 GitHub API 只在校验成功后更新对应平台，离线或 API 失败时保留直链。

2026-11-05 修复下载旧名称：v0.15.2 Release 已新增与原包字节一致的 `ImmersiveSpeaking` 下载副本，预览页四个直链已切换；`downloads.js` 优先采用通过完整校验的新名，兼容旧名。旧资产保留供既有自动更新使用。后续发布配置也已追加副本上传，需随本轮代码提交推送后才对下一次发版生效。详情见 `../docs/website-download-naming-2026-11-05.md`。

下载回归测试无需安装依赖，在仓库根目录运行 `node --test website/tests/downloads.test.mjs`。

2026-11-05 按宽屏观感反馈收紧预览：正文最大1120px、首屏最大880px、桌面主标题最大80px，并按较矮的桌面窗口进一步缩放。验证与边界见 `../docs/website-scale-adjustment-2026-11-05.md`。

移动端根节点 `#mobile` 的标记段与样式 `mobile.css` 独立，当前明确标开发中、原型预览，方便用户交给 Mac 上的 AI 补真实素材和实际发布渠道。交接见 `../docs/website-mobile-handoff-2026-11-04.md`。

界面素材来源见 `assets/screenshot-upgrade-provenance-2026-11-04.md`，设计与验证见 `../docs/website-upgrade-2026-11-04.md`。界面可放大，支持键盘与无脚本直接查看原图。

`index.html` 是单文件静态落地页，样式与交互脚本均内联。无需 npm 安装或构建，部署 `index.html` 与 `assets/` 即可。

- 主视觉和 Windows 功能以当前桌面前端为依据，截图使用演示资料。
- 手机端图片来自已确认原型，页面明确标注为预览，未提供手机端下载。
- 下载按钮默认进入 GitHub Release；可选 API 查询成功后指向最新 x64 安装包，查询失败仍保留可用链接。
- 字体使用系统字体，展示图片均为本地资源。无分析追踪脚本或登录表单。
- 修改官网文案时注意区分免费客户端与按额度提供的云服务、默认本地保存与用户主动开启的同步。

本地可直接用浏览器打开 `index.html`；建议通过任意静态服务器预览滚动交互。较矮的屏幕、触屏设备及“减少动态效果”模式均有对应布局。

素材出处见 `assets/screenshot-provenance.md` 和 `assets/mobile-provenance.md`。本轮设计与验证记录见 `../docs/website-redesign-2026-10-30.md`。

`_backup-ai-version.html` 与旧 `reader-room-*` 素材保留为历史文件，当前首页没有引用它们。
