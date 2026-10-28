/**
 * 语音网关 REST 通道的生产接线（voiceRuntime 默认 http=null → 这里补上）：
 * method+path+JSON body 经 invoke 转给 Rust `voice_http_request` 命令——Bearer
 * 会话令牌附带、401 单飞刷新重放、x-quota-* / retry-after 透传全在 Rust 侧
 * （auth.rs with_auth 管线），本模块只做 IPC 形状适配，不含任何令牌逻辑
 * （红线：token 永不跨 IPC）。
 *
 * 调用点唯一：src/main.tsx（全部窗口共用该入口）；WSS（原生 WebSocket 工厂）与
 * baseUrl 默认实现无需接线。未接线时 voiceRequest 抛「语音网关 HTTP 通道未接线」
 * 编程错误，换票/批量转写/发音评测全部不可用——接线冒烟见 voiceRuntimeIpc.test.ts。
 */

import { invoke } from "@tauri-apps/api/core";
import { setVoiceRuntime, type VoiceHttpResponse } from "./voiceRuntime";

/** 安装生产 HTTP 传输（应用启动时调用；重复调用只是覆盖同一实现，幂等）。 */
export function installVoiceHttpTransport(): void {
  setVoiceRuntime({
    http: (method, path, bodyJson) =>
      invoke<VoiceHttpResponse>("voice_http_request", {
        method,
        path,
        bodyJson: bodyJson ?? null,
      }),
  });
}
