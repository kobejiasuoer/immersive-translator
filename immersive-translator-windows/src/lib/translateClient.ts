/**
 * 翻译请求客户端工厂（translate_stream 事件按 tag 路由的通用封装）。
 *
 * ReaderApp 内联了同一套逻辑；录音直译窗口（live-caption）没有 ReaderApp
 * 的事件路由，这里给出独立实例。同一窗口只需创建一个客户端。
 */

import {
  onTranslationCancelled,
  onTranslationDelta,
  onTranslationDone,
  onTranslationError,
  translateStream,
} from "./tauriBridge";
import { hasValidSettings, loadSettingsAsync } from "./settingsStore";

export type TranslateOutcome = { status: "done" | "error" | "cancelled"; text: string };

interface Pending {
  onDelta?: (text: string) => void;
  settle: (r: TranslateOutcome) => void;
}

export interface TranslateClient {
  request(
    input: string,
    systemPrompt: string,
    tag: string,
    onDelta?: (text: string) => void,
  ): Promise<TranslateOutcome>;
  dispose(): void;
}

const REQUEST_TIMEOUT_MS = 120_000;

export function createTranslateClient(windowLabel: string): TranslateClient {
  const pending = new Map<string, Pending>();
  let disposed = false;

  const unlistens: Promise<() => void>[] = [
    onTranslationDelta((e) => pending.get(e.tag)?.onDelta?.(e.text)).then((u) => () => u()),
    onTranslationDone((e) => {
      const p = pending.get(e.tag);
      if (p) {
        pending.delete(e.tag);
        p.settle({ status: "done", text: e.text });
      }
    }).then((u) => () => u()),
    onTranslationError((e) => {
      const p = pending.get(e.tag);
      if (p) {
        pending.delete(e.tag);
        p.settle({ status: "error", text: e.body || `HTTP ${e.status ?? ""}` });
      }
    }).then((u) => () => u()),
    onTranslationCancelled((e) => {
      const p = pending.get(e.tag);
      if (p) {
        pending.delete(e.tag);
        p.settle({ status: "cancelled", text: e.partial });
      }
    }).then((u) => () => u()),
  ];

  return {
    request(input, systemPrompt, tag, onDelta) {
      return new Promise<TranslateOutcome>((resolve) => {
        let settled = false;
        const finish = (r: TranslateOutcome) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          pending.delete(tag);
          resolve(r);
        };
        const timer = window.setTimeout(
          () => finish({ status: "error", text: "请求超时" }),
          REQUEST_TIMEOUT_MS,
        );
        pending.set(tag, { onDelta, settle: finish });
        void loadSettingsAsync()
          .then((s) => {
            if (disposed || !hasValidSettings(s)) {
              finish({ status: "error", text: "未配置翻译接口（设置里填好接口与 Key）" });
              return;
            }
            return translateStream({
              text: input,
              endpoint: s.endpoint,
              apiKey: s.apiKey,
              model: s.model,
              systemPrompt,
              stream: s.stream,
              windowLabel,
              tag,
            }).catch((error) => {
              finish({ status: "error", text: error instanceof Error ? error.message : String(error) });
            });
          })
          .catch((error) => finish({ status: "error", text: String(error) }));
      });
    },
    dispose() {
      disposed = true;
      void Promise.all(unlistens).then((fns) => fns.forEach((fn) => fn()));
    },
  };
}
