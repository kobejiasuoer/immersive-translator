/**
 * 通用 push 屏——翻译历史（左滑删除 = 撤销 toast）、术语表（B6 实化：localStorage 真数据
 * + 粘贴导入 + 行删除）、诊断反馈（真实 diag 队列 + 脱敏复制）。
 * visual-theme-cleanup：AboutScreen/ShareScreen 随旧 spike 路由删除（about 仅被已删的 MeScreen
 * 引用；share 路由与「分享这篇文章」入口同批移除）。
 */
import { useState } from "react";
import { actions, toast, useApp } from "../store";
import { Icon } from "../ui/icons";
import { PNav, SwipeRow } from "../ui/kit";
import { useNav } from "../ui/nav";
import { parseGlossaryText, readGlossary, saveGlossary, type GlossaryPair } from "../core/glossary";
import { writeClipboard } from "../services/device";
import { norm } from "../core/judge";
/* 版本唯一出口 core/version.ts（「我的-关于行」同源，治两处各写一份不同步）。 */
import { voiceConfigured } from "../services/voice";
import { APP_VERSION } from "../core/version";

export function HistoryScreen() {
  const nav = useNav();
  const history = useApp((s) => s.history);
  const [q, setQ] = useState("");
  const query = norm(q);
  const list = history.filter((x) => !query || norm(x.en).includes(query) || x.zh.includes(q));
  return (
    <>
      <PNav title="翻译历史" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="search">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索历史记录" aria-label="搜索历史记录" />
        </div>
        <div style={{ marginTop: 10 }}>
          {list.map((x) => (
            <SwipeRow key={x.id} innerClass="vmain" onDelete={() => actions.deleteHistory(x.id)}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span className="pos-badge">{x.src}</span>
                  <span className="meta">{x.time}</span>
                  {x.star && (
                    <span style={{ color: "var(--accent)" }}>
                      <Icon name="star" size={13} />
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 14,
                    lineHeight: "20px",
                    marginTop: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--ink-2)",
                  }}
                >
                  {x.en}
                </div>
              </div>
            </SwipeRow>
          ))}
          {!list.length && (
            <div className="meta" style={{ textAlign: "center", padding: "40px 0" }}>
              没有匹配的记录
            </div>
          )}
        </div>
        <div className="meta" style={{ marginTop: 12 }}>左滑删除，5 秒内可撤销。</div>
      </div>
    </>
  );
}

export function GlossaryScreen() {
  const nav = useNav();
  /* 数据源唯一口径：core/glossary.ts（localStorage ita.v3.glossary，buildCfg 消费）。 */
  const [list, setList] = useState<GlossaryPair[]>(() => readGlossary());
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");

  /** 导入：parseGlossaryText 解析 → 按原文 a 去重合并（同原文更新译法）→ 落盘，toast 报真实数量。
      全角逗号先规范化为半角（core/glossary.ts 的 comma 分支只认半角，中文输入法常见「a，b」不能丢）。 */
  function doImport() {
    const parsed = parseGlossaryText(pasteText.replace(/，/g, ","));
    if (!parsed.length) {
      toast("没解析出术语 · 每行一条「原文 → 译名」");
      return;
    }
    const before = new Set(list.map((p) => p.a));
    const map = new Map<string, string>();
    for (const p of list) map.set(p.a, p.b);
    let added = 0;
    let updated = 0;
    for (const p of parsed) {
      if (before.has(p.a)) updated++;
      else added++;
      map.set(p.a, p.b);
    }
    const merged = [...map.entries()].map(([a, b]) => ({ a, b }));
    saveGlossary(merged);
    setList(merged);
    setPasting(false);
    setPasteText("");
    toast(`已导入 ${parsed.length} 条 · 新增 ${added} · 更新 ${updated} · 共 ${map.size} 条`);
  }

  function removePair(a: string) {
    const next = list.filter((p) => p.a !== a);
    saveGlossary(next);
    setList(next);
    toast(`已删除「${a}」`);
  }

  return (
    <>
      <PNav title="术语表" onBack={() => nav.pop()} />
      <div className="pbody">
        {pasting ? (
          <div className="gcard" style={{ padding: "10px 14px" }}>
            <textarea
              className="input"
              rows={6}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"每行一条，支持：\n结账流程 → checkout flow\n流失，drop off"}
              spellCheck={false}
              aria-label="粘贴术语对照（每行一条）"
            />
            <div className="meta" style={{ marginTop: 6 }}>
              {"分隔符支持 → / -> / => / 全角冒号 / 冒号 / 制表符 / 半角逗号；同原文视为更新译法。"}
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                className="btn-ghost"
                style={{ border: "1px solid var(--hairline-strong)", flex: 1 }}
                onClick={doImport}
                disabled={!pasteText.trim()}
              >
                导入
              </button>
              <button
                className="btn-ghost"
                style={{ border: "1px solid var(--hairline-strong)", flex: 1 }}
                onClick={() => {
                  setPasting(false);
                  setPasteText("");
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button
            className="btn-ghost"
            style={{ border: "1px solid var(--hairline-strong)" }}
            onClick={() => setPasting(true)}
          >
            <Icon name="plus" size={15} />
            导入术语（粘贴）
          </button>
        )}
        <div style={{ marginTop: 12 }}>
          {list.map((x) => (
            <SwipeRow key={x.a} onDelete={() => removePair(x.a)}>
              <div className="grow" style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="grow" style={{ fontSize: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {x.a}
                </span>
                <span className="mono" style={{ fontSize: 13, color: "var(--ink-2)", flex: "none" }}>
                  {x.b}
                </span>
              </div>
            </SwipeRow>
          ))}
          {!list.length && (
            <div className="meta" style={{ textAlign: "center", padding: "40px 0" }}>
              还没有术语——添加后会自动注入翻译提示词
            </div>
          )}
        </div>
        {!!list.length && (
          <div className="meta" style={{ marginTop: 10 }}>
            {list.length} 条 · 左滑删除 · 翻译时自动注入提示词。
          </div>
        )}
      </div>
    </>
  );
}

export function DiagScreen() {
  const nav = useNav();
  /* 真实诊断队列（store.diag 环形 30 条，registerDiagSink 汇入；新的在前）。 */
  const diag = useApp((s) => s.diag);
  const voiceOn = voiceConfigured();
  const list = [...diag].reverse();

  /** 复制诊断信息：序列化脱敏摘要（无任何 Key 明文），写剪贴板并按结果 toast。 */
  async function copyDiag() {
    const payload = {
      version: APP_VERSION,
      service: "account",
      voiceConfigured: voiceOn,
      diag: diag.slice(-10),
    };
    const ok = await writeClipboard(JSON.stringify(payload, null, 2));
    toast(ok ? "已复制脱敏诊断信息" : "复制失败 · 剪贴板不可用");
  }

  return (
    <>
      <PNav title="诊断反馈" onBack={() => nav.pop()} />
      <div className="pbody">
        <div className="overline">异常记录（{diag.length}/30 · 仅存本机，重启清空）</div>
        <div className="gcard" style={{ marginTop: 8 }}>
          {list.length ? (
            list.map((d, i) => (
              <div key={`${d.time}-${i}`} className="frow" style={{ cursor: "default", alignItems: "flex-start" }}>
                <span className="statusdot warn" style={{ marginTop: 5 }} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, lineHeight: "18px" }}>
                    <span className="pos-badge">{d.kind}</span>
                    <span className="meta mono" style={{ marginLeft: 6 }}>
                      {new Date(d.time).toLocaleTimeString("zh-CN", { hour12: false })}
                    </span>
                  </span>
                  <span
                    className="sub"
                    style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word", marginTop: 2 }}
                  >
                    {d.msg}
                  </span>
                </span>
              </div>
            ))
          ) : (
            <div className="meta" style={{ textAlign: "center", padding: "30px 0" }}>
              暂无异常记录
            </div>
          )}
          <button className="frow" onClick={copyDiag}>
            <span />
            <span className="grow" style={{ color: "var(--accent)" }}>
              复制诊断信息（已脱敏）
            </span>
          </button>
          {!voiceOn && (
            <button className="frow" onClick={() => nav.replace("setVoice")}>
              <span />
              <span className="grow" style={{ color: "var(--accent)" }}>
                查看语音与朗读设置
              </span>
            </button>
          )}
        </div>
        <div className="gcard" style={{ marginTop: 16 }}>
          <button className="frow" onClick={() => toast("谢谢 · 每一条反馈都会被读到")}>
            <span className="ico" style={{ color: "var(--ink)" }}>
              <Icon name="chat" size={18} />
            </span>
            <span className="grow">告诉我们哪里不顺手</span>
            <Icon name="right" size={15} />
          </button>
        </div>
      </div>
    </>
  );
}
