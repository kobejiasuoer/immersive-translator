/** 沉浸云语音：账号状态与服务可用性分开；每项能力就地配置和真实测试。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  asrLanguagesFor,
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

const SAMPLE_REF_TEXT = "The quick brown fox jumps over the lazy dog.";
const TTS_PROBE_TEXT = "Hello. Welcome to Immersive Speaking.";
type TestKey = VoiceCapabilityKey;
type LightState = { state: "idle" | "testing" | "ok" | "bad"; message: string };
const IDLE_LIGHT: LightState = { state: "idle", message: "" };
const TEST_ORDER: TestKey[] = ["tts", "asr", "ise"];
const FEATURE_COPY: Record<TestKey, { title: string; description: string; test: string }> = {
  tts: { title: "朗读", description: "把阅读内容读出来，听单词和句子的发音。", test: "试听" },
  asr: { title: "语音转文字", description: "用于录音直译和口语陪练中的语音输入。", test: "测试识别" },
  ise: { title: "跟读评分", description: "跟读英文句子后，查看发音和流利度评分。", test: "测试评分" },
};

let sampleBase64: Promise<string> | null = null;
function loadSampleBase64(): Promise<string> {
  sampleBase64 ??= fetch(iseSampleUrl)
    .then((res) => {
      if (!res.ok) throw new Error("测试音频加载失败");
      return res.arrayBuffer();
    })
    .then((buf) => bytesToBase64(new Uint8Array(buf)))
    .catch((err: unknown) => {
      sampleBase64 = null;
      throw err;
    });
  return sampleBase64;
}

function testErrorText(err: unknown): string {
  const info = voiceErrorMessage(err as { code?: unknown });
  return info.text || "测试未完成，请检查网络后重试";
}
function asrLanguageLabel(lang: string): string {
  return lang === "en_us" ? "英语" : lang === "zh_cn" ? "中文" : lang;
}

export interface GatewayVoiceSectionProps {
  email: string;
  loggedIn: boolean;
  openingLogin: boolean;
  caps: VoiceCapabilities | null;
  view: VoiceGatewayView;
  selectedVoice: string | undefined;
  iseEnabled: boolean;
  onLogin: () => void;
  onManageAccount: () => void;
  onRetryCaps: () => void;
  onOpenRedeem: () => void;
  onSelectVoice: (voiceId: string) => void;
  onToggleIse: (on: boolean) => void;
  onQuotaEvent: (resource: string) => void;
  onUseXfyun?: () => void;
}

export function GatewayVoiceSection({
  email, loggedIn, openingLogin, caps, view, selectedVoice, iseEnabled,
  onLogin, onManageAccount, onRetryCaps, onOpenRedeem, onSelectVoice, onToggleIse,
  onQuotaEvent, onUseXfyun,
}: GatewayVoiceSectionProps) {
  const [lights, setLights] = useState<Record<TestKey, LightState>>({
    tts: IDLE_LIGHT, asr: IDLE_LIGHT, ise: IDLE_LIGHT,
  });
  const [running, setRunning] = useState(false);
  const aliveRef = useRef(true);
  const generationRef = useRef(0);
  const playbackRef = useRef<{ audio: HTMLAudioElement; finish: (ok: boolean) => void } | null>(null);
  const stopPlayback = useCallback(() => playbackRef.current?.finish(false), []);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generationRef.current += 1;
      stopPlayback();
    };
  }, [stopPlayback]);

  // 换账号、刷新能力或更换音色后，旧探测结果不可继续当作当前配置的成功证据。
  useEffect(() => {
    generationRef.current += 1;
    stopPlayback();
    setLights({ tts: IDLE_LIGHT, asr: IDLE_LIGHT, ise: IDLE_LIGHT });
    setRunning(false);
  }, [caps, email, loggedIn, selectedVoice, stopPlayback]);

  const voices = caps?.ttsVoices ?? [];
  const languages = caps ? asrLanguagesFor(caps) : [];
  const capabilityReady = loggedIn && (view.caps === "full" || view.caps === "partial");
  const missing = (key: TestKey) => !capabilityReady || view.missing.includes(key);
  const exhausted = (key: TestKey) =>
    view.quota?.[key]?.remaining === 0 || view.exhaustedLabels.includes(CAPABILITY_LABELS[key]);
  const testAvailable = (key: TestKey) =>
    !missing(key) && !exhausted(key) && (key !== "asr" || languages.includes("en_us")) && (key !== "ise" || iseEnabled);
  const anyTesting = running || Object.values(lights).some((light) => light.state === "testing");
  const anyTestAvailable = TEST_ORDER.some(testAvailable);
  const voiceId = voices.some((voice) => voice.id === selectedVoice) ? selectedVoice : voices[0]?.id;

  const playAudio = useCallback((chunks: ArrayBuffer[]): Promise<LightState> => {
    if (!aliveRef.current) return Promise.resolve({ state: "bad", message: "试听已停止" });
    if (chunks.every((chunk) => chunk.byteLength === 0)) {
      return Promise.resolve({ state: "bad", message: "服务未返回音频，请重试" });
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(new Blob(chunks, { type: "audio/mpeg" }));
      const audio = new Audio(url);
      let settled = false;
      const watchdog = window.setTimeout(() => finish(false), 15_000);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute("src");
        URL.revokeObjectURL(url);
        if (playbackRef.current?.audio === audio) playbackRef.current = null;
        resolve(ok
          ? { state: "ok", message: "已合成并播放试听，请确认能听到声音。" }
          : { state: "bad", message: "试听未完成，请检查声音输出后重试。" });
      };
      playbackRef.current = { audio, finish };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      void audio.play().catch(() => finish(false));
    });
  }, []);

  const runProbe = useCallback(async (key: TestKey): Promise<LightState> => {
    const generation = generationRef.current;
    const active = () => aliveRef.current && generation === generationRef.current;
    const stopped: LightState = { state: "bad", message: "配置已变更，请重新测试。" };
    try {
      if (key === "ise") {
        const sample = await loadSampleBase64();
        if (!active()) return stopped;
        const result = await evaluatePronunciation(SAMPLE_REF_TEXT, "en", sample);
        return result.isRejected
          ? { state: "bad", message: "测试音频未通过评测，请重试。" }
          : { state: "ok", message: `评分接口正常，测试样本得分 ${result.total.toFixed(1)} / 5。` };
      }
      if (key === "asr") {
        const sample = await loadSampleBase64();
        if (!active()) return stopped;
        const result = await transcribeBatch("en_us", sample);
        return result.text.trim() === ""
          ? { state: "bad", message: "识别结果为空，请重试。" }
          : { state: "ok", message: `已识别测试音频：“${result.text.trim()}”` };
      }
      const chunks: ArrayBuffer[] = [];
      await new Promise<void>((resolve, reject) => {
        synthesize(TTS_PROBE_TEXT, voiceId, undefined, (chunk) => chunks.push(chunk), resolve, reject);
      });
      return active() ? await playAudio(chunks) : stopped;
    } catch (err) {
      if (err instanceof VoiceError && err.code === "quota_exceeded") {
        const details = quotaDetailsOf(err);
        if (details.resource !== null && active()) onQuotaEvent(details.resource);
        const reset = quotaResetText(details.resetsAt);
        return { state: "bad", message: `本月${CAPABILITY_LABELS[key]}额度已用完${reset ? `，${reset}` : ""}` };
      }
      return { state: "bad", message: testErrorText(err) };
    }
  }, [onQuotaEvent, playAudio, voiceId]);

  const runTests = (keys: TestKey[]) => {
    if (anyTesting) return;
    const selected = keys.filter(testAvailable);
    if (selected.length === 0) return;
    const generation = generationRef.current;
    setRunning(true);
    setLights((current) => {
      const next = { ...current };
      for (const key of selected) next[key] = { state: "testing", message: "" };
      return next;
    });
    void Promise.all(selected.map(async (key) => ({ key, light: await runProbe(key) }))).then((results) => {
      if (!aliveRef.current || generation !== generationRef.current) return;
      setLights((current) => {
        const next = { ...current };
        for (const { key, light } of results) next[key] = light;
        return next;
      });
      setRunning(false);
    });
  };

  const summary = capabilitySummary(view, loggedIn);
  const done = Object.values(lights).filter((light) => light.state === "ok" || light.state === "bad");
  const badCount = done.filter((light) => light.state === "bad").length;
  return (
    <div className="voice-cloud-panel">
      <div className={`voice-availability ${summary.tone}`} role="status">
        <div className="voice-availability-main">
          <strong>{summary.title}</strong>
          <p>{summary.description}</p>
        </div>
        <div className="voice-availability-actions">
          {!loggedIn || view.caps === "auth_required" ? (
            <button className="btn btn-primary btn-sm" disabled={openingLogin} onClick={onLogin}>
              <IconUser size={14} />{openingLogin ? "正在打开…" : view.caps === "auth_required" ? "重新登录" : "登录沉浸云"}
            </button>
          ) : (
            <>
              {view.caps !== "banned" && (
                <button className="btn btn-secondary btn-sm" disabled={view.caps === "loading" || anyTesting} onClick={onRetryCaps}>
                  <IconRetry size={13} />{view.caps === "loading" ? "正在检查…" : "刷新状态"}
                </button>
              )}
              {view.caps === "none" && onUseXfyun && (
                <button className="btn btn-primary btn-sm" onClick={onUseXfyun}>配置讯飞语音</button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="voice-account-line">
        <span><IconUser size={14} />{loggedIn ? `当前账号：${email || "已登录"}` : "当前未登录沉浸云"}</span>
        {loggedIn && <button className="btn btn-ghost btn-sm" onClick={onManageAccount}>管理账号</button>}
      </div>

      <div className="voice-feature-list" aria-label="语音功能">
        {TEST_ORDER.map((key) => {
          const copy = FEATURE_COPY[key];
          const light = lights[key];
          const loading = loggedIn && view.caps === "loading";
          const unavailable = missing(key);
          const noQuota = exhausted(key);
          const statusText = !loggedIn ? "待登录" : view.caps === "auth_required" ? "待重新登录" :
            loading ? "正在检查" : view.caps === "banned" ? "账号不可用" : view.caps === "error" ? "待检查" :
            unavailable ? "未开放" : noQuota ? "额度已用完" : key === "ise" && !iseEnabled ? "已关闭" :
            light.state === "testing" ? "测试中…" : light.state === "ok" ? "测试通过" : light.state === "bad" ? "测试失败" : "已开放";
          return (
            <section className="voice-feature-row" key={key} aria-label={copy.title}>
              <div className="voice-feature-copy">
                <div className="voice-feature-heading">
                  <h3>{copy.title}</h3>
                  <span className={`voice-feature-status ${loading || unavailable || (key === "ise" && !iseEnabled) ? "muted" : noQuota ? "warn" : light.state === "bad" ? "bad" : "ok"}`}>{statusText}</span>
                </div>
                <p>{copy.description}</p>
                {key === "ise" && !unavailable && (
                  <p className="voice-feature-note">
                    跟读评测可在 设置 → 阅读与练习 中开启；两处都开启才会打分
                  </p>
                )}
                {key === "tts" && !loading && unavailable && <p className="voice-feature-note">阅读室可继续选择免费朗读。</p>}
                {key === "asr" && !unavailable && (
                  <p className="voice-feature-note">支持{languages.map(asrLanguageLabel).join("、")}{!languages.includes("en_us") ? "；当前没有英语识别，无法运行英文样本测试。" : ""}</p>
                )}
                {light.message && <p className={`voice-probe-result ${light.state}`}>{light.message}</p>}
              </div>
              <div className="voice-feature-controls">
                {key === "tts" && !unavailable && (
                  <select className="input voice-voice-select" aria-label="朗读音色" value={voiceId ?? ""} disabled={anyTesting || noQuota} onChange={(e) => onSelectVoice(e.target.value)}>
                    {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
                  </select>
                )}
                {key === "ise" && !unavailable && (
                  <label className="voice-ise-toggle">
                    <span>{iseEnabled ? "评分已开启" : "评分已关闭"}</span>
                    <button type="button" className={`switch${iseEnabled ? " on" : ""}`} role="switch" aria-checked={iseEnabled} aria-label="跟读评分" onClick={() => onToggleIse(!iseEnabled)} />
                  </label>
                )}
                {!unavailable && (
                  <button className="btn btn-secondary btn-sm" disabled={!testAvailable(key) || anyTesting} onClick={() => runTests([key])}>
                    {light.state === "testing" ? "测试中…" : copy.test}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {capabilityReady && (
        <details className="voice-details">
          <summary>连接测试与本月额度</summary>
          <div className="voice-details-content">
            <div className="voice-diagnostic-head">
              <div>
                <strong>验证当前配置</strong>
                <p>试听会播放声音；识别与评分使用内置英文音频，评分消耗 1 次额度。</p>
              </div>
              <button className="btn btn-secondary btn-sm" disabled={!anyTestAvailable || anyTesting} onClick={() => runTests(TEST_ORDER)}>
                {anyTesting ? "测试中…" : "测试已开放功能"}
              </button>
            </div>
            {!anyTesting && done.length > 0 && (
              <div className={`msg-bar ${badCount ? "warn" : "ok"}`}>
                {badCount ? <IconAlert size={14} /> : <IconCheck size={14} />}
                <span>已测 {done.length} 项，{done.length - badCount} 项通过{badCount ? `，${badCount} 项未通过，请按提示重试。` : "。未测试的功能仍需单独验证。"}</span>
              </div>
            )}
            <div className="voice-quota-row">
              <div>
                <strong>本月剩余额度</strong>
                <p>{view.quota ? quotaLine(view.quota) : "服务暂未提供额度明细；用尽时会提示。"}</p>
                {firstResetsAt(view.quota) && <p>{quotaResetText(firstResetsAt(view.quota))}</p>}
              </div>
              {view.exhausted && <button className="btn btn-secondary btn-sm" onClick={onOpenRedeem}>兑换更多额度</button>}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

function capabilitySummary(view: VoiceGatewayView, loggedIn: boolean): { title: string; description: string; tone: string } {
  if (!loggedIn) return { title: "登录后查看云语音是否开放", description: "云语音需要沉浸云账号；也可以直接配置自己的讯飞服务。", tone: "muted" };
  if (view.caps === "auth_required") return { title: "登录已失效", description: "重新登录后再检查语音功能。", tone: "warn" };
  if (view.caps === "loading") return { title: "正在检查云语音", description: "正在获取当前账号的功能开通状态。", tone: "muted" };
  if (view.caps === "none") return { title: "云语音暂未开放", description: "账号已登录，三项云语音均未开通。可配置讯飞继续使用。", tone: "warn" };
  if (view.caps === "banned") return { title: "账号已被封禁", description: "当前无法使用云语音，请到账号页查看账号状态。", tone: "bad" };
  if (view.caps === "error") return { title: "暂时无法检查云语音", description: voiceErrorMessage(view.errorCode ?? "network_error").text || "请检查网络后刷新状态。", tone: "bad" };
  if (view.exhausted) return { title: "部分功能额度已用完", description: `本月${view.exhaustedLabels.join("、")}额度已用完，可兑换额度后继续使用。`, tone: "warn" };
  if (view.caps === "partial") return { title: "部分云语音已开放", description: `${view.missing.map((key) => CAPABILITY_LABELS[key]).join("、")}暂未开放；已开放功能可在下方测试。`, tone: "warn" };
  return { title: "云语音已开放", description: "三项语音功能已开通。建议先试听或测试，确认当前配置能够正常使用。", tone: "ok" };
}
function firstResetsAt(quota: VoiceGatewayView["quota"]): string | null {
  if (quota === null) return null;
  for (const key of ["tts", "asr", "ise"] as VoiceQuotaKey[]) {
    const entry = quota[key];
    if (entry?.resetsAt) return entry.resetsAt;
  }
  return null;
}
