/**
 * 首启引导窗口（onboarding）：首次启动时由后端弹出（app_data_dir/onboarding_done
 * 标记不存在）。展示三大核心能力与当前生效的快捷键、托盘入口，点「开始使用」
 * 或「跳过引导」都算完成——后端写标记并关闭本窗口，之后启动不再弹。
 *
 * 设计令牌与全局 styles.css 一致（accent #4c5ff0 / bg #f4f5f9 / surface #fff）。
 * 样式独立在 onboarding.css，不与其他窗口共用类名，避免互相牵连。
 */
import { useEffect, useState } from "react";
import { loadSettingsFullAsync } from "../lib/settingsStore";
import { finishOnboarding } from "../lib/tauriBridge";
import "./onboarding.css";

const DEFAULT_HOTKEYS = {
  hotkey: "Ctrl+Shift+Q",
  ocrHotkey: "Ctrl+Shift+E",
  readerHotkey: "Ctrl+Shift+R",
};

export function Onboarding() {
  const [hotkeys, setHotkeys] = useState(DEFAULT_HOTKEYS);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    // 读用户已保存的热键（首启基本是默认值；重看引导时展示真实值）。
    void loadSettingsFullAsync()
      .then(({ settings }) =>
        setHotkeys({
          hotkey: settings.hotkey || DEFAULT_HOTKEYS.hotkey,
          ocrHotkey: settings.ocrHotkey || DEFAULT_HOTKEYS.ocrHotkey,
          readerHotkey: settings.readerHotkey || DEFAULT_HOTKEYS.readerHotkey,
        }),
      )
      .catch(() => undefined);
  }, []);

  async function finish() {
    if (finishing) return;
    setFinishing(true);
    try {
      await finishOnboarding();
      // 后端 finish_onboarding 会关闭窗口；这里兜底（命令失败时窗口还能走）。
      window.close();
    } catch (error) {
      console.error("[onboarding] finish failed", error);
      setFinishing(false);
    }
  }

  return (
    <div className="ob-root">
      <header className="ob-drag" data-tauri-drag-region />

      <div className="ob-body">
        <div className="ob-hero">
          <div className="ob-logo" aria-hidden>
            译
          </div>
          <h1>欢迎使用 ImmersiveTranslator</h1>
          <p className="ob-tagline">划词即译 · 截图即翻 · 长文精读</p>
        </div>

        <ul className="ob-cards">
          <li className="ob-card">
            <span className="ob-icon" aria-hidden>
              选中
            </span>
            <div className="ob-card-text">
              <h3>划词翻译</h3>
              <p>
                选中任意文字，按 <kbd>{hotkeys.hotkey}</kbd> 弹出浮窗即时翻译
              </p>
            </div>
          </li>
          <li className="ob-card">
            <span className="ob-icon" aria-hidden>
              截图
            </span>
            <div className="ob-card-text">
              <h3>截图 OCR</h3>
              <p>
                按 <kbd>{hotkeys.ocrHotkey}</kbd>，框选屏幕区域，图片里的文字直接译出来
              </p>
            </div>
          </li>
          <li className="ob-card">
            <span className="ob-icon" aria-hidden>
              精读
            </span>
            <div className="ob-card-text">
              <h3>沉浸阅读室</h3>
              <p>
                按 <kbd>{hotkeys.readerHotkey}</kbd> 把选中内容送进精读空间：句对翻译、朗读、收藏生词
              </p>
            </div>
          </li>
        </ul>

        <div className="ob-tray">
          <span className="ob-tray-dot" aria-hidden />
          <p>
            任务栏右下角的托盘图标是常驻入口：左键/右键打开菜单，可进
            <b>阅读室、生词本、快速复习、设置</b>。
          </p>
        </div>

        <div className="ob-actions">
          <button className="ob-start" onClick={() => void finish()} disabled={finishing}>
            {finishing ? "正在进入…" : "开始使用"}
          </button>
          <button className="ob-skip" onClick={() => void finish()} disabled={finishing}>
            跳过引导
          </button>
        </div>

        <p className="ob-foot">快捷键可在 设置 → 快捷键 修改；建议在 设置 → 关于 开启开机自启，复习提醒才不会漏。</p>
      </div>
    </div>
  );
}
