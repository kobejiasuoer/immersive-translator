/**
 * 我的（Tab 5）—— §3.5：六组 iOS 分组列表。
 * 硬约束保留：spike 自检入口在「我的」（收进通用组，进入独立 push 页，不外溢 debug UI）。
 * demo 21/23 实化：模型服务行按 settings 动态（服务商 · 模型 · 连接态，不再写死 OpenAI 已连接）；
 * 术语表行为真实计数（readGlossary，随增删联动）；关于行与 AboutScreen 同口径。
 */
import { useEffect, useState } from "react";
import { reviewStats, useApp } from "../store";
import { readGlossary } from "../core/glossary";
import { APP_VERSION_SUB } from "../core/version";
import { PROVIDER_MODEL } from "../services/translate";
import { Icon } from "../ui/icons";
import { useNav } from "../ui/nav";

/** 服务商显示名（镜像 SettingsScreens PROVIDERS 名单，id 与 translate.ts PROVIDER_* 同键）。 */
const PROVIDER_NAME: Record<string, string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  zhipu: "智谱",
  moonshot: "Moonshot",
  silicon: "硅基流动",
  ollama: "Ollama 本地",
  custom: "自定义",
};

/** 术语表计数：渲染期直读 localStorage（push/pop、store 任意 emit 都会触发重渲染），
 *  另监听 storage（跨标签页）/focus/visibilitychange 兜住同页无重渲染的写入。 */
function useGlossaryCount(): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("storage", bump);
    window.addEventListener("focus", bump);
    document.addEventListener("visibilitychange", bump);
    return () => {
      window.removeEventListener("storage", bump);
      window.removeEventListener("focus", bump);
      document.removeEventListener("visibilitychange", bump);
    };
  }, []);
  return readGlossary().length;
}

function G({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="group">
      <div className="group-t overline">{title}</div>
      <div className="gcard">{children}</div>
    </div>
  );
}

function Row({
  icon,
  title,
  sub,
  onClick,
  subWarn,
  extra,
}: {
  icon: string;
  title: string;
  sub?: string;
  onClick: () => void;
  subWarn?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <button className="frow" onClick={onClick}>
      <span className="ico">
        <Icon name={icon} size={19} />
      </span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span style={{ display: "block" }}>{title}</span>
        {sub && (
          <span className="sub" style={{ display: "block", color: subWarn ? "var(--warn)" : undefined }}>
            {sub}
          </span>
        )}
      </span>
      {extra || <Icon name="right" size={15} />}
    </button>
  );
}

/** 模型服务行 sub：未填 Key 引导配置；已填按 服务商 · 模型（覆盖或预设） · 连接态。 */
function modelServiceSub(s: { apiKey: string; provider: string; model: string; conn: "idle" | "loading" | "ok" | "fail" }): string {
  if (!s.apiKey.trim()) return "未配置 Key · 翻译与查词需先配置";
  const name = PROVIDER_NAME[s.provider] || s.provider;
  const model = s.model.trim() || PROVIDER_MODEL[s.provider] || "未指定模型";
  const conn = s.conn === "ok" ? "已连接" : s.conn === "fail" ? "连接失败" : s.conn === "loading" ? "连接中" : "已配置·未测试";
  return `${name} · ${model} · ${conn}`;
}

export default function MeScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  const history = useApp((s) => s.history);
  const notes = useApp((s) => s.notes);
  const st = useApp(reviewStats);
  const glossaryCount = useGlossaryCount();

  return (
    <div>
      <div className="h1">我的</div>
      <G title="模型服务">
        <Row
          icon="bolt"
          title="模型服务"
          sub={modelServiceSub(settings)}
          subWarn={!settings.apiKey.trim()}
          onClick={() => nav.push("setModel")}
        />
      </G>
      <G title="翻译偏好">
        <Row
          icon="copy"
          title="翻译偏好"
          sub={`${settings.dir === "e2c" ? "英 → 中" : settings.dir === "c2e" ? "中 → 英" : "自动检测"} · ${settings.stream ? "流式输出" : "整段输出"}`}
          onClick={() => nav.push("setPref")}
        />
      </G>
      <G title="语音服务">
        <Row
          icon="mic"
          title="语音服务"
          sub={settings.voice ? "讯飞 · TTS / ASR / ISE 已配置" : "讯飞 · 评测未配置"}
          subWarn={!settings.voice}
          onClick={() => nav.push("setVoice")}
        />
      </G>
      <G title="提醒与目标">
        <Row
          icon="hist"
          title="提醒与目标"
          sub={`每天 ${settings.remindTime} · 连续 ${st.streak} 天`}
          onClick={() => nav.push("setRemind")}
        />
      </G>
      <G title="外观">
        <Row
          icon="aa"
          title="外观"
          sub={settings.themePref === "system" ? "跟随系统" : settings.themePref === "dark" ? "深色" : "浅色"}
          onClick={() => nav.push("setLook")}
        />
      </G>
      <G title="通用">
        <Row icon="hist" title="翻译历史" sub={`${history.length} 条记录`} onClick={() => nav.push("history")} />
        <Row icon="book" title="术语表" sub={`${glossaryCount} 条 · 自动注入提示词`} onClick={() => nav.push("glossary")} />
        <Row icon="flask" title="诊断反馈" onClick={() => nav.push("diag")} />
        <Row icon="note" title="复习笔记" sub={notes.length ? `${notes.length} 篇笔记` : "复习后可一键生成"} onClick={() => nav.push("noteslib")} />
        <Row icon="gear" title="关于" sub={APP_VERSION_SUB} onClick={() => nav.push("about")} />
        <Row icon="bolt" title="重看首次引导" onClick={() => nav.push("onboarding")} />
        {/* spike 自检仅 dev 构建可见（§2.1 我的页不承载 debug 自检；工作区约束保留入口本身） */}
        {import.meta.env.DEV && (
          <Row icon="flask" title="spike 自检" sub="S1–S7 真机观察点（开发用）" onClick={() => nav.push("spike")} />
        )}
      </G>
      <div style={{ height: 24 }} />
    </div>
  );
}
