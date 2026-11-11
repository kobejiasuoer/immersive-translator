import { useEffect, useRef, useState } from "react";
import { cloudState, subscribeCloud } from "../../services/cloud";
import { activeRepository, type DictEntry } from "../../store";
import { cachedReadingHelp, requestReadingHelp, type ReadingHelpRequest, type ReadingHelpResult } from "../../services/readingHelp";

/** Mounting or selecting text never requests a model; only the explicit button does. */
export function EnglishHelp({ request, dictionary, saved, onResult }: {
  request: ReadingHelpRequest;
  dictionary?: DictEntry;
  saved?: ReadingHelpResult | null;
  onResult?: (result: ReadingHelpResult | null) => void;
}) {
  const sourceKey = JSON.stringify(request);
  const [result, setResult] = useState<ReadingHelpResult | null>(() => saved ?? cachedReadingHelp(request));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const version = ++generation.current;
    controller.current?.abort(); controller.current = null;
    const initial = saved ?? cachedReadingHelp(requestRef.current);
    setResult(initial); setError(""); setLoading(false); onResult?.(initial);
    return () => { if (version === generation.current) generation.current++; controller.current?.abort(); controller.current = null; };
    // A refreshed article object cannot restart or relabel an in-flight request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  useEffect(() => {
    let repository = activeRepository();
    let cloud = cloudState();
    const clearVisible = () => { setResult(null); onResult?.(null); setError(""); };
    // The service decides whether a pending guest login may continue. Clear any
    // completed content immediately when a different account/profile is shown.
    const unsubscribe = subscribeCloud(() => {
      const next = cloudState();
      if (next.generation !== cloud.generation || next.account?.id !== cloud.account?.id) clearVisible();
      cloud = next;
    });
    const profileChanged = () => { if (activeRepository() !== repository) { repository = activeRepository(); clearVisible(); } };
    window.addEventListener("mobile-profile-change", profileChanged);
    return () => { unsubscribe(); window.removeEventListener("mobile-profile-change", profileChanged); };
  }, [onResult]);

  function run() {
    if (controller.current) return;
    const current = new AbortController(), version = ++generation.current;
    controller.current = current;
    setLoading(true); setError("");
    void requestReadingHelp(requestRef.current, current.signal, dictionary).then(value => {
      if (current.signal.aborted || version !== generation.current) return;
      setResult(value); onResult?.(value);
    }).catch(cause => {
      if (current.signal.aborted || version !== generation.current) return;
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (controller.current === current) controller.current = null;
      if (version === generation.current) setLoading(false);
    });
  }

  return <section className="reader-english-help" aria-label={request.kind === "word" ? "英文语境解释" : "简明英文改述"}>
    {result ? <>
      <p className="reader-english-meaning" lang="en">{result.meaning}</p>
      {result.example && <p className="reader-english-example" lang="en">{result.example}</p>}
    </> : <>
      <button className="reader-english-request" disabled={loading} onClick={run}>
        {loading ? "正在用英文解释…" : error ? "重试英文解释" : request.kind === "word" ? "用英文解释这里的用法" : "用简单英文解释"}
      </button>
      {loading && <span className="sheet-note" role="status">解释完成后会显示在这里。</span>}
      {error && <p className="sheet-note" role="alert">{error}</p>}
    </>}
  </section>;
}
