import { useMemo, useState } from "react";
import { clusterMembersMap, collapseClusters } from "../lib/clusters";
import type { Article, TrendsResponse } from "../types";

// Same calendar-day definition TieredFeed's dateBucket uses for "Today".
function isPublishedToday(publishedAt?: string): boolean {
  if (!publishedAt) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d = new Date(publishedAt);
  const pub = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return pub >= today;
}

function flattenArticles(articles: Article[], search: string, savedOnly: boolean, savedIds: Set<string>) {
  let list = articles;
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        (a.enrich_summary ?? "").toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
  if (savedOnly) list = list.filter((a) => savedIds.has(a.id));
  // Collapse clusters so keyboard nav (j/k) steps through the same representative
  // cards the feed shows, not the hidden corroborating members.
  return collapseClusters(list); // already sorted by tier then published_at from the API
}

export interface ReadingProgressResult {
  showSavedOnly: boolean;
  setShowSavedOnly: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** Flat ordered article list (mirrors TieredFeed render order) — for keyboard nav. */
  flatArticles: Article[];
  clusterMembers: Map<string, Article[]>;
  readProgress: { read: number; total: number };
  todayUnreadCount: number;
  topTags: string[];
}

export function useReadingProgress(
  allArticles: Article[],
  tagFilteredArticles: Article[],
  isServerSearch: boolean,
  search: string,
  savedIds: Set<string>,
  readIds: Set<string>,
  trendsData: TrendsResponse | undefined,
): ReadingProgressResult {
  const [showSavedOnly, setShowSavedOnly] = useState(false);

  const flatArticles = useMemo(
    () => flattenArticles(tagFilteredArticles, isServerSearch ? "" : search, showSavedOnly, savedIds),
    [tagFilteredArticles, isServerSearch, search, showSavedOnly, savedIds],
  );

  // cluster_id -> all members, for listing corroborating coverage in the detail panel
  const clusterMembers = useMemo(() => clusterMembersMap(allArticles), [allArticles]);

  // Reading progress: how many non-noise representative articles have been read
  const readProgress = useMemo(() => {
    const reps = collapseClusters(tagFilteredArticles).filter((a) => a.tier !== "NOISE");
    const read = reps.filter((a) => readIds.has(a.id)).length;
    return { read, total: reps.length };
  }, [tagFilteredArticles, readIds]);

  // BottomNav's "Today" badge: unread count among today's articles, from
  // whatever's currently loaded — independent of the todayOnly toggle so it
  // reads the same whether or not "Today" is the active filter (same
  // convention as the Saved tab's badge, which shows savedIds.size
  // regardless of whether showSavedOnly is on).
  const todayUnreadCount = useMemo(() => {
    const reps = collapseClusters(allArticles).filter((a) => a.tier !== "NOISE" && isPublishedToday(a.published_at));
    return reps.filter((a) => !readIds.has(a.id)).length;
  }, [allArticles, readIds]);

  // Top tag chips: trending tags first, backfilled from all-time top_tags up to 12.
  const topTags = useMemo(() => {
    if (!trendsData) return [];
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const t of trendsData.trending.slice(0, 6)) { seen.add(t.tag); tags.push(t.tag); }
    for (const t of trendsData.top_tags) {
      if (!seen.has(t.tag)) { seen.add(t.tag); tags.push(t.tag); if (tags.length >= 12) break; }
    }
    return tags;
  }, [trendsData]);

  return { showSavedOnly, setShowSavedOnly, flatArticles, clusterMembers, readProgress, todayUnreadCount, topTags };
}
