/**
 * 发音要点抽屉（speaking-parity · 原型 SHEETS.pronunciation，html:2687-2696）。
 * overline「当前表达的发音强化」+ 大衬线标题（有词显示词，无词显示「跟读这句」）+
 * 音标（有则显示，不本地编造）；听词音 / 慢速示范（约 0.55×）/ 听整句（卡内绿色文字链）/
 * 听我刚才的回答（真实原声，仅录制设备可播）；主按钮在练习内是「回去重说这句」
 * （触发练习页既有的重录流程，上一条回答保留），练习外（复盘等）是「跟读这个表达」
 * 开 follow 练习并带 source——该练习结束后回到本抽屉（见 notifyPronunciationReturn）。
 * 视觉底座复用阅读域 ReadingDrawer（同一套 .sheet 语义与手势）。
 */
import { useEffect, useRef } from "react";
import { ReadingDrawer } from "../reading/Drawer";
import { Icon } from "../../ui/icons";
import { stopSpeak } from "../../store";
import { speakDemo } from "./demoVoice";

/* 「跟读这个表达」练习（PracticeTask.pronunciationReturn 标记）退出时通知宿主页重开抽屉。 */
const returnListeners = new Set<() => void>();
export function notifyPronunciationReturn(): void { returnListeners.forEach(fn => fn()); }
export function usePronunciationReturn(handler: () => void): void {
  const ref = useRef(handler); ref.current = handler;
  useEffect(() => { const fn = () => ref.current(); returnListeners.add(fn); return () => { returnListeners.delete(fn); }; }, []);
}

export function PronunciationSheet({
  open,
  onClose,
  word,
  sentence,
  phonetic,
  answerLabel,
  onPlayAnswer,
  inPractice,
  onRepeat,
  onFollowExpression,
}: {
  open: boolean;
  onClose: () => void;
  /** 当前目标表达；无词的表达/句子练习传空（标题按原型显示「跟读这句」，句子回到句卡里读）。 */
  word?: string;
  sentence: string;
  /** 生词本里的音标（有则显示）；查不到就不显示，不编造。 */
  phonetic?: string;
  /** 「听我刚才的回答」入口：有可播原声时提供文案与回调。 */
  answerLabel?: string;
  onPlayAnswer?: () => void;
  inPractice: boolean;
  /** 练习内主按钮：回去重说这句（关闭抽屉并进入既有重录流程）。 */
  onRepeat?: () => void;
  /** 练习外主按钮：跟读这个表达（开 follow 练习，结束后回到本抽屉）。 */
  onFollowExpression?: () => void;
}) {
  const hasWord = Boolean(word?.trim());
  /* 开抽屉停掉在播句音；关抽屉停掉抽屉里发起的朗读，避免声音穿透到下层页面。 */
  useEffect(() => { if (open) stopSpeak(); return () => { if (open) stopSpeak(); }; }, [open]);
  if (!hasWord && !sentence.trim()) return null;
  return (
    <ReadingDrawer open={open} onClose={onClose} label="发音要点">
      <div className="sp-sheet-head">
        <span className="v2-sp-overline" style={{ marginBottom: 0 }}>当前表达的发音强化</span>
        <h3 className="v2-sp-pron-word" style={{ margin: "10px 0 0" }}>{hasWord ? word!.trim() : "跟读这句"}</h3>
        {phonetic && <p className="v2-sp-pron-ph">{phonetic}</p>}
      </div>
      <div className="sp-sheet-body">
        <p className="sp-sheet-copy" style={{ marginTop: 0 }}>
          先听词音里的重音，再把表达放回整句里读。照着示范模仿一次，最后用自己的速度重说。
        </p>
        {hasWord && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "4px 0" }}>
            <button className="btn-ghost v2-sp-compact" style={{ flex: 1, minWidth: 108 }} onClick={() => speakDemo(word!)}>
              <Icon name="speaker" size={15} />听词音
            </button>
            <button className="btn-ghost v2-sp-compact" style={{ flex: 1, minWidth: 108 }} onClick={() => speakDemo(word!, 0.55)}>
              <Icon name="wave" size={15} />慢速示范
            </button>
          </div>
        )}
        <div className="v2-sp-pron-sentence">
          <small>回到这句里读</small>
          <p>{sentence}</p>
          <button className="v2-sp-audio-link" onClick={() => speakDemo(sentence)}>
            <Icon name="speaker" size={15} />听整句
          </button>
        </div>
        {answerLabel && onPlayAnswer && (
          <button className="btn-ghost" onClick={onPlayAnswer}>
            <Icon name="speaker" size={15} />{answerLabel}
          </button>
        )}
        {inPractice ? (
          <button className="btn voice" style={{ marginTop: 10 }} onClick={() => { stopSpeak(); onRepeat?.(); }}>
            <Icon name="mic" size={15} />回去重说这句
          </button>
        ) : (
          <button className="btn voice" style={{ marginTop: 10 }} onClick={() => { stopSpeak(); onFollowExpression?.(); }}>
            <Icon name="mic" size={15} />跟读这个表达
          </button>
        )}
      </div>
    </ReadingDrawer>
  );
}
