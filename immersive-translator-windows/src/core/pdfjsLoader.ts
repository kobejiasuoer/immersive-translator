/**
 * 浏览器端 pdfjs 加载器：标准 build + worker 以独立资产随应用分发
 * （vite `?url` 导出，Tauri 打包后走应用内资源，不依赖网络）。
 *
 * 单测在 Node 里跑，用 pdfjs-dist/legacy build 或 mock 注入
 * （见 fileImport.test.ts），不经过本文件。
 */

import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfjsLike } from "./fileImport";

let cached: Promise<PdfjsLike> | null = null;

export function loadPdfjsBrowser(): Promise<PdfjsLike> {
  if (!cached) {
    cached = (async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return cached;
}
