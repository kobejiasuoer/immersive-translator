/**
 * 练（Tab 2）—— §3.2：三个「开口」功能的家 + 最近会话。
 * 缺讯飞凭据 → 行尾 warn「需配置」深链「我的 → 语音服务」（#22 降级，不阻塞）。
 * 最近会话读真实存档（sessions.ts，治 P-40 假列表）；无记录显示引导句。
 */
import { useApp } from "../store";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";
import { sessionWhen, useSpeakSessions } from "../core/sessions";
import { SHADOW_MAX_SENTS } from "../core/shadowState";
import { DEMO_TREES } from "../core/demo";

export default function PracticeScreen() {
  const nav = useNav();
  const voice = useApp((s) => s.settings.voice);
  const articles = useApp((s) => s.articles);
  const sessions = useSpeakSessions();
  /* 句源口径与 ShadowScreen 一致：书架第一篇（空兜底种子文章），单轮上限 6 句 */
  const shadowCount = Math.min(SHADOW_MAX_SENTS, (articles[0] ?? DEMO_TREES).sentences.length);

  return (
    <div>
      <div className="h1">练</div>
      <div style={{ marginTop: 6 }}>
        <button className="prow" onClick={() => nav.push("scenes")}>
          <span className="ic">
            <Icon name="chat" size={22} />
          </span>
          <span className="grow">
            <span className="tt" style={{ display: "block" }}>
              口语陪练
            </span>
            <span className="dd" style={{ display: "block" }}>
              4 个场景 · 按住说话，AI 陪你开口
            </span>
          </span>
          <Icon name="right" size={16} />
        </button>
        <button className="prow" onClick={() => nav.push("shadow")}>
          <span className="ic">
            <Icon name="wave" size={22} />
          </span>
          <span className="grow">
            <span className="tt" style={{ display: "block" }}>
              影子跟读
            </span>
            <span className="dd" style={{ display: "block" }}>
              {shadowCount} 句一轮 · 不达标词级标红
            </span>
          </span>
          {!voice && (
            <span
              className="warn-chip"
              onClick={(e) => {
                e.stopPropagation();
                nav.push("setVoice");
              }}
            >
              需配置
            </span>
          )}
          <Icon name="right" size={16} />
        </button>
        <button className="prow" style={{ borderBottom: 0 }} onClick={() => nav.push("caption")}>
          <span className="ic">
            <Icon name="clip" size={22} />
          </span>
          <span className="grow">
            <span className="tt" style={{ display: "block" }}>
              录音直译
            </span>
            <span className="dd" style={{ display: "block" }}>
              开口说英文，双语字幕实时落
            </span>
          </span>
          <Icon name="right" size={16} />
        </button>
      </div>
      <hr className="hr" style={{ marginTop: 4 }} />
      <div className="sec">
        <div className="overline">最近会话</div>
        {sessions.length ? (
          <div className="recent">
            {sessions.slice(0, 6).map((s) => (
              <button
                key={s.id}
                className="rc"
                onClick={() => {
                  nav.push("chat", { scene: s.sceneId, resumeSession: s });
                }}
              >
                <div className="t">{s.scene}</div>
                <div className="m">
                  {sessionWhen(s.at)} · {s.turns} 轮
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="meta" style={{ padding: "8px 0 2px" }}>
            还没有口语记录 · 完成一场陪练并保存，就会出现在这里
          </div>
        )}
      </div>
      <div className="meta" style={{ marginTop: 10 }}>
        跟读评测走讯飞 ISE；未配置时录音与收句真实生效、评分需配置后可用（不假打分）。
      </div>
    </div>
  );
}
