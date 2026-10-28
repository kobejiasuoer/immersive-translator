/**
 * 语音页右列 · 沉浸云模式（契约 §三.6/§三.7/§三.8）。
 *
 * - 账号卡：未登录给登录入口（openLoginWindow 由父级处理），已登录回显邮箱 +
 *   「管理账号」（切账号 tab）；令牌由客户端自动携带续期，无任何凭据配置。
 * - 能力卡：状态机归约结果（gatewayViewState.reduceVoiceGatewayView）渲染
 *   读取中 / 未开通 / 部分可用 / 额度用尽 / 全部可用；网络失败与封禁是独立整卡。
 * - 本月额度：me/config 下发 quota 字段 → 常驻余量明细；未下发 → 平时只给说明，
 *   收到 quota_exceeded（402/WSS 事件经 onQuotaEvent 上抛）后切换「额度用尽」+ 兑换入口。
 * - 一键测试：三行灯（跟读打分 / 云端朗读 / 口语识别）+ 汇总条，行内可单独重测。
 *   跟读打分用打包的真实英文样本打 ISE（耗 1 次评分额度，§三.9）；朗读短句合成
 *   不播放；识别用同一样本转写（耗少量秒数）。均经 lib/voice 消费口，不碰帧协议。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bytesToBase64,
  evaluatePronunciation,
  quotaDetailsOf,
  synthesize,
  transcribeBatch,
  VoiceError,
  voiceErrorMessage,
  type VoiceCapabilities,
  type VoiceQuotaKey,
} from "../lib/voice";
import {
  CAPABILITY_LABELS,
  quotaLine,
  quotaResetText,
  type VoiceCapabilityKey,
  type VoiceGatewayView,
} from "../lib/voice/gatewayViewState";
import { IconAlert, IconCheck, IconRetry, IconUser } from "../ui/icons";
import iseSampleUrl from "../assets/voice/ise-test-sample.pcm?url";

/** 一键测试样本的固定英文句（assets/voice/README.md：样本内容的唯一真源）。 */
const SAMPLE_REF_TEXT = "The quick brown fox jumps over the lazy dog.";
/** 朗读通道探测用的极短句（正常计字符额度，量级可忽略）。 */
const TTS_PROBE_TEXT = "Hello.";

/** 申诉入口：两个仓库均未定义申诉页/客服渠道（客户端、服务端、deploy 均查无），
 *  上线前由运维回填；为 null 时按钮置灰占位（契约 §三.6 封禁态要求该按钮存在）。 */
const APPEAL_URL: string | null = null;

type LightState = { state: "idle" | "testing" | "ok" | "bad"; message: string };
type TestKey = VoiceCapabilityKey;

const TEST_ROWS: Record<TestKey, { label: string; name: string }> = {
  ise: { label: "跟读打分", name: "真实英文样本评测 · 消耗 1 次评分额度" },
  tts: { label: "云端朗读", name: "短句合成探测 · 不播放声音" },
  asr: { label: "口语识别", name: "样本转写探测 · 消耗少量识别秒数" },
};

const IDLE_LIGHT: LightState = { state: "idle", message: "" };

/** 样本 base64（懒加载 + 缓存；样本是打包的合成音频，无隐私、可复用）。 */
let sampleBase64: Promise<string> | null = null;
function loadSampleBase64(): Promise<string> {
  sampleBase64 ??= fetch(iseSampleUrl)
    .then((res) => {
      if (!res.ok) throw new Error(`测试样本加载失败（${res.status}）`);
      return res.arrayBuffer();
    })
    .then((buf) => bytesToBase64(new Uint8Array(buf)));
  return sampleBase64;
}

/** 测试失败的展示文案：VoiceError 走 §二映射表，其余（网络/未接线）落通用兜底。 */
function testErrorText(err: unknown): string {
  const info = voiceErrorMessage(err as { code?: unknown });
  return info.text !== "" ? info.text : "服务暂时不可用，请稍后再试";
}

/** asrLanguages 成员 → 展示名（服务端契约只有 en_us/zh_cn，其余透传）。 */
function asrLanguageLabel(lang: string): string {
  if (lang === "en_us") return "英语";
  if (lang === "zh_cn") return "中文";
  return lang;
}

function dotColor(state: LightState["state"]): string {
  switch (state) {
    case "ok":
      return "var(--ok, #2a9d4a)";
    case "bad":
      return "var(--err, #d33)";
    case "testing":
      return "var(--amber, #d99a2a)";
    default:
      return "var(--border, #999)";
  }
}

export interface GatewayVoiceSectionProps {
  email: string;
  loggedIn: boolean;
  /** 登录窗口已点开、还在打开中（按钮禁用态）。 */
  openingLogin: boolean;
  caps: VoiceCapabilities | null;
  view: VoiceGatewayView;
  selectedVoice: string | undefined;
  iseEnabled: boolean;
  onLogin: () => void;
  onManageAccount: () => void;
  onRetryCaps: () => void;
  /** 「兑换更多额度」→ 账号 tab 兑换码卡（§三.10）。 */
  onOpenRedeem: () => void;
  onSelectVoice: (voiceId: string) => void;
  onToggleIse: (on: boolean) => void;
  /** 测试中收到 quota_exceeded：上抛 resource（402 事件式兜底的来源之一）。 */
  onQuotaEvent: (resource: string) => void;
}

export function GatewayVoiceSection({
  email,
  loggedIn,
  openingLogin,
  caps,
  view,
  selectedVoice,
  iseEnabled,
  onLogin,
  onManageAccount,
  onRetryCaps,
  onOpenRedeem,
  onSelectVoice,
  onToggleIse,
  onQuotaEvent,
}: GatewayVoiceSectionProps) {
  const [lights, setLights] = useState<Record<TestKey, LightState>>({
    ise: IDLE_LIGHT,
    tts: IDLE_LIGHT,
    asr: IDLE_LIGHT,
  });
  const [running, setRunning] = useState(false);
  /** 探测是 fire-and-forget 异步链，卸载后不再 setState。 */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const voices = caps?.ttsVoices ?? [];
  const languages = caps?.asrLanguages ?? [];
  const missing = (key: TestKey): boolean => view.missing.includes(key);
  const testsAllowed = view.caps === "full" || view.caps === "partial";
  const anyTesting = running || Object.values(lights).some((l) => l.state === "testing");

  const setLight = useCallback((key: TestKey, light: LightState) => {
    if (aliveRef.current) setLights((cur) => ({ ...cur, [key]: light }));
  }, []);

  /** 统一收口：跑一项探测；quota_exceeded 顺带上抛 resource（402 事件式兜底）。 */
  const runProbe = useCallback(
    async (key: TestKey): Promise<LightState> => {
      try {
        if (key === "ise") {
          const result = await evaluatePronunciation(SAMPLE_REF_TEXT, "en", await loadSampleBase64());
          if (result.isRejected) {
            return { state: "bad", message: "样本被判定为无效语音，请重测" };
          }
          return { state: "ok", message: `评测通道正常（总分 ${result.total.toFixed(1)}）` };
        }
        if (key === "asr") {
          const result = await transcribeBatch("en_us", await loadSampleBase64());
          if (result.text.trim() === "") {
            return { state: "bad", message: "识别结果为空，请重测" };
          }
          const seconds = result.durationMs !== null ? (result.durationMs / 1000).toFixed(1) : null;
          return {
            state: "ok",
            message: seconds !== null ? `识别通道正常（约 ${seconds} 秒）` : "识别通道正常",
          };
        }
        // tts：短句合成探测，分片不播放（onChunk 空实现）。
        return await new Promise<LightState>((resolve) => {
          synthesize(
            TTS_PROBE_TEXT,
            undefined,
            undefined,
            () => undefined,
            () => resolve({ state: "ok", message: "合成通道正常" }),
            (err: VoiceError) => resolve({ state: "bad", message: testErrorText(err) }),
          );
        });
      } catch (err) {
        if (err instanceof VoiceError && err.code === "quota_exceeded") {
          const details = quotaDetailsOf(err);
          if (details.resource !== null) onQuotaEvent(details.resource);
          const reset = quotaResetText(details.resetsAt);
          return { state: "bad", message: `本月${CAPABILITY_LABELS[key]}额度已用完${reset ? `，${reset}` : ""}` };
        }
        return { state: "bad", message: testErrorText(err) };
      }
    },
    [onQuotaEvent],
  );

  const runOne = useCallback(
    (key: TestKey) => {
      if (anyTesting || !testsAllowed || missing(key)) return;
      setLight(key, { state: "testing", message: "" });
      void runProbe(key).then((light) => setLight(key, light));
    },
    [anyTesting, testsAllowed, missing, runProbe, setLight],
  );

  const runAll = useCallback(() => {
    if (anyTesting || !testsAllowed) return;
    setRunning(true);
    const keys = (Object.keys(TEST_ROWS) as TestKey[]).filter((k) => !missing(k));
    setLights({ ise: IDLE_LIGHT, tts: IDLE_LIGHT, asr: IDLE_LIGHT });
    for (const key of keys) setLight(key, { state: "testing", message: "" });
    void Promise.all(keys.map((key) => runProbe(key).then((light) => ({ key, light })))).then(
      (results) => {
        if (aliveRef.current) {
          setLights((cur) => {
            const next = { ...cur };
            for (const { key, light } of results) next[key] = light;
            return next;
          });
        }
        setRunning(false);
      },
    );
  }, [anyTesting, testsAllowed, missing, runProbe, setLight]);

  const done = Object.values(lights).filter((l) => l.state !== "idle");
  const okCount = done.filter((l) => l.state === "ok").length;
  const badCount = done.filter((l) => l.state === "bad").length;

  return (
    <>
      {/* ---- 卡A 沉浸云账号（模型服务页同构） ---- */}
      <div className="group-card">
        <div className="field-block">
          <div className="field-block-head">
            <span className="field-label-v2">账号</span>
            <span className={`chip ${loggedIn ? "chip-green" : "chip-amber"}`}>
              {loggedIn ? "已登录" : "未登录"}
            </span>
          </div>
          {!loggedIn ? (
            <>
              <p className="field-hint">
                登录后即可使用：无需申请任何密钥，朗读、识别、跟读打分三个服务共用一个账号，按账号额度计费。
              </p>
              <div className="provider-actions" style={{ margin: 0 }}>
                <button className="btn btn-primary" disabled={openingLogin} onClick={onLogin}>
                  <IconUser size={14} />
                  {openingLogin ? "正在打开登录窗口…" : "登录沉浸云"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="platform-account-row">
                <span className="platform-account-mark" aria-hidden>
                  <IconUser size={13} />
                </span>
                <span className="platform-account-email">{email}</span>
              </div>
              <p className="field-hint">语音请求的令牌由客户端自动携带并自动续期，无需配置。</p>
              <div className="provider-actions" style={{ margin: 0 }}>
                <button className="btn btn-secondary" onClick={onManageAccount}>
                  <IconUser size={14} />
                  管理账号
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---- 网络失败（重试）/ 封禁（无重试）整卡 ---- */}
      {loggedIn && view.caps === "error" && (
        <div className="group-card">
          <div className="field-block">
            <div className="field-block-head">
              <span className="field-label-v2">语音能力</span>
              <span className="chip chip-red">获取失败</span>
            </div>
            <p className="field-hint">账号登录状态不受影响；网络恢复后重新获取，回到沉浸云语音。</p>
            <div className="msg-bar err">
              <IconAlert size={14} />
              <span>无法连接沉浸云，请检查网络或代理设置。</span>
              <button className="btn btn-secondary btn-sm" onClick={onRetryCaps}>
                <IconRetry size={12} />
                重试
              </button>
            </div>
          </div>
        </div>
      )}
      {loggedIn && view.caps === "banned" && (
        <div className="group-card">
          <div className="field-block">
            <div className="field-block-head">
              <span className="field-label-v2">语音能力</span>
              <span className="chip chip-red">已封禁</span>
            </div>
            <p className="field-hint">封禁期间朗读、识别、跟读打分全部停用；申诉通过后自动恢复，无需重新配置。</p>
            <div className="msg-bar err">
              <IconAlert size={14} />
              <span>账号已被封禁，如有疑问请前往申诉。</span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={APPEAL_URL === null}
                title={APPEAL_URL === null ? "申诉渠道即将开放" : undefined}
                onClick={() => {
                  if (APPEAL_URL !== null) window.open(APPEAL_URL, "_blank", "noreferrer");
                }}
              >
                前往申诉
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- 能力卡（读取中 / 未开通 / 部分可用 / 额度用尽 / 全部可用） ---- */}
      {loggedIn && view.caps !== "error" && view.caps !== "banned" && (
        <div className="group-card">
          <CapabilityCardHead view={view} />
          <div className="field-row">
            <div className="field-text">
              <span className="field-label-v2">朗读音色</span>
              <span className="field-hint">音色由沉浸云统一下发，管理台更新后下次启动生效。</span>
            </div>
            <div className="field-ctrl">
              {view.caps === "loading" ? (
                <span className="chip chip-blue">读取中…</span>
              ) : view.caps === "none" || missing("tts") ? (
                <select className="input" style={{ width: 252, maxWidth: "100%" }} disabled aria-label="朗读音色">
                  <option>暂无可用音色</option>
                </select>
              ) : (
                <select
                  className="input"
                  style={{ width: 252, maxWidth: "100%" }}
                  aria-label="朗读音色"
                  value={voices.some((v) => v.id === selectedVoice) ? selectedVoice : voices[0]?.id ?? ""}
                  onChange={(e) => onSelectVoice(e.target.value)}
                >
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="field-row">
            <div className="field-text">
              <span className="field-label-v2">识别语种</span>
              {missing("asr") ? (
                <span className="field-hint">沉浸云识别暂未开放——录音直译、口语陪练入口不可用。</span>
              ) : (
                <span className="field-hint">
                  语种由消费场景决定（领读、陪练为英语；录音直译按翻译方向），此处仅展示下发结果。
                </span>
              )}
            </div>
            <div className="field-ctrl">
              {view.caps === "loading" ? (
                <span className="chip chip-blue">读取中…</span>
              ) : view.caps === "none" || missing("asr") ? (
                <span className="chip chip-gray">暂未开放</span>
              ) : (
                languages.map((lang) => (
                  <span key={lang} className="chip chip-blue">
                    {asrLanguageLabel(lang)}
                  </span>
                ))
              )}
            </div>
          </div>
          <div className="field-row">
            <div className="field-text">
              <span className="field-label-v2">跟读打分</span>
              {missing("ise") ? (
                <span className="field-hint">服务端暂未开放，开通后自动恢复；期间跟读页隐藏评测入口。</span>
              ) : (
                <span className="field-hint">关闭后，跟读练习只保留原声朗读，不再评分。</span>
              )}
            </div>
            <div className="field-ctrl">
              {view.caps === "loading" ? (
                <span className="chip chip-blue">读取中…</span>
              ) : view.caps === "none" || missing("ise") ? (
                <>
                  <button type="button" className="switch" role="switch" aria-checked={false} aria-label="跟读打分" disabled />
                  <span className="chip chip-gray">未开放</span>
                </>
              ) : (
                <button
                  type="button"
                  className={`switch${iseEnabled ? " on" : ""}`}
                  role="switch"
                  aria-checked={iseEnabled}
                  aria-label="跟读打分"
                  onClick={() => onToggleIse(!iseEnabled)}
                />
              )}
            </div>
          </div>
          <div className="field-row">
            <div className="field-text">
              <span className="field-label-v2">本月额度</span>
              {view.caps === "loading" ? (
                <span className="field-hint">读取额度信息…</span>
              ) : view.quota !== null ? (
                <>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: view.exhausted ? "var(--warn, #b45309)" : "var(--text-1)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {quotaLine(view.quota)}
                  </span>
                  <span className="field-hint">
                    {quotaResetText(firstResetsAt(view.quota)) ?? "按自然月（UTC）计费"}；额度随用随扣，用尽时提醒。
                  </span>
                </>
              ) : view.exhausted ? (
                <span className="field-hint">
                  本月{view.exhaustedLabels.join("、")}额度已用完；可用兑换码补足，或等下月自动重置。
                </span>
              ) : (
                <span className="field-hint">额度随用随扣，按自然月（UTC）计费；用尽时这里会展示余量与重置时间。</span>
              )}
            </div>
            {view.exhausted && view.caps !== "loading" && (
              <div className="field-ctrl">
                <button className="btn btn-secondary btn-sm" onClick={onOpenRedeem}>
                  兑换更多额度
                </button>
              </div>
            )}
          </div>
          <div className="field-row">
            <div className="field-text">
              <span className="field-label-v2">一键测试</span>
              <span className="field-hint">逐项验证朗读、识别、跟读打分通道；评分项消耗 1 次额度。</span>
            </div>
            <div className="field-ctrl">
              <button
                className="btn btn-secondary btn-sm"
                disabled={!testsAllowed || anyTesting}
                title="评分项消耗 1 次额度"
                onClick={runAll}
              >
                {anyTesting ? "测试中…" : "一键测试"}
              </button>
            </div>
          </div>
          {testsAllowed && (
            <div style={{ paddingBottom: 4 }}>
              {(Object.keys(TEST_ROWS) as TestKey[]).map((key) => {
                const row = TEST_ROWS[key];
                const light = lights[key];
                const rowDisabled = missing(key);
                return (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "6px 0" }}>
                    <span
                      aria-hidden
                      style={{ width: 9, height: 9, borderRadius: "50%", flex: "none", background: dotColor(light.state) }}
                    />
                    <b style={{ fontSize: 13 }}>{row.label}</b>
                    <span style={{ fontSize: 12, color: "var(--text-3, #888)" }}>
                      {rowDisabled ? "服务端暂未开放" : row.name}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: "auto" }}
                      disabled={rowDisabled || anyTesting}
                      onClick={() => runOne(key)}
                    >
                      {light.state === "testing" ? "测试中…" : light.state === "idle" ? "测试" : "重测"}
                    </button>
                    {light.message && (
                      <p
                        className="field-hint"
                        style={{
                          flexBasis: "100%",
                          margin: 0,
                          color: light.state === "ok" ? "var(--ok, #2a9d4a)" : "var(--err, #d33)",
                        }}
                      >
                        {light.message}
                      </p>
                    )}
                  </div>
                );
              })}
              {!anyTesting && badCount > 0 && (
                <div className="msg-bar warn">
                  <IconAlert size={14} />
                  <span>
                    测试完成：{okCount} 项通过，{badCount} 项异常——可对未通过项单独「重测」。
                  </span>
                </div>
              )}
              {!anyTesting && badCount === 0 && okCount > 0 && (
                <div className="msg-bar ok">
                  <IconCheck size={14} />
                  <span>测试完成：已测 {okCount} 项全部正常。</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** 能力卡头：相位徽标 + 一句话说明。 */
function CapabilityCardHead({ view }: { view: VoiceGatewayView }) {
  let chip = <span className="chip chip-green">全部可用</span>;
  let hint = "三项能力由沉浸云统一下发，随账号状态自动更新。";
  if (view.caps === "loading") {
    chip = <span className="chip chip-blue">读取中…</span>;
    hint = "正在获取本账号的语音能力，通常数秒内完成。";
  } else if (view.caps === "none") {
    chip = <span className="chip chip-gray">未开通</span>;
    hint = "服务端尚未为本账号开通语音；开通后此卡自动点亮，无需重新配置。";
  } else if (view.caps === "partial") {
    chip = <span className="chip chip-amber">部分可用</span>;
    hint = `${view.missing.map((k) => CAPABILITY_LABELS[k]).join("、")}暂未开放，其余能力不受影响。`;
  } else if (view.exhausted) {
    chip = <span className="chip chip-amber">额度用尽</span>;
    hint = `能力正常，本月${view.exhaustedLabels.join("、")}额度已用完；重置后自动恢复，不改动你的服务商选择。`;
  }
  return (
    <div className="field-block">
      <div className="field-block-head">
        <span className="field-label-v2">语音能力</span>
        {chip}
      </div>
      <p className="field-hint">{hint}</p>
    </div>
  );
}

/** 三资源恒为同一月末周期（单一月度周期），取任一非空 resetsAt 即可。 */
function firstResetsAt(quota: VoiceGatewayView["quota"]): string | null {
  if (quota === null) return null;
  for (const key of ["tts", "asr", "ise"] as VoiceQuotaKey[]) {
    const entry = quota[key];
    if (entry !== undefined && entry.resetsAt !== null) return entry.resetsAt;
  }
  return null;
}
