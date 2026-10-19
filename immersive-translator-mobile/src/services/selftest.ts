/**
 * 真机 TTS 自检（诊断用，ITA_SELFTEST=1 / --ita-selftest 启动门禁，Rust selftest_active）——
 * 把「真机去试」自动化：复现「录音 → 停（触发会话恢复）→ 立即云 TTS 播放」这条出过
 * 「录完就播全无声」竞态的链路，再隔 3s 做一次对照播放。结果逐行 JSONL 落盘
 * （tmp/ita-selftest.jsonl，devicectl copy from 取回），诊断尾巴一并带出
 * （ctx 等待/播放完成/引擎失败都在 store.diag）。
 * 只在自检拉起时跑一次，正常使用零影响。
 */
import { getState } from "../store";
import { invokeRaw } from "./device";
import { startPcmCapture } from "./audio";
import { cloudAvailable, speakCloud } from "./voice";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTtsSelftest(): Promise<void> {
  const report = (tag: string, extra: Record<string, unknown> = {}) => {
    void invokeRaw("selftest_report", { line: JSON.stringify({ t: new Date().toISOString(), tag, ...extra }) }).catch(
      () => undefined,
    );
  };

  report("start", { ua: navigator.userAgent.slice(0, 90) });
  /* 合成手势态：真实链路里用户刚按过 hold 按钮（pointerdown 解锁仪式），
     这里用合成事件尽力对齐（untrusted 事件 iOS 可能不认，diag 尾巴会暴露差异） */
  try {
    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  } catch {
    /* 无 PointerEvent 的环境忽略 */
  }
  await wait(1500);

  /* 1) 真实录音 1.2s → stop（teardown 内自动调 restore_playback_audio） */
  const tRec = Date.now();
  let recDetail: Record<string, unknown> = {};
  try {
    const cap = await startPcmCapture();
    if (!cap) {
      recDetail = { denied: true };
    } else {
      await wait(1200);
      const r = await cap.stop();
      recDetail = { ms: r.ms, peak: +r.peak.toFixed(3), pcmKB: Math.round(r.pcmB64.length / 1365) };
    }
  } catch (err) {
    recDetail = { error: String(err) };
  }
  report("record", { wallMs: Date.now() - tRec, ...recDetail });

  /* 2) 停止后立即云合成+播放（毒窗口探测）与 3s 后对照 */
  const speakOnce = async (label: string, text: string) => {
    if (!cloudAvailable()) {
      report(label, { skip: "cloud unavailable" });
      return;
    }
    report(label + "-start"); /* 冻结定位：webview 挂起时最后一行停在哪步一目了然 */
    const t0 = Date.now();
    try {
      const h = speakCloud(text);
      const result = await Promise.race([h.done.then(() => "done"), wait(25000).then(() => "timeout")]);
      report(label, { result, ms: Date.now() - t0 });
    } catch (err) {
      report(label, { result: "error", err: String(err), ms: Date.now() - t0 });
    }
  };
  await speakOnce("speak-immediate", "Quick audio check right after recording. One, two, three.");
  await wait(3000);
  await speakOnce("speak-control", "Control playback a few seconds later. Four, five, six.");

  /* 3) 诊断尾巴（awaitRunningCtx 等待、播放完成、引擎切换/失败全在这） */
  const msgs = getState()
    .diag.filter((d) => d.kind === "tts" || d.kind === "invoke")
    .slice(-14)
    .map((d) => d.msg);
  report("diag-tail", { msgs });
  report("end");
}
