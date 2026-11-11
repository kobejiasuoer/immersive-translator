import { useEffect, useRef, useState, type ReactNode } from "react";
import { useCloud } from "../services/cloud";
import { useSyncStatus } from "../services/sync";
import { openAccountSheet } from "../components/account/accountGate";
import { Icon } from "./icons";

/** Large title at rest; a compact title keeps the section identifiable while scrolling.
 * This is a WebView navigation header, not a UIKit UINavigationBar. */
export function Heading({ title, subtitle, extra }: { title: string; subtitle?: string; extra?: ReactNode }) {
  const header = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const { account } = useCloud();
  const sync = useSyncStatus();
  const state = !account ? "local" : sync.phase;
  const label = !account ? "本机试用" : state === "syncing" ? "正在同步" : state === "offline" || state === "error" ? "待同步" : "已同步";
  const letter = account ? (account.nickname || account.email || "I").trim().slice(0, 1).toUpperCase() : null;
  useEffect(() => {
    const scroller = header.current?.parentElement?.querySelector<HTMLElement>(".learning-body");
    if (!scroller) return;
    // Hysteresis avoids toggling when the header changes the viewport's height.
    const update = () => setCompact(value => scroller.scrollTop > 52 ? true : scroller.scrollTop < 4 ? false : value);
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, []);
  return <header ref={header} className={`product-heading${compact ? " is-compact" : ""}`}>
    <div className="product-navigation-row">
      <span className="product-inline-title" aria-hidden="true">{title}</span>
      <div className="product-heading-actions">
        {extra}
        <button className="account-entry" aria-label="账号与设置" title={label} onClick={openAccountSheet}>
          <span className="product-avatar">{letter || <Icon name="me" size={22} />}<i data-sync={state} aria-hidden="true"/></span>
          <span className="sr-only">{label}</span>
        </button>
      </div>
    </div>
    <div className="product-heading-copy"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
  </header>;
}
