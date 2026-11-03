/**
 * 讯飞语音凭据 · 设置 → 语音。
 *
 * 面向普通用户的模型：只填一组「主凭据」（APPID / API Key / API Secret）。
 * 讯飞的凭据按应用发放，同一应用可同时开通语音评测 / 流式听写 / 在线合成，
 * 所以三个功能（跟读打分 / 口语识别 / 云端朗读）默认都取主凭据。
 *
 * - 服务灯：用与真实调用同一套签名构造 https 地址，经 Rust probe_https 拿到
 *   WS 握手层看不到的 HTTP 状态（浏览器一律报 1006），把结果翻译成人话：
 *   绿 = 可用；红 = 凭据抄错 / 该应用未开通此服务 / 网络不通，附排查指引。
 * - 凭据回显：已保存的主凭据填回输入框（APPID 明文，Key/Secret 圆点，眼睛切换明文）；
 *   部分保存时只回显存过的字段，留空的输入不会覆盖已存值。
 * - 高级折叠区：只有不同服务用了不同讯飞应用时才需要，按服务单独覆盖
 *   （覆盖只影响该服务，清空后自动回到主凭据）。
 *
 * 主凭据沿用既有 ISE 三件套的存储键（老用户已保存的凭据原地有效）；
 * 保存走 DPAPI 加密，成功后广播 `xfyun:creds-updated`，常驻的阅读室窗口
 * 据此刷新云端合成凭据缓存。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  asrCredSource,
  clearAsrCredentials,
  clearXfyunTtsCredentials,
  iseCredsConfigured,
  loadAsrCredentials,
  loadIseCredentialParts,
  loadIseCredentials,
  loadXfyunTtsCredentials,
  saveAsrCredentials,
  saveIseCredentials,
  saveXfyunTtsCredentials,
  xfyunTtsCredSource,
} from "../lib/iseCredentials";
import { probeHttps } from "../lib/tauriBridge";
import { buildXfyunAuthUrl } from "../core/xfyunAuth";
import { IconEye, IconEyeOff } from "../ui/icons";

type ServiceKind = "ise" | "tts" | "asr";
type OverrideKind = "tts" | "asr";
type CredPatch = { appId?: string; apiKey?: string; apiSecret?: string };

/** 三个语音服务：host/path 与真实调用共用同一签名路径。 */
const SERVICES: Record<ServiceKind, { label: string; name: string; host: string; path: string }> = {
  ise: { label: "跟读打分", name: "语音评测", host: "ise-api.xfyun.cn", path: "/v2/open-ise" },
  tts: { label: "云端朗读", name: "在线语音合成", host: "tts-api.xfyun.cn", path: "/v2/tts" },
  asr: { label: "口语识别", name: "流式听写", host: "iat-api.xfyun.cn", path: "/v2/iat" },
};

const SERVICE_ORDER: ServiceKind[] = ["tts", "asr", "ise"];

type LightState = { state: "idle" | "testing" | "ok" | "bad"; message: string };
const IDLE_LIGHT: LightState = { state: "idle", message: "" };

/** 用生效凭据实际探测一个服务的讯飞端点（同签名、GET 降级、不耗额度）。 */
async function probeService(kind: ServiceKind): Promise<LightState> {
  const creds =
    kind === "ise"
      ? await loadIseCredentials()
      : kind === "tts"
        ? await loadXfyunTtsCredentials()
        : await loadAsrCredentials();
  if (!creds) {
    return { state: "bad", message: "没有可用的应用凭据，请先填写并保存。" };
  }
  const svc = SERVICES[kind];
  const wssUrl = await buildXfyunAuthUrl(svc.host, svc.path, creds);
  const result = await probeHttps(wssUrl.replace(/^wss:\/\//, "https://"));
  return { state: result.ok ? "ok" : "bad", message: result.message };
}

/** 圆点显示的密文字段，附明文切换（与模型服务页 API Key 同款交互）。 */
function MaskedInput({
  value,
  placeholder,
  label,
  onChange,
}: {
  value: string;
  placeholder: string;
  label: string;
  onChange: (v: string) => void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-group key-input-full">
      <input
        className="input mono"
        type={shown ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="icon-btn input-append"
        aria-label={shown ? `隐藏 ${label}` : `显示 ${label}`}
        title={shown ? `隐藏 ${label}` : `显示 ${label}`}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <IconEyeOff size={14} /> : <IconEye size={14} />}
      </button>
    </div>
  );
}

/** 三段凭据输入（受控）。主凭据与高级覆盖共用外观；APPID 明文，Key/Secret 圆点。 */
function CredTripleInputs({
  appId,
  apiKey,
  apiSecret,
  appIdPlaceholder,
  onChange,
}: {
  appId: string;
  apiKey: string;
  apiSecret: string;
  appIdPlaceholder: string;
  onChange: (patch: CredPatch) => void;
}) {
  return (
    <div className="voice-credentials-grid">
      <label className="voice-credential-field">
        <span>APPID</span>
        <input
          className="input mono input-full"
          placeholder={appIdPlaceholder}
          value={appId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange({ appId: e.target.value })}
        />
      </label>
      <div className="voice-credential-field">
        <span>API Key</span>
        <MaskedInput
          value={apiKey}
          placeholder="API Key"
          label="API Key"
          onChange={(v) => onChange({ apiKey: v })}
        />
      </div>
      <div className="voice-credential-field">
        <span>API Secret</span>
        <MaskedInput
          value={apiSecret}
          placeholder="API Secret"
          label="API Secret"
          onChange={(v) => onChange({ apiSecret: v })}
        />
      </div>
    </div>
  );
}

function Feedback({ feedback }: { feedback: { ok: boolean; text: string } | null }) {
  if (!feedback) return null;
  return (
    <p className="field-hint" style={{ color: feedback.ok ? "var(--ok, #2a9d4a)" : "var(--err, #d33)" }}>
      {feedback.text}
    </p>
  );
}

export function XfyunVoiceSection() {
  const [mainConfigured, setMainConfigured] = useState<boolean | null>(null);
  const [lights, setLights] = useState<Record<ServiceKind, LightState>>({
    ise: IDLE_LIGHT,
    tts: IDLE_LIGHT,
    asr: IDLE_LIGHT,
  });
  const [testing, setTesting] = useState(false);
  const probeGenerationRef = useRef(0);
  const [main, setMain] = useState({ appId: "", apiKey: "", apiSecret: "" });
  const [savingMain, setSavingMain] = useState(false);
  const [mainFeedback, setMainFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sources, setSources] = useState<Record<OverrideKind, "own" | "main" | null>>({
    tts: null,
    asr: null,
  });

  const refreshStatus = useCallback(() => {
    void iseCredsConfigured()
      .then((ok) => setMainConfigured(ok))
      .catch(() => setMainConfigured(false));
    void xfyunTtsCredSource()
      .then((s) => setSources((cur) => ({ ...cur, tts: s })))
      .catch(() => undefined);
    void asrCredSource()
      .then((s) => setSources((cur) => ({ ...cur, asr: s })))
      .catch(() => undefined);
  }, []);

  /** 把已保存的主凭据（逐字段）回填进表单：APPID 明文，Key/Secret 圆点。 */
  const echoMain = useCallback(() => {
    void loadIseCredentialParts()
      .then((parts) => setMain(parts))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    refreshStatus();
    echoMain();
    // 他处保存凭据后广播事件，这里同步徽标与回显
    let unlisten: (() => void) | null = null;
    void listen("xfyun:creds-updated", () => {
      if (!active) return;
      probeGenerationRef.current += 1;
      refreshStatus();
      echoMain();
      setLights({ ise: IDLE_LIGHT, tts: IDLE_LIGHT, asr: IDLE_LIGHT });
    }).then((fn) => {
      if (active) unlisten = fn;
      else fn();
    }).catch(() => undefined);
    return () => {
      active = false;
      probeGenerationRef.current += 1;
      unlisten?.();
    };
  }, [refreshStatus, echoMain]);

  const testService = useCallback(async (kind: ServiceKind) => {
    const generation = probeGenerationRef.current;
    setLights((cur) => ({ ...cur, [kind]: { state: "testing", message: "" } }));
    try {
      const result = await probeService(kind);
      if (generation !== probeGenerationRef.current) return;
      setLights((cur) => ({ ...cur, [kind]: result }));
    } catch (e) {
      if (generation !== probeGenerationRef.current) return;
      setLights((cur) => ({
        ...cur,
        [kind]: { state: "bad", message: `测试失败：${e instanceof Error ? e.message : String(e)}` },
      }));
    }
  }, []);

  const testAll = useCallback(async () => {
    if (testing) return;
    setTesting(true);
    try {
      await Promise.all(SERVICE_ORDER.map((k) => testService(k)));
    } finally {
      setTesting(false);
    }
  }, [testing, testService]);

  const mainEmpty = !main.appId.trim() && !main.apiKey.trim() && !main.apiSecret.trim();

  const saveMain = useCallback(async () => {
    if (savingMain || mainEmpty) return;
    setSavingMain(true);
    setMainFeedback(null);
    try {
      const ok = await saveIseCredentials(main);
      if (ok) {
        probeGenerationRef.current += 1;
        setMainFeedback({ ok: true, text: "凭据已保存。请检查各项服务连接，并在应用中验证实际朗读、录音或评分。" });
        setLights({ ise: IDLE_LIGHT, tts: IDLE_LIGHT, asr: IDLE_LIGHT });
        void emit("xfyun:creds-updated", { kind: "main" }).catch(() => undefined);
      } else {
        setMainFeedback({
          ok: false,
          text: "已保存填写的项，但三段还不齐——APPID / API Key / API Secret 都要各保存过一次才算配置完成（没填的下次补填即可，已保存的不会被覆盖）",
        });
      }
    } catch (e) {
      setMainFeedback({ ok: false, text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSavingMain(false);
      refreshStatus();
      echoMain();
    }
  }, [savingMain, mainEmpty, main, refreshStatus, echoMain]);

  return (
    <div className="voice-xfyun-panel">
      <div className={`voice-availability ${mainConfigured || sources.tts || sources.asr ? "muted" : "warn"}`}>
        <div className="voice-availability-main">
          <strong>{mainConfigured || sources.tts || sources.asr ? "凭据已保存，请验证服务连接" : "先配置你的讯飞应用"}</strong>
          <p>需要在讯飞应用中分别开通在线语音合成、语音听写和语音评测。保存凭据不代表三项功能已开通。</p>
        </div>
      </div>
      <div className="voice-xfyun-credentials">
        <div className="voice-diagnostic-head">
          <div>
            <h3>应用凭据</h3>
            <p>从讯飞控制台的同一个应用中复制下列三个值，默认供三项语音功能共用。</p>
          </div>
          <span className="voice-feature-status muted">{mainConfigured === null ? "读取中…" : mainConfigured ? "主凭据已保存" : "尚未填齐"}</span>
        </div>
        <CredTripleInputs
          appId={main.appId}
          apiKey={main.apiKey}
          apiSecret={main.apiSecret}
          appIdPlaceholder="讯飞应用 APPID"
          onChange={(patch) => {
            setMain((cur) => ({ ...cur, ...patch }));
            setMainFeedback(null);
          }}
        />
        <div className="voice-credential-actions">
          <button className="btn btn-primary btn-sm" disabled={savingMain || mainEmpty} onClick={() => void saveMain()}>
            {savingMain ? "保存中…" : "保存凭据"}
          </button>
          <span>凭据在本机加密保存，保存后立即生效。</span>
        </div>
        <Feedback feedback={mainFeedback} />
      </div>

      <section className="voice-xfyun-checks" aria-label="讯飞服务连接">
        <div className="voice-diagnostic-head">
          <div>
            <h3>检查服务连接</h3>
            <p>检查网络与签名认证。通过后，还需在应用中实际试听、录音或评分，确认服务权限和额度。</p>
          </div>
          <button className="btn btn-secondary btn-sm" disabled={testing || (!mainConfigured && !sources.tts && !sources.asr)} onClick={() => void testAll()}>
            {testing ? "检查中…" : "检查全部连接"}
          </button>
        </div>
        {SERVICE_ORDER.map((kind) => {
          const svc = SERVICES[kind];
          const light = lights[kind];
          const source = kind === "ise" ? mainConfigured ? "主凭据" : null : sources[kind] === "own" ? "单独凭据" : sources[kind] === "main" ? "主凭据" : null;
          const state = !source ? "未配置" : light.state === "ok" ? "连接检查通过" : light.state === "bad" ? "连接检查失败" : light.state === "testing" ? "检查中…" : "尚未检查";
          return (
            <div className="voice-xfyun-check-row" key={kind}>
              <div>
                <strong>{svc.label}</strong>
                <p>{svc.name} · {source || "需要保存凭据"}</p>
                {light.message && <p className={`voice-probe-result ${light.state}`}>{light.message}</p>}
              </div>
              <span className={`voice-feature-status ${light.state === "ok" ? "ok" : light.state === "bad" ? "bad" : "muted"}`}>{state}</span>
              <button className="btn btn-ghost btn-sm" disabled={!source || testing || light.state === "testing"} onClick={() => void testService(kind)}>
                {light.state === "testing" ? "检查中…" : light.state === "idle" ? "检查连接" : "重新检查"}
              </button>
            </div>
          );
        })}
      </section>

      <div className="voice-details">
        <button className="voice-details-toggle" onClick={() => setAdvancedOpen((value) => !value)} aria-expanded={advancedOpen}>
          <span aria-hidden>{advancedOpen ? "▾" : "▸"}</span>
          高级：为不同服务配置独立应用
          {(sources.tts === "own" || sources.asr === "own") && <span className="voice-feature-status muted">已设置独立凭据</span>}
        </button>
        {advancedOpen && (
          <div className="voice-details-content">
            <p className="voice-footnote">仅在朗读或识别使用不同讯飞应用时填写；清除独立凭据后，会恢复使用上面的应用凭据。</p>
            <OverrideCard
              kind="tts"
              title="云端朗读的独立应用"
              source={sources.tts}
              onSave={saveXfyunTtsCredentials}
              onClear={clearXfyunTtsCredentials}
              onChanged={() => {
                probeGenerationRef.current += 1;
                refreshStatus();
                setLights((current) => ({ ...current, tts: IDLE_LIGHT }));
              }}
            />
            <OverrideCard
              kind="asr"
              title="语音识别的独立应用"
              source={sources.asr}
              onSave={saveAsrCredentials}
              onClear={clearAsrCredentials}
              onChanged={() => {
                probeGenerationRef.current += 1;
                refreshStatus();
                setLights((current) => ({ ...current, asr: IDLE_LIGHT }));
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** 高级覆盖卡：三段输入 + 保存 + 清除（回到主凭据）。 */
function OverrideCard({
  kind,
  title,
  source,
  onSave,
  onClear,
  onChanged,
}: {
  kind: OverrideKind;
  title: string;
  source: "own" | "main" | null;
  onSave: (patch: CredPatch) => Promise<boolean>;
  onClear: () => Promise<void>;
  onChanged: () => void;
}): ReactNode {
  const [fields, setFields] = useState<CredPatch>({});
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const empty = !fields.appId?.trim() && !fields.apiKey?.trim() && !fields.apiSecret?.trim();

  const save = useCallback(async () => {
    if (saving || empty) return;
    setSaving(true);
    setFeedback(null);
    try {
      const ok = await onSave(fields);
      if (ok) {
        setFields({});
        setFeedback({ ok: true, text: "已保存，本服务改用这组单独凭据 ✓" });
        void emit("xfyun:creds-updated", { kind }).catch(() => undefined);
      } else {
        setFeedback({ ok: false, text: "已保存填写的项，但三段还不齐（都保存过才生效；生效前仍用原凭据）" });
      }
    } catch (e) {
      setFeedback({ ok: false, text: `保存失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSaving(false);
      onChanged();
    }
  }, [saving, empty, fields, onSave, kind, onChanged]);

  const clear = useCallback(async () => {
    if (clearing) return;
    setClearing(true);
    setFeedback(null);
    try {
      await onClear();
      setFeedback({ ok: true, text: "已清除，本服务回到使用主凭据" });
      void emit("xfyun:creds-updated", { kind }).catch(() => undefined);
    } catch (e) {
      setFeedback({ ok: false, text: `清除失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setClearing(false);
      onChanged();
    }
  }, [clearing, onClear, kind, onChanged]);

  return (
    <div style={{ marginTop: 10, paddingLeft: 8, borderLeft: "2px solid var(--border, #ddd)" }}>
      <div className="field-block-head">
        <span className="field-label-v2" style={{ fontSize: 12.5 }}>{title}</span>
        <span className={`chip ${source === "own" ? "chip-blue" : "chip-amber"}`}>
          {source === "own" ? "使用单独凭据" : source === "main" ? "使用主凭据" : "未配置"}
        </span>
      </div>
      <CredTripleInputs
        appId={fields.appId ?? ""}
        apiKey={fields.apiKey ?? ""}
        apiSecret={fields.apiSecret ?? ""}
        appIdPlaceholder="APPID（该服务的应用）"
        onChange={(patch) => {
          setFields((cur) => ({ ...cur, ...patch }));
          setFeedback(null);
        }}
      />
      <div className="provider-actions">
        <button className="btn btn-primary btn-sm" disabled={saving || empty} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          disabled={clearing || source !== "own"}
          onClick={() => void clear()}
          title="删除本服务的单独凭据，回到使用主凭据"
        >
          {clearing ? "清除中…" : "清除（回到主凭据）"}
        </button>
      </div>
      <Feedback feedback={feedback} />
    </div>
  );
}
