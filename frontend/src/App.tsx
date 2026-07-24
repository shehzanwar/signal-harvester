import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IS_STATIC_MODE, api } from "./api/client";
import { BatchBar } from "./components/BatchBar";
import { BottomNav } from "./components/BottomNav";
import { StatsPanel } from "./components/StatsPanel";
import { Toast } from "./components/Toast";
import { BottomSheet } from "./components/BottomSheet";
import { CategoryBar } from "./components/CategoryBar";
import { DetailPanel } from "./components/DetailPanel";
import { KPIStrip } from "./components/KPIStrip";
import { PrefsPanel } from "./components/PrefsPanel";
import { TieredFeed } from "./components/TieredFeed";
import { TrendsStrip } from "./components/TrendsStrip";
import { getWeights, recordEngagement } from "./lib/affinity";
import { orderedCategories } from "./lib/categories";
import { clusterMembersMap, collapseClusters } from "./lib/clusters";
import { useIsMobile, useIsTouch } from "./lib/hooks";
import { isMuted, usePrefs } from "./lib/prefs";
import { breakdownRows, forYouOrder, scoreArticle } from "./lib/scoring";
import type { Article } from "./types";

// ── LocalStorage set hook ─────────────────────────────────────────────────────
function useLocalSet(key: string): [Set<string>, (id: string) => void] {
  const [ids, setIds] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
    } catch {
      return new Set<string>();
    }
  });
  const toggle = useCallback(
    (id: string) => {
      setIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          localStorage.setItem(key, JSON.stringify([...next]));
        } catch {}
        return next;
      });
    },
    [key],
  );
  return [ids, toggle];
}

// ── Flat ordered article list (mirrors TieredFeed render order) ───────────────
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

export default function App() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [subcategory, setSubcategory] = useState<string | null>(null);
  // Selecting a new top-level category invalidates whatever subcategory was
  // active — a subcategory value from one category is meaningless in another.
  const selectCategory = useCallback((key: string | null) => {
    setCategory(key);
    setSubcategory(null);
  }, []);
  const [todayOnly, setTodayOnly] = useState(false);
  const [compact, setCompact] = useState(false);
  const [hideRead, setHideRead] = useState(false);
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [detailArticle, setDetailArticle] = useState<Article | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [filterSheet, setFilterSheet] = useState(false);
  const [sortMode, setSortMode] = useState<"tiered" | "foryou">("tiered");
  const [briefMode, setBriefMode] = useState(false);
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set());
  const [rankSeed, setRankSeed] = useState(0);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [lastVisit] = useState<Date | null>(() => {
    try { const s = localStorage.getItem("signal-last-visit"); return s ? new Date(s) : null; } catch { return null; }
  });
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [statsOpen, setStatsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; undo: () => void; key: number } | null>(null);
  const showToast = useCallback((message: string, undo: () => void) => {
    setToast({ message, undo, key: Date.now() });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchMRef = useRef<HTMLInputElement>(null);

  const isMobile = useIsMobile();
  const isTouch = useIsTouch();

  const [readIds, toggleRead] = useLocalSet("signal-read");
  const [savedIds, toggleSave] = useLocalSet("signal-saved");
  const [prefs, updatePrefs, replacePrefs] = usePrefs();

  // Latest readIds without making the For You order recompute on every toggle.
  const readIdsRef = useRef(readIds);
  readIdsRef.current = readIds;
  // Latest loaded articles, for id->article lookups in event handlers.
  const articlesDataRef = useRef<Article[]>([]);

  // Dwell-time tracking: record how long the user spent in the detail panel.
  const detailOpenRef = useRef<{ article: Article; at: number } | null>(null);

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
      setDetailArticle(a);
    },
    [recordDwell],
  );

  const closeDetail = useCallback(() => {
    if (detailOpenRef.current) recordDwell(detailOpenRef.current.article);
    setDetailArticle(null);
  }, [recordDwell]);
  const toggleSaveTracked = useCallback(
    (id: string) => {
      const isSaving = !savedIds.has(id);
      if (isSaving) {
        const a = (articlesDataRef.current ?? []).find((x) => x.id === id);
        if (a) recordEngagement(a, "save");
      }
      toggleSave(id);
      showToast(isSaving ? "Saved ★" : "Unsaved", () => toggleSave(id));
    },
    [savedIds, toggleSave, showToast],
  );

  const toggleReadTracked = useCallback(
    (id: string) => {
      const isMarkingRead = !readIds.has(id);
      toggleRead(id);
      showToast(isMarkingRead ? "Marked read" : "Marked unread", () => toggleRead(id));
    },
    [readIds, toggleRead, showToast],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const batchMarkRead = useCallback(() => {
    selectedIds.forEach((id) => { if (!readIds.has(id)) toggleRead(id); });
    setBatchMode(false);
    setSelectedIds(new Set());
    showToast(`Marked ${selectedIds.size} read`, () => {
      selectedIds.forEach((id) => toggleRead(id));
    });
  }, [selectedIds, readIds, toggleRead, showToast]);

  const batchSave = useCallback(() => {
    selectedIds.forEach((id) => { if (!savedIds.has(id)) toggleSave(id); });
    setBatchMode(false);
    setSelectedIds(new Set());
    showToast(`Saved ${selectedIds.size}`, () => {
      selectedIds.forEach((id) => toggleSave(id));
    });
  }, [selectedIds, savedIds, toggleSave, showToast]);

  const exitBatch = useCallback(() => {
    setBatchMode(false);
    setSelectedIds(new Set());
  }, []);

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

  const title = profile?.dashboard_title ?? "Signal Harvester";
  const allArticles = articlesData?.items ?? [];
  articlesDataRef.current = allArticles;
  const showing = articlesData?.items.length ?? 0;
  const total = articlesData?.total ?? 0;
  const truncated = showing < total;

  // Per-category story counts (collapsed reps, non-noise) for the category bar.
  // Independent of search/filters so the nav stays stable.
  const categoryCounts = useMemo(() => {
    const reps = collapseClusters(allArticles).filter((a) => a.tier !== "NOISE");
    const counts: Record<string, number> = { all: reps.length };
    for (const a of reps) {
      const c = a.category || "general";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [allArticles]);

  // Feed scoped to the selected category (null = All).
  const categoryArticles = useMemo(
    () =>
      category
        ? allArticles.filter((a) => (a.category || "general") === category)
        : allArticles,
    [allArticles, category],
  );

  // Subcategory counts/options within the CURRENT category only — a
  // subcategory bar for "world" showing "science"/"health" makes no sense
  // once the user has switched to "technology". Only feeds that declared a
  // non-empty subcategory contribute; feeds without one fall through
  // ungrouped (no "general" bucket forced onto sources that didn't ask for it).
  const subcategoryCounts = useMemo(() => {
    if (!category) return { all: 0 };
    const reps = collapseClusters(categoryArticles).filter((a) => a.tier !== "NOISE");
    const counts: Record<string, number> = { all: reps.length };
    for (const a of reps) {
      if (a.subcategory) counts[a.subcategory] = (counts[a.subcategory] ?? 0) + 1;
    }
    return counts;
  }, [categoryArticles, category]);

  const subcategoryOptions = useMemo(
    () =>
      Object.keys(subcategoryCounts)
        .filter((key) => key !== "all")
        .sort((a, b) => subcategoryCounts[b] - subcategoryCounts[a])
        .map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) })),
    [subcategoryCounts],
  );

  const subcategoryArticles = useMemo(
    () => (subcategory ? categoryArticles.filter((a) => a.subcategory === subcategory) : categoryArticles),
    [categoryArticles, subcategory],
  );

  // Tag filter applied after category/subcategory filter (client-side; OR semantics across selected tags).
  const tagFilteredArticles = useMemo(
    () =>
      selectedTags.size > 0
        ? subcategoryArticles.filter((a) => a.tags.some((t) => selectedTags.has(t)))
        : subcategoryArticles,
    [subcategoryArticles, selectedTags],
  );

  // Flat list of visible articles for keyboard navigation.
  // When the server has already filtered by FTS5, skip the client-side text pass.
  const flatArticles = flattenArticles(tagFilteredArticles, isServerSearch ? "" : search, showSavedOnly, savedIds);

  const batchMute = useCallback(() => {
    const prevMuted = [...prefs.mutedTags];
    const selected = flatArticles.filter((a) => selectedIds.has(a.id));
    const tags = [...new Set(selected.flatMap((a) => (a.tags ?? []).map((t) => t.toLowerCase())))];
    if (tags.length === 0) return;
    updatePrefs((p) => ({ ...p, mutedTags: [...new Set([...p.mutedTags, ...tags])] }));
    const count = selectedIds.size;
    setBatchMode(false);
    setSelectedIds(new Set());
    showToast(
      `Muted ${tags.length} tag${tags.length !== 1 ? "s" : ""} from ${count} article${count !== 1 ? "s" : ""}`,
      () => updatePrefs((p) => ({ ...p, mutedTags: prevMuted })),
    );
  }, [selectedIds, flatArticles, prefs.mutedTags, updatePrefs, showToast]);

  // cluster_id -> all members, for listing corroborating coverage in the detail panel
  const clusterMembers = useMemo(() => clusterMembersMap(allArticles), [allArticles]);

  // Reading progress: how many non-noise representative articles have been read
  const readProgress = useMemo(() => {
    const reps = collapseClusters(tagFilteredArticles).filter((a) => a.tier !== "NOISE");
    const read = reps.filter((a) => readIds.has(a.id)).length;
    return { read, total: reps.length };
  }, [tagFilteredArticles, readIds]);

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

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }, []);

  // Mobile forces compact cards; the toggle only exists on desktop.
  const effectiveCompact = compact || isMobile;
  // ── Personalization ────────────────────────────────────────────────────────
  const orderedCats = useMemo(() => orderedCategories(prefs.categoryOrder), [prefs.categoryOrder]);
  const isMutedFn = useCallback((a: Article) => isMuted(a, prefs), [prefs]);
  const lowInterestFn = useCallback(
    (a: Article) => (prefs.categoryInterest[a.category ?? ""] ?? "normal") === "low",
    [prefs],
  );

  // For You ordering. Weights + read state are snapshotted when this recomputes
  // (on prefs change or an explicit re-rank) so the order stays stable while you
  // tap — learning is applied on the next re-rank, not mid-scroll.
  const forYouOrderFn = useMemo(() => {
    const weights = getWeights();
    const now = Date.now();
    return (reps: Article[]) => {
      const readIds_ = readIdsRef.current;
      // Count read articles per cluster for story-fatigue scoring.
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
    // rankSeed forces a fresh weight/read snapshot on explicit re-rank.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, rankSeed]);

  const activateForYou = useCallback(() => {
    setSortMode("foryou");
    setBriefMode(false);
    setRankSeed((s) => s + 1);
  }, []);

  const muteArticle = useCallback(
    (a: Article) => {
      const prevMuted = [...prefs.mutedTags];
      const tags = (a.tags ?? []).map((t) => t.toLowerCase());
      updatePrefs((p) => ({
        ...p,
        mutedTags: [...new Set([...p.mutedTags, ...tags])],
      }));
      recordEngagement(a, "mute");
      setDetailArticle(null);
      showToast(
        `Muted "${a.tags[0] ?? "topic"}"`,
        () => updatePrefs((p) => ({ ...p, mutedTags: prevMuted })),
      );
    },
    [prefs.mutedTags, updatePrefs, showToast],
  );

  // "Why ranked" breakdown for the currently open article (For You only).
  const whyRanked = useMemo(() => {
    if (sortMode !== "foryou" || !detailArticle) return null;
    const readClusterCount = detailArticle.cluster_id
      ? (articlesDataRef.current ?? []).filter(
          (a) => a.cluster_id === detailArticle.cluster_id && readIds.has(a.id),
        ).length
      : 0;
    const b = scoreArticle(detailArticle, {
      prefs,
      weights: getWeights(),
      isRead: readIds.has(detailArticle.id),
      now: Date.now(),
      readClusterCount,
    });
    return breakdownRows(b);
  }, [sortMode, detailArticle, prefs, readIds]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Save visit timestamp so the "NEW" badge shows on next session.
  useEffect(() => {
    const save = () => {
      try { localStorage.setItem("signal-last-visit", new Date().toISOString()); } catch {}
    };
    window.addEventListener("pagehide", save);
    return () => { save(); window.removeEventListener("pagehide", save); };
  }, []);

  // ── Keyboard navigation ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in an input
      const inInput =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement;

      if (e.key === "/") {
        if (!inInput) {
          e.preventDefault();
          searchRef.current?.focus();
        }
        return;
      }

      if (inInput) return;

      if (e.key === "x") {
        setBatchMode((v) => !v);
        if (batchMode) setSelectedIds(new Set());
        return;
      }

      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const idMap = { "1": "section-t1", "2": "section-t2", "3": "section-t3" } as const;
        document.getElementById(idMap[e.key])?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setFocusedId((prev) => {
          if (!flatArticles.length) return null;
          const idx = flatArticles.findIndex((a) => a.id === prev);
          const next =
            e.key === "j"
              ? Math.min(idx + 1, flatArticles.length - 1)
              : Math.max(idx - 1, 0);
          const nextId = flatArticles[idx === -1 ? 0 : next]?.id ?? null;
          // Scroll into view
          if (nextId) {
            document.querySelector(`[data-article-id="${nextId}"]`)?.scrollIntoView({
              block: "nearest",
              behavior: "smooth",
            });
          }
          return nextId;
        });
        return;
      }

      if ((e.key === "Enter" || e.key === "o") && focusedId) {
        const art = flatArticles.find((a) => a.id === focusedId);
        if (art) {
          recordEngagement(art, "open");
          window.open(art.url, "_blank", "noopener,noreferrer");
        }
        return;
      }

      if (e.key === "s" && focusedId) {
        toggleSaveTracked(focusedId);
        return;
      }

      if (e.key === "r" && focusedId) {
        toggleReadTracked(focusedId);
        return;
      }

      if (e.key === "d" && focusedId) {
        const art = flatArticles.find((a) => a.id === focusedId);
        if (art) openDetail(art);
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [flatArticles, focusedId, batchMode, toggleSaveTracked, toggleReadTracked, openDetail]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Trends strip (collapsible) */}
      {trendsData && <TrendsStrip trends={trendsData} />}

      <main className="max-w-7xl mx-auto px-4 py-6 sm:pb-6 pb-24" role="main">
        {/* Category navigation */}
        {allArticles.length > 0 && (
          <CategoryBar
            categories={orderedCats}
            counts={categoryCounts}
            selected={category}
            onSelect={selectCategory}
          />
        )}

        {/* Subcategory navigation — only when the selected category actually
            has 2+ distinct subcategories; a bar with one option is noise. */}
        {category && subcategoryOptions.length > 1 && (
          <CategoryBar
            categories={subcategoryOptions}
            counts={subcategoryCounts}
            selected={subcategory}
            onSelect={setSubcategory}
          />
        )}

        {/* Tag filter chips */}
        {topTags.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 mb-4 -mx-1 px-1">
            {selectedTags.size > 0 && (
              <button
                onClick={() => setSelectedTags(new Set())}
                className="shrink-0 text-xs px-2.5 py-1 rounded-full border border-neutral-600
                           text-neutral-400 hover:text-neutral-200 transition-colors whitespace-nowrap"
              >
                ✕ Clear
              </button>
            )}
            {topTags.map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${
                  selectedTags.has(tag)
                    ? "bg-blue-600 border-blue-500 text-white"
                    : "bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Toolbar — desktop */}
        <div className="hidden sm:flex items-center gap-3 mb-6 flex-wrap">
          <div className="flex-1 min-w-48">
            <label htmlFor="search" className="sr-only">Search articles</label>
            <input
              id="search"
              ref={searchRef}
              type="search"
              placeholder="Search titles, summaries, tags… (press / to focus)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2
                         text-sm text-neutral-100 placeholder-neutral-500
                         focus:outline-none focus:border-neutral-500 transition-colors"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={todayOnly}
              onChange={(e) => setTodayOnly(e.target.checked)}
              className="rounded border-neutral-600 bg-neutral-800 text-blue-500"
            />
            Today
          </label>

          <label className="flex items-center gap-2 text-sm text-neutral-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={compact}
              onChange={(e) => setCompact(e.target.checked)}
              className="rounded border-neutral-600 bg-neutral-800 text-blue-500"
            />
            Compact
          </label>

          <label className="flex items-center gap-2 text-sm text-neutral-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideRead}
              onChange={(e) => setHideRead(e.target.checked)}
              className="rounded border-neutral-600 bg-neutral-800 text-blue-500"
            />
            Hide read
          </label>

          <button
            onClick={() => setShowSavedOnly((v) => !v)}
            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
              showSavedOnly
                ? "bg-amber-900/40 border-amber-700 text-amber-300"
                : "border-neutral-700 text-neutral-400 hover:border-neutral-600"
            }`}
          >
            ★ Saved{savedIds.size > 0 ? ` (${savedIds.size})` : ""}
          </button>

          <span className="text-xs text-neutral-600 ml-auto">
            {articlesData
              ? truncated
                ? `showing ${showing.toLocaleString()} of ${total.toLocaleString()} articles`
                : `${total.toLocaleString()} articles`
              : ""}
          </span>
        </div>

        {/* Toolbar — mobile: search only (filters/saved/today in BottomNav) */}
        <div className="flex sm:hidden items-center mb-4">
          <label htmlFor="search-m" className="sr-only">Search articles</label>
          <input
            id="search-m"
            ref={searchMRef}
            type="search"
            placeholder="Search articles…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2.5
                       text-sm text-neutral-100 placeholder-neutral-500
                       focus:outline-none focus:border-neutral-500 transition-colors"
          />
        </div>

        {/* Keyboard hint — non-touch only */}
        {!isTouch && (
          <p className="text-xs text-neutral-700 mb-3">
            j/k navigate · 1/2/3 jump tier · Enter open · s save · r read · d detail · x select · / search
          </p>
        )}

        {/* Sort mode + preferences */}
        <div className="flex items-center gap-2 mb-4">
          <div className="inline-flex rounded-lg border border-neutral-700 overflow-hidden text-sm">
            <button
              onClick={() => { setSortMode("tiered"); setBriefMode(false); }}
              className={`px-3 py-1.5 transition-colors ${
                sortMode === "tiered" && !briefMode
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              Tiered
            </button>
            <button
              onClick={() => { setSortMode("tiered"); setBriefMode(true); }}
              className={`px-3 py-1.5 transition-colors ${
                briefMode
                  ? "bg-emerald-900/50 text-emerald-200"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
              title="5-minute briefing: all Critical + top 3 Notable articles"
            >
              ⚡ 5-min
            </button>
            <button
              onClick={activateForYou}
              className={`px-3 py-1.5 transition-colors ${
                sortMode === "foryou"
                  ? "bg-blue-900/50 text-blue-200"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              For You
            </button>
          </div>
          {sortMode === "foryou" && (
            <button
              onClick={() => setRankSeed((s) => s + 1)}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500"
              title="Re-rank with your latest activity"
            >
              ↻ Re-rank
            </button>
          )}
          <button
            onClick={() => setBatchMode((v) => { if (v) setSelectedIds(new Set()); return !v; })}
            className={`text-sm px-2.5 py-1.5 rounded-lg border transition-colors ${
              batchMode
                ? "bg-blue-900/40 border-blue-700 text-blue-300"
                : "border-neutral-700 text-neutral-500 hover:text-neutral-300 hover:border-neutral-600"
            }`}
            title="Multi-select mode (x)"
          >
            ☐ Select
          </button>
          <button
            onClick={() => setStatsOpen(true)}
            className="flex items-center justify-center h-9 w-9 rounded-lg border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500"
            aria-label="Reading stats"
            title="Reading stats"
          >
            📊
          </button>
          <button
            onClick={() => setPrefsOpen(true)}
            className="flex items-center justify-center h-9 w-9 rounded-lg border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500"
            aria-label="Preferences"
            title="Preferences"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        {/* Feed */}
        {isLoading && (
          <div className="space-y-4">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="h-28 rounded-lg bg-neutral-800 animate-pulse"
                style={{ opacity: 1 - i * 0.12 }}
              />
            ))}
          </div>
        )}

        {error && (
          <div className="text-center py-20">
            <p className="text-red-400 mb-2">Failed to load articles</p>
            <p className="text-neutral-500 text-sm">
              Is the harvester server running?{" "}
              <code className="text-neutral-400">python -m harvester serve</code>
            </p>
          </div>
        )}

        {/* Reading progress bar */}
        {articlesData && readProgress.total > 0 && (
          <div className="mb-4">
            <div className="flex items-center justify-between text-xs text-neutral-700 mb-1">
              <span>{readProgress.read} / {readProgress.total} read</span>
              {readProgress.read === readProgress.total && (
                <span className="text-emerald-700">All caught up ✓</span>
              )}
            </div>
            <div className="h-0.5 bg-neutral-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-neutral-600 rounded-full transition-all duration-500"
                style={{ width: `${(readProgress.read / readProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {articlesData && (
          <TieredFeed
            articles={tagFilteredArticles}
            search={search}
            skipSearchFilter={isServerSearch}
            briefMode={briefMode}
            newSince={lastVisit}
            onExitBriefMode={() => setBriefMode(false)}
            compact={effectiveCompact}
            mode={sortMode}
            batchMode={batchMode}
            selectedIds={selectedIds}
            forYouOrder={forYouOrderFn}
            isMuted={isMutedFn}
            lowInterest={lowInterestFn}
            readIds={readIds}
            savedIds={savedIds}
            hideRead={hideRead}
            showSavedOnly={showSavedOnly}
            focusedId={focusedId}
            onDetail={openDetail}
            onToggleSave={toggleSaveTracked}
            onToggleRead={toggleReadTracked}
            onToggleSelect={toggleSelect}
            statsSlot={stats ? <KPIStrip stats={stats} title={title} meta={meta ?? null} inline /> : undefined}
          />
        )}
      </main>

      <footer className="border-t border-neutral-800 mt-12 py-4 text-center text-xs text-neutral-700">
        {profile && (
          <>
            Profile: <code className="text-neutral-600">{profile.profile}</code>
            {" · "}Model: <code className="text-neutral-600">{profile.model}</code>
            {" · "}
          </>
        )}
        {!IS_STATIC_MODE && (
          <a href="/api/docs" className="hover:text-neutral-500 underline underline-offset-2" target="_blank">
            API docs
          </a>
        )}
      </footer>

      {/* Mobile filter sheet */}
      <BottomSheet open={filterSheet} onClose={() => setFilterSheet(false)} title="Filters">
        <div className="flex flex-col gap-1">
          <SheetToggle label="Today only" checked={todayOnly} onChange={setTodayOnly} />
          <SheetToggle label="Hide read" checked={hideRead} onChange={setHideRead} />
          <SheetToggle
            label={`Saved${savedIds.size > 0 ? ` (${savedIds.size})` : ""}`}
            checked={showSavedOnly}
            onChange={setShowSavedOnly}
          />
        </div>
      </BottomSheet>

      {/* Detail panel */}
      <DetailPanel
        article={detailArticle}
        clusterMembers={clusterMembers}
        whyRanked={whyRanked}
        onClose={closeDetail}
        isSaved={detailArticle ? savedIds.has(detailArticle.id) : false}
        isRead={detailArticle ? readIds.has(detailArticle.id) : false}
        onToggleSave={toggleSaveTracked}
        onToggleRead={toggleReadTracked}
        onMute={muteArticle}
      />

      {/* Preferences */}
      <PrefsPanel
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        prefs={prefs}
        onUpdate={updatePrefs}
        onReplacePrefs={replacePrefs}
      />

      {/* Stats panel */}
      <StatsPanel
        open={statsOpen}
        articles={allArticles}
        readIds={readIds}
        savedIds={savedIds}
        prefs={prefs}
        onClose={() => setStatsOpen(false)}
      />

      {/* Batch action bar */}
      {batchMode && selectedIds.size > 0 && (
        <BatchBar
          count={selectedIds.size}
          onMarkRead={batchMarkRead}
          onSave={batchSave}
          onMute={batchMute}
          onCancel={exitBatch}
        />
      )}

      {/* Undo toast */}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          onUndo={toast.undo}
          onDismiss={dismissToast}
        />
      )}

      {/* Mobile bottom navigation */}
      <BottomNav
        todayOnly={todayOnly}
        showSavedOnly={showSavedOnly}
        savedCount={savedIds.size}
        filterCount={[hideRead, selectedTags.size > 0].filter(Boolean).length}
        onTodayToggle={() => setTodayOnly((v) => !v)}
        onSearchFocus={() => searchMRef.current?.focus()}
        onSavedToggle={() => setShowSavedOnly((v) => !v)}
        onFilterSheet={() => setFilterSheet(true)}
        onSettings={() => setPrefsOpen(true)}
      />
    </div>
  );
}

function SheetToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between w-full min-h-[48px] px-3 rounded-lg text-left text-sm text-neutral-200 active:bg-neutral-800"
      aria-pressed={checked}
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-6 w-11 rounded-full transition-colors ${
          checked ? "bg-blue-600" : "bg-neutral-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}
