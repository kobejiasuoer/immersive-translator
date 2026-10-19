/**
 * v3 共用 UI 件：push 导航、分段、开关、进度墨线、左滑行、按住手势。
 * 形态均对齐 prototypes/mobile-v3-2026-09-24.html。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";
import { haptic } from "../services/device";

/* ---------- push 顶栏 ---------- */
export function PNav({
  title,
  onBack,
  left,
  right,
}: {
  title: string;
  onBack?: () => void;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="pnav">
      <div className="side l">
        {onBack ? (
          <button className="iconbtn" aria-label="返回" onClick={onBack}>
            <Icon name="left" size={20} />
          </button>
        ) : (
          left
        )}
      </div>
      <div className="ttl">{title}</div>
      <div className="side">{right}</div>
    </div>
  );
}

/* ---------- 分段控件 ---------- */
export function Seg<V extends string>({
  value,
  items,
  onChange,
  className,
}: {
  value: V;
  items: [V, string][];
  onChange: (v: V) => void;
  className?: string;
}) {
  return (
    <div className={`seg ${className || ""}`}>
      {items.map(([v, label]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/* ---------- iOS 开关（on = 墨蓝，§1.3） ---------- */
export function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      className={`switch ${on ? "on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={onToggle}
    >
      <i />
    </button>
  );
}

/* ---------- 进度墨线 ---------- */
export function Meter({ pct }: { pct: number }) {
  return (
    <div className="meter">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/* ---------- 左滑删除行（撤销 toast 5s，评审要点 7②） ---------- */
export function SwipeRow({
  children,
  onDelete,
  innerClass = "swipe-main",
}: {
  children: ReactNode;
  onDelete: () => void;
  innerClass?: "swipe-main" | "vmain";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const st = useRef({ startX: 0, startY: 0, dx: 0, dragging: false, moved: false });
  const [drag, setDrag] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function down(e: PointerEvent) {
      const s = st.current;
      s.startX = e.clientX;
      s.startY = e.clientY;
      s.dx = 0;
      s.dragging = true;
      s.moved = false;
      el?.classList.add("drag");
    }
    function move(e: PointerEvent) {
      const s = st.current;
      if (!s.dragging) return;
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      if (Math.abs(dy) > Math.abs(dx) + 8) {
        cleanup();
        return;
      }
      s.dx = Math.max(-88, Math.min(0, dx));
      s.moved = s.moved || Math.abs(dx) > 10;
      setDrag(s.dx);
    }
    function up() {
      const s = st.current;
      if (!s.dragging) return;
      el?.classList.remove("drag");
      s.dragging = false;
      if (s.dx < -48) {
        setOpen(true);
        setDrag(-76);
      } else {
        setOpen(false);
        setDrag(0);
      }
      if (s.moved) {
        /* 滑动过则吞掉随后的 click，避免误触打开 */
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        el?.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => el?.removeEventListener("click", swallow, { capture: true }), 120);
      }
    }
    function cleanup() {
      const s = st.current;
      s.dragging = false;
      el?.classList.remove("drag");
      setDrag(0);
    }
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const transform = drag === null ? (open ? "translateX(-76px)" : "translateX(0px)") : `translateX(${drag}px)`;
  return (
    <div className="swipe-row">
      <button
        className="swipe-act"
        onClick={() => {
          haptic("light");
          onDelete();
        }}
      >
        删除
      </button>
      <div ref={ref} style={{ transform }} className={innerClass}>
        {children}
      </div>
    </div>
  );
}

/* ---------- 按住说话（pointerup/cancel 挂 document，§6.1） ---------- */
export function useHold(onStart: () => void, onEnd: (ms: number) => void) {
  const st = useRef({ start: 0, holding: false });
  /* document 委托只挂一次，回调经 ref 转发——空 deps effect 不能捕获挂载期闭包，
     否则调用方（口语陪练 advance）永远读到首轮的陈旧 state（治 P-33） */
  const cbRef = useRef({ onStart, onEnd });
  useEffect(() => {
    cbRef.current = { onStart, onEnd };
  });
  useEffect(() => {
    const up = () => {
      if (!st.current.holding) return;
      st.current.holding = false;
      cbRef.current.onEnd(Date.now() - st.current.start);
    };
    const cancel = () => {
      if (!st.current.holding) return;
      st.current.holding = false;
      cbRef.current.onEnd(-1);
    };
    const move = (e: PointerEvent) => {
      /* 手指大幅移动视为取消（滚动场景） */
      if (st.current.holding && e.movementY !== undefined && Math.abs(e.movementY) > 40) cancel();
    };
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("pointermove", move);
    return () => {
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("pointermove", move);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      st.current.start = Date.now();
      st.current.holding = true;
      onStart();
    },
  };
}

export function fmtDateCN(d = new Date()): string {
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日  星期${week}`;
}

export function dayDiffLabel(dueAt: number, now = Date.now()): string {
  const days = Math.ceil((dueAt - now) / 86400000);
  if (days <= 0) return "现在";
  if (days === 1) return "明天";
  if (days < 7) return `${days} 天后`;
  const d = new Date(dueAt);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
