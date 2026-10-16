import { getCurrentWindow } from "@tauri-apps/api/window";
import { TranslationPanel } from "./views/TranslationPanel";
import { Settings } from "./views/Settings";
import { History } from "./views/History";
import { OcrOverlay } from "./views/OcrOverlay";
import { ReaderApp } from "./reader/ReaderApp";
import { ReminderApp } from "./reminder/ReminderApp";
import { QuickReviewApp } from "./quickreview/QuickReviewApp";
import { LiveCaptionApp } from "./livecaption/LiveCaptionApp";
import { Onboarding } from "./views/Onboarding";
import { LoginView } from "./views/LoginView";

// 多窗口分发：根据当前窗口 label 渲染不同 UI。
// panel → 翻译浮窗；settings → 设置；history → 历史；ocr-overlay → 截图框选；
// reader → 沉浸阅读室；reminder → 复习提醒卡；quick-review → 快速复习迷你窗；
// live-caption → 录音直译（实时转写 + 双语字幕）；onboarding → 首启引导；
// login → 账号登录（验证码主流程 + 密码页签，docs/windows-auth-design-2026-09-26.md）。
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
  if (label === "login") {
    return <LoginView />;
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
  if (label === "reminder") {
    return <ReminderApp />;
  }
  if (label === "quick-review") {
    return <QuickReviewApp />;
  }
  if (label === "live-caption") {
    return <LiveCaptionApp />;
  }
  if (label === "onboarding") {
    return <Onboarding />;
  }
  return <TranslationPanel />;
}

export default App;
