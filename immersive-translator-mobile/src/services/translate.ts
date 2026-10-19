/**
 * 翻译服务 —— 三阶段状态机（连接中 → 等首字 → 输出中，§3.9）。
 * 真实链路：Tauri Rust command translate_text（SSE 流式，delta 经 translate-delta
 * 事件回推；WebView 直连受 CORS 限制，spike S4 已验证）。
 * 未配置模型（无 Key / 非 Tauri）：不再产出任何伪译文——回调 onUnconfigured
 * 交调用方呈引导空态（去「我的→模型服务」配置）。
 */
import { getState } from "../store";
import { readGlossary, type GlossaryPair } from "../core/glossary";
import { invoke, invokeRaw, isTauri } from "./device";

export interface StreamHandlers {
  onFirst?: () => void;
  onDelta: (chunk: string) => void;
  onDone: (full: string, ms: number) => void;
  onFail: (msg: string) => void;
  /** 未配置模型服务（无 Key）时触发；不传则静默不产出（调用方自定空态）。 */
  onUnconfigured?: () => void;
}

export interface TranslateEngine {
  stop: () => void;
}

/** 传给 Rust 的 LLM 配置（serde camelCase 对齐；glossary 注入 system prompt 术语对照）。 */
export interface LlmCfg {
  baseUrl: string;
  apiKey: string;
  model: string;
  dir: string;
  style: string;
  glossary: GlossaryPair[];
}

export const PROVIDER_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  moonshot: "https://api.moonshot.cn/v1",
  silicon: "https://api.siliconflow.cn/v1",
};
export const PROVIDER_MODEL: Record<string, string> = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  zhipu: "glm-4-flash",
  moonshot: "moonshot-v1-8k",
  silicon: "Qwen/Qwen2.5-7B-Instruct",
};

/** 真实引擎可用：Tauri 环境 + Key 已填。 */
export function llmConfigured(): boolean {
  return isTauri() && !!getState().settings.apiKey.trim();
}

/** 从 settings 组 cfg：覆盖优先，预设兜底；术语表随 cfg 下发（Rust 注入 system prompt）。 */
export function buildCfg(): LlmCfg {
  const s = getState().settings;
  return {
    baseUrl: (s.baseUrl.trim() || PROVIDER_BASE[s.provider] || s.baseUrl).replace(/\/+$/, ""),
    apiKey: s.apiKey.trim(),
    model: s.model.trim() || PROVIDER_MODEL[s.provider] || "gpt-4o-mini",
    dir: s.dir,
    style: s.style,
    glossary: readGlossary(),
  };
}

/** Rust 命令错误为中文串（Result<T,String>），Error 对象取 message；统一兜底文案。 */
function cmdErrMsg(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message) return err.message;
  return "网络请求失败";
}

/** 真实引擎：流式翻译。delta 经 translate-delta 事件回推，命令返回值做全量兜底。
 *  同步返回引擎句柄（内部异步管线即刻起跑）。 */
function streamReal(srcText: string, h: StreamHandlers): TranslateEngine {
  let stopped = false;
  let acc = "";
  let firstFired = false;
  let unlisten: (() => void) | null = null;
  const t0 = performance.now();
  /* 流 ID（治 rust-core-2，契约对齐 chat-delta）：阅读页允许逐句并发翻译，事件是全局广播——
     不按 reqId 过滤的话两条流互收对方增量，每句 UI 长出双句混排译文，
     并经 onDelta→fillSentenceZh 把错乱文本持久化进文章。 */
  const reqId = "tr-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  /** settings.stream 开关：false 时不逐 delta 渲染，仅最终值（onDone）落地。 */
  const wantStream = () => getState().settings.stream !== false;
  const finish = (full: string) => {
    unlisten?.();
    unlisten = null;
    h.onDone(full, Math.round(performance.now() - t0));
  };
  void (async () => {
    try {
      /* 铁律：先 listen 成功再 invoke（首 delta 不丢） */
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ reqId: string; text: string }>("translate-delta", (e) => {
        if (stopped || !e.payload || e.payload.reqId !== reqId) return;
        const inc = e.payload.text;
        if (!inc) return;
        acc += inc;
        if (import.meta.env.DEV) {
          // 与 A1 Rust 侧逐 delta emit 日志对拍（到达时间戳 + 增量/累计长度）
          console.debug(`[translate] delta +${Math.round(performance.now() - t0)}ms len=${inc.length} acc=${acc.length}`);
        }
        if (!firstFired) {
          firstFired = true;
          h.onFirst?.();
        }
        if (wantStream()) h.onDelta(acc);
      });
      const out = await invokeRaw<string>("translate_text", { text: srcText, cfg: buildCfg(), reqId });
      if (stopped) return;
      if (out == null) throw new Error("command 不可用");
      /* 事件丢失/非流式响应兜底：以命令返回的全量为准 */
      if (out && out !== acc) {
        acc = out;
      }
      if (!firstFired) h.onFirst?.();
      /* 终值统一渲染一次（stream=false 时这是唯一一次增量渲染） */
      h.onDelta(acc);
      finish(acc);
    } catch (err) {
      unlisten?.();
      if (!stopped) h.onFail(cmdErrMsg(err));
    }
  })();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      /* 手动停止：摘监听 + 中止请求，不伪造 onDone（治 services-2）——此前 stop 后 Rust 按
         「部分成功」返回，旧请求的 onDelta/onDone 照常触发：重译瞬间旧半截译文闪回上屏、
         半截/空译文经 onDone→addHistory 写进历史。调用方（停止按钮/返回/重译）自管终态。 */
      unlisten?.();
      unlisten = null;
      void invoke("translate_abort");
    },
  };
}

/** 启动翻译：已配置 → 真实流式；未配置 → onUnconfigured 引导空态（空引擎，无伪译文）。 */
export function startTranslate(srcText: string, h: StreamHandlers): TranslateEngine {
  if (llmConfigured()) {
    /* 直传 streamReal 的真引擎（治 services-2）：此前另包一层只发 translate_abort 的新对象，
       内部 stopped 永假成死码——迟到的增量/完成回调拦不住，监听器也要等命令结束才摘。 */
    return streamReal(srcText, h);
  }
  h.onUnconfigured?.();
  return {
    stop: () => {
      /* 未配置：无在途请求 */
    },
  };
}

/* ---------- LLM 对话流（llm_chat 封装；陪练/总结等批次二消费） ---------- */

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatStreamHandlers {
  /** 每个 delta 到达：text=累计全文（Rust 侧已按 reqId 重算累计）。 */
  onDelta: (cum: string) => void;
  onDone: (full: string) => void;
  onFail: (msg: string) => void;
}

export interface ChatStream {
  stop: () => void;
}

/** 流式对话：先 listen('chat-delta') 按 reqId 过滤，再 invoke('llm_chat')。 */
export function chatStream(systemPrompt: string, messages: ChatMsg[], h: ChatStreamHandlers): ChatStream {
  const reqId = "chat-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  let stopped = false;
  let unlisten: (() => void) | null = null;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<{ reqId: string; text: string }>("chat-delta", (e) => {
        if (stopped || e.payload?.reqId !== reqId) return;
        h.onDelta(e.payload.text);
      });
      const full = await invokeRaw<string>("llm_chat", {
        cfg: buildCfg(),
        systemPrompt,
        messages,
        reqId,
      });
      if (stopped) return;
      if (full == null) throw new Error("command 不可用");
      h.onDone(full);
    } catch (err) {
      if (!stopped) h.onFail(cmdErrMsg(err));
    } finally {
      unlisten?.();
      unlisten = null;
    }
  })();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unlisten?.();
      unlisten = null;
      /* 后端中止（治 services-6）：此前只摘前端监听，Rust 侧 llm_chat 不可中止——
         陪练「跳过」/笔记页退出后整段回复仍在后台拉完，BYOK token 照烧 */
      void invoke("llm_abort");
    },
  };
}

/* ---------- AI 词典查询（#6 调用点；无 Key 立即返回未配置释义，不再延时假装查询） ---------- */
export interface DictLookup {
  defs: { pos: string; cn: string }[];
  ex?: string;
}

export function lookupWord(word: string): Promise<DictLookup> {
  if (llmConfigured()) {
    return invoke<DictLookup>("dict_lookup", { word, cfg: buildCfg() }).then(
      (r) => r ?? { defs: [{ pos: "AI 词典", cn: "（词典服务未返回）" }] },
      () => ({ defs: [{ pos: "AI 词典", cn: "（查询失败，请检查网络后重试）" }] }),
    );
  }
  return Promise.resolve({
    defs: [
      {
        pos: "AI 词典",
        cn: "未配置模型服务——在「我的→模型服务」填入 API Key 后，这里会返回真实释义与例句。",
      },
    ],
  });
}
