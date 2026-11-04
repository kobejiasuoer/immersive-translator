/**
 * 「我对这个词的感觉」自评读取（复检 r1 · vault）：自评仍只存在设备本地 local.vocabFeel
 * （与词条详情 chips 同一份记录，不进同步载荷）；统计三格 / 阶段筛选 / 列表 tag 通过本 hook
 * 读到同一份自评，使原型 w.stage 口径（自评即阶段）在各处一致。
 * 自评写入后由写入方派发 FEEL_EVENT，本 hook 重读；账号切换（vocab 整体替换）时也重读。
 */
import { useEffect, useState } from "react";
import { activeRepository, profileIdentity, useApp } from "../../store";
import { FEEL_KEYS, type Feel } from "./derive";

export const FEEL_EVENT = "mobile-vocab-feel-change";

export function useVocabFeels(): Map<string, Feel> {
  const vocab = useApp((s) => s.vocab);
  const [feels, setFeels] = useState<Map<string, Feel>>(() => new Map());
  useEffect(() => {
    let alive = true;
    const load = () => {
      let identity = "";
      try {
        identity = profileIdentity();
      } catch {
        return;
      }
      void activeRepository()
        .list<{ feel?: Feel }>("local.vocabFeel")
        .then((rows) => {
          if (!alive || identity !== profileIdentity()) return;
          const next = new Map<string, Feel>();
          for (const row of rows) {
            const feel = row.payload?.feel;
            if (!row.deleted && feel && FEEL_KEYS.includes(feel)) next.set(row.id, feel);
          }
          setFeels(next);
        })
        .catch(() => undefined);
    };
    load();
    window.addEventListener(FEEL_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(FEEL_EVENT, load);
    };
  }, [vocab]);
  return feels;
}
