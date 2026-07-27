import { useRef, useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  onSwipeLeft?: () => void; // Save
  onSwipeRight?: () => void; // Mark read
  threshold?: number; // px to trigger (default 80)
  disabled?: boolean;
}

/**
 * Horizontal swipe-to-act wrapper for MobileHeadlineCard: swipe left saves,
 * swipe right marks read. Uses Pointer Events (not Touch Events) so mouse
 * drag works too — testable in a desktop browser, and free coverage for
 * any pointer-type device, not just touchscreens.
 */
export function SwipeableCard({ children, onSwipeLeft, onSwipeRight, threshold = 80, disabled }: Props) {
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const locked = useRef<"h" | "v" | null>(null);
  const suppressClick = useRef(false);
  const activePointerId = useRef<number | null>(null);

  if (disabled) return <>{children}</>;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX.current = e.clientX;
    startY.current = e.clientY;
    locked.current = null;
    activePointerId.current = e.pointerId;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (activePointerId.current !== e.pointerId) return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;

    // Lock axis on first significant movement — once vertical wins, get out
    // of the way entirely so the page scrolls normally.
    if (!locked.current && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      locked.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if (locked.current !== "h") return;

    // Once this is confirmed a horizontal card-swipe, stop it from also
    // bubbling to App.tsx's page-level pull-to-refresh handler — both are
    // mounted on ancestors of every card, and without this a diagonal swipe
    // could nudge the pull-to-refresh indicator open at the same time.
    e.stopPropagation();

    // Best-effort: keeps receiving move events if the pointer drifts
    // outside the card mid-drag. Not required for correctness (the
    // pointerId check above already ignores unrelated pointers) and can
    // throw NotFoundError in edge cases (e.g. the pointer already released) —
    // must not abort the rest of the gesture if it does.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setSwiping(true);
    suppressClick.current = true;
    setOffset(Math.max(-120, Math.min(120, dx)));
  };

  const endSwipe = () => {
    if (offset < -threshold) {
      onSwipeLeft?.();
      if ("vibrate" in navigator) navigator.vibrate(10);
    } else if (offset > threshold) {
      onSwipeRight?.();
      if ("vibrate" in navigator) navigator.vibrate(10);
    }
    setOffset(0);
    setSwiping(false);
    locked.current = null;
    activePointerId.current = null;
  };

  // Swallow the click that follows a real swipe so it doesn't also open
  // the detail panel. Runs in the capture phase so it fires before the
  // card's own onClick.
  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick.current = false;
    }
  };

  return (
    <div className="relative overflow-hidden" onClickCapture={onClickCapture}>
      {/* Background actions revealed by swipe */}
      <div className="absolute inset-0 flex items-center justify-between px-6 pointer-events-none" aria-hidden>
        <span className={`text-sm font-medium transition-opacity ${offset > 30 ? "opacity-100" : "opacity-0"} text-emerald-400`}>
          ✓ Read
        </span>
        <span className={`text-sm font-medium transition-opacity ${offset < -30 ? "opacity-100" : "opacity-0"} text-amber-400`}>
          ★ Save
        </span>
      </div>

      {/* Card content */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endSwipe}
        onPointerCancel={endSwipe}
        style={{
          touchAction: "pan-y",
          transform: `translateX(${offset}px)`,
          transition: swiping ? "none" : "transform 0.2s ease-out",
        }}
        className="relative bg-neutral-950"
      >
        {children}
      </div>
    </div>
  );
}
