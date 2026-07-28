import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { getWeights, recordEngagement } from "../lib/affinity";
import type { Prefs } from "../lib/prefs";
import { breakdownRows, forYouOrder, scoreArticle } from "../lib/scoring";
import type { Article } from "../types";

export interface ForYouRankingResult {
  sortMode: "tiered" | "foryou";
  setSortMode: (mode: "tiered" | "foryou") => void;
  briefMode: boolean;
  setBriefMode: (v: boolean) => void;
  forYouOrderFn: (reps: Article[]) => Article[];
  activateForYou: () => void;
  muteArticle: (a: Article) => void;
  whyRanked: ReturnType<typeof breakdownRows> | null;
}

/**
 * "For You" ranking mode: affinity-weighted ordering, re-rank trigger, mute
 * action, and the "why ranked" breakdown shown in the detail panel. Weights
 * are re-read from localStorage (affinity.ts's own decay-persist store) on
 * mount and on every explicit re-rank, not on every render.
 */
export function useForYouRanking(
  prefs: Prefs,
  updatePrefs: (updater: (p: Prefs) => Prefs) => void,
  readIds: Set<string>,
  readIdsRef: RefObject<Set<string>>,
  articlesDataRef: RefObject<Article[]>,
  detailArticle: Article | null,
  setDetailArticle: (a: Article | null) => void,
  showToast: (message: string, undo: () => void) => void,
): ForYouRankingResult {
  const [sortMode, setSortMode] = useState<"tiered" | "foryou">("tiered");
  const [briefMode, setBriefMode] = useState(false);
  const [rankSeed, setRankSeed] = useState(0);
  const [affinityWeights, setAffinityWeights] = useState<Record<string, number>>({});

  useEffect(() => {
    setAffinityWeights(getWeights());
  }, [rankSeed]);

  const forYouOrderFn = useMemo(() => {
    const weights = affinityWeights;
    const now = Date.now();
    return (reps: Article[]) => {
      const readIds_ = readIdsRef.current ?? new Set<string>();
      const clusterReadCounts: Record<string, number> = {};
      for (const a of reps) {
        if (a.cluster_id && readIds_.has(a.id)) {
          clusterReadCounts[a.cluster_id] = (clusterReadCounts[a.cluster_id] ?? 0) + 1;
        }
      }
      return forYouOrder(reps, (a) => {
        const readClusterCount = a.cluster_id ? (clusterReadCounts[a.cluster_id] ?? 0) : 0;
        return scoreArticle(a, { prefs, weights, isRead: readIds_.has(a.id), now, readClusterCount }).total;
      });
    };
  }, [prefs, affinityWeights, readIdsRef]);

  const activateForYou = useCallback(() => {
    setSortMode("foryou");
    setBriefMode(false);
    setRankSeed((s) => s + 1);
  }, []);

  const muteArticle = useCallback(
    (a: Article) => {
      const prevMuted = [...prefs.mutedTags];
      const tags = (a.tags ?? []).map((t) => t.toLowerCase());
      updatePrefs((p) => ({ ...p, mutedTags: [...new Set([...p.mutedTags, ...tags])] }));
      recordEngagement(a, "mute");
      setDetailArticle(null);
      showToast(`Muted "${a.tags[0] ?? "topic"}"`, () => updatePrefs((p) => ({ ...p, mutedTags: prevMuted })));
    },
    [prefs.mutedTags, updatePrefs, setDetailArticle, showToast],
  );

  const whyRanked = useMemo(() => {
    if (sortMode !== "foryou" || !detailArticle) return null;
    const readClusterCount = detailArticle.cluster_id
      ? (articlesDataRef.current ?? []).filter(
          (a) => a.cluster_id === detailArticle.cluster_id && readIds.has(a.id),
        ).length
      : 0;
    const b = scoreArticle(detailArticle, {
      prefs,
      weights: affinityWeights,
      isRead: readIds.has(detailArticle.id),
      now: Date.now(),
      readClusterCount,
    });
    return breakdownRows(b);
  }, [sortMode, detailArticle, prefs, readIds, affinityWeights, articlesDataRef]);

  return { sortMode, setSortMode, briefMode, setBriefMode, forYouOrderFn, activateForYou, muteArticle, whyRanked };
}
