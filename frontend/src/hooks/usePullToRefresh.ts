import { useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";

export interface PullToRefreshResult {
  pullDistance: number;
  refreshing: boolean;
  PULL_THRESHOLD: number;
  onPullPointerDown: (e: React.PointerEvent) => void;
  onPullPointerMove: (e: React.PointerEvent) => void;
  endPull: () => Promise<void>;
}

/**
 * Pull-to-refresh (mobile only). Arms on a downward drag starting at
 * window.scrollY === 0 — the page scrolls via window, not a nested
 * container (see Task 1.2's virtualizer, which relies on the same fact).
 * In static mode this just re-fetches the same export snapshot until the
 * next pipeline run — harmless, but a genuine no-op most of the time.
 */
export function usePullToRefresh(isMobile: boolean, queryClient: QueryClient): PullToRefreshResult {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullStartY = useRef(0);
  const pullArmed = useRef(false);
  const pullPointerId = useRef<number | null>(null);
  const PULL_THRESHOLD = 80;
  const PULL_RESISTANCE = 0.5;
  const PULL_MAX = 120;

  const onPullPointerDown = (e: React.PointerEvent) => {
    if (!isMobile || refreshing || window.scrollY > 0) return;
    pullStartY.current = e.clientY;
    pullArmed.current = true;
    pullPointerId.current = e.pointerId;
  };

  const onPullPointerMove = (e: React.PointerEvent) => {
    if (!pullArmed.current || pullPointerId.current !== e.pointerId) return;
    const dy = e.clientY - pullStartY.current;
    if (dy <= 0 || window.scrollY > 0) {
      setPullDistance(0);
      return;
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best-effort only, see SwipeableCard's identical guard
    }
    setPullDistance(Math.min(dy * PULL_RESISTANCE, PULL_MAX));
  };

  const endPull = async () => {
    const shouldRefresh = pullDistance > PULL_THRESHOLD;
    pullArmed.current = false;
    pullPointerId.current = null;
    if (shouldRefresh) {
      setRefreshing(true);
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["articles"] }),
          queryClient.invalidateQueries({ queryKey: ["trends"] }),
        ]);
      } finally {
        setRefreshing(false);
      }
    }
    setPullDistance(0);
  };

  return { pullDistance, refreshing, PULL_THRESHOLD, onPullPointerDown, onPullPointerMove, endPull };
}
