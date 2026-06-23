import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type AppSettings,
} from "../lib/settingsStore";
import type { TranslationMode } from "../core/languageDetect";

/**
 * 设置窗口。点托盘「设置」菜单打开。
 * 对齐 Mac 版设置字段。阶段 1：用 localStorage 暂存；阶段 2 接 Credential Manager 存 Key。
 */
export function Settings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  function handleSave() {
    saveSettings(settings);
    setSaved(true);
  }

  async function handleClose() {
    await getCurrentWindow().hide();
  }

  function handleResetDefaults() {
    if (confirm("确定恢复默认设置？已保存的接口配置会被清空。")) {
      const reset = { ...DEFAULT_SETTINGS };
      saveSettings(reset);
      setSettings(reset);
      setSaved(false);
    }
  }

  return (
    <div style={pageStyle}>
      <h1 style={titleStyle}>ImmersiveTranslator 设置</h1>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>翻译接口</h2>

        <label style={labelStyle}>
          接口地址（OpenAI 兼容）
          <input
            style={inputStyle}
            value={settings.endpoint}
            onChange={(e) => update("endpoint", e.target.value)}
            placeholder="https://api.openai.com/v1/chat/completions"
          />
        </label>
        <div style={hintStyle}>
          支持 OpenAI / DeepSeek / 智谱 / 通义等兼容接口。地址会自动补全 /v1/chat/completions。
        </div>

        <label style={labelStyle}>
          API Key
          <input
            style={inputStyle}
            type="password"
            value={settings.apiKey}
            onChange={(e) => update("apiKey", e.target.value)}
            placeholder="sk-..."
          />
        </label>

        <label style={labelStyle}>
          模型
          <input
            style={inputStyle}
            value={settings.model}
            onChange={(e) => update("model", e.target.value)}
            placeholder="gpt-4o-mini"
          />
        </label>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>翻译语言</h2>

        <div style={labelStyle}>
          翻译模式
          <div style={{ marginTop: 6 }}>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                name="mode"
                checked={settings.translationMode === "auto"}
                onChange={() => update("translationMode", "auto" as TranslationMode)}
              />
              自动（中文 → English，其他 → 简体中文）
            </label>
            <label style={radioLabelStyle}>
              <input
                type="radio"
                name="mode"
                checked={settings.translationMode === "fixed"}
                onChange={() => update("translationMode", "fixed" as TranslationMode)}
              />
              固定目标语言
            </label>
          </div>
        </div>

        <label style={labelStyle}>
          固定目标语言（仅"固定目标语言"模式生效）
          <input
            style={inputStyle}
            value={settings.fixedTarget}
            onChange={(e) => update("fixedTarget", e.target.value)}
            placeholder="例如：日本語、English、简体中文"
            disabled={settings.translationMode !== "fixed"}
          />
        </label>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>高级</h2>

        <label style={labelStyle}>
          自定义翻译风格（可选）
          <textarea
            style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
            value={settings.customStyle}
            onChange={(e) => update("customStyle", e.target.value)}
            placeholder="例如：使用自然口语化的风格；保留专有名词不翻译"
          />
        </label>

        <label style={labelStyle}>
          术语表（可选，每行一条，格式：原词 = 译法）
          <textarea
            style={{ ...inputStyle, minHeight: 90, resize: "vertical", fontFamily: "monospace" }}
            value={settings.glossaryText}
            onChange={(e) => update("glossaryText", e.target.value)}
            placeholder={"hello = 你好\nworld -> 世界\n# 这是注释，会被忽略"}
          />
        </label>
        <div style={hintStyle}>
          支持的格式：<code>=</code>、<code>-&gt;</code>、<code>：</code>、CSV/TSV 前两列。最多发送前 80 条。
        </div>

        <label style={checkboxRowStyle}>
          <input
            type="checkbox"
            checked={settings.stream}
            onChange={(e) => update("stream", e.target.checked)}
          />
          流式输出（边翻译边显示，关掉则等全部完成）
        </label>
      </section>

      <div style={actionsStyle}>
        <button style={secondaryBtnStyle} onClick={handleResetDefaults}>
          恢复默认
        </button>
        <span style={{ flex: 1 }} />
        {saved && <span style={savedHintStyle}>✓ 已保存</span>}
        <button style={secondaryBtnStyle} onClick={handleClose}>
          关闭
        </button>
        <button style={primaryBtnStyle} onClick={handleSave}>
          保存
        </button>
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  padding: 24,
  fontFamily: "system-ui, -apple-system, sans-serif",
  fontSize: 14,
  color: "#222",
  height: "100vh",
  boxSizing: "border-box",
  overflowY: "auto",
  background: "#fff",
};
const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  margin: "0 0 16px",
};
const sectionStyle: React.CSSProperties = {
  marginBottom: 20,
  paddingBottom: 16,
  borderBottom: "1px solid #eee",
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  margin: "0 0 10px",
  color: "#333",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 12,
  fontSize: 13,
  color: "#555",
};
const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "6px 8px",
  border: "1px solid #ccc",
  borderRadius: 4,
  fontSize: 13,
  boxSizing: "border-box",
  fontFamily: "inherit",
};
const radioLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  color: "#444",
  marginBottom: 4,
};
const checkboxRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  color: "#444",
  marginBottom: 8,
};
const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#999",
  margin: "-4px 0 12px",
  lineHeight: 1.4,
};
const actionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  paddingTop: 8,
};
const primaryBtnStyle: React.CSSProperties = {
  padding: "6px 18px",
  border: "none",
  background: "#2563eb",
  color: "#fff",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};
const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #ccc",
  background: "#fff",
  color: "#333",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};
const savedHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#16a34a",
};
