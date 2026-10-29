import { useEffect, useRef, useState, type ComponentType } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import {
  loadSettingsFullAsync,
  saveSettingsFullAsync,
  saveVoicePrefs,
  stripVoicePrefs,
  DEFAULT_SETTINGS,
  hasValidSettings,
  isOnboardingDismissed,
  setOnboardingDismissed,
  providerIdFor,
  type AppSettings,
  type KeyVault,
  type VoiceProvider,
} from "../lib/settingsStore";
import type { TranslationMode } from "../core/languageDetect";
import {
  PROVIDER_PRESETS,
  isLocalhostEndpoint,
  PLATFORM_PROVIDER_ID,
  platformEndpoint,
  type ProviderPreset,
} from "../core/providerPresets";
import {
  parseHotkey,
  validateHotkey,
  normalizeHotkey,
  RECOMMENDED_HOTKEYS,
} from "../core/hotkeyValidator";
import { reregisterHotkeys, testConnectivity, openOnboarding, settingsTakePendingTab, listenSettingsNavigateTab, authFetchServerConfig, authServerBaseUrl, openLoginWindow } from "../lib/tauriBridge";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  ocrModelsReady,
  ocrDownloadModels,
  onDownloadProgress,
  type DownloadProgress,
} from "../lib/tauriBridge";
import {
  checkForUpdate,
  downloadAndInstall,
  type UpdateProgress,
  type UpdateStage,
} from "../lib/updater";
import { buildSanitizedCurl, buildDiagnosticReport } from "../core/errorMessageFormatter";
import { glossaryStats, dedupAndNormalize, mergeGlossary } from "../core/glossaryParser";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import {
  IconCheck,
  IconAlert,
  IconDownload,
  IconUpload,
  IconEye,
  IconEyeOff,
  IconTranslate,
  IconRetry,
  IconClose,
  IconCopy,
  IconSparkles,
  IconBookOpen,
  IconInfo,
  IconKeyboard,
  IconVolume,
  IconUser,
} from "../ui/icons";
import { VoiceSettingsTab } from "./VoiceSettingsTab";
import { AccountSection, useAccountStatus } from "./AccountSection";
import { PrivacyPolicyCard } from "./PrivacyPolicyCard";

type SettingsTab = "provider" | "translation" | "voice" | "glossary" | "hotkeys" | "account" | "about";

const TABS: { id: SettingsTab; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: "provider", label: "模型服务", icon: IconSparkles },
  { id: "translation", label: "翻译", icon: IconTranslate },
  { id: "voice", label: "语音", icon: IconVolume },
  { id: "glossary", label: "术语表", icon: IconBookOpen },
  { id: "hotkeys", label: "快捷键", icon: IconKeyboard },
  { id: "account", label: "账号", icon: IconUser },
  { id: "about", label: "关于", icon: IconInfo },
];

/**
 * 设置窗口。点托盘「设置」菜单打开。
 * 左侧导航 + 右侧内容的双栏壳；七个分区：模型服务 / 翻译 / 语音 / 术语表 / 快捷键 / 账号 / 关于。
 * apiKey 按服务商分桶经 DPAPI 加密存储，其余字段存 localStorage。
 * 账号 tab（AccountSection）状态由 Rust 侧 auth-state-changed 事件驱动；
 * 托盘「账号登录」在已登录时经 settings_open_tab 双路径定位到账号 tab（挂载 take + 运行中 listen）。
 */
export function Settings() {
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
  }));
  /** 进入页面时已保存的快照：用于判断是否有未保存的更改。 */
  const [savedSnapshot, setSavedSnapshot] = useState<AppSettings | null>(null);
  /** 按服务商分桶的密钥库（内存副本），切换服务商时 Key 跟着切换。 */
  const [vault, setVault] = useState<KeyVault>({});
  const [activeTab, setActiveTab] = useState<SettingsTab>("provider");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeTab]);
  const [saved, setSaved] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  /** API Key 明文显隐。 */
  const [showKey, setShowKey] = useState(false);
  /** 「恢复默认」确认弹窗。 */
  const [confirmReset, setConfirmReset] = useState(false);

  // 首次加载后：加载设置与密钥库；若未关闭引导且接口未配好，显示引导卡
  useEffect(() => {
    let active = true;
    loadSettingsFullAsync().then(({ settings: s, vault: v }) => {
      if (!active) return;
      setSettings(s);
      setSavedSnapshot(s);
      setVault(v);
      if (!isOnboardingDismissed() && !hasValidSettings(s)) {
        setShowWelcome(true);
      }
    });
    void getVersion().then(setAppVersion).catch(() => setAppVersion(""));
    return () => {
      active = false;
    };
  }, []);

  // ---- 开机自启（tauri-plugin-autostart，Windows 写 HKCU Run 键）----
  // null = 还在查询；开关失败时回滚并提示。
  const [autoStart, setAutoStart] = useState<boolean | null>(null);
  const [autoStartErr, setAutoStartErr] = useState<string | null>(null);
  useEffect(() => {
    void isAutostartEnabled()
      .then(setAutoStart)
      .catch(() => setAutoStart(null));
  }, []);

  // ---- 账号（windows-auth）----
  // 状态机由 AccountSection 内的 useAccountStatus 持有；这里再取一份给侧栏 conn-chip。
  const { status: accountStatus } = useAccountStatus();

  // ---- 沉浸云（平台网关）----
  // endpoint = auth 同源 base + /v1/chat/completions（Rust 侧同构派生与识别）；
  // 模型列表来自 /v1/me/config（登录后才可拉），作为模型下拉建议。
  // platformBase === null = 沉浸云未开放（服务端未公开部署且本机无
  // server_endpoint.json）：整个「官方云服务」分组隐藏，不给可选即失败的配置。
  const [platformBase, setPlatformBase] = useState<string | null>(null);
  const [platformModels, setPlatformModels] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void authServerBaseUrl()
      .then((base) => {
        if (active) setPlatformBase(base);
      })
      .catch(() => setPlatformBase(null));
    return () => {
      active = false;
    };
  }, []);
  const platformEp = platformBase ? platformEndpoint(platformBase) : undefined;
  const loggedIn = accountStatus?.loggedIn ?? false;

  // ---- 登录自动切云（语音云决策 1）----
  // 登录成功的瞬间（loggedIn false→true）自动把 voiceProvider 写为 gateway：
  // 即时落盘 + 语音页卡片选中态随之切换 + 一条轻提示；讯飞凭据原样保留、随时可切回。
  // 已是 gateway 无感；启动静默续登录（null→true）不算登录瞬间，不代切。
  const prevLoggedInRef = useRef<boolean | null>(null);
  const [switchedNotice, setSwitchedNotice] = useState(false);
  const switchNoticeTimer = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevLoggedInRef.current;
    prevLoggedInRef.current = loggedIn;
    if (prev !== false || !loggedIn) return;
    if (settings.voiceProvider === "gateway") return;
    applyVoicePrefs({ voiceProvider: "gateway" });
    setSwitchedNotice(true);
    if (switchNoticeTimer.current !== null) window.clearTimeout(switchNoticeTimer.current);
    switchNoticeTimer.current = window.setTimeout(() => setSwitchedNotice(false), 4000);
  }, [loggedIn]);
  // 卸载时清掉未触发的提示定时器
  useEffect(() => {
    return () => {
      if (switchNoticeTimer.current !== null) window.clearTimeout(switchNoticeTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!loggedIn) {
      setPlatformModels([]);
      return;
    }
    let active = true;
    void authFetchServerConfig()
      .then((cfg) => {
        if (!active) return;
        const models = (cfg as { models?: unknown })?.models;
        setPlatformModels(
          Array.isArray(models) ? models.filter((m): m is string => typeof m === "string") : [],
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [loggedIn]);

  // 账号 tab 双入口定位（docs §7 命令 10/11）：挂载时取走 pending tab（恰好一次，
  // settings 窗 hide 不销毁、挂载一生一次，pending 只覆盖启动早期的窗口窄缝）。
  useEffect(() => {
    let active = true;
    void settingsTakePendingTab()
      .then((tab) => {
        if (!active || !tab) return;
        const known = TABS.find((t) => t.id === tab);
        if (known) setActiveTab(known.id);
      })
      .catch((e) => console.error("[settings] take pending tab failed", e));
    return () => {
      active = false;
    };
  }, []);

  // 窗口已存在时的即时导航：settings_open_tab 走 emit_to("settings")。
  useEffect(() => {
    const unlistenP = listenSettingsNavigateTab((tab) => {
      const known = TABS.find((t) => t.id === tab);
      if (known) setActiveTab(known.id);
    });
    return () => {
      void unlistenP.then((u) => u());
    };
  }, []);

  function toggleAutostart() {
    const next = !(autoStart ?? false);
    setAutoStart(next);
    setAutoStartErr(null);
    void (next ? enableAutostart() : disableAutostart()).catch((e) => {
      setAutoStart(!next);
      setAutoStartErr(String(e));
    });
  }

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  /** 当前服务商 id（与 vault 桶一致）。 */
  const activeProviderId = providerIdFor(settings, platformEp);
  const activePreset = PROVIDER_PRESETS.find((p) => p.id === activeProviderId);
  const isPlatform = activeProviderId === PLATFORM_PROVIDER_ID;
  const currentIsLocal = isPlatform || (activePreset?.allowEmptyApiKey ?? isLocalhostEndpoint(settings.endpoint));
  const platformPreset = PROVIDER_PRESETS.find((p) => p.id === PLATFORM_PROVIDER_ID);
  const localPresets = PROVIDER_PRESETS.filter((p) => p.id !== PLATFORM_PROVIDER_ID);
  // 语音偏好（voiceProvider 等）是即时保存字段：不进保存条 dirty 比较（契约 §三.2）。
  const dirty =
    savedSnapshot !== null &&
    JSON.stringify(stripVoicePrefs(settings)) !== JSON.stringify(stripVoicePrefs(savedSnapshot));

  /** 编辑 Key：同时写进当前服务商的桶，切换服务商不串味。 */
  function updateApiKey(value: string) {
    setSettings((prev) => ({ ...prev, apiKey: value }));
    setVault((prev) => ({ ...prev, [activeProviderId]: value }));
    setSaved(false);
  }

  /** 语音偏好点选即写盘：更新表单态 + 同步快照（dirty 恒静）+ 立即合并落 localStorage。 */
  function applyVoicePrefs(patch: {
    voiceProvider?: VoiceProvider;
    voiceGatewayVoice?: string;
    voiceGatewayIseEnabled?: boolean;
  }) {
    setSettings((prev) => ({ ...prev, ...patch }));
    setSavedSnapshot((prev) => (prev === null ? prev : { ...prev, ...patch }));
    saveVoicePrefs(patch);
  }

  /** 语音页「兑换更多额度」：切账号 tab 后滚动/聚焦兑换码卡（契约 §三.10）。 */
  function openAccountRedeem() {
    setActiveTab("account");
    window.setTimeout(() => {
      const card = document.getElementById("account-redeem");
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      card?.focus();
    }, 80);
  }

  /** 点服务商行：切换 endpoint + 模型 + 该服务商自己的 Key。 */
  function applyPreset(p: ProviderPreset) {
    if (p.id === PLATFORM_PROVIDER_ID) {
      // 沉浸云：endpoint 由 auth 同源 base 动态拼出；模型取服务端下发列表第一个。
      // 未开放时入口已隐藏，这里防御性直接返回（不回退本地联调地址）。
      const ep = platformEp;
      if (!ep) return;
      setSettings((prev) => ({
        ...prev,
        providerId: p.id,
        endpoint: ep,
        model: platformModels[0] ?? "",
        apiKey: "",
      }));
      setTestMsg(null);
      setSaved(false);
      return;
    }
    setSettings((prev) => ({
      ...prev,
      providerId: p.id,
      endpoint: p.endpoint,
      model: p.model,
      apiKey: vault[p.id] ?? "",
    }));
    setTestMsg(null);
    setSaved(false);
  }

  // 沉浸云模型兜底：me/config 比选中动作晚到时补上首个下发模型，避免空 model 请求
  useEffect(() => {
    if (isPlatform && platformModels.length > 0 && !settings.model.trim()) {
      update("model", platformModels[0]);
    }
  }, [isPlatform, platformModels, settings.model]);

  // ---- 连通性测试 ----
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ---- 术语表 ----
  const glossaryFileRef = useRef<HTMLInputElement>(null);
  const [glossaryMsg, setGlossaryMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const glossStats = glossaryStats(settings.glossaryText);

  // ---- OCR 模型 ----
  const [ocrReady, setOcrReady] = useState<boolean | null>(null);
  const [ocrDownloading, setOcrDownloading] = useState(false);
  const [ocrMsg, setOcrMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [ocrProgress, setOcrProgress] = useState<{ file: string; ratio: number } | null>(null);

  // 首次加载检查模型状态
  useEffect(() => {
    let active = true;
    ocrModelsReady().then((ready) => {
      if (active) setOcrReady(ready);
    });
    const unlistenP = onDownloadProgress((p: DownloadProgress) => {
      if (p.status === "downloading") {
        setOcrProgress({
          file: p.file,
          ratio: p.total ? (p.downloaded ?? 0) / p.total : 0,
        });
        setOcrMsg({ text: `正在下载 ${p.file}… ${p.total ? `${pct(p.downloaded ?? 0, p.total)}%` : ""}`, ok: true });
      } else if (p.status === "done") {
        setOcrProgress(null);
        setOcrMsg({ text: `${p.file} 下载完成`, ok: true });
      } else if (p.status === "complete") {
        setOcrProgress(null);
        setOcrMsg({ text: "模型下载完成，可以使用截图翻译了", ok: true });
        setOcrDownloading(false);
        setOcrReady(true);
      }
    });
    return () => {
      active = false;
      void unlistenP.then((u) => u());
    };
  }, []);

  async function handleDownloadModels() {
    setOcrDownloading(true);
    setOcrMsg({ text: "开始下载…", ok: true });
    setOcrProgress(null);
    try {
      await ocrDownloadModels();
    } catch (e) {
      setOcrMsg({ text: `下载失败：${e}`, ok: false });
      setOcrDownloading(false);
      setOcrProgress(null);
    }
  }

  // ---- 自动更新 ----
  const [updateStage, setUpdateStage] = useState<UpdateStage>("idle");
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | undefined>(undefined);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string } | null>(null);

  async function handleCheckUpdate() {
    setUpdateStage("checking");
    setUpdateMsg("正在检查更新…");
    setUpdateAvailable(null);
    try {
      const info = await checkForUpdate();
      if (info.hasUpdate) {
        setUpdateAvailable({ version: info.newVersion! });
        setUpdateMsg(`发现新版本 v${info.newVersion}（当前 v${info.currentVersion}）`);
        setUpdateStage("idle");
      } else {
        setUpdateMsg(`已是最新版本 v${info.currentVersion}`);
        setUpdateStage("done");
      }
    } catch (e) {
      setUpdateMsg(String(e));
      setUpdateStage("error");
    }
  }

  async function handleDownloadUpdate() {
    const onProgress = (p: UpdateProgress) => {
      setUpdateStage(p.stage);
      setUpdateMsg(p.message);
      setUpdateProgress(p.progress);
    };
    try {
      await downloadAndInstall(onProgress);
    } catch (e) {
      setUpdateMsg(`更新失败：${e}`);
      setUpdateStage("error");
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await testConnectivity(settings.endpoint, settings.apiKey, settings.model);
      setTestMsg({ text: r.message, ok: r.ok });
    } catch (e) {
      setTestMsg({ text: `测试失败：${e}`, ok: false });
    } finally {
      setTesting(false);
    }
  }

  // ---- 热键互斥校验（三个热键两两不能相同）----
  const [hotkeyErrMsg, setHotkeyErrMsg] = useState<string | null>(null);

  async function registerAllHotkeys(): Promise<boolean> {
    const t = normalizeHotkey(settings.hotkey);
    const o = normalizeHotkey(settings.ocrHotkey);
    const r = normalizeHotkey(settings.readerHotkey);
    if (t === o || t === r || o === r) {
      setHotkeyErrMsg("翻译、截图 OCR、阅读室热键两两不能相同");
      return false;
    }
    if (
      validateHotkey(t).blocking ||
      validateHotkey(o).blocking ||
      validateHotkey(r).blocking
    ) {
      setHotkeyErrMsg(null);
      return false;
    }
    try {
      await reregisterHotkeys(t, o, r);
      setHotkeyErrMsg(null);
      return true;
    } catch (e) {
      setHotkeyErrMsg(String(e));
      return false;
    }
  }

  async function handleSave() {
    // 与「进入页面时的快照」比较，判断热键是否真的被改过；
    // 只有改过才整组重注册，避免「改回默认值后未重注册」的遗留 bug。
    const changed =
      savedSnapshot !== null &&
      (settings.hotkey !== savedSnapshot.hotkey ||
        settings.ocrHotkey !== savedSnapshot.ocrHotkey ||
        settings.readerHotkey !== savedSnapshot.readerHotkey);
    await saveSettingsFullAsync(settings, vault);
    setSavedSnapshot(settings);
    if (changed) {
      await registerAllHotkeys();
    }
    // 配置已有效时，自动关闭引导卡
    if (configured) {
      setOnboardingDismissed(true);
      setShowWelcome(false);
    }
    setSaved(true);
  }

  async function handleClose() {
    await getCurrentWindow().hide();
  }

  function handleResetDefaults() {
    setConfirmReset(true);
  }

  function doResetDefaults() {
    setConfirmReset(false);
    const reset = { ...DEFAULT_SETTINGS };
    const resetVault: KeyVault = { [reset.providerId!]: "" };
    void saveSettingsFullAsync(reset, resetVault);
    setSettings(reset);
    setVault(resetVault);
    setSavedSnapshot(reset);
    setSaved(false);
  }

  // 沉浸云的「已配置」= 已选中且已登录（令牌代替 Key）；其他服务商看 endpoint + Key。
  const configured = hasValidSettings(settings) && (!isPlatform || loggedIn);
  const currentTabLabel = TABS.find((tab) => tab.id === activeTab)?.label ?? "模型服务";

  function renderTab(t: (typeof TABS)[number]) {
    const Icon = t.icon;
    return (
      <button
        key={t.id}
        className={`set-nav-item${activeTab === t.id ? " active" : ""}`}
        onClick={() => setActiveTab(t.id)}
      >
        <Icon size={16} />
        <span>{t.label}</span>
      </button>
    );
  }

  return (
    <div className="set-shell">
      {/* 左侧导航 */}
      <aside className="set-side">
        <div className="set-brand">
          <span className="set-brand-mark">
            <IconTranslate size={13} />
          </span>
          <span className="set-brand-copy">
            <strong>沉浸口语</strong>
            <small>设置中心</small>
          </span>
        </div>
        <nav className="set-nav" aria-label="设置分类">
          <span className="set-nav-caption">翻译与工具</span>
          {TABS.slice(0, 5).map(renderTab)}
          <span className="set-nav-caption set-nav-caption-account">账号与应用</span>
          {TABS.slice(5).map(renderTab)}
        </nav>
        <div className="set-side-foot">
          <span className={`conn-chip ${configured ? "ok" : "off"}`}>
            <i aria-hidden />
            {configured ? "接口已配置" : "未配置接口"}
          </span>
          <span className={`conn-chip ${accountStatus?.loggedIn ? "ok" : "off"}`}>
            <i aria-hidden />
            {accountStatus?.loggedIn ? "账号已登录" : "未登录账号"}
          </span>
          <span className="set-version">v{appVersion || "…"}</span>
        </div>
      </aside>

      {/* 右侧内容 */}
      <main className="set-main">
        <div className="set-topbar">
          <span>应用设置</span>
          <span className="set-topbar-divider" aria-hidden>／</span>
          <strong>{currentTabLabel}</strong>
        </div>
        <div className="set-content" ref={contentRef}>
        {switchedNotice && (
          <div className="msg-bar ok" role="status" style={{ marginBottom: 14 }}>
            <IconCheck size={14} />
            已切换为沉浸云语音——讯飞凭据已保留，可在「语音」页随时切回
          </div>
        )}
        {activeTab === "provider" && (
          <>
            <header className="set-pagehead">
              <div className="set-pagehead-text">
                <h2>模型服务</h2>
                <p>沉浸云登录即用；其他服务商使用你自己的 API Key，每家密钥分开保存、切换互不影响。</p>
              </div>
            </header>

            {showWelcome && (
              <div className="welcome-box">
                <div className="welcome-title">三步开始使用</div>
                <div className="welcome-body">
                  ① 选「<strong>沉浸云</strong>」登录即用；或选一个自带 Key 的服务商（国内直连推荐 <strong>DeepSeek</strong> 或 <strong>智谱 GLM</strong>）。
                  <br />
                  ② 自带 Key 的服务商需填入对应的 <strong>API Key</strong>（本地 Ollama 可留空）。
                  <br />
                  ③ 自带 Key 的服务商可点「测试连接」验证；选中任意文字按 <strong>Ctrl+Shift+Q</strong> 即可翻译。
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setOnboardingDismissed(true);
                    setShowWelcome(false);
                  }}
                >
                  知道了
                </button>
              </div>
            )}

            <div className="provider-workspace">
              <section className="provider-selection">
                <div role="radiogroup" aria-label="翻译服务商">
                  {platformBase !== null && (
                  <div className="provider-group">
                    <div className="settings-section-heading">
                      <div>
                        <h3>官方云服务</h3>
                        <p>沉浸云账号登录即用，无需申请任何密钥</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={isPlatform}
                      className={`platform-card${isPlatform ? " active" : ""}`}
                      onClick={() => platformPreset && applyPreset(platformPreset)}
                    >
                      <span className="provider-mark" aria-hidden>
                        云
                      </span>
                      <span className="platform-card-body">
                        <span className="platform-card-title">
                          沉浸云
                          <span className="chip chip-green">官方</span>
                        </span>
                        <span className="platform-card-desc">
                          模型与额度由服务端统一管理，本机不保存任何密钥。
                        </span>
                        <span className={`platform-card-status${loggedIn ? "" : " off"}`}>
                          <i aria-hidden />
                          {loggedIn
                            ? `已登录 ${accountStatus?.user?.email ?? ""}`
                            : "未登录——选中后到右侧登录即可使用"}
                        </span>
                      </span>
                      {isPlatform && (
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
                        <h3>自带 API Key 的服务商</h3>
                        <p>使用你自己的密钥，加密保存在本机，切换互不影响</p>
                      </div>
                      <span className="provider-count">{localPresets.length} 个</span>
                    </div>
                    <div className="provider-list">
                      {localPresets.map((p) => (
                        <ProviderItem
                          key={p.id}
                          preset={p}
                          active={activeProviderId === p.id}
                          hasKey={(vault[p.id]?.trim() ?? "") !== "" || (p.allowEmptyApiKey ?? false)}
                          onApply={() => applyPreset(p)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="provider-configuration">
                <div className="settings-section-heading">
                  <div>
                    <h3>{isPlatform ? "沉浸云账号" : "连接配置"}</h3>
                    <p>{activePreset ? activePreset.displayName : "自定义 OpenAI 兼容接口"}</p>
                  </div>
                  {isPlatform ? (
                    <span className={`chip ${loggedIn ? "chip-green" : "chip-amber"}`}>
                      {loggedIn ? "已登录" : "未登录"}
                    </span>
                  ) : currentIsLocal ? (
                    <span className="chip chip-green">本机服务</span>
                  ) : (
                    <span className={`chip ${settings.apiKey.trim() ? "chip-green" : "chip-amber"}`}>
                      {settings.apiKey.trim() ? "密钥已保存" : "等待密钥"}
                    </span>
                  )}
                </div>
                {!isPlatform && (
                  <p className="provider-caption">
                    {activePreset ? activePreset.hint : "可在高级设置中填写接口地址。"}
                  </p>
                )}
                <div className="group-card">
                {isPlatform ? (
                  <div className="field-block">
                    <div className="field-block-head">
                      <span className="field-label-v2">账号</span>
                    </div>
                    {loggedIn ? (
                      <>
                        <div className="platform-account-row">
                          <span className="platform-account-mark" aria-hidden>
                            <IconUser size={13} />
                          </span>
                          <span className="platform-account-email">
                            {accountStatus?.user?.email ?? ""}
                          </span>
                        </div>
                        <p className="field-hint">
                          翻译请求自动携带账号令牌（到期自动续期），按账号额度计费；模型由服务端统一下发，无需配置。
                        </p>
                        <div className="provider-actions" style={{ margin: 0 }}>
                          <button
                            className="btn btn-secondary"
                            onClick={() => setActiveTab("account")}
                          >
                            <IconUser size={14} />
                            管理账号
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="field-hint">
                          登录后即可使用：无需 API Key，模型由服务端下发，按账号额度计费。
                        </p>
                        <div className="provider-actions" style={{ margin: 0 }}>
                          <button
                            className="btn btn-primary"
                            onClick={() => void openLoginWindow().catch(() => {})}
                          >
                            <IconUser size={14} />
                            登录沉浸云
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="field-block">
                    <div className="field-block-head">
                      <span className="field-label-v2">API Key</span>
                      {currentIsLocal ? (
                        <span className="chip chip-green">本机无需 Key</span>
                      ) : (
                        <span className={`chip ${settings.apiKey.trim() ? "chip-green" : "chip-amber"}`}>
                          {settings.apiKey.trim() ? "已保存" : "未设置"}
                        </span>
                      )}
                    </div>
                    {!currentIsLocal && (
                      <div className="input-group key-input-full">
                        <input
                          className="input mono"
                          type={showKey ? "text" : "password"}
                          value={settings.apiKey}
                          onChange={(e) => updateApiKey(e.target.value)}
                          placeholder={
                            activePreset
                              ? `填入 ${activePreset.displayName} 的 API Key`
                              : "sk-…"
                          }
                          spellCheck={false}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          className="icon-btn input-append"
                          title={showKey ? "隐藏 Key" : "显示 Key"}
                          onClick={() => setShowKey((v) => !v)}
                        >
                          {showKey ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                        </button>
                      </div>
                    )}
                    {activePreset?.keyUrl && !currentIsLocal && (
                      <a className="key-link" href={activePreset.keyUrl} target="_blank" rel="noreferrer">
                        ↗ 前往 {activePreset.displayName} 控制台获取 API Key
                      </a>
                    )}
                  </div>
                )}

                {!isPlatform && (
              <div className="field-block">
                <span className="field-label-v2">模型</span>
                <input
                  className="input mono input-full"
                  value={settings.model}
                  onChange={(e) => update("model", e.target.value)}
                  list="model-suggestions"
                  placeholder="gpt-4o-mini"
                  spellCheck={false}
                />
                <datalist id="model-suggestions">
                  {(activePreset?.models ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <span className="field-hint">
                  {`下拉里是 ${activePreset ? activePreset.displayName : "该服务商"} 的常用模型，也可自由输入`}
                </span>
              </div>
                )}
                </div>

                {!isPlatform && (
                  <div className="provider-actions">
                    <button className="btn btn-secondary" disabled={testing} onClick={() => void handleTest()}>
                      <IconRetry size={14} />
                      {testing ? "测试中…" : "测试连接"}
                    </button>
                  </div>
                )}
                {!isPlatform && testMsg && <StatusBar msg={testMsg} />}

                {!isPlatform && (
                <details className="settings-advanced">
                  <summary>高级：接口地址与诊断</summary>
                  <div className="settings-advanced-body">
                    <label className="field-label" style={{ display: "block" }}>
                      接口地址（OpenAI 兼容）
                      <input
                        className="input mono"
                        value={settings.endpoint}
                        onChange={(e) => update("endpoint", e.target.value)}
                        placeholder="https://api.openai.com/v1/chat/completions"
                        spellCheck={false}
                      />
                    </label>
                    <p className="hint">
                      实际请求：<code>{normalizeEndpointPreview(settings.endpoint) || "（未填写）"}</code>
                      <br />
                      地址会自动补全 /v1/chat/completions；支持任意 OpenAI 兼容接口。
                    </p>
                    <div className="toolbar-row" style={{ padding: 0 }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          const curl = buildSanitizedCurl(settings.endpoint, settings.apiKey, settings.model, "hello");
                          void navigator.clipboard.writeText(curl);
                          setTestMsg({ text: "脱敏 curl 已复制到剪贴板", ok: true });
                        }}
                      >
                        <IconCopy size={13} />
                        复制脱敏 curl
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          const report = buildDiagnosticReport({
                            endpoint: settings.endpoint,
                            apiKey: settings.apiKey,
                            model: settings.model,
                            stream: settings.stream,
                            translationMode: settings.translationMode,
                            fixedTarget: settings.fixedTarget,
                            appVersion: appVersion || "0.2.0",
                          });
                          void navigator.clipboard.writeText(report);
                          setTestMsg({ text: "诊断报告已复制（已脱敏，可安全分享）", ok: true });
                        }}
                      >
                        生成诊断报告
                      </button>
                    </div>
                  </div>
                </details>
                )}
              </section>
            </div>
          </>
        )}

        {activeTab === "translation" && (
          <>
            <header className="set-pagehead">
              <div className="set-pagehead-text">
                <h2>翻译</h2>
                <p>目标语言与翻译浮窗的行为。</p>
              </div>
            </header>
            <div className="translation-route" aria-label="翻译语言方向">
              <div className="translation-route-endpoint">
                <span className="translation-route-label">原文</span>
                <strong>自动识别</strong>
              </div>
              <span className="translation-route-arrow" aria-hidden="true">→</span>
              <div className="translation-route-endpoint translation-route-target">
                <span className="translation-route-label">译文</span>
                <strong>
                  {settings.translationMode === "auto" ? "English / 简体中文" : settings.fixedTarget || "选择目标语言"}
                </strong>
              </div>
              <span className="translation-route-mode">
                {settings.translationMode === "auto" ? "自动切换" : "固定目标"}
              </span>
            </div>
            <div className="translation-grid">
              <section className="group-card translation-card">
                <div className="settings-section-heading">
                  <div>
                    <h3>译文目标</h3>
                    <p>决定翻译结果使用的语言</p>
                  </div>
                </div>
                <div className="field-row">
                  <div className="field-text">
                    <span className="field-label-v2">翻译模式</span>
                    <span className="field-hint">
                      {settings.translationMode === "auto"
                        ? "中文 → English，其他语言 → 简体中文"
                        : "始终翻译为指定的目标语言"}
                    </span>
                  </div>
                  <div className="field-ctrl">
                    <div className="seg">
                      <button
                        className={settings.translationMode === "auto" ? "active" : ""}
                        onClick={() => update("translationMode", "auto" as TranslationMode)}
                      >
                        自动识别
                      </button>
                      <button
                        className={settings.translationMode === "fixed" ? "active" : ""}
                        onClick={() => update("translationMode", "fixed" as TranslationMode)}
                      >
                        固定目标语言
                      </button>
                    </div>
                  </div>
                </div>
                {settings.translationMode === "fixed" && (
                  <div className="field-row">
                    <div className="field-text">
                      <span className="field-label-v2">目标语言</span>
                    </div>
                    <div className="field-ctrl">
                      <input
                        className="input target-input"
                        value={settings.fixedTarget}
                        onChange={(e) => update("fixedTarget", e.target.value)}
                        placeholder="如：日本語、English、简体中文"
                      />
                    </div>
                  </div>
                )}
              </section>

              <section className="group-card translation-card">
                <div className="settings-section-heading">
                  <div>
                    <h3>输出行为</h3>
                    <p>选择划词浮窗呈现结果的方式</p>
                  </div>
                </div>
                <div className="field-row">
                  <div className="field-text">
                    <span className="field-label-v2">流式输出</span>
                    <span className="field-hint">边翻译边显示；关闭则等全部完成再显示</span>
                  </div>
                  <div className="field-ctrl">
                    <Switch
                      checked={settings.stream}
                      onChange={(v) => update("stream", v)}
                      label="流式输出"
                    />
                  </div>
                </div>
                <div className="field-row">
                  <div className="field-text">
                    <span className="field-label-v2">词典卡片</span>
                    <span className="field-hint">
                      划选单个单词或短语时，浮窗自动切换为词典卡片（音标、多义项释义、例句）
                    </span>
                  </div>
                  <div className="field-ctrl">
                    <Switch
                      checked={settings.dictCard === "auto"}
                      onChange={(v) => update("dictCard", v ? "auto" : "off")}
                      label="词典卡片"
                    />
                  </div>
                </div>
              </section>

              <section className="group-card translation-card translation-style-card">
                <div className="field-block">
                  <span className="field-label-v2">自定义翻译风格</span>
                  <span className="field-hint">可选项，追加到系统提示词</span>
                  <textarea
                    className="textarea"
                    style={{ minHeight: 78 }}
                    value={settings.customStyle}
                    onChange={(e) => update("customStyle", e.target.value)}
                    placeholder="例如：使用自然口语化的风格；保留专有名词不翻译"
                  />
                </div>
              </section>
            </div>
          </>
        )}

        {activeTab === "voice" && (
          <VoiceSettingsTab
            platformBase={platformBase}
            loggedIn={loggedIn}
            email={accountStatus?.user?.email ?? ""}
            voiceProvider={settings.voiceProvider}
            voiceGatewayVoice={settings.voiceGatewayVoice}
            voiceGatewayIseEnabled={settings.voiceGatewayIseEnabled ?? true}
            onSelectProvider={(p) => applyVoicePrefs({ voiceProvider: p })}
            onSelectVoice={(v) => applyVoicePrefs({ voiceGatewayVoice: v })}
            onToggleIse={(on) => applyVoicePrefs({ voiceGatewayIseEnabled: on })}
            onOpenRedeem={openAccountRedeem}
            onOpenAccount={() => setActiveTab("account")}
          />
        )}

        {activeTab === "glossary" && (
          <>
            <header className="set-pagehead">
              <div className="set-pagehead-text">
                <h2>术语表</h2>
                <p>固定译法。每行一条，翻译时随请求一并发送（最多前 80 条）。</p>
              </div>
              <span className="set-pagehead-meta">
                {glossStats.valid} 条有效
                {glossStats.invalid > 0 && ` · ${glossStats.invalid} 行无法解析`}
                {glossStats.overLimit > 0 && ` · 超出 80 条 ${glossStats.overLimit} 条`}
              </span>
            </header>
            <div className="glossary-workspace">
              <section className="group-card glossary-editor">
                <div className="glossary-editor-head">
                  <span className="field-label-v2">译法条目</span>
                  <span className="field-hint">一行一组原词与译法</span>
                </div>
                <div className="field-block">
                  <textarea
                    className="textarea mono"
                    style={{ minHeight: 150 }}
                    value={settings.glossaryText}
                    onChange={(e) => update("glossaryText", e.target.value)}
                    placeholder={"hello = 你好\nworld -> 世界\n# 注释行会被忽略\n\n支持 原词 = 译法、->、全角冒号，以及 CSV/TSV 前两列"}
                    spellCheck={false}
                  />
                </div>
                <div className="toolbar-row glossary-toolbar">
                <button className="btn btn-secondary btn-sm" onClick={() => glossaryFileRef.current?.click()}>
                  <IconUpload size={13} />
                  导入文件
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    const clip = await navigator.clipboard.readText().catch(() => "");
                    update("glossaryText", mergeGlossary(settings.glossaryText, clip));
                    setGlossaryMsg({ text: "已从剪贴板导入并合并", ok: true });
                  }}
                >
                  从剪贴板导入
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    update("glossaryText", dedupAndNormalize(settings.glossaryText));
                    setGlossaryMsg({ text: "已去重并规范化", ok: true });
                  }}
                >
                  去重 / 规范化
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const out = dedupAndNormalize(settings.glossaryText);
                    void navigator.clipboard.writeText(out);
                    setGlossaryMsg({
                      text: `已复制 ${out ? out.split("\n").length : 0} 条到剪贴板`,
                      ok: true,
                    });
                  }}
                >
                  导出到剪贴板
                </button>
                </div>
              </section>
              <aside className="glossary-guide">
                <section className="glossary-usage">
                  <div className="glossary-usage-count">
                    <strong>{glossStats.valid}</strong>
                    <span>/ 80 条已启用</span>
                  </div>
                  <div
                    className="glossary-progress"
                    role="progressbar"
                    aria-label="术语表发送条数"
                    aria-valuemin={0}
                    aria-valuemax={80}
                    aria-valuenow={Math.min(glossStats.valid, 80)}
                  >
                    <span style={{ width: `${Math.min(100, Math.round((glossStats.valid / 80) * 100))}%` }} />
                  </div>
                  <p>每次翻译最多附带 80 条有效术语。</p>
                  {glossStats.invalid > 0 && (
                    <div className="glossary-warning">{glossStats.invalid} 行无法识别，请检查分隔符。</div>
                  )}
                  {glossStats.overLimit > 0 && (
                    <div className="glossary-warning">有 {glossStats.overLimit} 条超出发送上限。</div>
                  )}
                </section>
                <section className="glossary-format">
                  <h3>格式示例</h3>
                  <code>原词 = 译法</code>
                  <code>source → target</code>
                  <p>也支持 CSV / TSV 的前两列，井号开头的行会忽略。</p>
                </section>
              </aside>
            </div>
            {glossaryMsg && <StatusBar msg={glossaryMsg} />}

            <input
              ref={glossaryFileRef}
              type="file"
              accept=".txt,.csv,.tsv"
              style={{ display: "none" }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const text = await file.text();
                update("glossaryText", mergeGlossary(settings.glossaryText, text));
                setGlossaryMsg({ text: `已导入并合并 ${file.name}`, ok: true });
                if (glossaryFileRef.current) glossaryFileRef.current.value = "";
              }}
            />
          </>
        )}

        {activeTab === "hotkeys" && (
          <>
            <header className="set-pagehead">
              <div className="set-pagehead-text">
                <h2>快捷键</h2>
                <p>任意界面下全局生效；改完点「立即生效」或保存设置。</p>
              </div>
            </header>
            <div className="hotkey-list">
              <HotkeyField
                label="翻译热键"
                hint="读取当前选中文字并弹出翻译浮窗"
                value={settings.hotkey}
                onChange={(v) => {
                  update("hotkey", v);
                  setHotkeyErrMsg(null);
                }}
                onApply={() => void registerAllHotkeys()}
              />
              <HotkeyField
                label="截图 OCR 热键"
                hint="进入截图模式，框选区域后自动识别并翻译"
                value={settings.ocrHotkey}
                onChange={(v) => {
                  update("ocrHotkey", v);
                  setHotkeyErrMsg(null);
                }}
                onApply={() => void registerAllHotkeys()}
              />
              <HotkeyField
                label="阅读室热键"
                hint="把选中的内容送进沉浸阅读室精读"
                value={settings.readerHotkey}
                onChange={(v) => {
                  update("readerHotkey", v);
                  setHotkeyErrMsg(null);
                }}
                onApply={() => void registerAllHotkeys()}
              />
            </div>
            {hotkeyErrMsg && (
              <p className="msg-bar warn">
                <IconAlert size={14} />
                {hotkeyErrMsg}
              </p>
            )}
          </>
        )}

        {activeTab === "account" && (
          <AccountSection />
        )}

        {activeTab === "about" && (
          <>
            <header className="set-pagehead">
              <div className="set-pagehead-text">
                <h2>关于</h2>
                <p>版本更新与离线模型管理。</p>
              </div>
            </header>
            <div className="about-grid">
              <section className="group-card about-release">
                <div className="settings-section-heading">
                  <div>
                    <h3>应用更新</h3>
                    <p>下载后自动校验签名再安装</p>
                  </div>
                  <code className="version-code">v{appVersion || "…"}</code>
                </div>
                <div className="about-release-actions">
                  {updateAvailable && updateStage !== "downloading" && updateStage !== "installing" && (
                    <button className="btn btn-primary btn-sm" onClick={() => void handleDownloadUpdate()}>
                      <IconDownload size={13} />
                      升级到 v{updateAvailable.version}
                    </button>
                  )}
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={
                      updateStage === "checking" ||
                      updateStage === "downloading" ||
                      updateStage === "installing"
                    }
                    onClick={() => void handleCheckUpdate()}
                  >
                    {updateStage === "checking" ? "检查中…" : "检查更新"}
                  </button>
                </div>
                {updateStage === "downloading" && updateProgress !== undefined && (
                  <div className="progress">
                    <div style={{ width: `${Math.max(4, Math.round(updateProgress * 100))}%` }} />
                  </div>
                )}
                {updateMsg && <StatusBar msg={{ text: updateMsg, ok: updateStage !== "error" }} />}
              </section>

              <section className="group-card about-preferences">
                <div className="settings-section-heading">
                  <div>
                    <h3>启动与引导</h3>
                    <p>控制后台驻留与功能介绍</p>
                  </div>
                </div>
                <div className="field-row">
                  <div className="field-text">
                    <span className="field-label-v2">开机自启</span>
                    <span className="field-hint">
                      开机后驻留托盘，确保提醒和角标正常工作
                    </span>
                  </div>
                  <div className="field-ctrl">
                    {autoStart === null ? (
                      <span className="field-hint">查询中…</span>
                    ) : (
                      <Switch checked={autoStart} onChange={toggleAutostart} label="开机自启" />
                    )}
                  </div>
                </div>
                {autoStartErr && (
                  <StatusBar msg={{ text: `设置开机自启失败：${autoStartErr}`, ok: false }} />
                )}
                <div className="field-row">
                  <div className="field-text">
                    <span className="field-label-v2">功能引导</span>
                    <span className="field-hint">重新查看主要功能与快捷键</span>
                  </div>
                  <div className="field-ctrl">
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => void openOnboarding().catch((e) => console.error("[onboarding] open failed", e))}
                    >
                      查看引导
                    </button>
                  </div>
                </div>
              </section>

              <section className="group-card about-local-model">
                <div className="settings-section-heading">
                  <div>
                    <h3>离线能力</h3>
                    <p>截图翻译使用本地 OCR 模型，无需联网</p>
                  </div>
                </div>
                <div className="about-model-status">
                  <div className="about-model-copy">
                    <span className="field-label-v2">截图翻译模型</span>
                    <span className="field-hint">PaddleOCR，支持中英日韩等</span>
                  </div>
                  <div className="field-ctrl">
                    {ocrReady === null ? (
                      <span className="field-hint">检查模型状态…</span>
                    ) : ocrReady ? (
                      <span className="chip chip-green">
                        <IconCheck size={11} />
                        已就绪
                      </span>
                    ) : (
                      <>
                        <span className="chip chip-amber">
                          <IconAlert size={11} />
                          未下载（约 16MB）
                        </span>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={ocrDownloading}
                          onClick={() => void handleDownloadModels()}
                        >
                          <IconDownload size={13} />
                          {ocrDownloading ? "下载中…" : "下载模型"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {ocrProgress && (
                  <div className="progress">
                    <div style={{ width: `${Math.max(6, Math.round(ocrProgress.ratio * 100))}%` }} />
                  </div>
                )}
                {ocrMsg && <StatusBar msg={ocrMsg} />}
              </section>

              <PrivacyPolicyCard />
            </div>

            <section className="danger-zone">
              <div className="danger-zone-text">
                <span className="field-label-v2">恢复默认设置</span>
                <span className="field-hint">
                  清空已保存的接口配置（endpoint / API Key / 模型等），并恢复全部默认值
                </span>
              </div>
              <button className="btn btn-outline-danger btn-sm" onClick={handleResetDefaults}>
                恢复默认
              </button>
            </section>
          </>
        )}
        </div>

        {/* 底部操作条 */}
        <div className="save-bar">
          {dirty ? (
            <span className="dirty-hint">
              <i aria-hidden />
              有未保存的更改
            </span>
          ) : saved ? (
            <span className="hint-ok" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <IconCheck size={13} />
              已保存
            </span>
          ) : (
            <span />
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={handleClose}>
            <IconClose size={14} />
            关闭
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            <IconCheck size={14} />
            保存设置
          </button>
        </div>
      </main>

      <ConfirmDialog
        open={confirmReset}
        title="恢复默认设置"
        message="将清空已保存的接口配置（endpoint / API Key / 模型等），并恢复全部默认值。确定继续？"
        confirmText="恢复默认"
        onCancel={() => setConfirmReset(false)}
        onConfirm={doResetDefaults}
      />
    </div>
  );
}

function pct(done: number, total: number): number {
  if (!total) return 100;
  return Math.min(100, Math.round((done / total) * 100));
}

/** 规范化 endpoint，对齐后端 translation.rs::normalize_endpoint。 */
function normalizeEndpointPreview(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (trimmed.toLowerCase().endsWith("/chat/completions")) return trimmed;
  if (trimmed.toLowerCase().endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function StatusBar({ msg }: { msg: { text: string; ok: boolean } }) {
  return (
    <div className={`msg-bar ${msg.ok ? "ok" : "err"}`}>
      {msg.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
      {msg.text}
    </div>
  );
}

/** 服务商单选行：品牌色徽标 + 名称 +（已存 Key 状态点）+ 模型胶囊，选中行右侧对勾徽章。 */
function ProviderItem({
  preset,
  active,
  hasKey,
  onApply,
}: {
  preset: ProviderPreset;
  active: boolean;
  hasKey: boolean;
  onApply: () => void;
}) {
  const brand = brandColor(preset.id);
  const mark = preset.mark ?? preset.displayName.charAt(0);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className={`provider-item${active ? " active" : ""}`}
      onClick={onApply}
    >
      <span className="provider-mark" style={{ color: brand, background: `${brand}1f` }} aria-hidden>
        {mark}
      </span>
      <span className="provider-name">{preset.displayName}</span>
      <span className="provider-meta">
        {preset.allowEmptyApiKey ? (
          <span className="chip chip-green">本地</span>
        ) : hasKey ? (
          <span className="provider-keydot" title="已保存此服务商的 API Key" />
        ) : null}
        <span className="provider-model-chip">{preset.model}</span>
      </span>
      {active && (
        <span className="provider-check">
          <IconCheck size={12} />
        </span>
      )}
    </button>
  );
}

/** 不同厂商不同品牌色，快速识别。 */
function brandColor(id: string): string {
  const map: Record<string, string> = {
    deepseek: "#4d6bfe",
    zhipu: "#3859ff",
    dashscope: "#ff6a00",
    moonshot: "#7b5cff",
    openai: "#10a37f",
    gemini: "#4285f4",
    ollama: "#8b8d94",
  };
  return map[id] ?? "var(--accent)";
}

/** 开关（与阅读室设置抽屉一致）。 */
function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    />
  );
}

/**
 * 热键录入卡：输入框 + 「录制组合键」 + 「立即生效」 + 推荐组合。
 * 单键格式/系统冲突校验在此内部完成；跨字段（两键互斥）校验由父组件做。
 */
function HotkeyField({
  label,
  hint,
  value,
  onChange,
  onApply,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const validation = validateHotkey(value);

  // 录制：监听下一次按键组合
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!recordingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        stopRecording();
        return;
      }
      // 忽略单按修饰键
      const modKeys = ["Control", "Alt", "Shift", "Meta"];
      if (modKeys.includes(e.key)) return;

      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      // 主键名
      let key = e.key;
      if (key === " ") key = "Space";
      key = key.length === 1 ? key.toUpperCase() : key;
      const combo = [...mods, key].join("+");
      const parsed = parseHotkey(combo);
      if (!parsed) {
        setMsg({ text: "需要至少一个修饰键 + 一个主键", ok: false });
        return;
      }
      const norm = normalizeHotkey(combo);
      const v = validateHotkey(norm);
      if (v.blocking) {
        setMsg({ text: v.warning ?? "该组合不可用", ok: false });
        return;
      }
      onChange(norm);
      setMsg(
        v.warning ? { text: `已设置 ${norm}（${v.warning}）`, ok: true } : { text: `已设置 ${norm}`, ok: true },
      );
      stopRecording();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // onChange 来自父组件闭包，值变化即重新绑定；录制态由 ref 控制
  }, [onChange]);

  function startRecording() {
    recordingRef.current = true;
    setRecording(true);
    setMsg({ text: "请按下新的组合键…（Esc 取消）", ok: true });
  }

  function stopRecording() {
    recordingRef.current = false;
    setRecording(false);
  }

  return (
    <div className="group-card hotkey-card">
      <div className="field-row">
        <div className="field-text">
          <span className="field-label-v2">{label}</span>
          <span className="field-hint">{hint}</span>
        </div>
        <div className="field-ctrl">
          <input
            className="input mono hotkey-input"
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setMsg(null);
            }}
            placeholder="Ctrl+Shift+Q"
            spellCheck={false}
          />
          <button
            className={recording ? "btn btn-primary btn-sm" : "btn btn-secondary btn-sm"}
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? "录制中…（取消）" : "录制组合键"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onApply} disabled={!validation.ok}>
            立即生效
          </button>
        </div>
      </div>
      {msg && (
        <p className={`msg-bar ${msg.ok ? "ok" : "warn"}`}>{msg.text}</p>
      )}
      {!msg && (validation.blocking || validation.warning) && (
        <p className="msg-bar warn">
          <IconAlert size={14} />
          {validation.warning}
        </p>
      )}
      <div className="hotkey-suggest">
        <span>推荐</span>
        {RECOMMENDED_HOTKEYS.map((h) => (
          <button
            key={h}
            type="button"
            className="kbd-chip"
            onClick={() => {
              onChange(h);
              setMsg(null);
            }}
          >
            {h}
          </button>
        ))}
      </div>
    </div>
  );
}
