/**
 * 屏 B · 阅读设置抽屉：右侧 380px 全高，背后 32% 黑遮罩。
 * 四组归口（§6）：版式 / 词块 / 朗读 / 主题；底部 恢复默认 · 完成。
 * 职责划分：视图菜单管「显示什么」（瞬时），这里管「怎么显示」（持久）。
 */

import { useEffect, useState } from "react";
import {
  DEFAULT_READER_SETTINGS,
  READER_ASSESS_SILENCE_MAX,
  READER_ASSESS_SILENCE_MIN,
  READER_FONT_SIZE_MAX,
  READER_FONT_SIZE_MIN,
  READER_RATE_MAX,
  READER_RATE_MIN,
  REVIEW_MODE_LABELS,
  type ArticleChunkState,
  type ContrastMode,
  type ReaderFontPair,
  type ReaderSettings,
  type ReaderTheme,
  type ReviewModeSetting,
} from "../core/readerTypes";
import { ttsVoices, openSettings, type TtsVoiceInfo } from "../lib/tauriBridge";
import { listMicDevices } from "../core/micRecorder";
import { iseCredsConfigured, xfyunTtsCredsConfigured } from "../lib/iseCredentials";
import {
  DEFAULT_TTS_VCN,
  DEFAULT_TTS_VCN_EN,
  XFUYUN_TTS_VOICE_SUGGESTIONS,
} from "../core/xfyunTts";
import {
  DEFAULT_EDGE_VOICE,
  DEFAULT_EDGE_VOICE_EN,
  EDGE_TTS_VOICE_SUGGESTIONS,
} from "../core/edgeTts";
import {
  reminderGetConfig,
  reminderSetConfig,
  type ReminderConfig,
} from "../lib/reminder";

interface Props {
  settings: ReaderSettings;
  onPatch: (patch: Partial<ReaderSettings>) => void;
  onReset: () => void;
  onClose: () => void;
  /** 当前文章的词块标注状态；无打开文章时不显示「重新标注」。 */
  chunkState?: ArticleChunkState;
  /** 重新标注当前文章（清空词块后重跑 LLM 标注）。 */
  onReannotate?: () => void;
  /** 复习模式修改：只进全局默认，不写文章覆盖（缺省时退回 onPatch）。 */
  onPatchReview?: (patch: Partial<ReaderSettings>) => void;
  /** 跟读评测麦克风设备 id（机器本地偏好，空串 = 系统默认）。 */
  micDeviceId: string;
  onMicDevice: (deviceId: string) => void;
  /** 讯飞合成凭据保存成功后回调（ReaderApp 重查就绪状态）。 */
  onXfyunTtsCredsSaved?: () => void;
}

const CONTRAST_OPTIONS: { value: ContrastMode; label: string }[] = [
  { value: "en", label: "仅英文" },
  { value: "dual", label: "对照" },
  { value: "zh", label: "仅中文" },
];

const FONT_OPTIONS: { value: ReaderFontPair; label: string }[] = [
  { value: "serif", label: "衬线（宋体 + Source Serif）" },
  { value: "sans", label: "无衬线（黑体 + Inter）" },
];

const THEMES: { value: ReaderTheme; label: string; swatch: string; text: string }[] = [
  { value: "light", label: "浅色", swatch: "#f4f5f9", text: "#1c2029" },
  { value: "dark", label: "深色", swatch: "#1d1f26", text: "#edeef4" },
  { value: "sepia", label: "护眼", swatch: "#f5efdf", text: "#5a5138" },
  { value: "oled", label: "纯黑", swatch: "#0a0a0b", text: "#b9bdc9" },
];

export function SettingsDrawer({ settings, onPatch, onReset, onClose, chunkState, onReannotate, onPatchReview, micDeviceId, onMicDevice }: Props) {
  const [voices, setVoices] = useState<TtsVoiceInfo[]>([]);
  const [rem, setRem] = useState<ReminderConfig | null>(null);
  const [micDevices, setMicDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [credConfigured, setCredConfigured] = useState<boolean | null>(null);
  const [ttsConfigured, setTtsConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    ttsVoices()
      .then((list) => {
        if (active) setVoices(list);
      })
      .catch((error) => console.error("[reader] list voices failed", error));
    reminderGetConfig()
      .then((config) => {
        if (active) setRem(config);
      })
      .catch((error) => console.error("[reader] load reminder config failed", error));
    listMicDevices()
      .then((list) => {
        if (active) setMicDevices(list);
      })
      .catch(() => undefined);
    iseCredsConfigured()
      .then((ok) => {
        if (active) setCredConfigured(ok);
      })
      .catch(() => {
        if (active) setCredConfigured(false);
      });
    xfyunTtsCredsConfigured()
      .then((ok) => {
        if (active) setTtsConfigured(ok);
      })
      .catch(() => {
        if (active) setTtsConfigured(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function patchReminder(patch: Partial<ReminderConfig>) {
    setRem((cur) => {
      if (!cur) return cur;
      const next = { ...cur, ...patch };
      void reminderSetConfig(next).catch((error) =>
        console.error("[reader] save reminder config failed", error),
      );
      return next;
    });
  }

  function fmtMinute(min: number): string {
    const h = Math.floor(min / 60) % 24;
    const m = min % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  return (
    <>
      <div className="reader-drawer-overlay" onClick={onClose} />
      <aside className="reader-drawer" role="dialog" aria-label="阅读设置">
        <div className="reader-drawer-header">
          <span className="title">阅读设置</span>
          <button className="reader-tb-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="reader-drawer-body">
          <div className="drawer-group-title">版式</div>
          <div className="drawer-row">
            <span className="label">对照模式</span>
            <div className="control">
              <div className="seg">
                {CONTRAST_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    className={settings.contrastMode === o.value ? "active" : ""}
                    onClick={() => onPatch({ contrastMode: o.value })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="drawer-row" title="盖住译文自测：点单句揭开，再点遮住；按住 H 临时全显。开关也出现在播放条的「视图」菜单里">
            <span className="label">译文遮罩</span>
            <div className="control">
              <button
                className={`reader-switch${settings.maskTranslation ? " on" : ""}`}
                onClick={() => onPatch({ maskTranslation: !settings.maskTranslation })}
                role="switch"
                aria-checked={settings.maskTranslation}
                aria-label="译文遮罩"
              />
          </div>
          </div>
          <div className="drawer-row">
            <span className="label">遮罩样式</span>
            <div className="control">
              <div className="seg" title="译文遮罩的隐藏样式；未开启遮罩时选样式会同时把遮罩打开">
                <button
                  className={settings.maskStyle === "blank" ? "active" : ""}
                  onClick={() => onPatch({ maskStyle: "blank", ...(settings.maskTranslation ? {} : { maskTranslation: true }) })}
                >
                  留白显影
                </button>
                <button
                  className={settings.maskStyle === "frost" ? "active" : ""}
                  onClick={() => onPatch({ maskStyle: "frost", ...(settings.maskTranslation ? {} : { maskTranslation: true }) })}
                >
                  毛玻璃
                </button>
              </div>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">正文字号</span>
            <div className="control">
              <div className="drawer-stepper">
                <button
                  onClick={() => onPatch({ fontSize: Math.max(READER_FONT_SIZE_MIN, settings.fontSize - 1) })}
                  disabled={settings.fontSize <= READER_FONT_SIZE_MIN}
                  aria-label="减小字号"
                >
                  −
                </button>
                <span className="val">{settings.fontSize}</span>
                <button
                  onClick={() => onPatch({ fontSize: Math.min(READER_FONT_SIZE_MAX, settings.fontSize + 1) })}
                  disabled={settings.fontSize >= READER_FONT_SIZE_MAX}
                  aria-label="增大字号"
                >
                  +
                </button>
              </div>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">行距</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={1}
                max={2}
                step={0.05}
                value={settings.lineHeight}
                onChange={(e) => onPatch({ lineHeight: Number(e.target.value) })}
                aria-label="行距"
              />
              <span className="drawer-slider-val">{settings.lineHeight.toFixed(2)}×</span>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">正文字体</span>
            <div className="control">
              <select
                className="reader-select"
                value={settings.fontPair}
                onChange={(e) => onPatch({ fontPair: e.target.value as ReaderFontPair })}
                aria-label="正文字体"
              >
                {FONT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="drawer-group-title">词块</div>
          <div
            className="drawer-row"
            title="新文章翻译完成后自动标注值得学的词组（会额外消耗接口 token），正文里以蓝色虚线下划线显示，点击看释义并可收藏"
          >
            <span className="label">自动标注词组</span>
            <div className="control">
              <button
                className={`reader-switch${settings.chunkHighlight ? " on" : ""}`}
                onClick={() => onPatch({ chunkHighlight: !settings.chunkHighlight })}
                role="switch"
                aria-checked={settings.chunkHighlight}
                aria-label="自动标注词组"
              />
            </div>
          </div>
          <div className="drawer-row" title="已收藏的词/词块在正文再次出现时用绿色点线标记，点击可查看">
            <span className="label">生词再现标记</span>
            <div className="control">
              <button
                className={`reader-switch${settings.showVocabMarks ? " on" : ""}`}
                onClick={() => onPatch({ showVocabMarks: !settings.showVocabMarks })}
                role="switch"
                aria-checked={settings.showVocabMarks}
                aria-label="生词再现标记"
              />
            </div>
          </div>
          {chunkState && onReannotate && (
            <div className="drawer-row" title="清空本篇已有标注，重新跑一遍词组标注">
              <span className="label">重新标注本篇</span>
              <div className="control">
                <button className="btn btn-secondary btn-sm" onClick={onReannotate}>
                  重新标注
                </button>
              </div>
            </div>
          )}

          <div className="drawer-group-title">复习</div>
          <div
            className="drawer-row"
            title="产出式复习：智能混合按卡自动选择（词块→完形 · 熟词→听写 · 新词→识别）；完形=原句挖空打字，听写=听整句写整句"
          >
            <span className="label">复习模式</span>
            <div className="control">
              <div className="seg">
                {(Object.keys(REVIEW_MODE_LABELS) as ReviewModeSetting[]).map((m) => (
                  <button
                    key={m}
                    className={settings.reviewMode === m ? "active" : ""}
                    onClick={() => (onPatchReview ?? onPatch)({ reviewMode: m })}
                  >
                    {REVIEW_MODE_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="drawer-group-title">提醒</div>
          <div
            className="drawer-row"
            title="到点弹系统级提醒卡（每天最多一次）；到期数同时显示在托盘图标角标上"
          >
            <span className="label">每日复习提醒</span>
            <div className="control">
              <button
                className={`reader-switch${(rem?.enabled ?? true) ? " on" : ""}`}
                onClick={() => patchReminder({ enabled: !(rem?.enabled ?? true) })}
                role="switch"
                aria-checked={rem?.enabled ?? true}
                aria-label="每日复习提醒"
              />
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">提醒时间</span>
            <div className="control">
              <div className="drawer-stepper">
                <button
                  onClick={() => rem && patchReminder({ minuteOfDay: Math.max(6 * 60, rem.minuteOfDay - 30) })}
                  disabled={!rem || rem.minuteOfDay <= 6 * 60}
                  aria-label="提早半小时"
                >
                  −
                </button>
                <span className="val">{rem ? fmtMinute(rem.minuteOfDay) : "--:--"}</span>
                <button
                  onClick={() => rem && patchReminder({ minuteOfDay: Math.min(23 * 60 + 30, rem.minuteOfDay + 30) })}
                  disabled={!rem || rem.minuteOfDay >= 23 * 60 + 30}
                  aria-label="推后半半小时"
                >
                  +
                </button>
              </div>
            </div>
          </div>
          <div className="drawer-row" title="此时间段内不弹提醒，只保留托盘角标">
            <span className="label">免打扰</span>
            <div className="control">
              <button
                className={`reader-switch${(rem?.dndEnabled ?? true) ? " on" : ""}`}
                onClick={() => patchReminder({ dndEnabled: !(rem?.dndEnabled ?? true) })}
                role="switch"
                aria-checked={rem?.dndEnabled ?? true}
                aria-label="免打扰"
              />
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">免打扰时段</span>
            <div className="control drawer-static">23:00 – 08:00</div>
          </div>
          <div className="drawer-row" title="每日阅读目标（复习目标 = 清空到期，随词量自动变）">
            <span className="label">每日目标 · 阅读</span>
            <div className="control">
              <div className="drawer-stepper">
                <button
                  onClick={() => rem && patchReminder({ readGoalMin: Math.max(5, rem.readGoalMin - 5) })}
                  disabled={!rem || rem.readGoalMin <= 5}
                  aria-label="减少 5 分钟"
                >
                  −
                </button>
                <span className="val">{rem ? `${rem.readGoalMin} 分钟` : "--"}</span>
                <button
                  onClick={() => rem && patchReminder({ readGoalMin: Math.min(60, rem.readGoalMin + 5) })}
                  disabled={!rem || rem.readGoalMin >= 60}
                  aria-label="增加 5 分钟"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          <div className="drawer-group-title">朗读</div>
          <div className="drawer-row" title="Edge 在线 = 微软神经音色（免费、无需凭据，默认）；讯飞在线 = 云音色需凭据；本地 = Windows 系统 SAPI（离线可用）">
            <span className="label">朗读引擎</span>
            <div className="control">
              <div className="seg">
                <button
                  className={settings.ttsProvider === "edge" ? "active" : ""}
                  onClick={() => onPatch({ ttsProvider: "edge" })}
                >
                  Edge 在线
                </button>
                <button
                  className={settings.ttsProvider === "xfyun" ? "active" : ""}
                  onClick={() => onPatch({ ttsProvider: "xfyun" })}
                >
                  讯飞在线
                </button>
                <button
                  className={settings.ttsProvider === "local" ? "active" : ""}
                  onClick={() => onPatch({ ttsProvider: "local" })}
                >
                  本地系统
                </button>
              </div>
            </div>
          </div>
          {settings.ttsProvider === "edge" && (
            <>
              <div className="drawer-row" title="Edge 中文句音色（微软神经音色 ShortName）；留空 = 晓晓。已播句子进缓存（内存+磁盘），重听不再请求网络">
                <span className="label">Edge音色·中文</span>
                <div className="control" style={{ flex: 1 }}>
                  <input
                    className="reader-cred-input"
                    style={{ flex: 1, width: "auto" }}
                    list="edge-voice-list"
                    placeholder={DEFAULT_EDGE_VOICE}
                    value={settings.edgeVoiceZh}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => onPatch({ edgeVoiceZh: e.target.value.trim() })}
                    aria-label="Edge 云音色（中文）"
                  />
                </div>
              </div>
              <div className="drawer-row" title="Edge 英文句音色；留空 = Ava（女声，自然）。男声推荐 AndrewNeural">
                <span className="label">Edge音色·英文</span>
                <div className="control" style={{ flex: 1 }}>
                  <input
                    className="reader-cred-input"
                    style={{ flex: 1, width: "auto" }}
                    list="edge-voice-list"
                    placeholder={DEFAULT_EDGE_VOICE_EN}
                    value={settings.edgeVoiceEn}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => onPatch({ edgeVoiceEn: e.target.value.trim() })}
                    aria-label="Edge 云音色（英文）"
                  />
                  <datalist id="edge-voice-list">
                    {EDGE_TTS_VOICE_SUGGESTIONS.map((v) => (
                      <option key={v.voice} value={v.voice}>
                        {v.label}
                      </option>
                    ))}
                  </datalist>
                </div>
              </div>
              <div className="drawer-row" title="Edge 在线合成为微软「大声朗读」同源服务，免费且无需账号；属非官方接口，偶发不可用时切回本地系统或讯飞">
                <span className="label">服务说明</span>
                <div className="control drawer-static" style={{ flex: 1, justifyContent: "flex-end" }}>
                  免费 · 无需凭据 · 需联网
                </div>
              </div>
            </>
          )}
          {settings.ttsProvider === "xfyun" && (
            <>
              <div className="drawer-row" title="讯飞中文发音人（vcn）：中文句用它读；完整列表在讯飞控制台「语音合成」可试听，未授权音色会提示 11200。已播句子进缓存（内存+磁盘），重听不耗每日次数">
                <span className="label">云音色·中文</span>
                <div className="control" style={{ flex: 1 }}>
                  <input
                    className="reader-cred-input"
                    style={{ flex: 1, width: "auto" }}
                    list="xfyun-vcn-list"
                    placeholder={DEFAULT_TTS_VCN}
                    value={settings.cloudVoice}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => onPatch({ cloudVoice: e.target.value.trim() })}
                    aria-label="讯飞云音色（中文）"
                  />
                </div>
              </div>
              <div className="drawer-row" title="讯飞英文发音人（vcn）：英文句用它读，跟读示范不再由中文音色代劳；留空沿用中文音色">
                <span className="label">云音色·英文</span>
                <div className="control" style={{ flex: 1 }}>
                  <input
                    className="reader-cred-input"
                    style={{ flex: 1, width: "auto" }}
                    list="xfyun-vcn-list"
                    placeholder={DEFAULT_TTS_VCN_EN}
                    value={settings.cloudVoiceEn}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => onPatch({ cloudVoiceEn: e.target.value.trim() })}
                    aria-label="讯飞云音色（英文）"
                  />
                  <datalist id="xfyun-vcn-list">
                    {XFUYUN_TTS_VOICE_SUGGESTIONS.map((v) => (
                      <option key={v.vcn} value={v.vcn}>
                        {v.label}
                      </option>
                    ))}
                  </datalist>
                </div>
              </div>
              <div className="drawer-row" title="讯飞凭据（评测/合成/听写）在主窗口 设置 → 语音 里集中配置">
                <span className="label">合成凭据</span>
                <div className="control" style={{ flex: 1, justifyContent: "flex-end", gap: 8 }}>
                  <span className={`cred-state${ttsConfigured ? " ok" : ""}`}>
                    {ttsConfigured === null ? "" : ttsConfigured ? "已配置 ✓" : "未配置"}
                  </span>
                  <button
                    className="reader-tb-btn"
                    onClick={() => void openSettings().catch(() => undefined)}
                    title="打开总设置 → 语音"
                  >
                    设置
                  </button>
                </div>
              </div>
            </>
          )}
          <div className="drawer-row">
            <span className="label">本地音色</span>
            <div className="control">
              <select
                className="reader-select"
                value={settings.voice}
                disabled={settings.ttsProvider !== "local"}
                onChange={(e) => onPatch({ voice: e.target.value })}
                aria-label="本地朗读音色"
              >
                <option value="">系统默认</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">语速</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={READER_RATE_MIN}
                max={READER_RATE_MAX}
                step={0.05}
                value={settings.rate}
                onChange={(e) => onPatch({ rate: Number(e.target.value) })}
                aria-label="语速"
              />
              <span className="drawer-slider-val">{settings.rate.toFixed(2)}×</span>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">每句停顿</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={0}
                max={2000}
                step={100}
                value={settings.sentencePauseMs}
                onChange={(e) => onPatch({ sentencePauseMs: Number(e.target.value) })}
                aria-label="每句停顿"
              />
              <span className="drawer-slider-val">{(settings.sentencePauseMs / 1000).toFixed(1)}s</span>
            </div>
          </div>
          <div className="drawer-row">
            <span className="label">跟读模式</span>
            <div className="control">
              <button
                className={`reader-switch${settings.shadowingMode ? " on" : ""}`}
                onClick={() => onPatch({ shadowingMode: !settings.shadowingMode })}
                role="switch"
                aria-checked={settings.shadowingMode}
                aria-label="跟读模式"
              />
            </div>
          </div>
          <div
            className="drawer-row"
            title="读完一句后自动开麦听你跟读，送讯飞语音评测打分：达标自动过，不达标卡住可「领读」示范。需要先在 设置 → 语音 里填评测凭据"
          >
            <span className="label">跟读评测</span>
            <div className="control">
              <button
                className={`reader-switch${settings.shadowingAssess ? " on" : ""}`}
                disabled={!settings.shadowingMode}
                onClick={() => onPatch({ shadowingAssess: !settings.shadowingAssess })}
                role="switch"
                aria-checked={settings.shadowingAssess}
                aria-label="跟读评测"
              />
            </div>
          </div>
          <div className="drawer-row" title="句分达到阈值才放行（满分 5 分）">
            <span className="label">过关阈值</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={3}
                max={5}
                step={0.1}
                value={settings.shadowingPassScore}
                disabled={!settings.shadowingAssess}
                onChange={(e) => onPatch({ shadowingPassScore: Number(e.target.value) })}
                aria-label="跟读过关阈值"
              />
              <span className="drawer-slider-val">
                {Math.round(settings.shadowingPassScore * 20)} 分（{settings.shadowingPassScore.toFixed(1)}/5）
              </span>
            </div>
          </div>
          <div className="drawer-row" title="开 = 本句读完自动开麦录音；关 = 出「开口跟读」按钮，点了才录">
            <span className="label">读完自动开麦</span>
            <div className="control">
              <button
                className={`reader-switch${settings.shadowingAutoMic ? " on" : ""}`}
                disabled={!settings.shadowingAssess}
                onClick={() => onPatch({ shadowingAutoMic: !settings.shadowingAutoMic })}
                role="switch"
                aria-checked={settings.shadowingAutoMic}
                aria-label="读完自动开麦"
              />
            </div>
          </div>
          <div className="drawer-row" title="说话停顿超过该时长即视为读完，自动送评测">
            <span className="label">静音断句</span>
            <div className="control" style={{ flex: 1 }}>
              <input
                type="range"
                className="drawer-slider"
                min={READER_ASSESS_SILENCE_MIN / 1000}
                max={READER_ASSESS_SILENCE_MAX / 1000}
                step={0.1}
                value={settings.shadowingSilenceMs / 1000}
                disabled={!settings.shadowingAssess}
                onChange={(e) =>
                  onPatch({ shadowingSilenceMs: Math.round(Number(e.target.value) * 1000) })
                }
                aria-label="静音断句时长"
              />
              <span className="drawer-slider-val">
                {(settings.shadowingSilenceMs / 1000).toFixed(1)}s
              </span>
            </div>
          </div>
          <div className="drawer-row" title="跟读录音用的麦克风；录不出声音时优先换一个（默认可能选到虚拟声卡）">
            <span className="label">麦克风</span>
            <div className="control">
              <select
                className="reader-select"
                value={micDeviceId}
                onChange={(e) => onMicDevice(e.target.value)}
                aria-label="跟读麦克风"
              >
                <option value="">系统默认</option>
                {micDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {settings.shadowingMode && (
            <div className="drawer-row" title="讯飞评测凭据在主窗口 设置 → 语音 里集中配置；过关判定与跟读打分都用它">
              <span className="label">评测凭据</span>
              <div className="control" style={{ flex: 1, justifyContent: "flex-end", gap: 8 }}>
                <span className={`cred-state${credConfigured ? " ok" : ""}`}>
                  {credConfigured === null ? "" : credConfigured ? "已配置 ✓" : "未配置"}
                </span>
                <button
                  className="reader-tb-btn"
                  onClick={() => void openSettings().catch(() => undefined)}
                  title="打开总设置 → 语音"
                >
                  设置
                </button>
              </div>
            </div>
          )}

          <div className="drawer-group-title">主题</div>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button
                key={t.value}
                className={`theme-swatch${settings.theme === t.value ? " active" : ""}`}
                onClick={() => onPatch({ theme: t.value })}
                aria-label={`主题：${t.label}`}
              >
                <i style={{ background: t.swatch }} aria-hidden />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="reader-drawer-footer">
          <button className="btn btn-ghost" onClick={onReset}>
            恢复默认
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </aside>
    </>
  );
}

export { DEFAULT_READER_SETTINGS };
