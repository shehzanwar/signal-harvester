import { useCallback, useEffect, useState } from "react";

/** Reactive CSS media query. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

// Tailwind's `sm` breakpoint is 640px, so <640px is our "mobile" layout.
export const useIsMobile = () => useMediaQuery("(max-width: 639px)");
// Coarse pointer = touch; used to drop hover-only affordances and keyboard hints.
export const useIsTouch = () => useMediaQuery("(pointer: coarse)");

/** useState mirrored to localStorage under `key`. */
export function useLocalStorageState<T>(
  key: string,
  initial: T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setState((prev) => {
        const next = typeof v === "function" ? (v as (prev: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* quota / disabled storage — ignore */
        }
        return next;
      });
    },
    [key],
  );
  return [state, set];
}

/**
 * Direction-aware scroll visibility for an auto-hiding header.
 * Returns false (hidden) after scrolling down past `threshold`, true when
 * scrolling back up or near the top. Only meaningful when enabled.
 */
export function useScrollDirectionVisible(enabled: boolean, threshold = 64): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!enabled) {
      setVisible(true);
      return;
    }
    let lastY = window.scrollY;
    let ticking = false;
    const update = () => {
      const y = window.scrollY;
      if (y < threshold) {
        setVisible(true);
      } else if (Math.abs(y - lastY) > 6) {
        setVisible(y < lastY);
      }
      lastY = y;
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [enabled, threshold]);
  return visible;
}
