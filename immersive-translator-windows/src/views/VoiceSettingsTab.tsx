/**
 * 设置页「语音」tab（契约 §三.1/§三.6/§三.7）：复刻「模型服务」双栏单选同构。
 *
 * - 左列：「沉浸云语音」官方大卡（platform-card）+「自带凭据 · 高级」下的讯飞行；
 *   右列随选中切换（云能力卡 / 现有 XfyunVoiceSection 三件套原样保留）。
 * - 选中即即时保存（voiceProvider，§三.2，写盘在 Settings 的回调里）；
 *   与 LLM providerId 解耦。
 * - 迁移推断（§三.3）：未存过 voiceProvider 时按讯飞凭据存在性取默认，只展示不落盘。
 * - 沉浸云未开放（platformBase===null）：官方分组不渲染、选中强制讯飞语义、页头保留
 *   现网讯飞文案（§三.6 最后一态）。
 * - 能力下发：登录后拉一次 getVoiceCapabilities()，视图状态经 gatewayViewState 归约；
 *   失败码只有 banned 单列（封禁整卡），其余并入「网络失败」。
 */

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openLoginWindow } from "../lib/tauriBridge";
import {
  getVoiceCapabilities,
  type VoiceCapabilities,
} from "../lib/voice";
import {
  reduceVoiceGatewayView,
  voiceGatewayStatusLine,
} from "../lib/voice/gatewayViewState";
import type { VoiceProvider } from "../lib/settingsStore";
import { hasAnyXfyunCredential } from "../lib/iseCredentials";
import { GatewayVoiceSection } from "./GatewayVoiceSection";
import { XfyunVoiceSection } from "./XfyunVoiceSection";
import { IconAlert, IconCheck, IconClose, IconInfo, IconRetry } from "../ui/icons";

export interface VoiceSettingsTabProps {
  /** 沉浸云网关 base；null = 未开放（官方层整体不渲染）。 */
  platformBase: string | null;
  loggedIn: boolean;
  email: string;
  /** 即时保存的语音偏好（存于 AppSettings；undefined = 未存过，走迁移推断）。 */
  voiceProvider: VoiceProvider | undefined;
  voiceGatewayVoice: string | undefined;
  voiceGatewayIseEnabled: boolean;
  onSelectProvider: (provider: VoiceProvider) => void;
  onSelectVoice: (voiceId: string) => void;
  onToggleIse: (on: boolean) => void;
  /** 「兑换更多额度」→ 账号 tab 兑换码卡（Settings 里切 tab + scrollIntoView）。 */
  onOpenRedeem: () => void;
  /** 「管理账号」→ 账号 tab。 */
  onOpenAccount: () => void;
}

/** 能力拉取失败的错误码：AuthError 取 code，其余按网络失败。 */
function capsErrorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "network_error";
}

export function VoiceSettingsTab({
  platformBase,
  loggedIn,
  email,
  voiceProvider,
  voiceGatewayVoice,
  voiceGatewayIseEnabled,
  onSelectProvider,
  onSelectVoice,
  onToggleIse,
  onOpenRedeem,
  onOpenAccount,
}: VoiceSettingsTabProps) {
  const cloudOpen = platformBase !== null;
  /** 迁移推断结果（仅在未存过 voiceProvider 时生效；§三.3）。 */
  const [inferred, setInferred] = useState<VoiceProvider | null>(null);
  const [caps, setCaps] = useState<VoiceCapabilities | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  /** 402/WSS quota_exceeded 事件（资源裸值），配额常驻字段未下发时的兜底来源。 */
  const [quotaEvents, setQuotaEvents] = useState<string[]>([]);
  const [xfyunConfigured, setXfyunConfigured] = useState<boolean | null>(null);
  const [guideDismissed, setGuideDismissed] = useState(false);
  const [openingLogin, setOpeningLogin] = useState(false);

  // 迁移推断：未存过选择时按讯飞凭据存在性取默认（任一凭据存在 → 保持 xfyun 零感知）。
  useEffect(() => {
    if (!cloudOpen || voiceProvider !== undefined) return;
    let active = true;
    void hasAnyXfyunCredential()
      .then((any) => {
        if (active) setInferred(any ? "xfyun" : "gateway");
      })
      .catch(() => {
        if (active) setInferred("gateway");
      });
    return () => {
      active = false;
    };
  }, [cloudOpen, voiceProvider]);

  // 讯飞行 keydot / 右列徽标：任一讯飞凭据已保存即点亮；他处保存后广播事件同步。
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void hasAnyXfyunCredential()
        .then((any) => {
          if (active) setXfyunConfigured(any);
        })
        .catch(() => {
          if (active) setXfyunConfigured(false);
        });
    };
    refresh();
    let unlisten: (() => void) | null = null;
    void listen("xfyun:creds-updated", () => refresh()).then((fn) => {
      unlisten = fn;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // 能力下发：登录后拉一次；重试 / 登出重登由依赖项驱动。
  useEffect(() => {
    if (!cloudOpen || !loggedIn) {
      setCaps(null);
      setCapsError(null);
      return;
    }
    let active = true;
    setCapsLoading(true);
    setCapsError(null);
    void getVoiceCapabilities()
      .then((c) => {
        if (active) setCaps(c);
      })
      .catch((e) => {
        if (active) setCapsError(capsErrorCode(e));
      })
      .finally(() => {
        if (active) setCapsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cloudOpen, loggedIn, reloadNonce]);

  /** 生效服务商：官方云未开放强制讯飞；未存过用推断值；再未就绪先按 gateway 骨架。 */
  const provider: VoiceProvider = !cloudOpen
    ? "xfyun"
    : (voiceProvider ?? inferred ?? "gateway");

  const view = reduceVoiceGatewayView({
    loading: capsLoading,
    errorCode: capsError,
    caps,
    quotaEvents,
  });

  const status = voiceGatewayStatusLine(view, { loggedIn, email });

  const selectProvider = useCallback(
    (next: VoiceProvider) => {
      if (!cloudOpen && next === "gateway") return; // 未开放：官方卡不存在，不可选
      if (next !== provider) onSelectProvider(next);
    },
    [cloudOpen, provider, onSelectProvider],
  );

  const handleQuotaEvent = useCallback((resource: string) => {
    setQuotaEvents((cur) => (cur.includes(resource) ? cur : [...cur, resource]));
  }, []);

  const handleLogin = useCallback(() => {
    if (openingLogin || loggedIn) return;
    setOpeningLogin(true);
    // 登录成功的状态翻转由 Rust auth-state-changed 广播（loggedIn prop 变化即触发能力下发）。
    void openLoginWindow()
      .catch((e) => console.error("[voice] open login failed", e))
      .finally(() => setOpeningLogin(false));
  }, [openingLogin, loggedIn]);

  // 引导切云条：已登录且三项能力齐备、用户还停在讯飞时提示（可关闭）。
  const showSwitchGuide =
    cloudOpen && provider === "xfyun" && loggedIn && view.caps === "full" && !guideDismissed;
  // 未开通提示条：带重试（重新拉能力）。
  const showNotProvisioned = cloudOpen && provider === "gateway" && view.caps === "none";

  return (
    <>
      <header className="set-pagehead">
        <div className="set-pagehead-text">
          <h2>语音</h2>
          <p>
            {cloudOpen
              ? "云端朗读、口语识别、跟读打分——登录沉浸云即用，无需申请任何密钥；也可使用自己的讯飞凭据。"
              : "填一组讯飞凭据，跟读打分、云端朗读、口语识别三个服务共用（需在讯飞控制台为应用开通对应服务）。经 DPAPI 加密存储。"}
          </p>
        </div>
      </header>

      {showSwitchGuide && (
        <div className="msg-bar ok" role="status" style={{ marginBottom: 14 }}>
          <IconInfo size={14} />
          <span>沉浸云已为本账号开通语音能力——点击左侧「沉浸云语音」卡片即可切换，讯飞凭据保留、随时切回。</span>
          <button
            className="btn btn-ghost btn-sm"
            aria-label="关闭提醒"
            onClick={() => setGuideDismissed(true)}
          >
            <IconClose size={12} />
          </button>
        </div>
      )}
      {showNotProvisioned && (
        <div className="msg-bar warn" role="status" style={{ marginBottom: 14 }}>
          <IconAlert size={14} />
          <span>语音功能暂未开通——账号正常，服务端尚未为本账号开通语音。</span>
          <button className="btn btn-secondary btn-sm" onClick={() => setReloadNonce((n) => n + 1)}>
            <IconRetry size={12} />
            重试
          </button>
        </div>
      )}

      <div className="provider-workspace">
        {/* ---- 左列：服务商选择 ---- */}
        <section className="provider-selection">
          <div role="radiogroup" aria-label="语音服务商">
            {cloudOpen && (
              <div className="provider-group">
                <div className="settings-section-heading">
                  <div>
                    <h3>官方云服务</h3>
                    <p>沉浸云账号登录即用，三个服务零配置</p>
                  </div>
                </div>
                <button
                  type="button"
                  role="radio"
                  aria-checked={provider === "gateway"}
                  className={`platform-card${provider === "gateway" ? " active" : ""}`}
                  onClick={() => selectProvider("gateway")}
                >
                  <span className="provider-mark" aria-hidden>
                    云
                  </span>
                  <span className="platform-card-body">
                    <span className="platform-card-title">
                      沉浸云语音
                      <span className="chip chip-green">官方</span>
                      <span className="chip chip-blue">推荐</span>
                    </span>
                    <span className="platform-card-desc">登录即用，三服务共用一个账号</span>
                    <span
                      className={`platform-card-status${status.tone === "err" ? " err" : status.tone === "off" ? " off" : ""}`}
                    >
                      <i aria-hidden />
                      {status.text}
                    </span>
                  </span>
                  {provider === "gateway" && (
                    <span className="provider-check">
                      <IconCheck size={12} />
                    </span>
                  )}
                </button>
              </div>
            )}

            <div className="provider-group">
              <div className="settings-section-heading">
                <div>
                  <h3>自带凭据 · 高级</h3>
                  <p>使用你自己的讯飞开放平台应用与密钥</p>
                </div>
              </div>
              <div className="provider-list">
                <button
                  type="button"
                  role="radio"
                  aria-checked={provider === "xfyun"}
                  className={`provider-item${provider === "xfyun" ? " active" : ""}`}
                  onClick={() => selectProvider("xfyun")}
                >
                  <span
                    className="provider-mark"
                    style={{ color: "#2c6dfb", background: "rgba(44, 109, 251, 0.12)" }}
                    aria-hidden
                  >
                    讯
                  </span>
                  <span className="provider-name">讯飞开放平台</span>
                  <span className="provider-meta">
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        color: "var(--text-3, #888)",
                        fontSize: 10,
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      跟读打分 / 口语识别 / 云端朗读 · 需自行申请凭据
                    </span>
                    {xfyunConfigured && (
                      <span className="provider-keydot" title="已保存讯飞凭据（DPAPI 加密）" />
                    )}
                  </span>
                  {provider === "xfyun" && (
                    <span className="provider-check">
                      <IconCheck size={12} />
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* ---- 右列：随选中切换的配置面板 ---- */}
        <section className="provider-configuration">
          <div className="settings-section-heading">
            <div>
              <h3>{provider === "gateway" ? "沉浸云账号" : "讯飞开放平台"}</h3>
              <p>{provider === "gateway" ? "沉浸云语音" : "跟读打分 / 口语识别 / 云端朗读"}</p>
            </div>
            {provider === "gateway" ? (
              <span className={`chip ${loggedIn ? "chip-green" : "chip-amber"}`}>
                {loggedIn ? "已登录" : "未登录"}
              </span>
            ) : (
              <span className={`chip ${xfyunConfigured ? "chip-green" : "chip-amber"}`}>
                {xfyunConfigured === null ? "读取中…" : xfyunConfigured ? "凭据已保存" : "未配置"}
              </span>
            )}
          </div>
          {provider === "gateway" ? (
            <GatewayVoiceSection
              email={email}
              loggedIn={loggedIn}
              openingLogin={openingLogin}
              caps={caps}
              view={view}
              selectedVoice={voiceGatewayVoice}
              iseEnabled={voiceGatewayIseEnabled}
              onLogin={handleLogin}
              onManageAccount={onOpenAccount}
              onRetryCaps={() => setReloadNonce((n) => n + 1)}
              onOpenRedeem={onOpenRedeem}
              onSelectVoice={onSelectVoice}
              onToggleIse={onToggleIse}
              onQuotaEvent={handleQuotaEvent}
            />
          ) : (
            <XfyunVoiceSection />
          )}
        </section>
      </div>

      <p className="provider-caption">
        之前在阅读室设置抽屉、口语陪练、录音直译里填过的凭据仍然有效（同一套加密存储），无需重复填写。
      </p>
    </>
  );
}
