# 沉浸口语官网

`index.html` 是单文件静态落地页，样式与交互脚本均内联。无需 npm 安装或构建，部署 `index.html` 与 `assets/` 即可。

- 主视觉和 Windows 功能以当前桌面前端为依据，截图使用演示资料。
- 手机端图片来自已确认原型，页面明确标注为预览，未提供手机端下载。
- 下载按钮默认进入 GitHub Release；可选 API 查询成功后指向最新 x64 安装包，查询失败仍保留可用链接。
- 字体使用系统字体，展示图片均为本地资源。无分析追踪脚本或登录表单。
- 修改官网文案时注意区分免费客户端与按额度提供的云服务、默认本地保存与用户主动开启的同步。

本地可直接用浏览器打开 `index.html`；建议通过任意静态服务器预览滚动交互。较矮的屏幕、触屏设备及“减少动态效果”模式均有对应布局。

素材出处见 `assets/screenshot-provenance.md` 和 `assets/mobile-provenance.md`。本轮设计与验证记录见 `../docs/website-redesign-2026-10-30.md`。

`_backup-ai-version.html` 与旧 `reader-room-*` 素材保留为历史文件，当前首页没有引用它们。
