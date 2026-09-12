import { getCurrentWindow } from "@tauri-apps/api/window";
import { TranslationPanel } from "./views/TranslationPanel";
import { Settings } from "./views/Settings";
import { History } from "./views/History";
import { OcrOverlay } from "./views/OcrOverlay";
import { ReaderApp } from "./reader/ReaderApp";

// 多窗口分发：根据当前窗口 label 渲染不同 UI。
// panel → 翻译浮窗；settings → 设置；history → 历史；ocr-overlay → 截图框选；
// reader → 沉浸阅读室。
// 浏览器里调试可用 ?window=settings 直接指定（Tauri 窗口不带该参数，不影响线上）。
function currentWindowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return new URLSearchParams(window.location.search).get("window") ?? "panel";
  }
}

function App() {
  const label = currentWindowLabel();
  if (label === "settings") {
    return <Settings />;
  }
  if (label === "history") {
    return <History />;
  }
  if (label === "ocr-overlay") {
    return <OcrOverlay />;
  }
  if (label === "reader") {
    return <ReaderApp />;
  }
  return <TranslationPanel />;
}

export default App;
