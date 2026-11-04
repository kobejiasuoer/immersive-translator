/**
 * push 导航上下文 —— App 持有栈，屏幕只声明去向（§2.2 导航层级）。
 */
import { createContext, useContext } from "react";

/* visual-theme-cleanup 死代码收窄：translate/camera/scenes/chat/shadow/caption/about/share
   随旧 spike 屏一并删除；noteslib/notedetail 保留（NotesGen 存库跳转 / NotesLib 行点击是活引用）。
   proto-parity-2026-11-01：account 撤出 push 栈——原型 SHEETS.account 是根页呼出的底部抽屉
   （components/account/accountGate），不再是推入页路由。 */
export type PushName =
  | "learningPractice" | "learningImport" | "learningWord" | "learningNote" | "learningSearch"
  | "learningLibrary" | "learningFeeds" | "learningWordbook"
  | "reader"
  | "review"
  | "quick"
  | "notes"
  | "noteslib"
  | "notedetail"
  | "history"
  | "glossary"
  | "diag"
  | "setModel"
  | "setPref"
  | "setVoice"
  | "setRemind"
  | "setLook"
  | "onboarding";

export type PushProps = Record<string, unknown>;

export interface Nav {
  push: (name: PushName, props?: PushProps) => void;
  pop: () => void;
  popAll: () => void;
  /** 顶替当前页（拍译 → 翻译结果等跳转，不叠栈） */
  replace: (name: PushName, props?: PushProps) => void;
}

export const NavCtx = createContext<Nav>({ push: () => {}, pop: () => {}, popAll: () => {}, replace: () => {} });
export const useNav = () => useContext(NavCtx);
