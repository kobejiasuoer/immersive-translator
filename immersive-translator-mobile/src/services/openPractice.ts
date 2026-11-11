import { actions, activeRepository, toast } from "../store";
import { createPracticeTask } from "./practice";
import type { useNav } from "../ui/nav";

export async function openPractice(nav: ReturnType<typeof useNav>, input: Parameters<typeof createPracticeTask>[0], options: { replace?: boolean } = {}) {
  const target = activeRepository();
  try {
    const task = createPracticeTask(input);
    await actions.upsertTask(task);
    if (target !== activeRepository()) throw new Error("账号已切换，练习保存在原账号。");
    /* replace：复盘页「同一主题，再练一轮」顶替当前练习页，不叠栈（speaking-parity）。 */
    if (options.replace) nav.replace("learningPractice", { taskId: task.id });
    else nav.push("learningPractice", { taskId: task.id });
  } catch (error) { toast(error instanceof Error ? error.message : String(error)); }
}
