/**
 * 口语陪练会话存储访问层：包一层 Rust speak_store 命令。
 * 类型与 src/core/speakLogic.ts 一致（contracts/reading-room.schema.json）。
 */

import { invoke } from "@tauri-apps/api/core";
import type { SpeakSession } from "../core/speakLogic";

export function speakListSessions(): Promise<SpeakSession[]> {
  return invoke<SpeakSession[]>("speak_list_sessions");
}

export function speakSaveSession(session: SpeakSession): Promise<SpeakSession> {
  return invoke<SpeakSession>("speak_save_session", { session });
}

export function speakDeleteSession(id: string): Promise<boolean> {
  return invoke<boolean>("speak_delete_session", { id });
}
