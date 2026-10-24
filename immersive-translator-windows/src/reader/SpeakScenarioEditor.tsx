/**
 * 口语场景编辑器（升级计划 A2 §2.3/§2.4）：以「一句话生成」为主、手填为辅，
 * 保存进本地 speak-scenarios 同步集合（A0 syncStorePut 落 dirty 实体，跨设备
 * 由用户在账户页手动 syncNow）。
 *
 * 三态流转：input（一句话设想）→ generating（LLM 生成，可取消）→ form（可
 * 编辑表单，也可跳过生成直接手填）。提示词隔离（§2.4）：系统提示由客户端
 * 模板固定（buildScenarioGenSystemPrompt 零参数，不可能混入用户输入），用户
 * 原话只作为 <scenario-idea> 分隔的数据进 input 侧。
 *
 * 失败路径统一保留用户原话与已填表单（验收②）：idea 只有一个写入来源（用户
 * 键入），form 只有三个（initial 预填 / 解析成功预填 / 用户逐字段键入）——
 * 解析失败、接口失败、取消、返回重新生成、保存失败一律不碰这两个 state；
 * 「跳过，手动填写」只切态并显示当前 form（绝不重置）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSpeakScenarioLike,
  listUserScenarios,
  registerUserScenarios,
  type SpeakScenario,
  type SpeakScenarioCategory,
} from "../core/speakLogic";
import {
  buildScenarioGenSystemPrompt,
  buildScenarioGenUserInput,
  parseScenarioGenResponse,
  type ScenarioGenDraft,
  type ScenarioGenParseError,
} from "../core/scenarioForge";
import { track } from "../lib/analytics";
import { USER_SCENARIO_COLLECTION } from "../lib/scenarioCatalog";
import { cancelTranslation, syncStoreList, syncStorePut, type StoredSyncEntity } from "../lib/tauriBridge";
import type { NoteTranslateFn } from "./VocabNoteDialog";

export interface SpeakScenarioEditorProps {
  /** 与 ReaderApp.requestTranslate 同签名（SpeakView 直转发，零新增依赖）。 */
  requestTranslate: NoteTranslateFn;
  onToast: (msg: string) => void;
  /** 保存成功后父级刷新「我的场景」分组。 */
  onSaved: () => void;
  onClose: () => void;
  /** 编辑既有用户场景时传入；缺省 = 新建。 */
  initial?: SpeakScenario;
}

/** 失败不是独立态：是 input 态 + genError 文案。 */
type EditorPhase = "input" | "generating" | "form";

/** 表单态（9 字段；keyPhrases 动态行，空行保存时剔除）。 */
interface ScenarioForm {
  title: string;
  category: SpeakScenarioCategory;
  aiRole: string;
  userRole: string;
  goal: string;
  keyPhrases: string[];
  opener: string;
  openerZh: string;
}

/** 契约 keyPhrases maxItems（speak-scenario.schema.json :84）。 */
const MAX_KEY_PHRASES = 8;
/** 一句话设想防呆上限（HTML 层阻止，§2.4）。 */
const MAX_IDEA_LEN = 200;

function emptyForm(): ScenarioForm {
  return {
    title: "",
    category: "custom",
    aiRole: "",
    userRole: "",
    goal: "",
    keyPhrases: [],
    opener: "",
    openerZh: "",
  };
}

/** 编辑既有场景的表单预填（initial 打开时一次性写入）。 */
function formOfInitial(sc: SpeakScenario): ScenarioForm {
  return {
    title: sc.title,
    category: sc.category,
    aiRole: sc.aiRole,
    userRole: sc.userRole ?? "",
    goal: sc.goal ?? "",
    keyPhrases: sc.keyPhrases ? [...sc.keyPhrases] : [],
    opener: sc.opener,
    openerZh: sc.openerZh ?? "",
  };
}

/** 生成草稿的表单预填（解析成功路径；可选字段钉死为空串/空数组）。 */
function formOfDraft(draft: ScenarioGenDraft): ScenarioForm {
  return {
    title: draft.title,
    category: draft.category,
    aiRole: draft.aiRole,
    userRole: draft.userRole,
    goal: draft.goal,
    keyPhrases: [...draft.keyPhrases],
    opener: draft.opener,
    openerZh: draft.openerZh,
  };
}

/** 解析失败的中文文案（对齐蓝图失败路径统一规则）。 */
function genErrorTextOf(error: ScenarioGenParseError): string {
  if (error === "empty") return "生成结果为空，请重试";
  if (error === "missing_required") return "生成结果缺少必要字段（场景名/角色设定/开场白），请重试或改用手动填写";
  return "生成结果格式异常（未能解析出场景卡），请重试或改用手动填写"; // no_json / bad_json
}

export function SpeakScenarioEditor({ requestTranslate, onToast, onSaved, onClose, initial }: SpeakScenarioEditorProps) {
  const [phase, setPhase] = useState<EditorPhase>(() => (initial ? "form" : "input"));
  /** 一句话原话——任何失败路径绝不清空（验收②的根）。 */
  const [idea, setIdea] = useState("");
  const [genError, setGenError] = useState("");
  const [form, setForm] = useState<ScenarioForm>(() => (initial ? formOfInitial(initial) : emptyForm()));
  /** 保存的表单内容是否源自最后一次成功生成的预填（via 埋点口径）。 */
  const [usedGenerate, setUsedGenerate] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  /** 生成请求 tag 序号（防撞并发的陪练回合/词块标注等翻译流）。 */
  const seqRef = useRef(0);
  const tagRef = useRef("");

  // Esc：生成中先当一次取消用（VocabNoteDialog.tsx:71-79 先例），保存中不误关。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (phase === "generating") void cancelTranslation(tagRef.current);
      else if (!saving) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, saving, onClose]);

  /** 一句话生成：不传 onDelta（JSON 流式上屏无意义），解析只用最终 res.text。 */
  const generate = useCallback(async () => {
    const text = idea.trim();
    if (!text) return;
    setPhase("generating");
    setGenError("");
    const tag = `scngen${++seqRef.current}`;
    tagRef.current = tag;
    try {
      const res = await requestTranslate(buildScenarioGenUserInput(text), buildScenarioGenSystemPrompt(), tag);
      if (res.status === "done") {
        const parsed = parseScenarioGenResponse(res.text);
        if (parsed.ok) {
          // 唯一的 form 写入来源（b）：用户主动生成并成功拿到新草稿，整体替换
          setForm(formOfDraft(parsed.draft));
          setUsedGenerate(true);
          setPhase("form");
          track("scenario_generate_result", { ok: true });
          return;
        }
        track("scenario_generate_result", { ok: false, parseError: parsed.error });
        setGenError(genErrorTextOf(parsed.error));
        setPhase("input");
        return;
      }
      if (res.status === "cancelled") {
        // 半截累计文本绝不当成功解析；原话与表单都不动
        track("scenario_generate_result", { ok: false });
        setGenError("已取消，可重试或手动填写");
        setPhase("input");
        return;
      }
      track("scenario_generate_result", { ok: false });
      setGenError(`生成失败：${res.text}`);
      setPhase("input");
    } catch (e) {
      // 防御分支（requestTranslate 正常永不 reject）
      track("scenario_generate_result", { ok: false });
      setGenError(`生成失败：${e instanceof Error ? e.message : String(e)}`);
      setPhase("input");
    }
  }, [idea, requestTranslate]);

  /** 表单字段逐项更新（唯一的 form 写入来源（c）：用户键入）。 */
  const patchForm = useCallback((patch: Partial<ScenarioForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const setPhrase = useCallback((idx: number, value: string) => {
    setForm((prev) => {
      const keyPhrases = [...prev.keyPhrases];
      keyPhrases[idx] = value;
      return { ...prev, keyPhrases };
    });
  }, []);

  const removePhrase = useCallback((idx: number) => {
    setForm((prev) => ({ ...prev, keyPhrases: prev.keyPhrases.filter((_, i) => i !== idx) }));
  }, []);

  const addPhrase = useCallback(() => {
    setForm((prev) =>
      prev.keyPhrases.length >= MAX_KEY_PHRASES ? prev : { ...prev, keyPhrases: [...prev.keyPhrases, ""] },
    );
  }, []);

  /** 保存：构造场景卡 →（编辑路径先读回 baseVersion）→ syncStorePut 落 dirty
   *  实体 → 注册表整桶合并替换 → 通知父级刷新。任何失败都保留表单可重试。 */
  const handleSave = useCallback(async () => {
    if (saving) return;
    const title = form.title.trim();
    const aiRole = form.aiRole.trim();
    const opener = form.opener.trim();
    const missing: string[] = [];
    if (!title) missing.push("场景名");
    if (!aiRole) missing.push("AI 角色设定");
    if (!opener) missing.push("英文开场白");
    if (missing.length > 0) {
      setSaveError(`请填写：${missing.join("、")}`);
      return;
    }
    setSaveError("");
    setSaving(true);
    // 可选字段空值不写入（落库 JSON 干净）；长度按契约 maxLength/maxItems 双保险 clamp
    const cleanPhrases = form.keyPhrases.map((p) => p.trim()).filter((p) => p !== "");
    const scenario: SpeakScenario = {
      id: initial?.id ?? `usr_${crypto.randomUUID()}`,
      source: "user",
      title,
      category: form.category,
      aiRole: aiRole.slice(0, 300),
      ...(form.userRole.trim() ? { userRole: form.userRole.trim().slice(0, 200) } : {}),
      ...(form.goal.trim() ? { goal: form.goal.trim().slice(0, 200) } : {}),
      ...(cleanPhrases.length > 0 ? { keyPhrases: cleanPhrases.slice(0, MAX_KEY_PHRASES) } : {}),
      opener,
      ...(form.openerZh.trim() ? { openerZh: form.openerZh.trim() } : {}),
      ...(initial?.defaultDifficulty ? { defaultDifficulty: initial.defaultDifficulty } : {}),
      ...(initial?.emoji ? { emoji: initial.emoji } : {}),
      updatedAt: Date.now(),
    };
    // 防御断言（理论必过：三个必填都来自非空 trim；防注册表静默丢弃）
    if (!isSpeakScenarioLike(scenario)) {
      setSaveError("场景数据校验失败，请检查必填字段后重试");
      setSaving(false);
      return;
    }
    // 编辑路径先读回 baseVersion（不重置服务端版本）；读回失败 = 中止保存不落库
    let baseVersion = 0;
    if (initial) {
      let stored: StoredSyncEntity[];
      try {
        stored = await syncStoreList(USER_SCENARIO_COLLECTION);
      } catch (e) {
        setSaveError(`读取本地同步数据失败：${e instanceof Error ? e.message : String(e)}，请重试`);
        setSaving(false);
        return;
      }
      baseVersion = stored.find((e) => e.id === initial.id)?.baseVersion ?? 0;
    }
    const entity: StoredSyncEntity = {
      id: scenario.id,
      baseVersion,
      updatedAt: scenario.updatedAt,
      deleted: false,
      schemaVersion: 1,
      originDevice: "windows",
      payload: scenario,
      dirty: true,
    };
    try {
      await syncStorePut(USER_SCENARIO_COLLECTION, [entity]);
    } catch (e) {
      setSaveError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
      setSaving(false);
      return;
    }
    // 注册表立即生效：registerUserScenarios 是整桶替换，必须合并全量 + 同 id 覆盖
    registerUserScenarios([...listUserScenarios().filter((s) => s.id !== scenario.id), scenario]);
    onSaved();
    // 只有新建发 create（编辑语义是更新）；via=表单内容是否源自最后一次成功生成
    if (!initial) track("scenario_create", { via: usedGenerate ? "generate" : "manual" });
    onToast(initial ? "场景已更新" : "场景已保存");
    onClose();
  }, [form, initial, saving, usedGenerate, onSaved, onToast, onClose]);

  const editing = Boolean(initial);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== "generating" && !saving) onClose();
      }}
    >
      <div className="reader-import-modal scgen-dialog" role="dialog" aria-modal="true" aria-label="场景编辑器">
        <div className="reader-import-head">
          <div>
            <h3>{editing ? "编辑场景" : "新建场景"}</h3>
            <p>
              {phase === "input" && "用一句话描述你想练的场景，AI 帮你生成场景卡；也可以跳过直接手动填写"}
              {phase === "generating" && "正在根据你的一句话设想生成场景卡…"}
              {phase === "form" && "生成结果可以再修改；标 * 的字段必填"}
            </p>
          </div>
          {phase !== "generating" && !saving && (
            <button className="reader-tb-btn" onClick={onClose} title="关闭 (Esc)">
              ✕
            </button>
          )}
        </div>

        {phase === "input" && (
          <div className="scgen-body">
            <textarea
              className="scgen-idea-area"
              aria-label="一句话设想"
              maxLength={MAX_IDEA_LEN}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder={"例如：下周要跟德国客户谈合同续约，对方想压价 10%\n（一句话即可，AI 会帮你展开成完整的口语场景卡）"}
            />
            <div className="scgen-idea-meta">
              <span>{idea.length}/{MAX_IDEA_LEN}</span>
            </div>
            {genError && <div className="scgen-error">{genError}</div>}
            <div className="scgen-foot">
              {/* 手填入口：只切态 + via 复位（表单内容原样显示，绝不重置） */}
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setUsedGenerate(false);
                  setPhase("form");
                }}
              >
                跳过，手动填写
              </button>
              <button className="btn btn-primary" disabled={idea.trim() === ""} onClick={() => void generate()}>
                生成场景
              </button>
            </div>
          </div>
        )}

        {phase === "generating" && (
          <div className="scgen-body scgen-generating">
            <div className="scgen-spinner" aria-hidden />
            <div className="scgen-generating-text">
              正在生成场景卡（角色设定、开场白与目标短语）…<br />
              <span className="scgen-generating-echo">「{idea.trim()}」</span>
            </div>
            <div className="scgen-foot">
              <button className="btn btn-secondary" onClick={() => void cancelTranslation(tagRef.current)}>
                取消生成
              </button>
            </div>
          </div>
        )}

        {phase === "form" && (
          <div className="scgen-body">
            <div className="scgen-field">
              <label htmlFor="scgen-title">场景名 *</label>
              <input
                id="scgen-title"
                className="scgen-input"
                aria-label="场景名"
                type="text"
                value={form.title}
                onChange={(e) => patchForm({ title: e.target.value })}
                placeholder="例如：合同续约谈判"
              />
            </div>
            <div className="scgen-field scgen-field-row">
              <div>
                <label htmlFor="scgen-category">分类</label>
                <select
                  id="scgen-category"
                  className="scgen-input scgen-select"
                  aria-label="分类"
                  value={form.category}
                  onChange={(e) => patchForm({ category: e.target.value as SpeakScenarioCategory })}
                >
                  <option value="daily">日常</option>
                  <option value="travel">旅行</option>
                  <option value="workplace">职场</option>
                  <option value="academic">学术</option>
                  <option value="custom">自定义</option>
                </select>
              </div>
              <div className="scgen-grow">
                <label htmlFor="scgen-openerzh">开场白中文提示</label>
                <input
                  id="scgen-openerzh"
                  className="scgen-input"
                  aria-label="开场白中文提示"
                  type="text"
                  value={form.openerZh}
                  onChange={(e) => patchForm({ openerZh: e.target.value })}
                  placeholder="一句话说明开场白意思"
                />
              </div>
            </div>
            <div className="scgen-field">
              <label htmlFor="scgen-airole">AI 角色与情境设定 *（≤300 字）</label>
              <textarea
                id="scgen-airole"
                className="scgen-textarea"
                aria-label="AI 角色与情境设定"
                maxLength={300}
                value={form.aiRole}
                onChange={(e) => patchForm({ aiRole: e.target.value })}
                placeholder="AI 扮演谁、在什么情境里、什么语气，例如：你扮演德国客户的采购经理，态度友善但想压价 10%，围绕合同续约谈判"
              />
            </div>
            <div className="scgen-field">
              <label htmlFor="scgen-userrole">你的角色（≤200 字）</label>
              <input
                id="scgen-userrole"
                className="scgen-input"
                aria-label="你的角色"
                type="text"
                maxLength={200}
                value={form.userRole}
                onChange={(e) => patchForm({ userRole: e.target.value })}
                placeholder="例如：供应商一方的销售代表"
              />
            </div>
            <div className="scgen-field">
              <label htmlFor="scgen-goal">练习目标（≤200 字）</label>
              <input
                id="scgen-goal"
                className="scgen-input"
                aria-label="练习目标"
                type="text"
                maxLength={200}
                value={form.goal}
                onChange={(e) => patchForm({ goal: e.target.value })}
                placeholder="例如：守住报价、争取更长合同期"
              />
            </div>
            <div className="scgen-field">
              <label>目标短语（≤{MAX_KEY_PHRASES} 条，建议在对话中用出的英文词块）</label>
              {form.keyPhrases.map((p, i) => (
                <div key={i} className="scgen-phrase-row">
                  <input
                    className="scgen-input"
                    aria-label="目标短语"
                    type="text"
                    value={p}
                    onChange={(e) => setPhrase(i, e.target.value)}
                    placeholder="例如：close the deal"
                  />
                  <button
                    className="scgen-phrase-remove"
                    onClick={() => removePhrase(i)}
                    title="删除这条短语"
                    aria-label="删除短语"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="scgen-phrase-add"
                onClick={addPhrase}
                disabled={form.keyPhrases.length >= MAX_KEY_PHRASES}
              >
                ＋ 添加短语
              </button>
            </div>
            <div className="scgen-field">
              <label htmlFor="scgen-opener">英文开场白 *</label>
              <textarea
                id="scgen-opener"
                className="scgen-textarea"
                aria-label="英文开场白"
                value={form.opener}
                onChange={(e) => patchForm({ opener: e.target.value })}
                placeholder="AI 的第一句英文，1-2 句自然口语，结尾留出接话空间，例如：Good to see you again. Shall we start with the pricing?"
              />
            </div>
            {saveError && <div className="scgen-error">{saveError}</div>}
            <div className="scgen-foot">
              <button className="btn btn-secondary" onClick={() => setPhase("input")}>
                ← 返回重新生成
              </button>
              <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
                {saving ? "保存中…" : "保存场景"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
