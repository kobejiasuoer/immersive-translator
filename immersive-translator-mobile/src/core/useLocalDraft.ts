import { useEffect, useState } from "react";
import { activeRepository, commitRepository, useApp, toast } from "../store";

/** Device-only drafts are loaded and saved under the same explicit profile key. */
export function useLocalDraft<T>(id: string, initial: T) {
  useApp(s => s);
  const repository = activeRepository();
  const key = repository.identity + ":" + id;
  const [loaded, setLoaded] = useState<{ key: string; value: T } | null>(null);
  const ready = loaded?.key === key;
  const value = ready ? loaded.value : initial;
  useEffect(() => {
    let alive = true;
    void repository.get<T>("local.drafts", id).then(row => {
      if (!alive || repository !== activeRepository()) return;
      setLoaded({ key, value: row && !row.deleted && row.payload !== null ? row.payload : initial });
    }).catch(error => { if (alive) toast(String(error)); });
    return () => { alive = false; };
  }, [id, key, repository]);
  useEffect(() => {
    if (!ready || repository !== activeRepository()) return;
    void commitRepository({ records: [{ collection: "local.drafts", id, payload: value }] }).catch(error => toast(String(error)));
  }, [id, value, ready, repository]);
  const setValue = (next: T | ((current: T) => T)) => {
    if (!ready || repository !== activeRepository()) return;
    setLoaded(current => current?.key === key ? { key, value: typeof next === "function" ? (next as (current: T) => T)(current.value) : next } : current);
  };
  const clear = () => {
    if (!ready || repository !== activeRepository()) return Promise.reject(new Error("账号已切换，草稿仍在原账号保留"));
    return commitRepository({ records: [{ collection: "local.drafts", id, payload: null, deleted: true }] });
  };
  return [value, setValue, ready, clear] as const;
}
