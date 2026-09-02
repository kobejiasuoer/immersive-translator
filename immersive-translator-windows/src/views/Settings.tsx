import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import {
  loadSettingsAsync,
  saveSettingsAsync,
  DEFAULT_SETTINGS,
  hasValidSettings,
  isOnboardingDismissed,
  setOnboardingDismissed,
  type AppSettings,
} from "../lib/settingsStore";
import type { TranslationMode } from "../core/languageDetect";
import {
  PROVIDER_PRESETS,
  findMatchingPreset,
  isLocalhostEndpoint,
  type ProviderPreset,
} from "../core/providerPresets";
import {
  parseHotkey,
  validateHotkey,
  normalizeHotkey,
  RECOMMENDED_HOTKEYS,
} from "../core/hotkeyValidator";
import { reregisterHotkeys, testConnectivity } from "../lib/tauriBridge";
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
} from "../ui/icons";

/** 规范化 endpoint，对齐后端 translation.rs::normalize_endpoint。 */
function normalizeEndpointPreview(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (trimmed.toLowerCase().endsWith("/chat/completions")) return trimmed;
  if (trimmed.toLowerCase().endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/**
 * 设置窗口。点托盘「设置」菜单打开。
 * 对齐 Mac 版设置字段。apiKey 经 DPAPI 加密存储，其余字段存 localStorage。
 */
export function Settings() {
  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
  }));
  /** 进入页面时已保存的快照：用于判断"热键是否真的改过"。 */
  const [savedSnapshot, setSavedSnapshot] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  /** API Key 明文显隐。 */
  const [showKey, setShowKey] = useState(false);

  // 首次加载后：加载设置；若未关闭引导且接口未配好，显示欢迎横幅
  useEffect(() => {
    let active = true;
    loadSettingsAsync().then((s) => {
      if (!active) return;
      setSettings(s);
      setSavedSnapshot(s);
      if (!isOnboardingDismissed() && !hasValidSettings(s)) {
        setShowWelcome(true);
      }
    });
    void getVersion().then(setAppVersion).catch(() => setAppVersion(""));
    return () => {
      active = false;
    };
  }, []);

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

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

  // ---- 热键互斥校验（两个热键不能相同）----
  const [hotkeyErrMsg, setHotkeyErrMsg] = useState<string | null>(null);

  async function registerAllHotkeys(): Promise<boolean> {
    const t = normalizeHotkey(settings.hotkey);
    const o = normalizeHotkey(settings.ocrHotkey);
    if (t === o) {
      setHotkeyErrMsg("翻译热键和截图 OCR 热键不能相同");
      return false;
    }
    if (validateHotkey(t).blocking || validateHotkey(o).blocking) {
      setHotkeyErrMsg(null);
      return false;
    }
    try {
      await reregisterHotkeys(t, o);
      setHotkeyErrMsg(null);
      return true;
    } catch (e) {
      setHotkeyErrMsg(String(e));
      return false;
    }
  }

  async function handleSave() {
    // 与「进入页面时的快照」比较，判断热键是否真的被改过；
    // 只有改过才整对重注册，避免「改回默认值后未重注册」的遗留 bug。
    const changed =
      savedSnapshot !== null &&
      (settings.hotkey !== savedSnapshot.hotkey || settings.ocrHotkey !== savedSnapshot.ocrHotkey);
    await saveSettingsAsync(settings);
    setSavedSnapshot(settings);
    if (changed) {
      await registerAllHotkeys();
    }
    // 配置已有效时，自动关闭欢迎横幅
    if (hasValidSettings(settings)) {
      setOnboardingDismissed(true);
      setShowWelcome(false);
    }
    setSaved(true);
  }

  async function handleClose() {
    await getCurrentWindow().hide();
  }

  function handleResetDefaults() {
    if (confirm("确定恢复默认设置？已保存的接口配置会被清空。")) {
      const reset = { ...DEFAULT_SETTINGS };
      void saveSettingsAsync(reset);
      setSettings(reset);
      setSavedSnapshot(reset);
      setSaved(false);
    }
  }

  const cloudPresets = PROVIDER_PRESETS.filter((p) => !p.allowEmptyApiKey);
  const localPresets = PROVIDER_PRESETS.filter((p) => p.allowEmptyApiKey);

  return (
    <div className="settings-page">
      <div className="settings-inner">
        {/* 页头 */}
        <div className="page-header">
          <div className="panel-logo">
            <IconTranslate size={14} />
          </div>
          <h1>设置</h1>
          <span className="version">v{appVersion || "…"}</span>
        </div>

        {showWelcome && (
          <div className="welcome-box">
            <div className="welcome-title">欢迎使用 ImmersiveTranslator</div>
            <div className="welcome-body">
              1. 选一个服务商（国内直连推荐 <strong>DeepSeek</strong> 或 <strong>智谱</strong>）。
              <br />
              2. 填入对应 <strong>API Key</strong>（本地 Ollama / LM Studio 可留空）。
              <br />
              3. 点「测试当前接口」，回到任意应用选中文本，按热键即可翻译。
            </div>
            <button
              className="btn"
              onClick={() => {
                setOnboardingDismissed(true);
                setShowWelcome(false);
              }}
            >
              我知道了
            </button>
          </div>
        )}

        {/* ① 翻译接口 */}
        <section className="section-card">
          <h2 className="section-title">
            <span className="num">1</span>
            翻译接口
          </h2>

          <div className="field-label">Provider 预设（点击套用接口 + 模型）</div>
          <PresetGroup label="云端服务" presets={cloudPresets} settings={settings} onApply={applyPreset} />
          <PresetGroup label="本地模型（免 Key）" presets={localPresets} settings={settings} onApply={applyPreset} />

          <div className="form-divider" />

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
            地址会自动补全 /v1/chat/completions；支持 OpenAI / DeepSeek / 智谱 / 通义等兼容接口。
          </p>

          <div className="field-label">API Key（DPAPI 加密保存）</div>
          <div className="input-group">
            <input
              className="input mono"
              type={showKey ? "text" : "password"}
              value={settings.apiKey}
              onChange={(e) => update("apiKey", e.target.value)}
              placeholder="sk-…（本地接口可留空）"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="icon-btn input-append"
              style={{ height: 22, width: 22 }}
              title={showKey ? "隐藏 Key" : "显示 Key"}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? <IconEyeOff size={14} /> : <IconEye size={14} />}
            </button>
          </div>
          {settings.apiKey.trim() === "" && !isLocalhostEndpoint(settings.endpoint) && (
            <p className="msg-bar warn">
              <IconAlert size={14} />
              该接口需要 API Key，当前为空。本地接口（localhost）可留空。
            </p>
          )}

          <label className="field-label" style={{ display: "block", marginTop: 10 }}>
            模型
            <input
              className="input mono"
              value={settings.model}
              onChange={(e) => update("model", e.target.value)}
              placeholder="gpt-4o-mini"
              spellCheck={false}
            />
          </label>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button className="btn btn-secondary" disabled={testing} onClick={() => void handleTest()}>
              <IconRetry size={14} />
              {testing ? "测试中…" : "测试当前接口"}
            </button>
            <button
              className="btn btn-ghost"
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
              className="btn btn-ghost"
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
          {testMsg && <StatusBar msg={testMsg} />}
        </section>

        {/* ② 翻译语言与行为 */}
        <section className="section-card">
          <h2 className="section-title">
            <span className="num">2</span>
            翻译语言与行为
          </h2>

          <div className="form-row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div className="field-label">翻译模式</div>
              <div className="seg">
                <button
                  className={settings.translationMode === "auto" ? "active" : ""}
                  onClick={() => update("translationMode", "auto" as TranslationMode)}
                >
                  自动
                </button>
                <button
                  className={settings.translationMode === "fixed" ? "active" : ""}
                  onClick={() => update("translationMode", "fixed" as TranslationMode)}
                >
                  固定目标语言
                </button>
              </div>
              <p className="hint">
                {settings.translationMode === "auto"
                  ? "中文 → English，其他语言 → 简体中文"
                  : "始终翻译为你指定的目标语言"}
              </p>
            </div>
            <label className="form-col field-label" style={{ margin: 0 }}>
              固定目标语言
              <input
                className="input"
                style={{ marginTop: 6 }}
                value={settings.fixedTarget}
                onChange={(e) => update("fixedTarget", e.target.value)}
                placeholder="如：日本語、English、简体中文"
                disabled={settings.translationMode !== "fixed"}
              />
              {settings.translationMode !== "fixed" && (
                <span className="hint">切换为「固定目标语言」后生效</span>
              )}
            </label>
          </div>

          <div className="form-divider" />

          <label className="form-row field-label" style={{ margin: 0, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={settings.stream}
              onChange={(e) => update("stream", e.target.checked)}
            />
            <span style={{ display: "inline-flex", flexDirection: "column" }}>
              流式输出
              <span className="hint" style={{ margin: 0 }}>
                边翻译边显示；关闭则等全部完成再显示
              </span>
            </span>
          </label>

          <div className="form-divider" />

          <label className="field-label" style={{ display: "block" }}>
            自定义翻译风格（可选，追加到系统提示词）
            <textarea
              className="textarea"
              style={{ minHeight: 54, marginTop: 6 }}
              value={settings.customStyle}
              onChange={(e) => update("customStyle", e.target.value)}
              placeholder="例如：使用自然口语化的风格；保留专有名词不翻译"
            />
          </label>
        </section>

        {/* ③ 术语表 */}
        <section className="section-card">
          <h2 className="section-title">
            <span className="num">3</span>
            术语表
            <span style={{ marginLeft: "auto", fontWeight: 500, fontSize: 11, color: "var(--text-3)" }}>
              {glossStats.valid} 条有效
              {glossStats.invalid > 0 && ` · ${glossStats.invalid} 行无法解析`}
              {glossStats.overLimit > 0 && ` · 超出 80 条 ${glossStats.overLimit} 条`}
            </span>
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            每行一条，支持 <code>原词 = 译法</code>、<code>-&gt;</code>、<code>：</code> 与 CSV/TSV 前两列；最多发送前 80 条。
          </p>
          <textarea
            className="textarea mono"
            style={{ minHeight: 96 }}
            value={settings.glossaryText}
            onChange={(e) => update("glossaryText", e.target.value)}
            placeholder={"hello = 你好\nworld -> 世界\n# 注释行会被忽略"}
            spellCheck={false}
          />

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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <button className="btn btn-secondary" onClick={() => glossaryFileRef.current?.click()}>
              <IconUpload size={13} />
              导入文件
            </button>
            <button
              className="btn btn-ghost"
              onClick={async () => {
                const clip = await navigator.clipboard.readText().catch(() => "");
                update("glossaryText", mergeGlossary(settings.glossaryText, clip));
                setGlossaryMsg({ text: "已从剪贴板导入并合并", ok: true });
              }}
            >
              从剪贴板导入
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                update("glossaryText", dedupAndNormalize(settings.glossaryText));
                setGlossaryMsg({ text: "已去重并规范化", ok: true });
              }}
            >
              去重 / 规范化
            </button>
            <button
              className="btn btn-ghost"
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
          {glossaryMsg && <StatusBar msg={glossaryMsg} />}
        </section>

        {/* ④ 截图翻译 (OCR) */}
        <section className="section-card">
          <h2 className="section-title">
            <span className="num">4</span>
            截图翻译 (OCR)
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            框选屏幕区域自动识别并翻译。基于 PaddleOCR，离线运行，支持中英日韩等。
          </p>

          <div className="form-row" style={{ flexWrap: "wrap" }}>
            {ocrReady === null ? (
              <span className="hint">检查模型状态…</span>
            ) : ocrReady ? (
              <span className="chip chip-green">
                <IconCheck size={11} />
                OCR 模型已就绪
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
                  {ocrDownloading ? "下载中…" : "下载中文模型 (det + rec)"}
                </button>
              </>
            )}
          </div>
          {ocrProgress && (
            <div className="progress" style={{ marginTop: 10 }}>
              <div style={{ width: `${Math.max(6, Math.round(ocrProgress.ratio * 100))}%` }} />
            </div>
          )}
          {ocrMsg && <StatusBar msg={ocrMsg} />}
        </section>

        {/* ⑤ 快捷键 */}
        <section className="section-card">
          <h2 className="section-title">
            <span className="num">5</span>
            快捷键
          </h2>
          <HotkeyField
            label="翻译热键"
            hint="按下热键会读取当前选中文字并弹出翻译浮窗。"
            value={settings.hotkey}
            onChange={(v) => {
              update("hotkey", v);
              setHotkeyErrMsg(null);
            }}
            onApply={() => void registerAllHotkeys()}
          />
          <HotkeyField
            label="截图 OCR 热键"
            hint="按下热键进入截图模式，框选区域后自动 OCR 识别并翻译。"
            value={settings.ocrHotkey}
            onChange={(v) => {
              update("ocrHotkey", v);
              setHotkeyErrMsg(null);
            }}
            onApply={() => void registerAllHotkeys()}
          />
          {hotkeyErrMsg && (
            <p className="msg-bar warn">
              <IconAlert size={14} />
              {hotkeyErrMsg}
            </p>
          )}
        </section>

        {/* ⑥ 关于 / 更新 */}
        <section className="section-card" style={{ marginBottom: 8 }}>
          <h2 className="section-title">
            <span className="num">6</span>
            关于 / 更新
          </h2>
          <div className="form-row" style={{ flexWrap: "wrap" }}>
            {updateAvailable && updateStage !== "downloading" && updateStage !== "installing" && (
              <button className="btn btn-primary" onClick={() => void handleDownloadUpdate()}>
                <IconDownload size={14} />
                下载并安装 v{updateAvailable.version}
              </button>
            )}
            <button
              className="btn btn-secondary"
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
            <div className="progress" style={{ marginTop: 8 }}>
              <div style={{ width: `${Math.max(4, Math.round(updateProgress * 100))}%` }} />
            </div>
          )}
          {updateMsg && <StatusBar msg={{ text: updateMsg, ok: updateStage !== "error" }} />}
          <p className="hint">
            更新从 GitHub Releases 拉取，下载后自动校验签名（防止篡改）再安装。
          </p>
        </section>

        {/* 底部操作条 */}
        <div className="save-bar">
          <button className="btn btn-ghost" style={{ color: "var(--err)" }} onClick={handleResetDefaults}>
            恢复默认
          </button>
          {saved && (
            <span className="hint-ok" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <IconCheck size={13} />
              已保存
            </span>
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
      </div>
    </div>
  );

  function applyPreset(p: ProviderPreset) {
    setSettings((prev) => ({ ...prev, endpoint: p.endpoint, model: p.model }));
    setSaved(false);
  }
}

function pct(done: number, total: number): number {
  if (!total) return 100;
  return Math.min(100, Math.round((done / total) * 100));
}

function StatusBar({ msg }: { msg: { text: string; ok: boolean } }) {
  return (
    <div className={`msg-bar ${msg.ok ? "ok" : "err"}`}>
      {msg.ok ? <IconCheck size={14} /> : <IconAlert size={14} />}
      {msg.text}
    </div>
  );
}

/** Provider 分组渲染：云端 / 本地。 */
function PresetGroup({
  label,
  presets,
  settings,
  onApply,
}: {
  label: string;
  presets: ProviderPreset[];
  settings: AppSettings;
  onApply: (p: ProviderPreset) => void;
}) {
  if (presets.length === 0) return null;
  return (
    <div>
      <div className="preset-group-label">{label}</div>
      <div className="preset-grid">
        {presets.map((p) => (
          <PresetCard
            key={p.id}
            preset={p}
            active={findMatchingPreset(settings.endpoint)?.id === p.id}
            apiKeyMissing={settings.apiKey.trim() === "" && !(p.allowEmptyApiKey ?? false)}
            onApply={() => onApply(p)}
          />
        ))}
      </div>
    </div>
  );
}

function PresetCard({
  preset,
  active,
  apiKeyMissing,
  onApply,
}: {
  preset: ProviderPreset;
  active: boolean;
  apiKeyMissing: boolean;
  onApply: () => void;
}) {
  const [hovering, setHovering] = useState(false);
  const hint = preset.hint ?? preset.modelNote;
  return (
    <div
      className={`preset-card${active ? " active" : ""}`}
      onClick={onApply}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onApply();
        }
      }}
    >
      <div className="preset-top">
        <span className="preset-logo" style={{ background: brandGradient(preset.id) }}>
          {preset.displayName.charAt(0)}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="preset-name">{preset.displayName}</div>
          <div className="preset-model">{preset.model}</div>
        </div>
      </div>
      <div className="preset-tags">
        {preset.allowEmptyApiKey ? (
          <span className="chip chip-green">免 Key</span>
        ) : apiKeyMissing ? (
          <span className="chip chip-amber">需填 Key</span>
        ) : null}
        {active && <span className="chip chip-blue">当前使用</span>}
        {hovering && !preset.allowEmptyApiKey && !active && apiKeyMissing && (
          <span className="chip chip-gray">点击套用</span>
        )}
      </div>
      {hint && hint !== preset.modelNote ? <div className="preset-hint">{hint}</div> : null}
    </div>
  );
}

/** 不同厂商不同品牌色，快速识别。 */
function brandGradient(id: string): string {
  const map: Record<string, string> = {
    openai: "linear-gradient(135deg,#10a37f,#0d8a6c)",
    deepseek: "linear-gradient(135deg,#4d6bfe,#3b4fc0)",
    zhipu: "linear-gradient(135deg,#3859ff,#7b2bf2)",
    gemini: "linear-gradient(135deg,#4285f4,#9b72cb)",
    openrouter: "linear-gradient(135deg,#8b5cf6,#d946ef)",
    siliconflow: "linear-gradient(135deg,#00c2a8,#007d86)",
    dashscope: "linear-gradient(135deg,#ff6a00,#ff8a50)",
    groq: "linear-gradient(135deg,#f55036,#d03020)",
    xai: "linear-gradient(135deg,#1a1a2e,#3a3a5c)",
    moonshot: "linear-gradient(135deg,#7b5cff,#b04dff)",
    ollama: "linear-gradient(135deg,#555,#888)",
    lmstudio: "linear-gradient(135deg,#5b9bf8,#3a6fd8)",
    vllm: "linear-gradient(135deg,#26c6da,#0091ea)",
  };
  return map[id] ?? "var(--accent-grad)";
}

/**
 * 热键录入行：输入框 + 「录制组合键」+ 「立即注册」+ 推荐组合。
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
    <div style={{ marginBottom: 14 }}>
      <div className="field-label">{label}</div>
      <div className="form-row" style={{ flexWrap: "wrap" }}>
        <input
          className="input mono"
          style={{ width: 190, flex: "0 1 auto" }}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setMsg(null);
          }}
          placeholder="Ctrl+Shift+Q"
          spellCheck={false}
        />
        <button
          className={recording ? "btn btn-primary" : "btn btn-secondary"}
          onClick={recording ? stopRecording : startRecording}
        >
          {recording ? "录制中…（点击取消）" : "录制组合键"}
        </button>
        <button className="btn btn-ghost" onClick={onApply} disabled={!validation.ok}>
          立即注册
        </button>
      </div>
      <p className="hint">
        {hint}当前：<code>{value}</code>
      </p>
      {msg && (
        <p className="msg-bar ok" style={msg.ok ? {} : { color: "var(--err)", background: "var(--err-soft)" }}>
          {msg.text}
        </p>
      )}
      {!msg && (validation.blocking || validation.warning) && (
        <p className="msg-bar warn">
          <IconAlert size={14} />
          {validation.warning}
        </p>
      )}
      <div className="hint" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        推荐：
        {RECOMMENDED_HOTKEYS.map((h) => (
          <button
            key={h}
            className="btn btn-ghost btn-sm"
            style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
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
