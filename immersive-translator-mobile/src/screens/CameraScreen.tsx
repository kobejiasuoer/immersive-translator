/**
 * 拍译（push，P1 #12/#14）—— 相机取景（getUserMedia 环境摄像头，失败降级纸面取景）
 * + 拍摄/相册 → 讯飞 OCR（ocr_image）→ 翻译结果页；空结果三退路（重拍/换张图/手动输入）。
 * 真实链路（B5）：拍摄 = video 离屏 canvas（videoWidth×videoHeight）取帧 → jpeg 0.85 →
 * base64；相册 = 任意 image/* → FileReader base64（>4M 提示换图，讯飞上限）。
 * language="cn|en"（中英混拍）；凭据与语音服务共用三件套，鉴权/未配置错误 →
 * toast + 「去配置」跳 setVoice。浏览器无 Tauri → invokeRaw 抛错如实提示，
 * 不再把写死文案当识别结果（治 P-14 演示态伪装）。
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/icons";
import { PNav } from "../ui/kit";
import { useNav } from "../ui/nav";
import { invokeRaw, openAppSettings, openCamera } from "../services/device";
import { getState, toast } from "../store";
import type { VoiceCfg } from "../services/voice";

/** Rust ocr_image 出参（serde camelCase）：text=行间 \n 拼接，lines=按文档序的行。 */
interface OcrResult {
  text: string;
  lines: string[];
}

/** 讯飞印刷文字识别上限：图像 base64 后 ≤4M（官方口径 jpg/png/bmp ≤4M）。 */
const OCR_MAX_B64 = 4 * 1024 * 1024;

function errText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 鉴权/未配置类错误 → 附「去配置」入口（OCR 与语音共用三件套）。 */
function isCredentialError(msg: string): boolean {
  return /未配置讯飞凭据|授权失败|鉴权失败|签名|10005/i.test(msg);
}

/** dataURL → 纯 base64（去 data:image/...;base64, 前缀）。 */
function dataUrlToB64(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/** 当前讯飞凭据（OCR 与语音服务共用；Rust 侧 VoiceCfg camelCase 对齐）。 */
function voiceCfgNow(): VoiceCfg {
  const s = getState().settings;
  return { appId: s.voiceAppId.trim(), apiKey: s.voiceApiKey.trim(), apiSecret: s.voiceApiSecret.trim() };
}

/** 取当前帧：离屏 canvas（videoWidth×videoHeight）→ toBlob jpeg 0.85 → base64。 */
function frameToJpegB64(video: HTMLVideoElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      reject(new Error("取景画面未就绪，请稍候再拍"));
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("无法创建画布"));
      return;
    }
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("画面编码失败"));
          return;
        }
        const fr = new FileReader();
        fr.onload = () => resolve(dataUrlToB64(String(fr.result ?? "")));
        fr.onerror = () => reject(new Error("读取画面失败"));
        fr.readAsDataURL(blob);
      },
      "image/jpeg",
      0.85,
    );
  });
}

export default function CameraScreen() {
  const nav = useNav();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [hasCam, setHasCam] = useState(false);
  const [noCam, setNoCam] = useState(false);
  /* 权限被拒与「无相机」分流（治 tools-3）：iOS 拒绝后系统不再弹授权框，
     界面要给「去系统设置」出口，而不是误称「已用演示取景」 */
  const [permDenied, setPermDenied] = useState(false);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState<null | "noText">(null);

  useEffect(() => {
    let dead = false;
    void openCamera().then((stream) => {
      if (dead) {
        if (stream && stream !== "denied") stream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (stream === "denied") {
        /* 权限被拒：iOS 不会再弹授权框，给「去系统设置」引导（治 tools-3） */
        setPermDenied(true);
        return;
      }
      if (!stream) {
        /* 相机不可用（无摄像头/环境不支持）→ 纸面取景背景，但要说清楚（对齐麦克风降级文案惯例，治 P-48） */
        setNoCam(true);
        return;
      }
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      v.srcObject = stream;
      void v.play().catch(() => {});
      setHasCam(true);
    });
    return () => {
      dead = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  /* 「没找到文字」空态会整棵卸载相机树：重拍一张回来 video 是新节点，而挂流的
     挂载 effect 是 [] 依赖不再重跑——在这里把仍持有的流补挂回去，否则取景永远黑屏（治 tools-2） */
  useEffect(() => {
    const v = videoRef.current;
    if (!empty && v && streamRef.current && !v.srcObject) {
      v.srcObject = streamRef.current;
      void v.play().catch(() => {});
    }
  }, [empty]);

  /**
   * 识别（拍摄/相册共用，busy 生命周期由两个入口管理）：
   * 有文本 → 顶替进翻译页（srcText 行间 \n 保留）；code==0 零文本 → 空态；
   * Err → 中文错误 toast + 停留原界面；鉴权/未配置 → 附「去配置」跳语音服务。
   */
  async function runOcr(b64: string): Promise<void> {
    if (b64.length > OCR_MAX_B64) {
      toast("图片过大（需小于 4MB），请换一张");
      return;
    }
    try {
      const r = await invokeRaw<OcrResult>("ocr_image", {
        imageB64: b64,
        language: "cn|en",
        voice: voiceCfgNow(),
      });
      if (r.text.trim()) {
        nav.replace?.("translate", { src: "拍译", srcText: r.text });
        return;
      }
      setEmpty("noText");
    } catch (err) {
      const msg = errText(err) || "未知错误";
      if (isCredentialError(msg)) {
        toast(`识别失败：${msg}。拍译与语音服务共用同一套讯飞凭据（AppID / API Key / API Secret）`, {
          action: "去配置",
          onAction: () => nav.push("setVoice"),
          duration: 6000,
        });
      } else {
        toast(`识别失败：${msg}`, { duration: 3200 });
      }
    }
  }

  /** 拍摄：flash 保留；真实取帧后识别（快门后立即「识别中…」，不再 900ms 静默跳转）。 */
  function shoot() {
    if (busy) return;
    const video = videoRef.current;
    if (!hasCam || !video) {
      /* 相机不可用/未就绪：如实提示可走相册，不再把纸面背景文案当识别结果；
         权限被拒单独分流——去系统设置才能解决（治 tools-3） */
      toast(
        permDenied
          ? "相机权限被拒 · 请到系统设置开启后重进"
          : noCam
            ? "相机不可用 · 无法拍摄识别，可从相册选择"
            : "相机启动中，请稍候再拍",
      );
      return;
    }
    setFlash(true);
    setTimeout(() => setFlash(false), 440);
    setBusy(true);
    void (async () => {
      try {
        const b64 = await frameToJpegB64(video);
        await runOcr(b64);
      } catch (err) {
        toast(`拍摄失败：${errText(err)}`);
      } finally {
        setBusy(false);
      }
    })();
  }

  /** 相册：任意 image/* → FileReader base64 → 同拍摄识别链路；非图片如实提示。 */
  function onAlbum(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // 复位以便重选同一文件
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast("请选择图片文件");
      return;
    }
    setBusy(true);
    const fr = new FileReader();
    fr.onload = () => {
      void runOcr(dataUrlToB64(String(fr.result ?? ""))).finally(() => setBusy(false));
    };
    fr.onerror = () => {
      setBusy(false);
      toast("读取图片失败，请重试");
    };
    fr.readAsDataURL(f);
  }

  if (empty) {
    return (
      <>
        <PNav title="拍译" onBack={() => setEmpty(null)} />
        <div className="cam-empty" style={{ position: "static", flex: 1 }}>
          <div style={{ color: "var(--ink-4)" }}>
            <Icon name="cam" size={40} />
          </div>
          <div className="t">没找到文字</div>
          <div className="d">这张图里没有可识别的内容</div>
          {busy && (
            <div className="meta" style={{ marginTop: 12 }}>
              识别中…
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", marginTop: 26 }}>
            <button className="btn" disabled={busy} onClick={() => setEmpty(null)}>
              重拍一张
            </button>
            <button
              className="btn-ghost"
              style={{ border: "1px solid var(--hairline-strong)" }}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              换张图
            </button>
            <button
              className="btn-ghost tlink"
              style={{ height: 40, fontSize: 14, fontWeight: 500 }}
              disabled={busy}
              onClick={() => nav.replace?.("translate", { src: "手动输入", srcText: "" })}
            >
              手动输入
            </button>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onAlbum} />
        </div>
      </>
    );
  }

  return (
    <div className="cam">
      <PNav title="" onBack={() => nav.pop()} />
      <div className="cam-view">
        {/* video 常驻 DOM（否则 ref 未挂上流进不来，取景死锁）；未就绪/降级时隐藏显示纸面背景 */}
        <video ref={videoRef} className="cam-video" playsInline muted style={hasCam ? undefined : { display: "none" }} />
        {!hasCam && (
          <div className="cam-scene" style={{ background: "#2A2620", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 250, background: "#F3EFE6", borderRadius: 10, padding: "20px 18px", transform: "rotate(-2deg)", boxShadow: "0 18px 50px rgba(0,0,0,.5)" }}>
              <div className="serif" style={{ fontSize: 21, color: "#26221B", letterSpacing: "0.06em", textAlign: "center", lineHeight: "30px" }}>
                FRESH PRODUCE
                <br />
                DAILY · MARKET ST
              </div>
              <div style={{ height: 1, background: "#D8D2C2", margin: "12px 0" }} />
              <div style={{ fontSize: 11.5, color: "#57503F", textAlign: "center", letterSpacing: "0.14em", lineHeight: "18px" }}>
                OPEN 7 AM — 6 PM
                <br />
                NO 12, GROVE LANE
              </div>
            </div>
          </div>
        )}
        <div className="cam-hint">{busy ? "识别中…" : "对准要翻译的文字"}</div>
        {permDenied ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 16,
              textAlign: "center",
              color: "rgba(250, 248, 243, 0.72)",
            }}
          >
            <div className="meta">相机权限被拒 · 拍译需要相机</div>
            <button
              className="tlink"
              style={{ display: "block", margin: "8px auto 0", fontSize: 14, color: "rgba(250, 248, 243, 0.9)" }}
              onClick={() => void openAppSettings()}
            >
              去系统设置开启
            </button>
          </div>
        ) : noCam ? (
          <div
            className="meta"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 16,
              textAlign: "center",
              color: "rgba(250, 248, 243, 0.72)",
            }}
          >
            相机不可用 · 已用演示取景
          </div>
        ) : null}
        <div className="cam-corner tl" />
        <div className="cam-corner tr" />
        <div className="cam-corner bl" />
        <div className="cam-corner br" />
        {flash && <div className="cam-flash go" />}
      </div>
      <div className="cam-bottom">
        <button className="cam-album" aria-label="相册" disabled={busy} style={busy ? { opacity: 0.5 } : undefined} onClick={() => fileRef.current?.click()}>
          <Icon name="shelf" size={19} />
        </button>
        <button className="cam-shutter" aria-label="拍摄" disabled={busy} style={busy ? { opacity: 0.6 } : undefined} onClick={shoot}>
          <i />
        </button>
        <button
          className="cam-flip"
          aria-label="手动输入"
          disabled={busy}
          style={busy ? { opacity: 0.5 } : undefined}
          onClick={() => nav.replace?.("translate", { src: "手动输入", srcText: "" })}
        >
          <Icon name="kbd" size={19} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onAlbum} />
      </div>
    </div>
  );
}
