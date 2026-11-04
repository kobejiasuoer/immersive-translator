/**
 * 阅读设置抽屉（reading-parity · 原型 SHEETS.readingSettings，html:2034-2037）。
 * 分节布局：label 在上（.rd-set-h）+ 全宽 soft seg；主题三选为 36×23 色板卡
 * （护眼灰绿 / 纸书暖黄 / 夜间深色）；底部「完成设置」确认钮。
 * 档位：字号 16/18/20/22、行距 1.55/1.78/2、语速 0.65/0.85/1/1.15；
 * 顶部实时样例随档位即时变化；主题 sepia=整应用换肤、纯黑=阅读页整页 dark 令牌
 * （data-reader-dark，ReaderScreen 挂到 push 根）。
 */
import { actions, useApp } from "../../store";
import { Seg } from "../../ui/kit";
import { ReadingDrawer } from "./Drawer";

const FS_TIERS: number[] = [16, 18, 20, 22];
const LH_TIERS: [number, string][] = [
  [1.55, "紧凑"],
  [1.78, "舒适"],
  [2, "宽松"],
];
const RATE_TIERS: number[] = [0.65, 0.85, 1, 1.15];

/** 旧档位值（如 fs=19、rate=0.9）不在新档内：展示时就近吸附，点选后落定真实档位值。 */
function nearest(value: number, tiers: number[]): number {
  return tiers.reduce((best, t) => (Math.abs(t - value) < Math.abs(best - value) ? t : best), tiers[0]);
}

const TOPIC_CHOICES: [string, string, string][] = [
  ["paper", "护眼灰绿", "v2-swatch-paper"],
  ["sepia", "纸书暖黄", "v2-swatch-sepia"],
  ["black", "夜间深色", "v2-swatch-black"],
];

export function SettingsSheet({ open, onClose, layer }: { open: boolean; onClose: () => void; layer?: "account" }) {
  const prefs = useApp((s) => s.reader);
  const scale = useApp((s) => s.settings.fsScale);
  const fs = FS_TIERS.includes(prefs.fs) ? prefs.fs : nearest(prefs.fs, FS_TIERS);
  const rate = RATE_TIERS.includes(prefs.rate) ? prefs.rate : nearest(prefs.rate, RATE_TIERS);
  const lh = LH_TIERS.some(([v]) => v === prefs.lh) ? prefs.lh : 1.78;
  return (
    <ReadingDrawer open={open} onClose={onClose} label="阅读设置" layer={layer}>
      <div className="sheet-title plain">阅读设置</div>
      <p className="sheet-note" style={{ margin: "2px 0 12px" }}>
        让文字和声音适合你。
      </p>
      {/* 实时样例：字号/行距档位即时生效预览（原型 .v2-reading-sample） */}
      <div style={{ border: "1px solid var(--hairline)", borderRadius: 12, padding: 14, background: "var(--surface-2)" }} aria-hidden="true">
        <span className="serif" style={{ fontSize: prefs.fs * scale, lineHeight: prefs.lh, display: "block", overflowWrap: "anywhere" }} lang="en">
          A short pause helps me clear my head.
        </span>
        <small style={{ display: "block", fontSize: prefs.mode === "zh" ? prefs.fs * scale : Math.max(17, prefs.fs * scale * .9), lineHeight: prefs.lh, color: "var(--ink-2)", marginTop: 8 }}>
          短暂停顿，思路会更清晰。
        </small>
      </div>
      <div className="rd-set-h">主题</div>
      <div className="v2-theme-options" role="radiogroup" aria-label="阅读主题">
        {TOPIC_CHOICES.map(([value, label, swatch]) => (
          <button
            key={value}
            role="radio"
            aria-checked={prefs.topic === value}
            className={`v2-theme-choice${prefs.topic === value ? " on" : ""}`}
            onClick={() => actions.setReaderPrefs({ topic: value as typeof prefs.topic })}
          >
            <i className={swatch} />
            {label}
          </button>
        ))}
      </div>
      <div className="rd-set-h">字号</div>
      <Seg
        className="rd-setting-seg soft"
        ariaLabel="阅读字号"
        value={String(fs)}
        items={FS_TIERS.map((v) => [String(v), String(v)] as [string, string])}
        onChange={(v) => actions.setReaderPrefs({ fs: Number(v) })}
      />
      <div className="rd-set-h">行距</div>
      <Seg
        className="rd-setting-seg soft"
        ariaLabel="阅读行距"
        value={String(lh)}
        items={LH_TIERS.map(([v, t]) => [String(v), t] as [string, string])}
        onChange={(v) => actions.setReaderPrefs({ lh: Number(v) })}
      />
      <div className="rd-set-h">朗读语速</div>
      <Seg
        className="rd-setting-seg soft"
        ariaLabel="朗读语速"
        value={String(rate)}
        items={RATE_TIERS.map((v) => [String(v), `${v}×`] as [string, string])}
        onChange={(v) => actions.setReaderPrefs({ rate: Number(v) })}
      />
      {/* 原型 SHEETS.readingSettings（html:2036）在语速后仅剩「先读英文」行 + 完成设置：
          「显示（对照/英文/中文）」「词块标注」与底部说明行为 App 旧排版面板遗留，不在原型内 */}
      <div className="lst v2-setting-bottom" style={{ marginTop: 6 }}>
        <button
          className="v2-mask-toggle"
          role="switch"
          aria-checked={prefs.mask}
          onClick={() => actions.setReaderPrefs({ mask: !prefs.mask })}
          style={{ justifyContent: "space-between", width: "100%", padding: "0 2px" }}
        >
          <span>
            <b style={{ display: "block", fontSize: 14 }}>双语模式下先隐藏译文</b>
            <small style={{ display: "block", color: "var(--ink-3)", fontSize: 12, marginTop: 2 }}>逐句点开中文；中文模式始终显示译文</small>
          </span>
          <span className={`sw${prefs.mask ? " on" : ""}`} />
        </button>
      </div>
      <button className="btn" style={{ marginTop: 19 }} onClick={onClose}>
        完成设置
      </button>
    </ReadingDrawer>
  );
}
