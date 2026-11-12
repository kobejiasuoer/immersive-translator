# 官网书摘方向重新设计（2026-11-05）

用户明确否定了此前只缩小尺寸的页面，要求使用 design-html、design-taste-frontend 与 frontend-design 重新设计。当前结果覆盖 `website/upgrade.html` 预览，不替换正式首页或部署。

## 设计与内容

The product performs，seed **550246572**。把《夜莺与玫瑰》的一句真实书摘变成访客可展开译文、查看 rose 词义、打开练习提示的一页材料。随后用真实 Windows 组件的细节图证明阅读、口语和原句复习；跟读报告、书架、开发中的手机原型各自承担后续内容。

保留书页图标与墨绿品牌，主要背景为纸白 `#f7f9f6`、白色 `#ffffff` 和纸绿 `#e9f1e9`，关键动作绿 `#256d53`，正文墨绿 `#173c31`。中文用产品系统字体，英文书摘用 Georgia。主标题上限64px、手机40px，500字重；区块标题40px、正文17px、手机16px。

抽取后的调整与原因：字体控制 Hero 与语言学习无关，重抽为 Control that reads the page；输入标题示范不代表产品能力，showcase改为 Output index, live sheet；不存在对应的四五个配置开关，features改为 Fixed output, live controls；无创始人肖像或信件，about改为 Wide photo, colour tile, facts；无邮件收集后端，CTA改为 Plain sentence, one action。几何取关系而非照搬过长空场，避免重现用户已否定的巨大观感。

没有新增摄影、视频、AI生成图片、客户、成绩或收费数字。五张Windows截图仍是匿名夹具渲染的组件演示；两张手机图仍是原型。新增三张截图细节仅裁切，来源、框坐标见 `website/assets/screenshot-upgrade-provenance-2026-11-04.md`。首屏译文与开口问题是静态示例，不声称现场 AI 对话或评测。

Windows为学习客户端。macOS为独立菜单栏翻译版本，差异直接标在下载旁。保留免费开源客户端、云服务按额度、默认本地保存及原声不跨设备同步的事实。

## 实现

- `reading-demo.js` 在本地同步控件显示状态与ARIA；无JS仍有原句和译文。
- `upgrade.js` 沿用菜单、切图、大图和焦点恢复，只增加 `data-full-width` 识别原图尺寸，避免660px裁切缩略图被当成小原图。
- `pretext.js` 原样复制用户指定 design-html 的 vendored bundle（30,602B）。`pretext-layout.js` 使用 `prepare()`、`layout()`，等待字体，缓存已准备内容，计算 `min-height` 并保留原生换行。ResizeObserver仅在宽度变化时排队，避免高度回写循环；断点字体与文本变更重新测量。
- 默认文本不可编辑；`?edit=1` 开启普通段落编辑与MutationObserver重排。使用本地模块，无CDN依赖。
- `mobile.css` 和模块标记继续独立，供手机团队交接。
- 独立 `finalized.html` 内联样式、图片、经典脚本和Pretext，可直接双击；分模块网站应通过HTTP访问。经典脚本移至body末尾，Pretext按bundle真实导出名生成本地别名；源码插入使用replace回调，防止 `$&` 等替换语义破坏内联脚本。

独立稿按design-html约定保存在 gstack state root 的 `projects/kobejiasuoer-immersive-translator/designs/speaking-landing-20261105/`，有 `finalized.html` 和 `finalized.json`。生成脚本为工作区 `.taste-skill/finalize-reading-design-2026-11-05.mjs`。设计批准仍待用户反馈，未写入根目录 DESIGN.md。

## 实际检查

- 源码lint：0 FAIL / 0 WARN。
- 浏览器inspect：1440×900、768×1024、390×844，0 FAIL / 2 WARN。两项警告是没有摄影与视频；软件页以自身界面和可操作书摘证明能力，本次没有合适的实景素材需求。
- 下载单元回归：`node --test website/tests/downloads.test.mjs`，36/36通过。
- 最终 `concise-check.mjs`：6种尺寸的切图、普通/特写大图、焦点恢复、FAQ、菜单、下载、资源、锚点均通过；无JS、减少动画、file/API失败回退也通过，实际退出码0。
- 追加1920×921、1366×768、375×812、1024×768、800×800、801×800及深色1440×900：无横向溢出、缺图或Runtime错误，标题最多两行，三项书摘控件状态正确。
- 真网页Pretext编辑及尺寸重排：1440→768→390→320→1440正常；长中文编辑让段落29→144px，恢复原文后回到29px。
- 独立HTML最终离线验证：4个内联脚本语法检查通过；file URL的1440和390px均有6个段落初始化，编辑后增高与回缩、三项书摘控件、切图及原图解码正常；无外部CSS/JS/图片依赖、横向溢出或Runtime错误。最终HTML SHA-256为 `8c7a7c775a2b448d29429b3af80670e670ebcbe02f35bfab502e05bf9f92c27f`，1,088,939B。可选GitHub版本查询离线失败会保留下载回退，不属于渲染依赖。

截图与详细检查位于 `.taste-skill/redesign-final-2026-11-05/`。静态截图及fixture验证不能代替真实AI、语音服务或学习效果验收。

## 视觉复核

ROUND 1

Seen in one second: 可读的书摘，与下载入口共同说明产品。
Idea (one sentence): 同一条rose原句，接续译文、查词与开口提示。
Live thing: 译文、词义和练习提示切换，工作空间切图与原图查看。
Layout words by section: hero=书摘与说明 / experience=工作空间索引 / voice=反馈特写 / content=书架与材料 / mobile=错位双屏 / download=入口与说明。
Scores: design 7 · usability 8 · creativity 7 · content 8 → overall 7.4。
Caps applied: 无。
Top three problems: 中文标题过重（desktop-fold）；书摘底部空区较大（desktop-fold）；整窗截图工具栏与空列占用展示面积（desktop-page-01）。分别减为500字重、收紧面板、改为细节裁切。

ROUND 2

Seen in one second: 一页可操作的阅读材料，页面与书摘比例稳定。
Idea (one sentence): 延续原句成为开口材料的构思。
Live thing: 同上，实际回归通过。
Layout words by section: 延续六段内容结构，已查看桌面、平板、手机完整截图和深色首屏。
Scores: design 7.8 · usability 8 · creativity 7 · content 8 → overall 7.7。
Caps applied: 无。
Top three problems: 已修复上述三项；保留局部产品图的裁切与点击原图，手机原型仍需后续正式素材替换，用户的视觉认可待反馈。

检查器只证明规则和布局，不证明美感；上述评分为本次视觉自评。

本机未安装gstack的design生成二进制，未生成PNG mockup；直接设计HTML，再用已安装浏览器在三个尺寸检查并做两轮视觉复核。没有新增根目录DESIGN.md，也没有执行发布或改动应用。
