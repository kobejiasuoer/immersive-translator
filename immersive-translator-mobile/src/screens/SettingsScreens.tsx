/**
 * 设置子页（push）—— §3.18 模式：分组列表 + 行式 radio（墨蓝对勾）+ 开关。
 * 模型服务（#17/#18/#19：7 预设 + Key 显隐 + 测试连接行内执行）/
 * 翻译偏好（#20）/ 语音服务（#22）/ 提醒与目标（#28）/ 外观。
 */
import { useState } from "react";
import { actions, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav, Seg, Switch } from "../ui/kit";
import { useNav } from "../ui/nav";
import { haptic, invokeRaw, isTauri, reportDiag } from "../services/device";
import { EDGE_VOICE_SUGGESTIONS, speakCloud } from "../services/voice";
import { buildCfg, PROVIDER_BASE, PROVIDER_MODEL } from "../services/translate";

const PROVIDERS: [string, string, string][] = [
  ["openai", "OpenAI", "GPT-4o mini"],
  ["deepseek", "DeepSeek", "deepseek-chat"],
  ["zhipu", "智谱", "glm-4-flash"],
  ["moonshot", "Moonshot", "kimi"],
  ["silicon", "硅基流动", "Qwen2.5-7B"],
  ["ollama", "Ollama 本地", "llama3.1"],
  ["custom", "自定义", "填入兼容接口"],
];

export function SetModelScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  const [keyShown, setKeyShown] = useState(false);
  const [testing, setTesting] = useState(false);

  const basePreset = PROVIDER_BASE[settings.provider];
  const modelPreset = PROVIDER_MODEL[settings.provider];

  function testConn() {
    if (testing) return;
    if (!settings.apiKey.trim()) {
      toast("先在下面填入 API Key");
      return;
    }
    if (settings.provider === "custom" && !settings.baseUrl.trim()) {
      toast("自定义服务需要填接口地址");
      return;
    }
    if (!isTauri()) {
      /* 浏览器演示态：明说这不是真实请求 */
      actions.setSettings({ conn: "ok", connMsg: "浏览器演示态 · 未实际请求，真机上才会真正连通" });
      return;
    }
    setTesting(true);
    actions.setSettings({ conn: "loading", connMsg: "" });
    void invokeRaw<string>("translate_probe", { cfg: buildCfg() })
      .then((msg) => {
        actions.setSettings({ conn: "ok", connMsg: msg });
        haptic("success");
      })
      .catch((e: Error) => {
        actions.setSettings({ conn: "fail", connMsg: e.message || "连接失败" });
      })
      .finally(() => setTesting(false));
  }

  return (
    <>
      <PNav title="模型服务" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="overline">服务预设</div>
        <div className="gcard" style={{ marginTop: 8 }}>
          {PROVIDERS.map(([id, name, model]) => (
            <button
              key={id}
              className="frow"
              onClick={() => {
                if (settings.provider === id) return;
                /* 切换预设同时清掉旧覆盖与连接状态（治 tools-5）：buildCfg 里 baseUrl/model
                   覆盖值优先于预设——不清的话翻译实际仍打旧地址/旧模型，而界面已选中新预设、
                   「我的」页还挂着旧 conn=ok 的「已连接」，误导排查。 */
                actions.setSettings({
                  provider: id,
                  baseUrl: "",
                  model: "",
                  conn: "idle",
                  connMsg: "",
                });
              }}
            >
              <span className="ico" style={{ width: 22 }}>
                {settings.provider === id && <Icon name="check" size={17} />}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                <span style={{ display: "block" }}>{name}</span>
              </span>
              <span className="meta mono">{model}</span>
            </button>
          ))}
        </div>
        <div className="overline" style={{ marginTop: 20 }}>
          接口与模型
        </div>
        <div className="gcard" style={{ marginTop: 8, padding: "4px 14px" }}>
          <div className="aa-row" style={{ padding: "8px 0" }}>
            <span className="meta2" style={{ flex: "none", width: 62 }}>
              接口地址
            </span>
            <input
              className="input"
              style={{ flex: 1, minHeight: 34, fontSize: 14 }}
              value={settings.baseUrl}
              onChange={(e) => actions.setSettings({ baseUrl: e.target.value })}
              placeholder={basePreset || "https://你的兼容接口/v1"}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="aa-row" style={{ padding: "8px 0" }}>
            <span className="meta2" style={{ flex: "none", width: 62 }}>
              模型
            </span>
            <input
              className="input"
              style={{ flex: 1, minHeight: 34, fontSize: 14 }}
              value={settings.model}
              onChange={(e) => actions.setSettings({ model: e.target.value })}
              placeholder={modelPreset || "填入模型名"}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="meta" style={{ padding: "2px 0 8px" }}>
            留空使用所选预设的默认值{basePreset ? `（当前：${basePreset} · ${modelPreset}）` : "（自定义服务两项都要填）"}
          </div>
        </div>
        <div className="overline" style={{ marginTop: 20 }}>
          API Key
        </div>
        <div className="gcard" style={{ marginTop: 8, padding: "4px 14px" }}>
          <div className="aa-row" style={{ padding: "8px 0" }}>
            <input
              className="input"
              style={{ flex: 1, minHeight: 38, fontSize: 15, fontFamily: "var(--mono, monospace)" }}
              type={keyShown ? "text" : "password"}
              value={settings.apiKey}
              onChange={(e) => actions.setApiKey(e.target.value)}
              placeholder="sk-…"
              autoComplete="off"
            />
            <button
              className="iconbtn"
              aria-label="显示或隐藏"
              style={{ width: 36, height: 36, flex: "none" }}
              onClick={() => setKeyShown((v) => !v)}
            >
              <Icon name={keyShown ? "eyeoff" : "eye"} size={17} />
            </button>
          </div>
          <div className="meta" style={{ padding: "2px 0 8px" }}>
            {settings.apiKey.trim()
              ? settings.keyStored
                ? "已填写 · 存在系统钥匙串（不落明文存储）"
                : isTauri()
                  ? "已填写 · 钥匙串暂不可用，明文兜底存本机"
                  : "已填写 · 浏览器态仅存本机（真机上会入钥匙串）"
              : "未填写 · 翻译与查词不可用（无演示兜底），填写后直连服务商"}
          </div>
          <button className="frow" onClick={testConn}>
            <span className="ico">
              <Icon name="bolt" size={17} />
            </span>
            <span className="grow">
              <span style={{ display: "block" }}>测试连接</span>
              <span className="sub" style={{ display: "block" }}>
                {settings.conn === "ok"
                  ? settings.connMsg
                  : settings.conn === "loading"
                    ? "正在连接…"
                    : settings.conn === "fail"
                      ? settings.connMsg || "连接失败 · 点此重试"
                      : "发一条最小请求验证 Key 与模型"}
              </span>
            </span>
            {settings.conn === "loading" ? (
              <div className="skel" style={{ width: 40, margin: 0 }} />
            ) : settings.conn === "ok" ? (
              <span className="statusdot ok" />
            ) : settings.conn === "fail" ? (
              <span className="statusdot warn" />
            ) : (
              <span style={{ width: 8 }} />
            )}
          </button>
        </div>
        <div className="meta" style={{ marginTop: 12 }}>
          请求由 App 内置网络层直发服务商（真机经 Rust 命令，绕开 WebView 的 CORS 限制）；Key 只存在本机——真机入系统钥匙串、不落明文，不上传任何服务器。
        </div>
      </div>
    </>
  );
}

export function SetPrefScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  return (
    <>
      <PNav title="翻译偏好" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="gcard" style={{ padding: "6px 14px" }}>
          <div className="aa-row" style={{ padding: "6px 0" }}>
            <span className="meta2" style={{ flex: "none" }}>
              方向
            </span>
            <Seg
              className="aa-seg"
              value={settings.dir}
              items={[
                ["e2c", "英 → 中"],
                ["c2e", "中 → 英"],
                ["auto", "自动"],
              ]}
              onChange={(dir) => actions.setSettings({ dir })}
            />
          </div>
          <div className="aa-row" style={{ padding: "6px 0" }}>
            <span className="meta2" style={{ flex: "none" }}>
              风格
            </span>
            <Seg
              className="aa-seg"
              value={settings.style}
              items={[
                ["plain", "简明"],
                ["faith", "忠实"],
                ["eleg", "信达雅"],
              ]}
              onChange={(style) => actions.setSettings({ style })}
            />
          </div>
        </div>
        <div className="gcard" style={{ marginTop: 14 }}>
          <div className="frow" style={{ cursor: "default" }}>
            <span className="grow">
              <span style={{ display: "block" }}>流式输出</span>
              <span className="sub" style={{ display: "block" }}>
                边生成边显示，快一两秒
              </span>
            </span>
            <Switch on={settings.stream} onToggle={() => actions.setSettings({ stream: !settings.stream })} />
          </div>
        </div>
      </div>
    </>
  );
}

export function SetVoiceScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  const credFilled = !!(settings.voiceAppId.trim() && settings.voiceApiKey.trim() && settings.voiceApiSecret.trim());
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<"idle" | "ok" | "fail">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [prevBusy, setPrevBusy] = useState(false);

  /** Edge 音色试听：speakCloud 直接合成播放（与正式朗读同一条链路），失败 toast 原因。 */
  function previewEdge() {
    if (prevBusy) return;
    if (!isTauri()) {
      toast("浏览器演示态 · 真机上才会真正连通");
      return;
    }
    setPrevBusy(true);
    const v = settings.edgeVoice.trim();
    const text = v.startsWith("zh") ? "你好，这是 Edge 在线音色。" : "Hello! This is the Edge online voice.";
    const h = speakCloud(text, v || undefined, 1);
    h.done
      .then(() => {
        reportDiag("tts", `Edge 试听成功（${v || "自动音色"}，播放完成）`);
        toast("试听完成");
      })
      .catch((e: Error) => {
        reportDiag("tts", `Edge 试听失败（${v || "自动音色"}）：${e.message}`);
        toast(`试听失败：${e.message}`);
      })
      .finally(() => setPrevBusy(false));
  }

  /** 三件套任一变化即重算 voice（voice = 三项齐全），去掉旧的假开关。 */
  function updVoice(k: "voiceAppId" | "voiceApiKey" | "voiceApiSecret", v: string) {
    const next = { voiceAppId: settings.voiceAppId, voiceApiKey: settings.voiceApiKey, voiceApiSecret: settings.voiceApiSecret, [k]: v };
    actions.setSettings({ [k]: v, voice: !!(next.voiceAppId.trim() && next.voiceApiKey.trim() && next.voiceApiSecret.trim()) });
  }

  /** 测试语音服务（B6 ②）：真发一次 xfyun_tts_speak("ok") 云合成，对齐 translate_probe 模式
      （成功「凭据可用」/ 失败展示 Rust 中文错误串；浏览器态明说未实际请求）。 */
  function testVoice() {
    if (testing) return;
    if (!credFilled) {
      toast("先在下面填好讯飞三件套");
      return;
    }
    if (!isTauri()) {
      setTestState("fail");
      setTestMsg("浏览器演示态 · 未实际请求，真机上才会真正连通");
      return;
    }
    setTesting(true);
    setTestState("idle");
    setTestMsg("");
    invokeRaw<{ audioB64: string; format: string }>("xfyun_tts_speak", {
      text: "ok",
      voiceName: null,
      speed: null,
      voice: {
        appId: settings.voiceAppId.trim(),
        apiKey: settings.voiceApiKey.trim(),
        apiSecret: settings.voiceApiSecret.trim(),
      },
    })
      .then((r) => {
        if (!r?.audioB64) throw new Error("讯飞未返回音频");
        setTestState("ok");
        setTestMsg(`凭据可用 · 云合成返回 ${Math.max(1, Math.round((r.audioB64.length * 3) / 4 / 1024))}KB ${r.format || "mp3"}`);
        haptic("success");
      })
      .catch((e: Error) => {
        setTestState("fail");
        setTestMsg(e.message || "测试失败");
      })
      .finally(() => setTesting(false));
  }

  return (
    <>
      <PNav title="语音服务" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="overline">朗读引擎</div>
        <div className="gcard" style={{ marginTop: 8 }}>
          <div className="frow" style={{ cursor: "default" }}>
            <span className="grow">
              <span style={{ display: "block" }}>云朗读声音</span>
              <span className="sub" style={{ display: "block" }}>
                {settings.ttsEngine === "edge"
                  ? "Edge 在线 · 神经音色（与 Windows 版同源），免费无凭据"
                  : "讯飞云合成 · 需下方三件套配置"}
              </span>
            </span>
          </div>
          <div style={{ padding: "8px 0 4px" }}>
            <Seg
              value={settings.ttsEngine}
              items={[["edge", "Edge 在线（推荐）"], ["xfyun", "讯飞合成"]] as ["edge" | "xfyun", string][]}
              onChange={(v) => actions.setSettings({ ttsEngine: v })}
            />
          </div>
          {settings.ttsEngine === "edge" && (
            <>
              <div className="aa-row" style={{ padding: "8px 0 4px", flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <span className="meta2">Edge 音色</span>
                <select
                  className="input"
                  style={{ minHeight: 36, fontSize: 14 }}
                  value={settings.edgeVoice}
                  onChange={(e) => actions.setSettings({ edgeVoice: e.target.value })}
                >
                  {EDGE_VOICE_SUGGESTIONS.map(([v, label]) => (
                    <option key={v || "auto"} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <button className="frow" onClick={previewEdge}>
                <span className="ico">
                  <Icon name="bolt" size={17} />
                </span>
                <span className="grow">
                  <span style={{ display: "block" }}>试听当前音色</span>
                  <span className="sub" style={{ display: "block" }}>
                    {prevBusy ? "正在合成…" : "在线合成一句示例并播放"}
                  </span>
                </span>
                {prevBusy ? <div className="skel" style={{ width: 40, margin: 0 }} /> : <span style={{ width: 8 }} />}
              </button>
            </>
          )}
        </div>
        <div className="overline" style={{ marginTop: 20 }}>
          讯飞开放平台（听写 / 评测 / 合成）
        </div>
        <div className="gcard" style={{ marginTop: 8 }}>
          <div className="frow" style={{ cursor: "default" }}>
            <span className="statusdot ok" />
            <span className="grow">
              <span style={{ display: "block" }}>语音合成 TTS</span>
              <span className="sub" style={{ display: "block" }}>
                可用 · {settings.ttsEngine === "edge" ? "当前引擎 Edge 在线（上方可切换）" : "当前引擎讯飞云合成"}
              </span>
            </span>
          </div>
          <div className="frow" style={{ cursor: "default" }}>
            <span className={`statusdot ${credFilled ? "ok" : "warn"}`} />
            <span className="grow">
              <span style={{ display: "block" }}>流式听写 ASR</span>
              <span className="sub" style={{ display: "block" }}>
                {credFilled ? "已配置 · 真实链路（讯飞 IAT 流式听写）" : "未配置 · 凭据填好后启用"}
              </span>
            </span>
          </div>
          <div className="frow" style={{ cursor: "default" }}>
            <span className={`statusdot ${credFilled ? "ok" : "warn"}`} />
            <span className="grow">
              <span style={{ display: "block" }}>语音评测 ISE</span>
              <span className="sub" style={{ display: "block" }}>
                {credFilled ? "已配置 · 真实链路（讯飞 ISE 发音评估）" : "未配置 · 凭据填好后启用"}
              </span>
            </span>
          </div>
        </div>
        <div className="overline" style={{ marginTop: 20 }}>
          凭据
        </div>
        <div className="gcard" style={{ marginTop: 8, padding: "4px 14px" }}>
          {(
            [
              ["APP ID", "voiceAppId", "应用详情页左上角"],
              ["API Key", "voiceApiKey", "应用详情页「服务接口认证信息」"],
              ["API Secret", "voiceApiSecret", "同上，与 Key 成对"],
            ] as const
          ).map(([label, field, hint]) => (
            <div key={field} className="aa-row" style={{ padding: "8px 0", flexDirection: "column", alignItems: "stretch", gap: 4 }}>
              <span className="meta2">{label}</span>
              <input
                className="input"
                style={{ minHeight: 36, fontSize: 14 }}
                value={settings[field]}
                onChange={(e) => updVoice(field, e.target.value)}
                placeholder={hint}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ))}
          <div className="meta" style={{ padding: "2px 0 8px" }}>
            {credFilled ? "三件套已存 · 仅存本机" : "在讯飞开放平台控制台创建应用，开通「语音听写 / 发音评估」，把三件套填到上面"}
          </div>
          <button className="frow" onClick={testVoice}>
            <span className="ico">
              <Icon name="bolt" size={17} />
            </span>
            <span className="grow">
              <span style={{ display: "block" }}>测试语音服务</span>
              <span className="sub" style={{ display: "block" }}>
                {testState === "ok"
                  ? testMsg
                  : testing
                    ? "正在合成…"
                    : testState === "fail"
                      ? testMsg || "失败 · 点此重试"
                      : '合成一句 "ok" 验证讯飞凭据'}
              </span>
            </span>
            {testing ? (
              <div className="skel" style={{ width: 40, margin: 0 }} />
            ) : testState === "ok" ? (
              <span className="statusdot ok" />
            ) : testState === "fail" ? (
              <span className="statusdot warn" />
            ) : (
              <span style={{ width: 8 }} />
            )}
          </button>
        </div>
        <div className="meta" style={{ marginTop: 12 }}>
          说明：朗读默认走 Edge 在线合成（微软神经音色，免费无凭据，失败自动回落系统语音）；
          听写/评测为讯飞链路，经 App 内 Rust 层直连讯飞 WebSocket（凭据在本机组装随调用传入，不落盘），
          三件套填好即启用，朗读引擎也可在上方切回讯飞合成。
        </div>
      </div>
    </>
  );
}

export function SetRemindScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  return (
    <>
      <PNav title="提醒与目标" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="gcard">
          <div className="frow" style={{ cursor: "default" }}>
            <span className="grow">
              <span style={{ display: "block" }}>每天提醒我复习</span>
              <span className="sub" style={{ display: "block" }}>
                只在有待清卡片时提醒
              </span>
            </span>
            <Switch on={settings.daily} onToggle={() => actions.setSettings({ daily: !settings.daily })} />
          </div>
          <div className="frow">
            <span className="grow">提醒时间</span>
            {/* 可修改（治 tools-6）：此前只展示默认 21:30 且全库无写入口，设置项走了个空壳。
                input[type=time] 在 WKWebView 弹系统时间滚轮；onChange 即写 setSettings
                （store 已联动 scheduleDailyReminder 重排本地通知）。 */}
            <input
              type="time"
              value={settings.remindTime}
              onChange={(e) => {
                const v = e.target.value;
                if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) actions.setSettings({ remindTime: v });
              }}
              style={{
                fontSize: 15,
                fontFamily: "var(--mono, monospace)",
                background: "none",
                border: "none",
                textAlign: "right",
                color: "var(--ink)",
              }}
            />
          </div>
          <div className="frow" style={{ cursor: "default" }}>
            <span className="grow">
              <span style={{ display: "block" }}>免打扰时段</span>
              <span className="sub" style={{ display: "block" }}>
                00:00 – 07:00 不打扰
              </span>
            </span>
            <Switch on={settings.dnd} onToggle={() => actions.setSettings({ dnd: !settings.dnd })} />
          </div>
        </div>
        <div className="meta" style={{ marginTop: 12 }}>
          点通知直达「清一张」；应用内横幅 60 秒无人操作会自动收起。
        </div>
        <button className="btn-ghost" style={{ border: "1px solid var(--hairline-strong)", marginTop: 14 }} onClick={() => actions.showBanner()}>
          预览一次提醒横幅
        </button>
      </div>
    </>
  );
}

export function SetLookScreen() {
  const nav = useNav();
  const settings = useApp((s) => s.settings);
  return (
    <>
      <PNav title="外观" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="gcard">
          {(
            [
              ["system", "跟随系统"],
              ["light", "浅色 · 暖纸"],
              ["dark", "深色 · 暖炭"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="frow" onClick={() => actions.setThemePref(v)}>
              <span className="ico" style={{ width: 22 }}>
                {settings.themePref === v && <Icon name="check" size={17} />}
              </span>
              <span className="grow">{label}</span>
            </button>
          ))}
        </div>
        <div className="meta" style={{ marginTop: 12 }}>
          阅读页里还有「纸色 / 纯黑」两种阅读主题，只影响正文。
        </div>
      </div>
    </>
  );
}
