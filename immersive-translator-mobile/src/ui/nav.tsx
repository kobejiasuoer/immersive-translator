/**
 * push 导航上下文 —— App 持有栈，屏幕只声明去向（§2.2 导航层级）。
 */
import { createContext, useContext } from "react";

export type PushName =
  | "reader"
  | "review"
  | "quick"
  | "translate"
  | "camera"
  | "scenes"
  | "chat"
  | "shadow"
  | "caption"
  | "notes"
  | "noteslib"
  | "notedetail"
  | "history"
  | "glossary"
  | "diag"
  | "about"
  | "setModel"
  | "setPref"
  | "setVoice"
  | "setRemind"
  | "setLook"
  | "onboarding"
  | "share"
  | "spike";

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
