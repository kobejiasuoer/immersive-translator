/**
 * 设备能力层 —— 浏览器/WKWebView 统一入口，允许优雅降级但保留调用点
 * （§6.3：TTS / 触感 / 通知 / 麦克风 / 相机；BYOK 请求走 Rust command）。
 * 真机插件（notification/haptics/clipboard-manager/deep-link）走官方 JS 包（A2）；
 * 分享走 Rust 命令 share_text（lib.rs：文本写临时 .txt → tauri-plugin-share 原生
 * 文件分享面板）——插件 2.0.5 无文本命令，plugin:share|share 直调必失败已弃用。
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* ---------- 诊断汇（registerDiagSink；store.diag 环形日志的数据源，A3 消费） ---------- */

export interface DiagEvent {
  time: number;
  kind: string;
  msg: string;
}

type DiagSink = (e: DiagEvent) => void;
let diagSink: DiagSink | null = null;

/** 注册诊断接收器（单槽，后注册覆盖）；invoke/invokeRaw 捕获错误时转发。 */
export function registerDiagSink(fn: DiagSink): void {
  diagSink = fn;
}

/** 转发一条诊断（内部与 voice/translate 服务共用；无 sink 时仅 console.warn）。 */
export function reportDiag(kind: string, msg: string): void {
  const e: DiagEvent = { time: Date.now(), kind, msg };
  try {
    diagSink?.(e);
  } catch {
    /* sink 自身异常不外溢 */
  }
  console.warn(`[diag:${kind}] ${msg}`);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Rust command 调用点；不可用或失败返回 null（浏览器演示态）。失败同时转发诊断汇。 */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<T> } };
    return await w.__TAURI_INTERNALS__.invoke(cmd, args);
  } catch (err) {
    reportDiag("invoke", `${cmd} 失败：${errMsg(err)}`);
    return null;
  }
}

/** 同 invoke，但错误向上抛（测试连接等需要展示失败原因的场景）；失败先转发诊断汇再抛。 */
export async function invokeRaw<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("仅真机（Tauri WebView）可用");
  const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<T> } };
  try {
    return await w.__TAURI_INTERNALS__.invoke(cmd, args);
  } catch (err) {
    reportDiag("invoke", `${cmd} 失败：${errMsg(err)}`);
    throw err;
  }
}

/* ---------- 触感（§1.8：tab 切换/评分/收词/开麦 = light；清空今日 = success） ---------- */
export function haptic(kind: "light" | "success"): void {
  if (isTauri()) {
    void (async () => {
      try {
        const m = await import("@tauri-apps/plugin-haptics");
        if (kind === "success") await m.notificationFeedback("success");
        else await m.impactFeedback("light");
      } catch (err) {
        reportDiag("haptic", `触感反馈失败：${errMsg(err)}`);
      }
    })();
    return;
  }
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(kind === "success" ? [12, 40, 12] : 8);
    }
  } catch {
    /* 静默 */
  }
}

/* ---------- 本地通知（#28 调用点；真机走 plugin-notification，浏览器仅记录） ---------- */

/** 每日提醒通知 id（定值，先 cancel 再 schedule 保证不重复投递）。 */
export const REMINDER_NOTIFICATION_ID = 1001;

/** 失败 toast（动态 import 规避 store↔device 静态环）。 */
async function diagToast(msg: string): Promise<void> {
  try {
    const { toast } = await import("../store");
    toast(msg);
  } catch {
    console.warn(`[notify] ${msg}`);
  }
}

/**
 * 每日复习提醒。真机：requestPermission → cancel(1001) → sendNotification
 * （Schedule.interval({hour,minute}) 每日重复，d.ts 口径：未设字段匹配任意日期）。
 * 失败 toast 如实（不再静默 console.warn）。浏览器分支不投递系统通知。
 */
export async function scheduleDailyReminder(time: string, enabled: boolean): Promise<void> {
  if (isTauri()) {
    try {
      const m = await import("@tauri-apps/plugin-notification");
      if (enabled) {
        let granted = await m.isPermissionGranted();
        if (!granted) granted = (await m.requestPermission()) === "granted";
        if (!granted) {
          await diagToast("通知权限未开启，每日提醒无法投递（可在系统设置中打开）");
          return;
        }
      }
      await m.cancel([REMINDER_NOTIFICATION_ID]);
      if (enabled) {
        const hm = /^(\d{1,2}):(\d{1,2})$/.exec(time.trim());
        if (!hm) {
          await diagToast(`提醒时间格式无效：${time}`);
          return;
        }
        m.sendNotification({
          id: REMINDER_NOTIFICATION_ID,
          title: "今晚的复习提醒",
          body: "到点清生词，睡前过一遍",
          schedule: m.Schedule.interval({ hour: Number(hm[1]), minute: Number(hm[2]) }),
        });
      }
    } catch (err) {
      await diagToast(`每日提醒设置失败：${errMsg(err)}`);
    }
    return;
  }
  console.info(`[notify] 每日提醒 ${enabled ? "开启" : "关闭"} @ ${time}（浏览器演示态：不投递系统通知）`);
}

/* ---------- 麦克风电平（陪练/直译/跟读共用；拒绝授权 → null 走模拟电平） ---------- */
export interface MicLevel {
  level: () => number;
  stop: () => void;
}
export async function openMicLevel(): Promise<MicLevel | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    return {
      level: () => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        return Math.min(1, sum / buf.length / 96);
      },
      stop: () => {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      },
    };
  } catch (err) {
    console.warn("[device] 麦克风不可用，降级为模拟电平", err);
    return null;
  }
}

/* ---------- 相机（拍译；拒绝/不可用 → 返回 null 用取景纸面场景降级） ---------- */
export type CameraOpen = MediaStream | null | "denied";

/** 打开后置相机。权限被拒（NotAllowed/Security）返回 "denied"——iOS 拒绝后系统不再
 *  弹授权框，只能引导去系统设置；其他失败（无相机/环境不支持）返回 null 降级纸面取景。
 *  此前权限被拒与无相机一并吞成 null，界面误称「已用演示取景」（治 tools-3）。 */
export async function openCamera(): Promise<CameraOpen> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      return "denied";
    }
    console.warn("[device] 相机不可用，拍译降级为取景演示", err);
    return null;
  }
}

/** 跳本 App 的系统设置页（权限被拒引导；Rust open_app_settings，仅真机 iOS 生效）。 */
export async function openAppSettings(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invokeRaw<void>("open_app_settings");
    return true;
  } catch (err) {
    reportDiag("settings", `打开系统设置失败：${errMsg(err)}`);
    return false;
  }
}

/* ---------- 剪贴板（读失败 → 调用方走「手动粘贴」次态 §3.1；真机优先插件） ---------- */
export async function readClipboard(): Promise<string | null> {
  if (isTauri()) {
    try {
      const m = await import("@tauri-apps/plugin-clipboard-manager");
      return await m.readText();
    } catch (err) {
      reportDiag("clipboard", `剪贴板读取失败，回退 Web API：${errMsg(err)}`);
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** 写剪贴板；结果上抛为 boolean（成功 true / 失败 false），调用方按结果给 toast，不再静默吞异常。 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const m = await import("@tauri-apps/plugin-clipboard-manager");
      await m.writeText(text);
      return true;
    } catch (err) {
      reportDiag("clipboard", `剪贴板写入失败，回退 Web API：${errMsg(err)}`);
    }
  }
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ---------- 系统分享（失败/取消 → 回退复制并返回 false，调用方按 false 提示） ---------- */
export async function shareText(title: string, text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      // Rust 侧写临时 .txt → tauri-plugin-share 原生 UIActivityViewController（真分享面板）
      await invokeRaw("share_text", { title, text });
      return true;
    } catch (err) {
      reportDiag("share", `系统分享失败，回退复制：${errMsg(err)}`);
      const copied = await writeClipboard(text);
      if (!copied) reportDiag("share", "分享与复制均失败");
      return false;
    }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.share) {
      await navigator.share({ title, text });
      return true;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // 用户主动取消分享：不算失败，也不复制
      return false;
    }
    reportDiag("share", `Web Share 失败，回退复制：${errMsg(err)}`);
  }
  const ok = await writeClipboard(text);
  if (!ok) reportDiag("share", "分享与复制均失败");
  return false;
}

/* ---------- 深链（ita:// scheme；真机 plugin-deep-link + hashchange 兜底） ---------- */
export function onDeepLink(cb: (url: string) => void): () => void {
  let unlistenSys: (() => void) | null = null;
  let disposed = false;
  if (isTauri()) {
    void (async () => {
      try {
        const m = await import("@tauri-apps/plugin-deep-link");
        /* 保存 unlisten 并入清理（治 shell-4）：此前清理函数只摘 hashchange，系统深链
           监听永不注销——StrictMode 双挂载各注册一份，每条 ita:// 深链回调两次。 */
        const fn = await m.onOpenUrl((urls) => {
          const u = urls?.[0];
          if (u && !disposed) cb(u);
        });
        if (disposed) {
          fn(); // 清理先于注册完成：立即注销
        } else {
          unlistenSys = fn;
        }
        const cur = await m.getCurrent();
        const u0 = cur?.[0];
        if (u0 && !disposed) cb(u0); // 冷启动经深链拉起
      } catch (err) {
        reportDiag("deep-link", `深链监听失败：${errMsg(err)}`);
      }
    })();
  }
  const onHash = () => cb(window.location.href);
  window.addEventListener("hashchange", onHash);
  return () => {
    disposed = true;
    unlistenSys?.();
    unlistenSys = null;
    window.removeEventListener("hashchange", onHash);
  };
}
