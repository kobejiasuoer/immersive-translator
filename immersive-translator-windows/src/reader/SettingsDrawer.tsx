/**
 * 屏 B · 阅读设置抽屉：右侧 380px 全高，背后 32% 黑遮罩。
 * 三组归口（§6）：版式 / 朗读 / 主题；底部 恢复默认 · 完成。
 * 职责划分：视图菜单管「显示什么」（瞬时），这里管「怎么显示」（持久）。
 */

import { useEffect, useState } from "react";
import {
  DEFAULT_READER_SETTINGS,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_RATE_MAX,
  READER_RATE_MIN,
  type ContrastMode,
  type ReaderFontPair,
  type ReaderSettings,
  type ReaderTheme,
} from "../core/readerTypes";
import { ttsVoices, type TtsVoiceInfo } from "../lib/tauriBridge";

interface Props {
  settings: ReaderSettings;
  onPatch: (patch: Partial<ReaderSettings>) => void;
  onReset: () => void;
  onClose: () => void;
}

const CONTRAST_OPTIONS: { value: ContrastMode; label: string }[] = [
  { value: "en", label: "仅英文" },
  { value: "dual", label: "对照" },
  { value: "zh", label: "仅中文" },
];

const FONT_OPTIONS: { value: ReaderFontPair; label: string }[] = [
  { value: "serif", label: "衬线（宋体 + Source Serif）" },
  { value: "sans", label: "无衬线（黑体 + Inter）" },
];

const THEMES: { value: ReaderTheme; label: string; swatch: string; text: string }[] = [
  { value: "light", label: "浅色", swatch: "#f4f5f9", text: "#1c2029" },
  { value: "dark", label: "深色", swatch: "#1d1f26", text: "#edeef4" },
  { value: "sepia", label: "护眼", swatch: "#f5efdf", text: "#5a5138" },
  { value: "oled", label: "纯黑", swatch: "#0a0a0b", text: "#b9bdc9" },
];

export function SettingsDrawer({ settings, onPatch, onReset, onClose }: Props) {
  const [voices, setVoices] = useState<TtsVoiceInfo[]>([]);

  useEffect(() => {
    let active = true;
    ttsVoices()
      .then((list) => {
        if (active) setVoices(list);
      })
      .catch((error) => console.error("[reader] list voices failed", error));
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <div className="reader-drawer-overlay" onClick={onClose} />
      <aside className="reader-drawer" role="dialog" aria-label="阅读设置">
        <div className="reader-drawer-header">
          <span className="title">阅读设置</span>
          <button className="reader-tb-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="reader-drawer-body">
          <div className="drawer-group-title">版式</div>
          <div className="drawer-row">
            <span className="label">对照模式</span>
            <div className="control">
              <div className="seg">
                {CONTRAST_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    className={settings.contrastMode === o.value ? "active" : ""}
                    onClick={() => onPatch({ contrastMode: o.value })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">遮罩样式</span>
            <div className="control">
              <div className="seg" title="译文遮罩的隐藏样式（开关在视图菜单；关闭遮罩时不可选）">
                <button
                  className={settings.maskStyle === "blank" ? "active" : ""}
                  disabled={!settings.maskTranslation}
                  onClick={() => onPatch({ maskStyle: "blank" })}
                >
                  留白显影
                </button>
                <button
                  className={settings.maskStyle === "frost" ? "active" : ""}
                  disabled={!settings.maskTranslation}
                  onClick={() => onPatch({ maskStyle: "frost" })}
                >
                  毛玻璃
                </button>
              </div>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">正文字号</span>
            <div className="control">
              <div className="drawer-stepper">
                <button
                  onClick={() => onPatch({ fontSize: Math.max(READER_FONT_SIZE_MIN, settings.fontSize - 1) })}
                  disabled={settings.fontSize <= READER_FONT_SIZE_MIN}
                  aria-label="减小字号"
                >
                  −
                </button>
                <span className="val">{settings.fontSize}</span>
                <button
                  onClick={() => onPatch({ fontSize: Math.min(READER_FONT_SIZE_MAX, settings.fontSize + 1) })}
                  disabled={settings.fontSize >= READER_FONT_SIZE_MAX}
                  aria-label="增大字号"
                >
                  +
                </button>
              </div>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">行距</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={1}
                max={2}
                step={0.05}
                value={settings.lineHeight}
                onChange={(e) => onPatch({ lineHeight: Number(e.target.value) })}
                aria-label="行距"
              />
              <span className="drawer-slider-val">{settings.lineHeight.toFixed(2)}×</span>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">正文字体</span>
            <div className="control">
              <select
                className="reader-select"
                value={settings.fontPair}
                onChange={(e) => onPatch({ fontPair: e.target.value as ReaderFontPair })}
                aria-label="正文字体"
              >
                {FONT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="drawer-group-title">朗读</div>
          <div className="drawer-row">
            <span className="label">音色</span>
            <div className="control">
              <select
                className="reader-select"
                value={settings.voice}
                onChange={(e) => onPatch({ voice: e.target.value })}
                aria-label="朗读音色"
              >
                <option value="">系统默认</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">语速</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={READER_RATE_MIN}
                max={READER_RATE_MAX}
                step={0.05}
                value={settings.rate}
                onChange={(e) => onPatch({ rate: Number(e.target.value) })}
                aria-label="语速"
              />
              <span className="drawer-slider-val">{settings.rate.toFixed(2)}×</span>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">每句停顿</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={0}
                max={2000}
                step={100}
                value={settings.sentencePauseMs}
                onChange={(e) => onPatch({ sentencePauseMs: Number(e.target.value) })}
                aria-label="每句停顿"
              />
              <span className="drawer-slider-val">{(settings.sentencePauseMs / 1000).toFixed(1)}s</span>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">跟读模式</span>
            <div className="control">
              <button
                className={`reader-switch${settings.shadowingMode ? " on" : ""}`}
                onClick={() => onPatch({ shadowingMode: !settings.shadowingMode })}
                role="switch"
                aria-checked={settings.shadowingMode}
                aria-label="跟读模式"
              />
            </div>
          </div>

          <div className="drawer-group-title">主题</div>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.value}
                className={`theme-swatch${settings.theme === t.value ? " active" : ""}`}
                style={{ background: t.swatch, color: t.text }}
                onClick={() => onPatch({ theme: t.value })}
                aria-label={`主题：${t.label}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="reader-drawer-footer">
          <button className="btn btn-ghost" onClick={onReset}>
            恢复默认
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </aside>
    </>
  );
}

export { DEFAULT_READER_SETTINGS };
