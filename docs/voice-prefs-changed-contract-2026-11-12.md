# 跨窗口语音设置事件契约：voice:prefs-changed

- 日期：2026-11-12
- 来源设计：`docs/voice-settings-merge-plan-2026-11-11.md` §5.3（事件协议原文）与 §5.2（入口A/B 职责划分）
- 参考实现：`immersive-translator-windows/src/lib/voiceSettingsHub.ts`（契约的单文件实现点）
- 性质：**跨端共同契约**。Windows 端已落地；Mac 端做语音页/阅读室联动时按本契约对齐，已回链 `docs/mac-parity-specs-2026-11-01/voice.md` 附录 A。
- 背景一句话：两个语音设置入口分属两个 Tauri WebView（settings / reader，同 origin 共享 localStorage），数据本就同源（唯一写点规则见设计 §5.2 对照表），本契约只补「写盘后的跨窗口通知」，不新增任何写点。

---

## 1. 事件与载荷

- **事件名**：`voice:prefs-changed`。Windows 用 Tauri 全局 `emit()`：广播到所有窗口，**包括发送窗自身**（回声，见 §2）。
- **载荷恰好三个字段，不带值**：

```jsonc
{ "scopes": ["voicePrefs"], "from": "settings", "rev": 1 }
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `scopes` | `("voicePrefs" \| "readerVoice")[]` | 变更范围登记表，见 §3 |
| `from` | `string` | 发送方窗口 label（`settings` / `reader` / `quick-review`…），回执方据此抑制回声 |
| `rev` | `number` | 发送方模块内单调递增计数（从 1 起），防乱序 |

- **不带值是硬性规定**：回执方一律重读存储取值。事件与存储之间存在竞态（写盘与投递异步交错），payload 里带值必然出现「事件值 ≠ 存储现值」的窗口；重读存储永远拿到写盘后的最新值。
- 类型定义与实现：`voiceSettingsHub.ts` 的 `VoicePrefsChangedPayload` / `VoiceSettingsScope`；广播函数模块私有，**没有绕过写 API 的裸广播口**。

## 2. 回执规则（订阅侧）

1. **重读存储**：收到事件后重读对应存储键，再刷新界面/缓存；不得使用事件里不存在的「值」。
2. **回声抑制**：`payload.from === 当前窗口 label` → 忽略。发送窗自己改了界面（自己写盘的），无需也无法靠事件自刷新。
3. **乱序防护**：同一发送方 `rev ≤ 已见最大值` → 忽略；**计数按 `from` 分桶维护**——各窗口的 rev 计数器互相独立，全局单一 lastRev 会把另一窗口的正常事件误判为旧事件。
4. **畸形载荷保守忽略**：缺字段、`rev` 非有限数、`scopes` 非数组等一律不回执、不抛错。
5. **监听器生命周期**：照仓内 `active + unlisten` 模式（先例 `SettingsDrawer.tsx` 挂载 effect、`XfyunVoiceSection.tsx` 的 creds-updated 订阅）；settings/reader 窗 hide 不销毁，组件常驻，卸载（窗口重建）时必须 unlisten 防重复回调。

## 3. scope 登记表与写点纪律（谁可以发）

| scope | 存储键 | 唯一写点 | hub 写 API |
|---|---|---|---|
| `voicePrefs` | localStorage `immersive-translator-settings` 的语音三字段（voiceProvider / voiceGatewayVoice / voiceGatewayIseEnabled） | 设置中心 → 语音（`applyVoicePrefs`，Settings.tsx） | `writeVoicePrefs`（包 `saveVoicePrefs` + 广播） |
| `readerVoice` | localStorage `immersive-translator-reader-settings` 全局键 | 阅读室（ReaderApp 双写路径） | `writeReaderVoice`（读-合并-整包写 + 广播；为 QuickReviewApp 等第三窗预留，Windows 现未接线） |

- **扩展纪律（最重要的维护约定）**：以后新增任何语音设置字段，必须进对应 hub 写 API + 在 `VoiceSettingsScope` 登记范围，漏了就复现「B 改完 A 不感知」。
- **诚实边界**：阅读室自己写 L1 全局键走 ReaderApp 既有「全局 + 文章覆盖」双写路径，**不经 hub、不发事件**（它是唯一写点且改完自窗即时生效）。因此 `readerVoice` 事件只在第三窗启用 `writeReaderVoice` 后才会出现——Mac 端复刻时二选一：维持「L1 唯一写点不发事件」，或把写路径统一收进 hub；**不允许出现「既直写又广播」的双路径**（会引入双写点）。
- **丢更新边界**：`writeReaderVoice` 是整包写（读-合并-写），两个 WebView 并发写同键存在丢更新窗口；只给第三窗低频偏好使用，阅读室抽屉不经此 API（设计 §4 弃方案二的理由）。
- **凭据同步不并入本事件**：讯飞凭据继续走既有 `xfyun:creds-updated`（DPAPI 命名 secret 九槽保存成功后广播），hub 不重复封装。两事件可同时订阅（Windows 抽屉就是双订阅）。

## 4. Windows 现状消费点（对齐参照）

- `ReaderApp.tsx`：`voicePrefs` → 热刷沉浸云音色缓存 `gatewayVoiceRef`（播放音色，替代渲染时现读）；`readerVoice` → 重跑 `loadGlobalReaderSettings` + `setGlobalSettings`（全局层热重载）。
- `SettingsDrawer.tsx`：订阅 `voice:prefs-changed` 与 `xfyun:creds-updated`（加登录态变化）合并成刷新信号 → 「当前链路」行 / 两处凭据徽标 / 音色来源 / 打分链投影重查重投影（三触发）。

## 5. Mac 落地要点（跨端对齐）

1. 传输层不必是同一 API：Windows 是 Tauri 全局事件；Mac 等价物是进程内通知（NotificationCenter / Combine 等）。**对齐的是 §1/§2 的协议语义**（payload 三字段、不带值、回声抑制、per-sender rev、重读存储），不是事件系统选型。
2. `from` 的语义改为「发送方视图/会话标识」，回声抑制同样成立（Mac 单进程无跨窗 localStorage 竞态问题更小，但「写完自己不回执」的纪律照守）。
3. 指路文案规则（设计 §6.2 言字卡）：只用用户能点到的名词——「设置 → 语音」「阅读室 → 阅读设置」；禁用「同步 / hub / 设置中心」等内部词。voice.md 验收清单 20 的 gateway/xfyun 行逐字文案不因本契约改动。
4. 验收基线：Windows 侧 `voiceSettingsHub.test.ts`（协议/回声/乱序/scope 过滤/卸载）、`SettingsDrawer.test.tsx`（三触发）、`GatewayVoiceSection.test.tsx`（B 侧只读投影）；Mac 补 Swift 侧同行为向量。

## 6. 变更记录

- 2026-11-12：初版。落地于 Windows P1–P3（hub 数据层 + 双入口接线 + B 侧投影），设计出处 `docs/voice-settings-merge-plan-2026-11-11.md`。
