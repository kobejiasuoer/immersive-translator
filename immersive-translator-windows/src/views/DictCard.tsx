import {
  IconVolume,
  IconStop,
  IconCopy,
  IconTranslate,
} from "../ui/icons";
import { cardToText, splitByWord, type DictCardData } from "../core/dictCard";

interface DictCardProps {
  card: DictCardData;
  /** 查询原文（用于例句高亮，可能与 card.word 不同）。 */
  query: string;
  /** 是否正在朗读词条。 */
  speaking: boolean;
  onSpeak: () => void;
  onCopy: (text: string, hint: string) => void;
  /** 切换为整句翻译（误判兜底入口）。 */
  onSwitchToTranslate: () => void;
}

/** 词典卡片：词条 + 音标 + 核心释义 + 分义项例句 + 词形/记忆 + 操作行。 */
export function DictCard({
  card,
  query,
  speaking,
  onSpeak,
  onCopy,
  onSwitchToTranslate,
}: DictCardProps) {
  return (
    <div className="dict-card">
      <div className="dict-head">
        <span className="dict-word">{card.word}</span>
        {card.phonetics.map((p, i) => (
          <span key={`${p.label}-${i}`} className="dict-phonetic">
            {p.label && <span className="dict-phonetic-label">{p.label}</span>}
            {p.value}
          </span>
        ))}
        <button
          className={`icon-btn icon-btn-sm${speaking ? " active" : ""}`}
          onClick={onSpeak}
          title={speaking ? "停止朗读" : "朗读词条"}
        >
          {speaking ? <IconStop size={14} /> : <IconVolume size={14} />}
        </button>
      </div>

      {card.translation && <div className="dict-core">{card.translation}</div>}

      {card.senses.length > 0 && (
        <ol className="dict-senses">
          {card.senses.map((sense, i) => (
            <li key={i} className="dict-sense">
              <div className="dict-gloss">
                {sense.pos && <span className="dict-pos">{sense.pos}</span>}
                {sense.gloss}
              </div>
              {sense.examples.map((ex, j) => (
                <div key={j} className="dict-example">
                  <div className="dict-example-s">
                    {splitByWord(ex.s, query || card.word).map((part, k) =>
                      part.hit ? (
                        <mark key={k} className="dict-hl">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={k}>{part.text}</span>
                      ),
                    )}
                  </div>
                  {ex.t && <div className="dict-example-t">{ex.t}</div>}
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}

      {(card.inflections || card.etymology) && (
        <div className="dict-extra">
          {card.inflections && (
            <div>
              <span className="dict-extra-label">词形</span>
              {card.inflections}
            </div>
          )}
          {card.etymology && (
            <div>
              <span className="dict-extra-label">记忆</span>
              {card.etymology}
            </div>
          )}
        </div>
      )}

      <div className="dict-actions">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => onCopy(cardToText(card), "已复制词典卡片")}
          title="复制词条（词 + 释义 + 例句）"
        >
          <IconCopy size={13} />
          复制卡片
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={onSwitchToTranslate}
          title="切回译文视图"
        >
          <IconTranslate size={13} />
          返回译文
        </button>
      </div>
    </div>
  );
}
