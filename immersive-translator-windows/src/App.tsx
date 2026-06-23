import { getCurrentWindow } from "@tauri-apps/api/window";
import { TranslationPanel } from "./views/TranslationPanel";
import { Settings } from "./views/Settings";

// 多窗口分发：根据当前窗口 label 渲染不同 UI。
// panel 窗口 → 翻译浮窗；settings 窗口 → 设置页面。
function App() {
  const label = getCurrentWindow().label;
  if (label === "settings") {
    return <Settings />;
  }
  return <TranslationPanel />;
}

export default App;
