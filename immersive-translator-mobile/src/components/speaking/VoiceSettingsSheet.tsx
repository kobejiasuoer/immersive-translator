import { GlassSwitch } from "../../ui/GlassSwitch";
import { useEffect, useRef, useState } from "react";
import { ReadingDrawer } from "../reading/Drawer";
import { actions, toast, useApp } from "../../store";
import { Icon } from "../../ui/icons";
import { loadCloudConfig, useCloud, cloudState } from "../../services/cloud";
import { ensureAccount } from "../../services/authGate";
import { speakCloud, voiceErrorText, type CloudSpeech } from "../../services/voice";
import { readDemoVoice, writeDemoVoice } from "./demoVoice";

/** Shared by the account drawer and the voice page; voices come from the account service. */
export function VoicePreferences() {
  const { account, config, generation } = useCloud();
  const selected = useApp(s => s.settings.ttsVoice);
  const [speed, setSpeed] = useState(() => readDemoVoice().speed);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [mic, setMic] = useState<"unknown" | "granted" | "denied" | "prompt" | "requesting">("unknown");
  const playback = useRef<CloudSpeech | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; playback.current?.stop(); }; }, []);
  useEffect(() => {
    let alive = true;
    setError(""); setPreviewing(false);
    if (account && !config) {
      setLoading(true);
      void loadCloudConfig().catch(err => { if (alive) setError(voiceErrorText(err)); }).finally(() => { if (alive) setLoading(false); });
    } else setLoading(false);
    return () => { alive = false; playback.current?.stop(); playback.current = null; };
  }, [account?.id, generation]);
  useEffect(() => {
    let alive = true, status: PermissionStatus | null = null;
    const update = () => { if (alive && status) setMic(status.state); };
    void navigator.permissions?.query({ name: "microphone" as PermissionName }).then(value => {
      status = value; update(); status.addEventListener("change", update);
    }).catch(() => undefined);
    return () => { alive = false; status?.removeEventListener("change", update); };
  }, []);
  async function preview() {
    if (previewing) return;
    setPreviewing(true); setError("");
    try {
      if (!await ensureAccount({ reason: "登录后试听示范声音。" }) || !mounted.current) return;
      const h = speakCloud("A short pause helps me clear my head.", undefined, speed);
      playback.current = h;
      await h.done;
      if (mounted.current && playback.current === h) toast("试听完成");
    } catch (err) { if (mounted.current) setError(voiceErrorText(err)); }
    finally { if (mounted.current) setPreviewing(false); }
  }
  async function requestMic() {
    setMic("requesting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("麦克风暂不可用");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      if (mounted.current) setMic("granted");
    } catch { if (mounted.current) setMic("denied"); }
  }
  async function retryConfig() {
    setLoading(true); setError("");
    const current = cloudState().generation;
    try { await loadCloudConfig(); } catch (err) { if (mounted.current && current === cloudState().generation) setError(voiceErrorText(err)); }
    finally { if (mounted.current) setLoading(false); }
  }
  const voices = config?.voice?.ttsVoices ?? [];
  const unavailable = !!account && !!config && !voices.length;
  return <div className="sp-sheet-body">
    <p className="sp-sheet-copy">{account ? "选择示范声音和适合自己的语速。" : "登录后使用朗读、语音识别和跟读评分。"}</p>
    {!account && <button className="btn" onClick={() => void ensureAccount({ reason: "登录后使用语音功能。" })}>登录账号</button>}
    <div className="rd-set-h">朗读声音</div>
    {loading ? <p className="meta" role="status">正在载入可用声音…</p> : unavailable ? <p className="meta">朗读暂未开放，请稍后再试。</p> : <select className="input" aria-label="朗读声音" disabled={!account || !voices.length || previewing} value={voices.some(v => v.id === selected) ? selected : ""} onChange={e => actions.setSettings({ ttsVoice: e.target.value })}>
      <option value="">默认声音{voices[0] ? ` · ${voices[0].label}` : ""}</option>
      {voices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
    </select>}
    <div className="rd-set-h">示范语速</div>
    <GlassSwitch className="seg soft" ariaLabel="示范语速" value={String(speed)}
      items={[0.7,0.85,1].map(value => ({value:String(value),label:`${value}×`}))}
      onChange={value => setSpeed(writeDemoVoice({speed:Number(value)}).speed)} />
    <button className="btn-ghost" style={{ marginTop: 14 }} disabled={previewing || loading || unavailable} onClick={() => void preview()}>{previewing ? "正在试听…" : "试听示范声音"}</button>
    {account && config && <p className="meta" style={{ marginTop: 12 }}>语音识别{config.voice?.asrLanguages.length ? "已开放" : "暂未开放"} · 跟读评分{config.voice?.iseEnabled ? "已开放" : "暂未开放"}</p>}
    {error && <p role="alert" className="v2-form-error">{error}</p>}
    {account && !config && !loading && <button className="btn-ghost" onClick={() => void retryConfig()}>重新载入声音</button>}
    <div className="rd-set-h">麦克风</div>
    <p className="v2-sp-permission-option"><Icon name="mic" size={15} /><span>{mic === "granted" ? "已允许，可以录音练习" : mic === "denied" ? "未获得授权，请在系统设置中允许麦克风" : mic === "requesting" ? "正在请求麦克风授权…" : "录音时需要允许使用麦克风"}</span></p>
    {mic !== "granted" && <button className="btn-ghost" disabled={mic === "requesting"} onClick={() => void requestMic()}>允许使用麦克风</button>}
  </div>;
}

export function VoiceSettingsSheet({ open, onClose, layer }: { open: boolean; onClose: () => void; layer?: "account" }) {
  return <ReadingDrawer open={open} onClose={onClose} label="语音与朗读" layer={layer}>
    <div className="sp-sheet-head"><h3>语音与朗读</h3></div>
    {open && <VoicePreferences />}
    <button className="btn" style={{ marginTop: 14 }} onClick={onClose}>完成设置</button>
  </ReadingDrawer>;
}
