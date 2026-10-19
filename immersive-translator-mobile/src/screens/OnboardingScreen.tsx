/**
 * 首启 Onboarding（push，P1 #24）—— 三步：目标 → Key 可跳过进演示 → 进今天。
 * 纯排版无插画；可从「我的」重看（进入即 push onboarding）。
 */
import { useState } from "react";
import { actions, reviewStats, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";

export default function OnboardingScreen() {
  const nav = useNav();
  const onboarded = useApp((s) => s.onboarded);
  const st = useApp(reviewStats);
  const articles = useApp((s) => s.articles);
  const progress = useApp((s) => s.progress);
  const remindTime = useApp((s) => s.settings.remindTime);
  const [step, setStep] = useState(1);
  const [goal, setGoal] = useState("读外刊与原版书");
  const [key, setKey] = useState("");

  /* step3 预告按真实数据计算（demo 22 实化）：到期数、进行中的文章、提醒时间，不再写死「8 个 / 一篇 / 九点半」 */
  const hasReading = articles.some(
    (a) => progress[a.id] !== undefined && progress[a.id] < a.sentences.length - 1,
  );
  const readyLine =
    st.due === 0
      ? `今晚没有到期卡片 · 明晚 ${remindTime} 见`
      : `${st.due} 个生词到期 · ${hasReading ? "一篇读到一半的文章" : "还没有开始的文章"} · 今晚 ${remindTime} 见`;

  function finish() {
    actions.setSettings({ goal }); /* 第一步选择的目标落库（P-03） */
    actions.setOnboarded();
    nav.popAll();
    actions.setTab("today");
  }

  return (
    <>
      <div style={{ position: "absolute", top: "calc(env(safe-area-inset-top) + 14px)", right: 20 }}>
        <span className="meta num">{step}/3</span>
      </div>
      <div className="ob-stage">
        {step === 1 && (
          <>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div className="overline">第一步</div>
              <div className="serif" style={{ fontSize: 30, lineHeight: "42px", fontWeight: 600, marginTop: 8 }}>
                你想把英语
                <br />
                用在哪里？
              </div>
              {(
                [
                  ["读外刊与原版书", "阅读为主，生词管理优先"],
                  ["职场沟通", "会议、邮件与日常口语"],
                  ["备考冲刺", "雅思托福，真题节奏"],
                ] as const
              ).map(([t, d]) => (
                <button key={t} className={`ob-opt ${goal === t ? "on" : ""}`} onClick={() => setGoal(t)}>
                  <span className="ob-check">
                    <Icon name="check" size={13} />
                  </span>
                  <span className="grow">
                    <span className="t" style={{ display: "block" }}>
                      {t}
                    </span>
                    <span className="d" style={{ display: "block" }}>
                      {d}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <button className="btn" onClick={() => setStep(2)}>
              下一步
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div className="overline">第二步</div>
              <div className="serif" style={{ fontSize: 30, lineHeight: "42px", fontWeight: 600, marginTop: 8 }}>
                连上你的
                <br />
                模型服务
              </div>
              <div className="meta" style={{ marginTop: 10 }}>
                填入任一服务商的 Key 即可；Key 只存钥匙串。
              </div>
              <input
                className="input"
                style={{ marginTop: 18 }}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
              />
              <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", marginTop: 12 }} onClick={finish}>
                先跳过，用演示数据转一圈
              </button>
            </div>
            <button
              className="btn"
              onClick={() => {
                if (!key.trim()) {
                  /* 空 Key 不静默放行：提示可跳过，停在本步（P-04） */
                  toast("未填写 Key · 可跳过");
                  return;
                }
                /* Key 走唯一写入口 setApiKey（真机 secret_put 入钥匙串，成功才 keyStored=true；
                   失败明文兜底不丢）。此前直写 setSettings({apiKey, keyStored:true}) 绕过钥匙串，
                   persistable 又把明文剔除——Key 既没进钥匙串也没落盘，重启即丢（治 shell-1）。
                   连接状态留给设置页的「测试连接」真实验证，不再假装已连上 */
                actions.setApiKey(key.trim());
                actions.setSettings({ conn: "idle", connMsg: "" });
                setStep(3);
              }}
            >
              连接并继续
            </button>
            <button
              className="tlink"
              style={{ marginTop: 12, alignSelf: "center", fontSize: 14 }}
              onClick={() => setStep(1)}
            >
              上一步
            </button>
          </>
        )}
        {step === 3 && (
          <>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div className="overline">准备完成</div>
              <div className="serif" style={{ fontSize: 30, lineHeight: "42px", fontWeight: 600, marginTop: 8 }}>
                今天该读什么、
                <br />
                该复习什么，
                <br />
                都替你排好了。
              </div>
              <div className="meta" style={{ marginTop: 12 }}>
                {readyLine}
              </div>
            </div>
            <button className="btn" onClick={finish}>
              进今天
            </button>
          </>
        )}
      </div>
      {onboarded && (
        <button className="tlink" style={{ position: "absolute", top: "calc(env(safe-area-inset-top) + 14px)", left: 20, fontSize: 15 }} onClick={() => nav.pop()}>
          关闭
        </button>
      )}
    </>
  );
}
