import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { IS_STATIC_MODE, api } from "../api/client";
import type { Article, ArticlesResponse, ProfileInfo, StaticMeta, Stats, TrendsResponse } from "../types";

export interface ArticlesDataResult {
  profile: ProfileInfo | undefined;
  stats: Stats | undefined;
  meta: StaticMeta | null | undefined;
  trendsData: TrendsResponse | undefined;
  articlesData: ArticlesResponse | undefined;
  isLoading: boolean;
  error: unknown;
  isServerSearch: boolean;
  allArticles: Article[];
  /** Full dataset regardless of the todayOnly toggle — see the hook's own comment. */
  historicalArticles: Article[];
  showing: number;
  total: number;
  truncated: boolean;
  queryClient: QueryClient;
}

/**
 * All server/query state the dashboard is built on: profile, stats, trends,
 * and the tiered (today-only vs. full) article set, plus the background
 * prefetch that makes toggling "Today only" off instant in static mode
 * (Task 1.1) and the reactive `historicalArticles` read that keeps
 * OnThisDay/BlindspotPanel/StatsPanel from being starved to "today" by
 * that same default (Task 4.5).
 */
export function useArticlesData(todayOnly: boolean, debouncedSearch: string): ArticlesDataResult {
  const { data: profile } = useQuery({
    queryKey: ["profile"],
    queryFn: api.profile,
  });

  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: api.stats,
    refetchInterval: IS_STATIC_MODE ? false : 60_000,
  });

  const { data: meta } = useQuery({
    queryKey: ["meta"],
    queryFn: api.meta,
    enabled: IS_STATIC_MODE,
  });

  const { data: trendsData } = useQuery({
    queryKey: ["trends"],
    queryFn: () => api.trends(30),
    refetchInterval: IS_STATIC_MODE ? false : 300_000,
  });

  // debouncedSearch is in the queryKey when live: FTS5 search runs server-side.
  // Static mode ignores search params (no server), so the key stays stable.
  const isServerSearch = !IS_STATIC_MODE && debouncedSearch.length > 0;
  const queryClient = useQueryClient();
  const { data: articlesData, isLoading, error } = useQuery({
    queryKey: ["articles", todayOnly, IS_STATIC_MODE ? "" : debouncedSearch],
    queryFn: () =>
      api.articles({
        today_only: todayOnly,
        search: isServerSearch ? debouncedSearch : undefined,
        limit: isServerSearch ? 200 : 2000,
      }),
    refetchInterval: IS_STATIC_MODE ? false : 120_000,
  });

  // Static mode paints from articles-today.json first; once that's in,
  // prefetch the full export in the background so switching "Today only"
  // off (or searching, which needs the full set client-side) is instant
  // instead of triggering a fresh multi-MB fetch on interaction.
  useEffect(() => {
    if (IS_STATIC_MODE && todayOnly && articlesData) {
      queryClient.prefetchQuery({
        queryKey: ["articles", false, ""],
        queryFn: () => api.articles({ today_only: false, limit: 2000 }),
      });
    }
  }, [articlesData, todayOnly, queryClient]);

  // Reactive read of the full-dataset cache the prefetch above warms —
  // enabled: false means this never fetches on its own, it just subscribes
  // to whatever's already in the cache under that key (populated by the
  // prefetchQuery call, or by the main query itself once todayOnly is
  // toggled off). Needed by BlindspotPanel/OnThisDay/StatsPanel: all three
  // look back multiple days or all-time, but in static mode's default view
  // `articlesData` is today-only — without this they'd only ever see
  // "today."
  const { data: fullArticlesData } = useQuery({
    queryKey: ["articles", false, ""],
    queryFn: () => api.articles({ today_only: false, limit: 2000 }),
    enabled: false,
  });
  const historicalArticles = fullArticlesData?.items ?? articlesData?.items ?? [];

  const allArticles = articlesData?.items ?? [];
  const showing = articlesData?.items.length ?? 0;
  const total = articlesData?.total ?? 0;
  const truncated = showing < total;

  return {
    profile,
    stats,
    meta,
    trendsData,
    articlesData,
    isLoading,
    error,
    isServerSearch,
    allArticles,
    historicalArticles,
    showing,
    total,
    truncated,
    queryClient,
  };
}
