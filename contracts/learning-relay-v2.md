# 移动端与 Windows 学习接力 v2

更新日期：2026-10-30。此文档描述当前实现，不替代服务端运行时校验。实现入口是 `packages/learning-core/src`、Windows `learning_store.rs` 与手机 `services/sync.ts`。

## 能力与传输

- 登录后先读取 `/v1/me/config` 的 `sync`：`protocolVersion: 2`、每集合 `schemaVersions/maxEntityBytes`、`maxPushEntities/maxPullLimit/maxBodyBytes/userQuotaBytes/contentChunkTargetBytes`。不支持的版本保留本地，不降级裁剪。
- 复用现有集合 `reading-articles`、`reading-vocab`、`notes`、`speak-scenarios`、`speak-sessions`、`speak-assessments`，增加不可变复习事件集合 `review-events`；使用已有通用实体表，不新增数据库表或迁移。
- 实体信封包含 `id/baseVersion/updatedAt/deleted/schemaVersion/originDevice/payload`；线路 `updatedAt` 为 ISO 字符串，本地为 Unix 毫秒。`deleted:true` 时线路 `payload:null`。游标是集合自己的服务端版本，不是时间戳。
- 首次全量与 staleCursor 恢复先暂存全部页面，最后一次事务替换实体与游标；保留本地 dirty 编辑。同批 push 原子拒绝时按冲突原因处理。
- 普通可变实体采用已有 LWW。练习任务采用下述回答并集与字段时钟合并；不可变复习事件同 ID 不同 payload 返回 `409 immutable_entity`，不得以 LWW 覆盖。ack 对应旧稿时保留在途的新编辑，吸收服务端版本并保持 dirty。
- `speak-sessions/speak-assessments` 当前每条 65,536 字节。超限完整记录保留本地并显示原因，不丢尝试、反馈或文字。Windows 同时按协商的实体数及 body 字节数拆批。

## 阅读正文

`reading-articles` 的 `schemaVersion:2` 载荷：

| kind | id | 必要字段 |
| --- | --- | --- |
| book | 书 ID | `v:2,kind,contentRevision,chapters[{articleId,...}]`，以及书名、顺序与进度等元数据 |
| article | 文章 ID | `v:2,kind,contentRevision,chunkIds[]`，以及原文章元数据；不重复内嵌正文 |
| content-chunk | `chunk:<articleId>:<revision>:<batchHash>` | `v:2,kind,articleId,contentRevision,sentences[]` |
| progress | `progress:<articleId>:<deviceId>` | `v:2,kind,articleId,deviceId,contentRevision,locator:{sentenceId,charOffset?},lastReadAt` |

正文版本以剥离音频、移除句子顶层派生 `id` 后的全部句子业务字段计算。对象 key 排序后做 FNV-1a 32 位，按 UTF-16 code units 遍历，输出 base36。分块 hash 覆盖该块实际句子，避免不同 chunk target 重用不同内容的 ID。缺块时不以半成品覆盖已有完整文章。定位句子的稳定 ID 默认为 `<articleId>:s<idx>`。中文翻译和词块变化会产生新正文版本。

## 生词与复习

`reading-vocab` 保留 `baseline`（真实旧 SRS）、`baselineRecall`（真实旧错题统计）、`generation` 及完整词条。`review-events`：

```ts
type ReviewEvent = {
  v: 2; id: string; wordId: string; deviceId: string; reviewedAt: number;
  kind: "grade" | "undo"; mode: string; generation?: string;
  grade?: "forgot" | "hard" | "good" | "easy";
  recall?: { bucket: "pass" | "wrong" | "trap"; answer?: string; expected?: string };
  supersedesEventId?: string; reversesEventId?: string; day?: string;
};
```

- 正常评分只追加 grade；改评新增带 `supersedesEventId` 的 grade；撤销新增带 `reversesEventId` 的 undo。不可变事件不允许 tombstone。
- 先按 `reviewedAt/id` 确定性排序、按 ID 去重并拒绝同 ID 不同内容，再处理改评/撤销和并发替代链。相同根评分的并发改评只算一次。
- 新增词条拥有新 generation，删除重加不会复用旧复习。旧词迁移为 `legacy-<addedAt 或 createdAt 或 0>`。缺 generation 的历史事件只在 legacy 代际读取归属，不改写原 payload。
- 四档沿用桌面算法：forgot 10 分钟、hard 1 天、good 3 天、easy 7 天；ease/reps/lapses 由共享 reducer 计算。不伪造历史事件。
- `day` 是完成事件的本地日期 YYYY-MM-DD，用于重建真实新复习日志。旧每日历史从真实迁移基线保留。

## 完整练习任务

采用 `speak-sessions`、schemaVersion 2，任务与全部 attempts 一起保存：

```ts
{
  v: 2, id, kind: "practice-task", scenario: "practice", difficulty: "medium", turns: [],
  createdAt, updatedAt, startedAt: createdAt, endedAt: updatedAt,
  task: {
    id, mode: "word" | "scenario" | "follow", title, reference, word?,
    source?: { articleId, sentenceIdx }, steps?, step, attempts, draft,
    status: "active" | "paused" | "completed", createdAt, updatedAt, skippedSteps?
  }
}
```

attempt 保存 ID、步骤、实际回答、状态、创建时间、冻结参考句、表达反馈、真实发音评测结果及 `clipId/deviceId` 引用。旧客户端写回不能剥离未知嵌套字段，或把任务当普通对话恢复。Windows 专用接力入口恢复原步骤/草稿/反馈，回原文句失败时保留快照。表达反馈只分析文字；发音分必须来自实际录音评测。

### 双端离线同时练习

- 共享实现 `practiceMerge.ts`：`stampPracticeTask(previous,next,at)` 仅为真正变化的叶字段生成逻辑时钟；`mergePracticeTask(existing,incoming)` 合并同任务；`mergePracticePayload(existing,incoming)` 合并同任务信封，不适用时返回 null。手机和 Windows 不各自定义合并规则。
- `attempt.id` 取并集、按 `createdAt/id` 稳定排列。不同回答完整保留，同一回答的文字、表达反馈和发音评测按叶字段独立合并，互不覆盖。数组值为一个原子字段；未知嵌套对象字段同样按叶字段保留。
- 信封、task、attempt 可带 `fieldUpdatedAt: Record<string,number>`，key 使用 JSON Pointer 叶路径（例如 `/feedback/message`，`~` 编码为 `~0`，`/` 编码为 `~1`）。旧根字段 key 兼容读取；无时钟时分别退回 task.updatedAt、attempt.updatedAt 或所属 task.updatedAt。新编辑时钟为 `max(now,previousFieldClock+1)`；从标量/数组提升为对象时，新子字段时钟另须大于祖先清除时钟，使同次结构变更正确可见。
- 同路径以字段时钟较大者为准；相等以 canonical JSON 值按 Unicode scalar 顺序稳定决胜。无值但有时钟表示显式清除，清除同钟优先。对象与标量类型冲突时，不可见的旧寄存器保存在 `fieldShadow: Record<JSONPointer,unknown>`，防止合并顺序改变结果；业务 UI 不直接编辑这些元数据。
- 取消录音必须把回答 ID 加入 `task.removedAttemptIds: string[]` 并移除显示记录。该集合单调并集、删除优先，不能用数组缺失表示取消。已删除的整任务信封不与 live payload 合并：任一侧 task tombstone 均优先，重新练习生成新任务 ID，避免离线旧稿复活。
- 增量拉取、全量替换、409 重推、本地旧稿保存以及 Rust SQLite 最终事务均执行合并。并集不同于服务端快照时保持 dirty、携服务端 baseVersion 重推；确认相同稿件后清 dirty。分页尚未完整成功时不提前应用部分快照。
- 删除优先以收到的显式 tombstone 为依据。服务端超过保留期清理 tombstone 后，全量快照仅有“缺失”，当前通用保留 dirty 策略仍可能重推长期离线旧稿；当前不宣称跨越保留期也永久防复活。要提供该保证需另行设计删除水位或保留策略，不能用客户端猜测缺失原因。

## 账号与本机录音

游客可本地阅读/收藏/复习。云翻译、语音、纠偏和同步在首次触发时登录，成功后恢复原动作。账号切换清理旧 UI，并让在途请求仅能写回捕获的账号空间；不把账号 A 数据迁到 B。查词登录只保留发起登录的同一词卡与取消信号；关卡、换词或普通切号不恢复旧查询。

登录时显示游客资料数量，由用户选择带入全部或仅带入当前任务/来源。源游客仓库在一次本机事务中移出所选数据，并写入绑定目标账号的 `local-guest-claims` 待恢复记录；目标仓库及本机录音迁移成功后才清除该记录。两个仓库之间不承诺单次原子提交，依靠目标合并幂等与账号绑定记录恢复；启动时在渲染主界面和同步前恢复当前账号已有记录，失败显示重试屏障，不清数据。其他账号不能采纳该记录，已消费资料不重复带入。

相同任务 ID 复用共享回答合并；未修改默认样文接纳游客有效版本。其他文章、笔记、生词等同 ID 内容差异保留确定性冲突副本，并映射文章来源、词条与复习引用；同 ID 不同内容的不可变复习事件拒绝认领并保留待恢复记录。已有旧批次时，后续登录明确确认的新任务/来源在同一源事务中并入该账号待恢复记录；启动恢复只处理旧批次，不自动认领新游客资料。取消发生在源事务提交前不消费资料，提交后则保留目标账号绑定记录待恢复；目标加载期间取消不发布目标账号空间。

音频以 PCM 分块先写源设备本机 SQLite，再处理转写/发音；中断前已提交的分块可恢复回听。音频字节、base64、路径或 blob 不进入同步载荷；仅同步 `clipId/deviceId`。另一设备明确说明原声仍在源设备。本机录音与文本反馈保存失败必须可见，不能以清空或假成功遮掩。

## 验证边界

共享 TS 测试与 Windows Rust 单测覆盖确定性复习、unicode revision、缺块、音频剥离、未知字段、超限保留、事务回滚、分页失败、冲突与在途编辑。正式发布仍需 Windows + iPhone + 实际服务端双设备回归；iPhone 的权限、音频中断、后台/锁屏、Keychain 和真机长文导入必须在 Apple 环境实测，不能用 TypeScript 检查代替。
