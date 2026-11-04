/**
 * 首启页（proto-parity-2026-11-01，对照原型 VIEWS.welcome html:1972-1978）：
 * 内容自顶部排布——品牌头（monogram 圆章 + 沉浸口语 + 副题）、eyebrow「每天，一小步」+
 * 衬线英文主标题 Read a little. Say a little.、入门卡（chip + 5 个短句 + A Small Break +
 * take a break 高亮例句 + 01/02/03 三步）、动作区（主按钮 + 本机说明 + 登录接续 + 创建账号）、
 * 底部「隐私与本机保存 · 了解同步」下划线脚注。
 * 业务链路不变：先体验一篇短文 → setOnboarded + 推入学习方向页；登录接续/创建账号仍走
 * ensureAccount（intent=relay/new，引导流登录为全屏推入页）。
 */
import { useState } from "react";
import { actions, flushPersist } from "../store";
import { ensureAccount } from "../services/authGate";
import { useNav } from "../ui/nav";
import { Icon } from "../ui/icons";
import { openGoal } from "../components/account/goalGate";
import { PrivacySheet } from "../components/account/PolicySheets";
import { SyncRulesSheet } from "../components/account/SyncRulesSheet";

export default function OnboardingScreen() {
  const nav = useNav();
  const [error, setError] = useState("");
  const [foot, setFoot] = useState<"privacy" | "sync" | null>(null);
  async function begin() {
    try {
      actions.setOnboarded();
      actions.setTab("today");
      await flushPersist();
      nav.popAll(); /* MeScreen「重看首次引导」以 push 进入时清栈；空栈时为空操作 */
      openGoal("onboarding");
    } catch (e) { setError(String(e)); }
  }
  return <main className="learning-onboarding">
    <div className="ob-brand">
      <span className="seal">I</span>
      <div><b>沉浸口语</b><small>从读懂一句，到自然说出口</small></div>
    </div>
    <div className="ob-intro">
      <span className="ob-eyebrow">每天，一小步</span>
      <h1>Read a little.<br />Say a little.</h1>
      <p>先读一篇短文，再用刚学到的表达说一句。</p>
    </div>
    {/* 入门卡（原型 html:1975）：chip + 右上句数、衬线标题、例句高亮、三步序号 */}
    <article className="learning-card ob-starter">
      <div className="ob-starter-top"><span className="learning-tag">入门 · 2 分钟</span><span className="ob-muted">5 个短句</span></div>
      <h2>A Small Break</h2>
      <p className="ob-starter-sent">Every afternoon, I <span>take a break</span> from work.</p>
      <p className="ob-muted">每天下午，我都会暂停工作，休息一会儿。</p>
      <div className="ob-steps"><span><b>01</b> 读一句</span><span><b>02</b> 记一个表达</span><span><b>03</b> 说一句</span></div>
    </article>
    <div className="ob-actions">
      {/* 主按钮带摊开书页图标（原型 v2Button(`${I('book','sm')}先体验一篇短文`,…,'primary block')） */}
      <button className="btn" onClick={() => void begin()}><Icon name="bookopen" size={15} />先体验一篇短文</button>
      <p className="ob-caption">先不用注册 · 学习记录保存在这台手机</p>
      <button className="btn-ghost" onClick={() => void ensureAccount({ kind: "relay", reason: "使用电脑端的同一个账号。确认登录后再读取学习记录。" })}>已有电脑端记录？登录接续</button>
      <p style={{ textAlign: "center" }}><button type="button" className="tlink" onClick={() => void ensureAccount({ kind: "new", reason: "手机可以独立开始，账号帮助你在不同设备接着学。" })}>创建账号，让学习跨端接续</button></p>
    </div>
    <div className="ob-legal">
      <button type="button" className="tlink" onClick={() => setFoot("privacy")}>隐私与本机保存</button>
      <span>·</span>
      <button type="button" className="tlink" onClick={() => setFoot("sync")}>了解同步</button>
    </div>
    {error && <p role="alert" className="learning-error">{error}</p>}
    {foot === "privacy" && <PrivacySheet onClose={() => setFoot(null)} />}
    {foot === "sync" && <SyncRulesSheet onClose={() => setFoot(null)} />}
  </main>;
}
