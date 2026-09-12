import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定端口 + 不清屏，与桌面端 vite 习惯一致
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    host: false,
  },
  build: {
    target: "safari16", // 最低 iOS 16（落地文档 §0）
  },
});
