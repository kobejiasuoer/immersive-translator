/**
 * 讯飞语音凭据 · 集中配置（设置 → 语音）。
 *
 * 三组三元组（APPID / API Key / API Secret），经 DPAPI 加密存储（secret_store），
 * 之前散落在阅读室设置抽屉 / 口语陪练 / 录音直译里，现在统一收口：
 * - 语音评测（ISE）：阅读室跟读评测打分、口语陪练「跟读打分」。
 * - 在线合成（TTS）：阅读室讯飞云音色朗读（与评测是两个应用，凭据分开）。
 * - 流式听写（ASR）：口语陪练「按住说话」与录音直译；留空 = 复用评测（ISE）凭据。
 *
 * 沿用既有的「只写非空字段」部分更新语义；保存成功后广播 `xfyun:creds-updated`，
 * 常驻的阅读室窗口据此刷新云端合成凭据缓存（其余凭据都是用时加载，无需刷新）。
 */

import { useCallback, useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import {
  iseCredsConfigured,
  loadAsrCredentials,
  saveAsrCredentials,
  saveIseCredentials,
  saveXfyunTtsCredentials,
  xfyunTtsCredsConfigured,
} from "../lib/iseCredentials";

type CredKind = "ise" | "tts" | "asr";

/** 单组凭据卡片：状态徽标 + 三段输入 + 保存（部分更新，只写非空项）。 */
function CredsCard({
  kind,
  title,
  statusHint,
  appIdPlaceholder,
  hint,
  configured,
  onSave,
}: {
  kind: CredKind;
  title: string;
  statusHint: string;
  appIdPlaceholder: string;
  hint: string;
  configured: boolean | null;
  onSave: (patch: { appId?: string; apiKey?: string; apiSecret?: string }) => Promise<boolean>;
}) {
  const [appId, setAppId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saving, setSaving] = useState(false);
  /** 本次会话是否保存成功过（再输入即消失）。 */
  const [saved, setSaved] = useState(false);

  const empty = !appId.trim() && !apiKey.trim() && !apiSecret.trim();

  const save = useCallback(async () => {
    if (saving || empty) return;
    setSaving(true);
    try {
      const ok = await onSave({ appId, apiKey, apiSecret });
      if (ok) {
        setAppId("");
        setApiKey("");
        setApiSecret("");
        setSaved(true);
        // 常驻窗口（阅读室等）即时刷新凭据缓存
        void emit("xfyun:creds-updated", { kind }).catch(() => undefined);
      }
    } finally {
      setSaving(false);
    }
  }, [saving, empty, appId, apiKey, apiSecret, onSave, kind]);

  return (
    <div className="group-card">
      <div className="field-block">
        <div className="field-block-head">
          <span className="field-label-v2">{title}</span>
          <span className={`chip ${configured ? "chip-green" : "chip-amber"}`}>
            {configured === null ? "读取中…" : configured ? "已配置" : "未配置"}
          </span>
        </div>
        <p className="field-hint">{statusHint}</p>
        <input
          className="input mono input-full"
          placeholder={appIdPlaceholder}
          value={appId}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setAppId(e.target.value);
            setSaved(false);
          }}
        />
        <input
          className="input mono input-full"
          placeholder="API Key"
          type="password"
          value={apiKey}
          autoComplete="off"
          onChange={(e) => {
            setApiKey(e.target.value);
            setSaved(false);
          }}
        />
        <input
          className="input mono input-full"
          placeholder="API Secret"
          type="password"
          value={apiSecret}
          autoComplete="off"
          onChange={(e) => {
            setApiSecret(e.target.value);
            setSaved(false);
          }}
        />
        <div className="provider-actions">
          <button className="btn btn-primary btn-sm" disabled={saving || empty} onClick={() => void save()}>
            {saving ? "保存中…" : "保存（DPAPI 加密）"}
          </button>
          {saved && (
            <span className="chip chip-green" style={{ alignSelf: "center" }}>
              已保存 ✓
            </span>
          )}
        </div>
        <p className="field-hint">{hint}</p>
      </div>
    </div>
  );
}

export function XfyunVoiceSection() {
  const [iseConfigured, setIseConfigured] = useState<boolean | null>(null);
  const [ttsConfigured, setTtsConfigured] = useState<boolean | null>(null);
  const [asrConfigured, setAsrConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    void iseCredsConfigured()
      .then((ok) => active && setIseConfigured(ok))
      .catch(() => active && setIseConfigured(false));
    void xfyunTtsCredsConfigured()
      .then((ok) => active && setTtsConfigured(ok))
      .catch(() => active && setTtsConfigured(false));
    // ASR 显示「自己那组 + 回落 ISE」的综合可用性（loadAsrCredentials 的回落语义）
    void loadAsrCredentials()
      .then((c) => active && setAsrConfigured(c !== null))
      .catch(() => active && setAsrConfigured(false));
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <CredsCard
        kind="ise"
        title="语音评测（跟读打分）"
        statusHint="跟读模式的「过关判定」和口语陪练的「跟读打分」都用它：讯飞开放平台「语音评测（流式版）」应用的三个值。"
        appIdPlaceholder="APPID（语音评测应用）"
        hint="只填想更新的项，已保存的不会覆盖；评测按次计费，有免费额度。"
        configured={iseConfigured}
        onSave={saveIseCredentials}
      />
      <CredsCard
        kind="tts"
        title="在线合成（云端朗读）"
        statusHint="阅读室「讯飞在线」朗读引擎用：讯飞控制台「在线语音合成」应用的三个值（与语音评测是两个应用，凭据不同）。"
        appIdPlaceholder="APPID（语音合成应用）"
        hint="每日 500 次免费调用；重听走本地缓存不耗额度。"
        configured={ttsConfigured}
        onSave={saveXfyunTtsCredentials}
      />
      <CredsCard
        kind="asr"
        title="流式听写（口语陪练 / 录音直译）"
        statusHint="口语陪练「按住说话」和录音直译的识别用。留空不填 = 复用「语音评测」的凭据（讯飞一个应用可同时开通评测 + 听写），只在识别报「未授权/未开通」时才需要单独填。"
        appIdPlaceholder="APPID（留空复用语音评测）"
        hint="给应用开通「流式听写」服务后的三个值；只填想更新的项。"
        configured={asrConfigured}
        onSave={saveAsrCredentials}
      />
    </>
  );
}
