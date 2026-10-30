# 官网重新设计与验证记录

日期：2026-10-30。

## 需求与范围

根据当前 Windows 代码与界面重做 `website/index.html`。用户补充要求：视觉与动画更鲜明，按已确认手机原型介绍移动端，页面文字尽量少。

范围仅为 `website/` 展示页面、图片及本文档。不修改 Windows / mobile 业务代码、版本、应用更新链路或商店流程；未执行线上部署。

## 内容依据

| 页面主张 | 项目依据 |
| --- | --- |
| 阅读内容可带入口语与复习 | Windows ReaderApp、ReadingView、SpeakView、VaultPage 与 ReaderTopBar |
| 支持自己的书、文档与网页 | bookImport、fileImport、ImportDialog；PDF 限带文本层，DOCX 不等同旧 DOC |
| 登录沉浸云或配置自己的 API Key | Settings、VoiceSettingsTab、voiceRoute；服务受额度与开放能力约束 |
| 本地默认存储、主动开启同步 | `docs/privacy-policy.md`；没有改政策正文 |
| 手机端仅展示原型 | `prototypes/mobile-accepted-2026-10-29.html` 与移动端执行文档，无已核实公开下载入口 |

线上旧页仍有 MIT、需自备所有 API Key、数据绝不上云等过时说明。新版改为 AGPL-3.0，主推 Windows，区分客户端与云服务，不承诺所有平台功能一致。

## 视觉与交互

使用 design-taste-frontend。抽取方向为 **Colour chapters**，seed **1058384896**。取当前护眼界面的绿与浅色、深绿主视觉；复用现有品牌图。使用系统字体，不依赖外部字体 CDN。

构思：把沉浸口语的“阅读 → 口语 → 笔记与复习”三个真实入口变为可滚动切换的界面章节。访客也可以直接点击入口切换演示画面。

原生成方案的超大独立控件无法代表完整产品，因此 showcase 改为实界面切换；下载区取消无后端的表单，采用真实 Release 按钮；footer 删除缺少事实依据的城市、时间、邮箱块。用户追加要求后补充手机原型章节和三维动效，文案收敛为标题与短句。

- 首屏两行大字入场；产品画面随鼠标轻微转动。
- 大屏且高度足够时固定阅读展示，随滚动切换阅读、口语、复习并缩放画面。
- 短屏电脑与触屏设备采用普通滚动，可直接点击切换。
- 手机原型随滚动由扇形向平行画面收拢；小屏采用独立堆叠排版。
- 分节入场使用 transform / opacity，无页面整体背景渐变或滚轮劫持。
- 保留减少动态效果、无 JavaScript 阅读与下载、原生 details FAQ。

## 素材与真实性

Windows 四张 WebP 直接渲染当前 React 组件，学习文章、练习内容与分数使用隔离演示数据。原生窗口抓图工具两次超时，因此没有将这些图标为原生端实拍，也没有使用私人学习资料或调用 AI / 麦克风。完整来源见 `website/assets/screenshot-provenance.md`。

移动端四张 WebP 从确认原型直接渲染，首页使用阅读、练习、复习三张，标注“原型预览”。完整来源见 `website/assets/mobile-provenance.md`。

`site-share-2026.png` 为本轮生成的 1200×630 分享图，Open Graph 与 Twitter 元数据均使用域名绝对 URL。无外部图库或视频资产，不存在图库作者署名或授权待补问题。

## 实际验证

- 源码 lint：0 FAIL、0 WARN。
- 浏览器视觉检查：1440、768、390 三种宽度，0 FAIL；保留 2 个可解释 WARN（无实景摄影、无视频）。本页以真实前端画面和滚动变换证明软件能力，不添加与产品无关的照片或背景视频。
- 六组浏览器功能检查：1440×900、1366×768、1440×700、768×1024、390×844、320×812；无横向溢出、图片加载失败或 Runtime 异常，场景切换、FAQ、手机菜单通过。
- 定向复测：1440×850、1440×900 固定展示中图片与说明完整可见；1366×768、1440×700 取消固定，内容可达。
- 手机扇形动画修复：入场动画结束后释放 transform，实际计算值随滚动变化。
- 减少动态效果：无动画、无固定展示、主视觉三维变换关闭。
- 直接 file URL 与禁用脚本：正文、图片、原生 FAQ、普通下载链接可用。
- 模拟 GitHub API 失败：下载保留普通 Release 链接。线上 Release API 另已确认当前 v0.11.1 存在 x64 安装包；页面不硬编码此版本。
- Git diff 空白检查通过。

浏览器报告与过程截图在本机 `.taste-skill/`，不属于静态部署资源。

## 视觉复盘

ROUND 1

Seen in one second: 深绿上的两行大字与阅读界面。

Idea: 实际学习入口变成连续的界面章节。

Live thing: 点击或滚动切换 Windows 场景。

Layout words by section: hero=透视双栏 / Windows=固定界面 / 内容=横幅与大图 / 口语复习=不等比例拼接 / 手机=扇形 / FAQ=折叠列表 / 下载=大字与动作 / footer=品牌收尾。

Scores: design 7.5 · usability 7.0 · creativity 7.5 · content 8.0 → overall 7.4。

Top three problems: 短屏固定展示截断；手机入场覆盖后续变换；平板首屏空白偏大且截图过小。分别通过高度条件、释放 transform、平板普通滚动与整行截图修复。

ROUND 2

Seen in one second: “读进去，说出来”与实际产品画面。

Idea / Live thing / Layout: 保持前述构思，补充鼠标产品透视反馈。

Scores: design 7.8 · usability 8.2 · creativity 7.6 · content 8.5 → overall 8.0。

Caps applied: 无；摄影、视频两项警告按软件实界面展示解释。

剩余限制：平面截图没有演示真实录音过程；手机端仍需真实设备与公开发布验收。页面已经清楚区分原型、演示资料和可下载产品。
