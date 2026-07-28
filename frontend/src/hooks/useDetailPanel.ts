import { useCallback, useRef, useState } from "react";
import { recordEngagement } from "../lib/affinity";
import { recordCategoryEngagement } from "../lib/exploration";
import type { Article } from "../types";

export interface DetailPanelResult {
  detailArticle: Article | null;
  setDetailArticle: (a: Article | null) => void;
  openDetail: (a: Article) => void;
  closeDetail: () => void;
  /** Articles opened this session — read by TieredFeed's impression tracker
      (Task 3.2) to skip firing a "skip" signal for anything already opened. */
  openedIdsRef: React.RefObject<Set<string>>;
}

/**
 * Detail panel open/close plus dwell-time tracking (bucketed short/medium/
 * long, not a raw seconds value — see affinity.ts's engagement weights).
 * Dwell is flushed when the panel closes OR swaps to a different article,
 * whichever happens first.
 */
export function useDetailPanel(): DetailPanelResult {
  const [detailArticle, setDetailArticle] = useState<Article | null>(null);
  const detailOpenRef = useRef<{ article: Article; at: number } | null>(null);
  const openedIdsRef = useRef<Set<string>>(new Set());

  const recordDwell = useCallback((article: Article) => {
    if (!detailOpenRef.current || detailOpenRef.current.article.id !== article.id) return;
    const secs = (Date.now() - detailOpenRef.current.at) / 1000;
    if (secs > 30) recordEngagement(article, "dwell_long");
    else if (secs > 10) recordEngagement(article, "dwell_medium");
    else if (secs < 3) recordEngagement(article, "dwell_short");
    detailOpenRef.current = null;
  }, []);

  const openDetail = useCallback(
    (a: Article) => {
      if (detailOpenRef.current) recordDwell(detailOpenRef.current.article);
      detailOpenRef.current = { article: a, at: Date.now() };
      openedIdsRef.current.add(a.id);
      if (a.category) recordCategoryEngagement(a.category);
      setDetailArticle(a);
    },
    [recordDwell],
  );

  const closeDetail = useCallback(() => {
    if (detailOpenRef.current) recordDwell(detailOpenRef.current.article);
    setDetailArticle(null);
  }, [recordDwell]);

  return { detailArticle, setDetailArticle, openDetail, closeDetail, openedIdsRef };
}
