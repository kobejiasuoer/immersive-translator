/**
 * 账号抽屉开关（proto-parity-2026-11-01，对照原型 SHEETS.account）：
 * 原型中账号面板是根页页头呼出的底部抽屉（sh-head「账号与学习设置」+ 抓手 + ×），
 * 不是推入页——此前 nav.push("account") 的整页形态按原型改为抽屉。
 * 沿用 goalGate 的「来源快照」外部 store 模式：openAccountSheet 打开、closeAccount 关闭。
 * 抽屉内的子抽屉（同步规则/隐私/退出确认）与学习方向推入页各自持有更高 zIndex，
 * 关闭学习方向页后本抽屉仍在原位（对齐原型多抽屉叠加）。
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
export function openAccountSheet(): void { if (open) return; open = true; emit(); }
export function closeAccount(): void { if (!open) return; open = false; emit(); }
export function accountOpen(): boolean { return open; }
export function useAccountOpen(): boolean {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, accountOpen);
}
