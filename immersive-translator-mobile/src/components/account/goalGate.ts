/**
 * 学习方向页开关（account-onboarding-parity）：目标三选一从首启页拆出为独立 goal 页，
 * 由 App 常驻渲染 GoalSheetHost。沿用 loginIntent 的「来源快照」模式：
 * 打开时记下来源（onboarding / login / account），收尾按来源恢复来路——
 * 首启与新账号登录后落在今天页，账号页进入则关闭即回账号页。
 */
import { useSyncExternalStore } from "react";

export type GoalSource = "onboarding" | "login" | "account";
let source: GoalSource | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());
export function openGoal(next: GoalSource): void { if (source === next) return; source = next; emit(); }
export function closeGoal(): void { if (!source) return; source = null; emit(); }
export function goalSource(): GoalSource | null { return source; }
export function useGoalSource(): GoalSource | null {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, goalSource);
}
