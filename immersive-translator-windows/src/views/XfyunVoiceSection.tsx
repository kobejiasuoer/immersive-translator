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

import { useCallback, useEffect, useState, type ReactNode } from "react";
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

const SERVICE_ORDER: ServiceKind[] = ["ise", "tts", "asr"];

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
    return { state: "bad", message: "还没有可用的凭据——先在上面保存一组主凭据" };
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
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="icon-btn input-append"
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
    <>
      <input
        className="input mono input-full"
        placeholder={appIdPlaceholder}
        value={appId}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange({ appId: e.target.value })}
      />
      <MaskedInput
        value={apiKey}
        placeholder="API Key"
        label="API Key"
        onChange={(v) => onChange({ apiKey: v })}
      />
      <MaskedInput
        value={apiSecret}
        placeholder="API Secret"
        label="API Secret"
        onChange={(v) => onChange({ apiSecret: v })}
      />
    </>
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
    refreshStatus();
    echoMain();
    // 他处保存凭据后广播事件，这里同步徽标与回显
    let unlisten: (() => void) | null = null;
    void listen("xfyun:creds-updated", () => {
      refreshStatus();
      echoMain();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [refreshStatus, echoMain]);

  const testService = useCallback(async (kind: ServiceKind) => {
    setLights((cur) => ({ ...cur, [kind]: { state: "testing", message: "" } }));
    try {
      const result = await probeService(kind);
      setLights((cur) => ({ ...cur, [kind]: result }));
    } catch (e) {
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
        setMainFeedback({ ok: true, text: "已保存 ✓ 三个服务现在都用这一组；点「一键测试」验证各服务是否已开通" });
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
    <>
      {/* ---- 主凭据 ---- */}
      <div className="group-card">
        <div className="field-block">
          <div className="field-block-head">
            <span className="field-label-v2">讯飞语音凭据</span>
            <span className={`chip ${mainConfigured ? "chip-green" : "chip-amber"}`}>
              {mainConfigured === null ? "读取中…" : mainConfigured ? "已配置" : "未配置"}
            </span>
          </div>
          <p className="field-hint">
            到讯飞开放平台控制台复制你应用的三个值。跟读打分、口语识别、云端朗读默认都用这一组——
            一个应用可同时开通三个服务（控制台 → 应用 → 服务列表领取免费额度）。
          </p>
          <CredTripleInputs
            appId={main.appId}
            apiKey={main.apiKey}
            apiSecret={main.apiSecret}
            appIdPlaceholder="APPID（讯飞控制台 → 我的应用）"
            onChange={(patch) => {
              setMain((cur) => ({ ...cur, ...patch }));
              setMainFeedback(null);
            }}
          />
          <div className="provider-actions">
            <button className="btn btn-primary btn-sm" disabled={savingMain || mainEmpty} onClick={() => void saveMain()}>
              {savingMain ? "保存中…" : "保存（DPAPI 加密）"}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={testing}
              onClick={() => void testAll()}
              title="用已保存的凭据逐个连一下三个服务的讯飞端点：不耗额度，几秒出结果"
            >
              {testing ? "测试中…" : "一键测试三个服务"}
            </button>
          </div>
          <Feedback feedback={mainFeedback} />
        </div>
      </div>

      {/* ---- 三个服务灯 ---- */}
      <div className="group-card">
        <div className="field-block">
          <span className="field-label-v2">服务状态</span>
          <p className="field-hint">
            绿 = 可用。红色时按提示排查后点「重测」；三个都红且提示网络超时，多为代理/防火墙拦截。
          </p>
          {SERVICE_ORDER.map((kind) => {
            const svc = SERVICES[kind];
            const light = lights[kind];
            const source: string | null =
              kind === "ise"
                ? mainConfigured
                  ? "主凭据"
                  : null
                : sources[kind] === "own"
                  ? "单独凭据"
                  : sources[kind] === "main"
                    ? "主凭据"
                    : null;
            return (
              <div
                key={kind}
                style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "6px 0" }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    flex: "none",
                    background:
                      light.state === "ok"
                        ? "var(--ok, #2a9d4a)"
                        : light.state === "bad"
                          ? "var(--err, #d33)"
                          : light.state === "testing"
                            ? "var(--amber, #d99a2a)"
                            : "var(--border, #999)",
                  }}
                />
                <b style={{ fontSize: 13 }}>{svc.label}</b>
                <span style={{ fontSize: 12, color: "var(--text-3, #888)" }}>
                  {svc.name}
                  {source ? ` · ${source}` : " · 未配置"}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: "auto" }}
                  disabled={light.state === "testing"}
                  onClick={() => void testService(kind)}
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
        </div>
      </div>

      {/* ---- 高级：按服务单独覆盖 ---- */}
      <div className="group-card">
        <div className="field-block">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? "▾" : "▸"} 高级：按服务使用不同凭据
          </button>
          <p className="field-hint">
            仅当你的不同语音功能用了不同的讯飞应用（例如合成单独买量）才需要；一般用户保持为空，
            三个服务自动共用上面的主凭据。
          </p>
          {advancedOpen && (
            <>
              <OverrideCard
                kind="tts"
                title="云端朗读（在线合成）单独凭据"
                source={sources.tts}
                onSave={saveXfyunTtsCredentials}
                onClear={clearXfyunTtsCredentials}
                onChanged={() => {
                  refreshStatus();
                  setLights((cur) => ({ ...cur, tts: IDLE_LIGHT }));
                }}
              />
              <OverrideCard
                kind="asr"
                title="口语识别（流式听写）单独凭据"
                source={sources.asr}
                onSave={saveAsrCredentials}
                onClear={clearAsrCredentials}
                onChanged={() => {
                  refreshStatus();
                  setLights((cur) => ({ ...cur, asr: IDLE_LIGHT }));
                }}
              />
            </>
          )}
        </div>
      </div>
    </>
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
