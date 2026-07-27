import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordEngagement } from "./affinity";
import type { Article } from "../types";

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

const IMPRESSION_MS = 2000;
const IMPRESSION_THRESHOLD = 0.7;

/**
 * Fires a weak "skip" engagement signal for T3 ("Background") articles that
 * sat >=70% visible for >=2s without being opened. T1/T2 are editorially
 * important regardless of engagement, and are excluded — T3 is the one
 * tier that otherwise generates zero learning signal, since almost nobody
 * opens most of it.
 *
 * Returns a ref-callback, not a container ref: TieredFeed's T3 section is
 * virtualized (@tanstack/react-virtual), and virtualized rows commonly
 * reuse the same DOM node for different articles as the list scrolls
 * rather than unmounting/remounting — a one-time container scan would miss
 * every row that virtualizes in after the initial scan. A stable
 * ref-callback attached per-card observes each element as it mounts,
 * regardless of whether the underlying DOM node is fresh or recycled; the
 * intersection callback re-reads `data-article-id` from the live element
 * at fire time, so a recycled node's current article is always correct.
 *
 * Known imprecision, accepted for a signal already weighted at -0.5 (see
 * SIGNAL.skip in affinity.ts): if a recycled row swaps to a new article
 * while still mid-impression on the old one, the old impression is
 * silently dropped rather than resolved — under-fires rather than
 * mis-fires, which is the right direction to err for a "weak" signal.
 */
export function useImpressionTracker(
  articles: Article[],
  openedIdsRef: React.RefObject<Set<string>>,
): (el: HTMLElement | null) => void {
  const impressionStart = useRef<Map<string, number>>(new Map());
  const fired = useRef<Set<string>>(new Set());
  const articlesByIdRef = useRef<Map<string, Article>>(new Map());
  articlesByIdRef.current = useMemo(() => new Map(articles.map((a) => [a.id, a])), [articles]);

  const observerRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-article-id");
          if (!id) continue;
          if (entry.isIntersecting) {
            impressionStart.current.set(id, Date.now());
            continue;
          }
          const start = impressionStart.current.get(id);
          impressionStart.current.delete(id);
          if (start == null || fired.current.has(id)) continue;
          if (Date.now() - start < IMPRESSION_MS) continue;
          const article = articlesByIdRef.current.get(id);
          if (article && article.tier === "T3" && !openedIdsRef.current?.has(id)) {
            recordEngagement(article, "skip");
            fired.current.add(id);
          }
        }
      },
      { threshold: IMPRESSION_THRESHOLD },
    );
    observerRef.current = observer;
    return () => observer.disconnect();
  }, [openedIdsRef]);

  return useCallback((el: HTMLElement | null) => {
    if (el) observerRef.current?.observe(el);
  }, []);
}
