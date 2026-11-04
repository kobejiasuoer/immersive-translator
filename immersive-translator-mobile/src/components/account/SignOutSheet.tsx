/**
 * 退出账号确认抽屉（account-onboarding-parity，文案对照原型 SHEETS.logout）：
 * 本机记录保留文案 + 「继续使用账号」取消。
 * 确认后的动作（logout + switchProfile("guest") + setOnboarded）由调用方执行，与本组件解耦。
 * 复检 2026-11-01（原型 html:2033 + prototype/sheet-logout.png 结构逐项对位）：
 * · 说明文案 = v2Hint → .v2-inline-note 灰底内联说明框（不是裸段落）；
 * · 「退出账号，保留本机记录」= v2Button(…,'block') 普通 .btn（surface 底描边 pill，html:119）→ App .btn-ghost；
 * · 「继续使用账号」= .v2-link.v2-full-link 居中文字链 → App tlink ob-full-link（与 LoginSheets 同一映射）。
 * 浏览器采集无真实账号、此抽屉不可达（AccountScreen 入口仅 account 存在时渲染），以源码对照为证据。
 */
import { SheetShell } from "./SheetShell";

export function SignOutSheet({ busy, onConfirm, onClose }: { busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return <SheetShell label="退出账号确认" title="退出这个账号？" onClose={onClose}>
    <div className="v2-inline-note" style={{ marginTop: 0 }}>当前账号的阅读位置、收藏与笔记会保留在这台手机。重新登录同一账号后可以继续；退出后会切换到本机试用。</div>
    <button className="btn-ghost" disabled={busy} onClick={onConfirm}>退出账号，保留本机记录</button>
    <button type="button" className="tlink ob-full-link" disabled={busy} onClick={onClose}>继续使用账号</button>
  </SheetShell>;
}
