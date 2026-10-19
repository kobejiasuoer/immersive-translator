/**
 * spike 自检（push，入口在「我的 → spike 自检」——工作区硬约束保留）。
 * S2 渲染压测（600 句全量渲染）、S3a TTS 事件命中率、S4 BYOK WebView 直连观察。
 */
import { useRef, useState, type ChangeEvent } from "react";
import { speak, stopSpeak, ttsEvents, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav } from "../ui/kit";
import { useNav } from "../ui/nav";
import { makeStressArticle } from "../core/data";
import { invoke } from "../services/device";

export default function SpikeScreen() {
  const nav = useNav();
  const articles = useApp((s) => s.articles);
  const [ttsTick, setTtsTick] = useState(0);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [endpoint, setEndpoint] = useState("https://api.deepseek.com/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [netResult, setNetResult] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function testFetch() {
    setNetResult("请求中…");
    const t0 = performance.now();
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 8 }),
      });
      const ms = Math.round(performance.now() - t0);
      const body = await res.text();
      setNetResult(`HTTP ${res.status} · ${ms}ms · ${body.slice(0, 120)}`);
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      setNetResult(`失败（${ms}ms）：${(err as Error).message} —— 若为 CORS/TypeError，记录为「WebView fetch 直连不可行，需走 Rust http」`);
    }
  }

  async function ping() {
    const r = await invoke<string>("ping");
    toast(r ? `ping → ${r}` : "Tauri command 不可用（浏览器演示态）");
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const j = JSON.parse(String(r.result)) as { articles?: unknown[]; vocab?: { words?: unknown[] } };
        toast(`解析成功：${Array.isArray(j.articles) ? j.articles.length : 0} 篇文章 · ${j.vocab?.words?.length ?? 0} 词条`);
      } catch (err) {
        toast(`解析失败：${(err as Error).message}`);
      }
    };
    r.readAsText(f);
  }

  return (
    <>
      <PNav title="spike 自检" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="overline">S2 · 渲染压测</div>
        <div className="gcard" style={{ marginTop: 8 }}>
          <button
            className="frow"
            onClick={() => {
              const stress = makeStressArticle(75);
              /* 直传 article 实体（治 ux-cross-2）：压测文章只构造不入库，
                 此前只传 articleId 而书架里永远找不到 → 渲染「内容不见了」死页 */
              nav.replace("reader", { article: stress, articleId: stress.id });
            }}
          >
            <span className="ico">
              <Icon name="book" size={18} />
            </span>
            <span className="grow">打开 600 句压测文章（全量渲染）</span>
            <Icon name="right" size={15} />
          </button>
          <button className="frow" onClick={ping}>
            <span className="ico">
              <Icon name="bolt" size={18} />
            </span>
            <span className="grow">Tauri command 探活（ping）</span>
            <Icon name="right" size={15} />
          </button>
          <button className="frow" onClick={() => fileRef.current?.click()}>
            <span className="ico">
              <Icon name="shelf" size={18} />
            </span>
            <span className="grow">S5 文件导入探针（JSON）</span>
            <Icon name="right" size={15} />
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFile} />
        </div>

        <div className="overline" style={{ marginTop: 20 }}>S3a · TTS（Web Speech）</div>
        <div className="gcard" style={{ marginTop: 8, padding: "12px 14px" }}>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="btn"
              style={{ flex: 1, height: 40, fontSize: 14 }}
              onClick={() => {
                setTtsBusy(true);
                speak("The idea of car-free streets took root after the summer of heatwaves.", 1, () => {
                  setTtsBusy(false);
                  setTtsTick((n) => n + 1);
                });
              }}
              disabled={ttsBusy}
            >
              {ttsBusy ? "播放中…" : "播放测试句"}
            </button>
            <button className="btn-ghost" style={{ flex: 1, height: 40, fontSize: 14, border: "1px solid var(--hairline-strong)" }} onClick={() => stopSpeak()}>
              停止
            </button>
          </div>
          <div className="meta" style={{ marginTop: 10, lineHeight: 1.8 }}>
            onstart <b className="num">{ttsEvents.start}</b> · onend <b className="num">{ttsEvents.end}</b>（渲染 {ttsTick} 次）·
            若 onend 恒为 0 而播放正常 → WebView onend 不可靠，走兜底定时器。
          </div>
        </div>

        <div className="overline" style={{ marginTop: 20 }}>S4 · BYOK WebView 直连</div>
        <div className="gcard" style={{ marginTop: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          <input className="input" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="endpoint" spellCheck={false} />
          <input className="input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key（仅本页内存）" type="password" spellCheck={false} />
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model" spellCheck={false} />
          <button className="btn" style={{ height: 40, fontSize: 14 }} onClick={testFetch} disabled={!apiKey}>
            发送测试请求
          </button>
          {netResult && <div className="meta" style={{ wordBreak: "break-all", lineHeight: 1.7 }}>{netResult}</div>}
        </div>

        <div className="meta" style={{ marginTop: 14 }}>
          当前书架文章数：{articles.length} · 观察结果记录进 docs/mobile-spike-report.md
        </div>
      </div>
    </>
  );
}
