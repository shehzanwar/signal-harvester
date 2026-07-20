import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IS_STATIC_MODE, api } from "./api/client";
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
  const [category, setCategory] = useState<string | null>(null);
  const [todayOnly, setTodayOnly] = useState(false);
  const [compact, setCompact] = useState(false);
  const [hideRead, setHideRead] = useState(false);
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [detailArticle, setDetailArticle] = useState<Article | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [filterSheet, setFilterSheet] = useState(false);
  const [sortMode, setSortMode] = useState<"tiered" | "foryou">("tiered");
  const [rankSeed, setRankSeed] = useState(0);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

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

  // Engagement-tracked wrappers.
  const openDetail = useCallback(
    (a: Article) => {
      recordEngagement(a, "detail");
      setDetailArticle(a);
    },
    [],
  );
  const toggleSaveTracked = useCallback(
    (id: string) => {
      if (!savedIds.has(id)) {
        const a = (articlesDataRef.current ?? []).find((x) => x.id === id);
        if (a) recordEngagement(a, "save");
      }
      toggleSave(id);
    },
    [savedIds, toggleSave],
  );

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

  // search is NOT in the queryKey — filtering is client-side so we don't
  // refetch on every keystroke. todayOnly changes the dataset so it stays in.
  const { data: articlesData, isLoading, error } = useQuery({
    queryKey: ["articles", todayOnly],
    queryFn: () => api.articles({ today_only: todayOnly, limit: 2000 }),
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

  // Flat list of visible articles for keyboard navigation
  const flatArticles = flattenArticles(categoryArticles, search, showSavedOnly, savedIds);

  // cluster_id -> all members, for listing corroborating coverage in the detail panel
  const clusterMembers = useMemo(() => clusterMembersMap(allArticles), [allArticles]);

  // Mobile forces compact cards; the toggle only exists on desktop.
  const effectiveCompact = compact || isMobile;
  const activeFilterCount = [todayOnly, hideRead, showSavedOnly].filter(Boolean).length;

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
    return (reps: Article[]) =>
      forYouOrder(reps, (a) =>
        scoreArticle(a, { prefs, weights, isRead: readIdsRef.current.has(a.id), now }).total,
      );
    // rankSeed forces a fresh weight/read snapshot on explicit re-rank.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, rankSeed]);

  const activateForYou = useCallback(() => {
    setSortMode("foryou");
    setRankSeed((s) => s + 1);
  }, []);

  const muteArticle = useCallback(
    (a: Article) => {
      const tags = (a.tags ?? []).map((t) => t.toLowerCase());
      updatePrefs((p) => ({
        ...p,
        mutedTags: [...new Set([...p.mutedTags, ...tags])],
      }));
      recordEngagement(a, "mute");
      setDetailArticle(null);
    },
    [updatePrefs],
  );

  // "Why ranked" breakdown for the currently open article (For You only).
  const whyRanked = useMemo(() => {
    if (sortMode !== "foryou" || !detailArticle) return null;
    const b = scoreArticle(detailArticle, {
      prefs,
      weights: getWeights(),
      isRead: readIds.has(detailArticle.id),
      now: Date.now(),
    });
    return breakdownRows(b);
  }, [sortMode, detailArticle, prefs, readIds]);

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
        toggleRead(focusedId);
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
  }, [flatArticles, focusedId, toggleSaveTracked, toggleRead, openDetail]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header / KPI strip */}
      {stats && <KPIStrip stats={stats} title={title} meta={meta ?? null} />}

      {/* Trends strip (collapsible) */}
      {trendsData && <TrendsStrip trends={trendsData} />}

      <main className="max-w-7xl mx-auto px-4 py-6" role="main">
        {/* Category navigation */}
        {allArticles.length > 0 && (
          <CategoryBar
            categories={orderedCats}
            counts={categoryCounts}
            selected={category}
            onSelect={setCategory}
          />
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

        {/* Toolbar — mobile: search + one filter button (opens bottom sheet) */}
        <div className="flex sm:hidden items-center gap-2 mb-4">
          <div className="flex-1 min-w-0">
            <label htmlFor="search-m" className="sr-only">Search articles</label>
            <input
              id="search-m"
              type="search"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2
                         text-sm text-neutral-100 placeholder-neutral-500
                         focus:outline-none focus:border-neutral-500 transition-colors"
            />
          </div>
          <button
            onClick={() => setFilterSheet(true)}
            className="shrink-0 relative flex items-center justify-center gap-1.5 min-h-[40px] px-3
                       rounded-lg border border-neutral-700 text-sm text-neutral-300 active:bg-neutral-800"
            aria-label="Filters"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center
                               text-[10px] font-bold rounded-full bg-blue-600 text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Keyboard hint — non-touch only */}
        {!isTouch && (
          <p className="text-xs text-neutral-700 mb-3">
            j/k navigate · Enter open · s save · r read · d detail · / search
          </p>
        )}

        {/* Sort mode + preferences */}
        <div className="flex items-center gap-2 mb-4">
          <div className="inline-flex rounded-lg border border-neutral-700 overflow-hidden text-sm">
            <button
              onClick={() => setSortMode("tiered")}
              className={`px-3 py-1.5 transition-colors ${
                sortMode === "tiered"
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300"
              }`}
            >
              Tiered
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
            onClick={() => setPrefsOpen(true)}
            className="ml-auto flex items-center justify-center h-9 w-9 rounded-lg border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500"
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

        {articlesData && (
          <TieredFeed
            articles={categoryArticles}
            search={search}
            compact={effectiveCompact}
            mode={sortMode}
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
            onToggleRead={toggleRead}
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
        onClose={() => setDetailArticle(null)}
        isSaved={detailArticle ? savedIds.has(detailArticle.id) : false}
        isRead={detailArticle ? readIds.has(detailArticle.id) : false}
        onToggleSave={toggleSaveTracked}
        onToggleRead={toggleRead}
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
