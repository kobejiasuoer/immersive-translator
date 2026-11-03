/** 语音设置：先选择服务，再展示真实可用性和各功能配置；偏好即时保存。 */

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
import { isLocalhostEndpoint } from "../core/providerPresets";
import { hasAnyXfyunCredential } from "../lib/iseCredentials";
import { GatewayVoiceSection } from "./GatewayVoiceSection";
import { XfyunVoiceSection } from "./XfyunVoiceSection";
import { IconCheck, IconClose, IconInfo } from "../ui/icons";

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
      if (active) unlisten = fn;
      else fn();
    }).catch(() => undefined);
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
      setCapsLoading(false);
      setQuotaEvents([]);
      return;
    }
    let active = true;
    setCapsLoading(true);
    setCapsError(null);
    setCaps(null);
    setQuotaEvents([]);
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
  }, [cloudOpen, platformBase, loggedIn, email, reloadNonce]);

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
    if (openingLogin) return;
    setOpeningLogin(true);
    // 登录成功的状态翻转由 Rust auth-state-changed 广播（loggedIn prop 变化即触发能力下发）。
    void openLoginWindow()
      .catch((e) => console.error("[voice] open login failed", e))
      .finally(() => setOpeningLogin(false));
  }, [openingLogin]);

  // 引导切云条：已登录且三项能力齐备、用户还停在讯飞时提示（可关闭）。
  const showSwitchGuide =
    cloudOpen && provider === "xfyun" && loggedIn && view.caps === "full" && !guideDismissed;

  return (
    <div className="voice-settings">
      <header className="set-pagehead">
        <div className="set-pagehead-text">
          <h2>语音</h2>
          <p>设置朗读、语音转文字和跟读评分，查看状态并测试。</p>
        </div>
        <span className="voice-save-note">选择后自动保存</span>
      </header>

      {platformBase !== null && isLocalhostEndpoint(platformBase) && (
        <div className="msg-bar warn voice-switch-guide" role="status">
          <IconInfo size={14} />
          <span>当前连接本地测试服务 {platformBase}。线上管理台的设置不会在这里生效，请用正式版验证云语音。</span>
        </div>
      )}

      <section className="voice-service-picker" aria-label="语音服务">
        <div className="voice-section-label">使用哪种语音服务</div>
        <div className={`voice-service-options${cloudOpen ? "" : " single"}`} role="radiogroup" aria-label="语音服务商">
          {cloudOpen && (
            <button
              type="button"
              role="radio"
              aria-checked={provider === "gateway"}
              className={`voice-service-option${provider === "gateway" ? " selected" : ""}`}
              onClick={() => selectProvider("gateway")}
            >
              <span className="voice-service-mark" aria-hidden>云</span>
              <span className="voice-service-copy">
                <strong>沉浸云语音</strong>
                <small className={`voice-service-status ${status.tone}`}>{status.text}</small>
              </span>
              <span className="voice-service-radio" aria-hidden>
                {provider === "gateway" && <IconCheck size={12} />}
              </span>
            </button>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={provider === "xfyun"}
            className={`voice-service-option${provider === "xfyun" ? " selected" : ""}`}
            onClick={() => selectProvider("xfyun")}
          >
            <span className="voice-service-mark" aria-hidden>讯</span>
            <span className="voice-service-copy">
              <strong>讯飞开放平台</strong>
              <small className="voice-service-status">
                {xfyunConfigured === null ? "正在读取配置…" : xfyunConfigured ? "已保存凭据，请检查各项服务连接" : "需要配置应用并开通对应服务"}
              </small>
            </span>
            <span className="voice-service-radio" aria-hidden>
              {provider === "xfyun" && <IconCheck size={12} />}
            </span>
          </button>
        </div>
      </section>

      {showSwitchGuide && (
        <div className="msg-bar ok voice-switch-guide" role="status">
          <IconInfo size={14} />
          <span>沉浸云的三项语音能力已开放，可以切换使用。</span>
          <button className="btn btn-secondary btn-sm" onClick={() => selectProvider("gateway")}>使用沉浸云</button>
          <button className="btn btn-ghost btn-sm" aria-label="关闭提醒" onClick={() => setGuideDismissed(true)}>
            <IconClose size={12} />
          </button>
        </div>
      )}

      <section className="voice-service-panel" aria-label={provider === "gateway" ? "沉浸云语音设置" : "讯飞语音设置"}>
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
            onUseXfyun={() => selectProvider("xfyun")}
          />
        ) : (
          <XfyunVoiceSection />
        )}
      </section>
      <p className="voice-footnote">已保存的讯飞凭据可继续使用，切换服务无需重复填写。朗读方式也可在阅读室中调整。</p>
    </div>
  );
}
