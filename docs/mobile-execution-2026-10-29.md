# 移动端实施与原型验收跟踪

更新：2026-10-30。当前为可本地运行、继续联调的实现，尚未完成 iOS 归档签名和发布验收。

## 基准与边界

原型：prototypes/mobile-accepted-2026-10-29.html，来自用户确认的 D:/Chrome-Downloads/code_artifact_optimized.html。
SHA-256：2D2A172E7BC9D3DC472DAEA82357CB8CB7C2C743097380417123CB920F755FDA。
以原型末尾最终覆盖实现为视觉与交互参考。模拟识别、评分、同步不作为真实业务结果。

- iPhone + Windows；Tauri 2 / React / Rust；服务端 D:/workspace/immersive-translator-server 为 NestJS / Fastify / Prisma。
- 阅读 / 口语 / 笔记与复习三标签；保留半透明玻璃导航、拖动气泡和来源恢复。
- 游客本地试读/收藏/复习；云翻译/语音/纠偏/同步前邮箱登录，成功恢复原动作，取消保留来源与草稿。
- 游客资料展示数量后确认带入；换号隔离，退出保留账号本机资料。原声仅录制设备保存，允许临时云处理，不跨端同步。
- 表达反馈基于确认文字，不生成发音分；原句跟读真实ISE使用录制时冻结原句。结果未知不自动重发，不承诺计费exactly-once。
- SRS沿用10分钟/1天/3天/7天，评分与撤销采用不可变事件。
- 手机粘贴/URL预览/公共EPUB/RSS；个人EPUB/PDF由Windows规范化章节后接力。

旧 docs/mobile-implementation-plan.md 的2026-09-12 spike范围不能替代本次确认范围，尤其是账号和云能力。

## 原型 → 实现 → 验收

自动回归指本机确定性测试，不等同于iPhone、生产接口或两台物理设备验收。

| 原型交互 | 已实现与验证 | 待验收或限制 |
| --- | --- | --- |
| 首次打开/游客 | 持久化启动屏障、真实空历史、样文、三标签；迁移/恢复/主路径回归 | 真机冷启动/断网 |
| 玻璃导航/气泡 | 26%亮色玻璃、8px blur、拖动/吸附/取消；11项组件/CSS回归；390×844浏览器左右拖动 | WebKit滚动/安全区 |
| 阅读/收藏/回源 | 稳定来源、原句发起练习、词条维护、回原文；正文协议和主路径回归 | 物理双端同章同句 |
| 导入/预览 | 粘贴、设备URL提取、可编辑预览、SHA去重、完整末句、草稿恢复；切号/迟到回归 | 真实站点CORS/反爬 |
| 发现内容 | 公共EPUB校验/完整章节/确认、RSS订阅/摘要标记；11项回归 | 公共目录可用性、长书真机性能 |
| 登录/带入 | OTP/密码、刷新单飞、Keychain、明确claim、身份隔离；跨仓库pending恢复、连续认领、冲突副本与取消发布保护；26项账号/仓储回归 | 实际邮件/Keychain/真实账号 |
| 三类口语 | task/step/attempt/draft持久化、录音、ASR确认、文字建议、真实ISE、跳过/重说/完成 | 真实服务商/付费用量、iPhone路由/中断 |
| 原声回听 | 身份分区WAV、分块提交/恢复、播放互斥；17项PCM与原生回归 | Apple备份排除/文件保护仍需实现，真机锁屏 |
| 纠偏/笔记 | attempt引用、建议幂等收藏、显式保存、草稿隔离；13项React+IDB回归 | 原生键盘/长文本 |
| 复习/撤销 | 共享SRS、稳定事件ID、补偿undo、崩溃恢复、同日连续天数去重；故障注入 | 双端离线评分实测 |
| Windows接力 | 正文manifest/分块、设备进度、词条/笔记/任务、专用练习页；TS/Rust回归 | Windows+iPhone+实际服务端 |
| 同任务并发 | attempt并集、独立字段时钟、取消墓碑、合并回推；嵌套结构转换收敛，隐藏字段剥离音频 | 物理双端离线验证；65,536字节超限保留本机报错 |
| 翻译/字典/取消 | 账号配置与reqId快照、原生按请求取消、迟到结果隔离；25项生命周期与9项真实词卡登录续接回归 | 真机后台/网络切换 |
| 搜索/设置/提醒/导出 | 既有入口、来源定位、权限请求、文字资料导出 | 真机提醒/系统分享面板；导出无录音 |
| Safari分享接收 | 未实现Share Extension/App Group；现有插件是向外分享 | Mac实现/签名/恢复/去重验收 |

## 代码入口

- 手机：immersive-translator-mobile/src/App.tsx、ui/GlassNav.tsx、ui/learning.css；screens/LearningHome、LearningImport、LearningDiscover、LearningPractice、AccountScreen、ReaderScreen、ReviewScreen。
- 账号/同步/草稿：src/services/cloud.ts、authGate.ts、sync.ts、src/core/useLocalDraft.ts、src/store.ts。
- 原生：src-tauri/src/persistence.rs、audio_store.rs、mobile_http.rs、keychain.rs、request_cancellation.rs。
- 共享：packages/learning-core/src；协议：contracts/learning-relay-v2.md。
- Windows：src/reader/PracticeRelayView.tsx、src/lib/learningRelay.ts、syncEngine.ts、src-tauri/src/learning_store.rs。
- 服务端：apps/api/src/modules/accounts/accounts.service.ts、apps/api/src/modules/sync，协商v2并兼容旧客户端。

## 实际验证记录

### 手机

目录 D:/workspace/immersive-translator/immersive-translator-mobile。命令均实际运行；协议响应受控，不调用付费服务。

| 命令 | 结果 |
| --- | --- |
| pnpm run build | 最终TypeScript+Vite成功，108 modules；主chunk570.25kB，有拆包与store动态/静态混用提示 |
| pnpm run storage:test | 8通过 |
| pnpm run discovery:test | 11通过 |
| pnpm run sync:test | 23通过，含并发回答/独立反馈发音/删除/在途编辑，以及fieldShadow/JSON Pointer隐藏音频入站与回推剥离 |
| pnpm run auth:test | 26通过，含真实IndexedDB认领、A→B隔离、IO/commit失败、重启恢复、冲突幂等、target加载时取消、旧pending与新确认任务连续认领 |
| pnpm run dict-login:test | 9项真实React词卡回归通过，含登录后同卡续查一次、取消/换词/关卡、不发布已取消的账号空间 |
| pnpm run audio:test | 17通过 |
| pnpm run draft:test | 13真实React+IndexedDB回归通过 |
| pnpm run translate:test | 25通过，含reqId取消/AbortSignal/切走再回同账号 |
| pnpm run nav:test | 11真实组件/CSS回归通过 |
| pnpm run smoke | 18通过且正常退出；游客无网络请求/假评分/假历史 |
| cargo check --offline --manifest-path src-tauri/Cargo.toml | 通过；旧edge_tts.rs unused_mut警告 |
| cargo test --offline --manifest-path src-tauri/Cargo.toml --lib | 58通过/4忽略/0失败，忽略项为真实外部语音探针 |

原生取消9项已包含在58项内；早期仓储/音频独立harness10项通过不重复累计。
账号恢复修复落地后，build、auth23、dict-login9、translate25、draft13、sync23、smoke18实际运行通过；最后连续认领仅改store与auth回归后，再次执行build、auth26、dict-login9、smoke18通过。
浏览器 http://127.0.0.1:1420/、390×844实际核对三标签/气泡左右拖动/玻璃计算样式/练习重载恢复/取消登录保留输入/完整末句/导入预览重载恢复，没有提交云请求。

### Windows

- tsc --noEmit / vite build通过。全量Vitest --maxWorkers=2：81files/1131passed/8skipped；另接力组件2项通过。
- 首次高并行恰逢Rust编译，两项文档解析触发原有5秒超时；隔离文件25/25、降低worker后全量通过。
- cargo test --lib：147passed/2ignored（需本机8090真服务端）。
- 最终同任务合并回归：Vitest 4 files / 68 passed（practiceMerge20、learningRelay14、sync30、接力UI4）；覆盖729组类型转换结合律、对象往返、叶时钟、attempt并集、删除、在途编辑和隐藏字段音频剥离。随后 tsc / vite build 成功（557 modules），Rust learning_store 14项通过。较早全量与本轮针对性回归分别列示，没有把旧全量冒充最终版本全量。

### 服务端

目录 D:/workspace/immersive-translator-server/apps/api。

1. node node_modules/@nestjs/cli/bin/nest.js build：exit0。
2. node node_modules/jest/bin/jest.js --selectProjects unit --runInBand src/modules/sync src/modules/accounts：4suites/46tests通过。
3. PowerShell设置 $env:E2E_EMBEDDED_PG='1'，node node_modules/jest/bin/jest.js --selectProjects e2e --runInBand --testTimeout=60000 test/sync.e2e-spec.ts：19通过/1失败。
4. 同命令加 --testNamePattern='集合白名单'：1通过/19跳过。

环境：embedded PostgreSQL17.5.0-beta.15、RedisMemoryServer、临时测试库初始化既有12迁移，未迁移生产库。
首次失败在66KiB history载荷：PostgreSQL PortalContext申请67,585字节OOM，预期HTTP200实得500；单项重跑通过。不能合写成全套20/20一次通过，发布前需稳定数据库重跑。Jest既有hookTimeout未知选项提示仍在，实际命令testTimeout=60000。

## 运行与发布

进入immersive-translator-mobile，运行 pnpm dev --host 127.0.0.1 --port 1420，访问 http://127.0.0.1:1420/。
浏览器只验证UI/IDB，Keychain和原生网络/音频需Tauri。未写入假结果/测试密钥或替换用户配置。

顺序：服务端兼容升级 → Windows → iPhone TestFlight。当前未提交Git/部署/调用付费服务，保留原有修改。

发布前剩余工作见 immersive-translator-mobile/docs/native-release-checks-2026-10-29.md：

1. Mac实现并验证录音备份排除/文件保护，包括旧文件迁移和改名后属性。
2. Safari接收Share Extension/App Group及有界交接队列，进程终止恢复/去重。
3. Mac/Xcode归档签名，iPhone权限/路由/中断/锁屏/键盘安全区，真实邮箱/服务商/物理双端。

上述不能用Windows编译或浏览器测试替代，本次代码交付不能描述为可直接上线。

长期离线边界：显式 tombstone 收到时删除优先；超过服务端 tombstone 保留期后，全量缺失仍保留 dirty 旧稿并可能重推。当前未提供跨保留期永久防复活保证，协议说明见 contracts/learning-relay-v2.md。
