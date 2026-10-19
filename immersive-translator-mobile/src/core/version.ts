/**
 * 应用版本唯一出口（B7 审计修正：「我的-关于行」与 AboutScreen 此前各写一份且不同步，
 * 现两处都从本模块取）。源头 package.json version——tsconfig 未开 resolveJsonModule，
 * 静态 import json 过不了 tsc → 用 Vite 原生 `?raw` 导入 + JSON.parse。
 */
import pkgRaw from "../../package.json?raw";

/** package.json version（解析失败兜底 0.0.0）。 */
export const APP_VERSION: string = (() => {
  try {
    return (JSON.parse(pkgRaw) as { version?: string }).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** 「我的-关于行」副标题（与 AboutScreen 版本行同一源头）。 */
export const APP_VERSION_SUB = `${APP_VERSION} · 内测`;
