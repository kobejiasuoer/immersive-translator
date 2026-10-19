import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定端口 + 不清屏，与桌面端 vite 习惯一致
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    // 真机 dev：同时监听 localhost（CLI 探活）与局域网 IP（手机加载页面）
    host: true,
  },
  build: {
    target: "safari16", // 最低 iOS 16（落地文档 §0）
  },
});
