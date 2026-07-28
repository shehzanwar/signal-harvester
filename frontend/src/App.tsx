import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { IS_STATIC_MODE } from "./api/client";
import { BatchBar } from "./components/BatchBar";
import { BottomNav } from "./components/BottomNav";
import { Toast } from "./components/Toast";
import { BottomSheet } from "./components/BottomSheet";
import { BlindspotPanel } from "./components/BlindspotPanel";
import { CategoryBar } from "./components/CategoryBar";
import { KPIStrip } from "./components/KPIStrip";
import { OnboardingSheet } from "./components/OnboardingSheet";
import { OnThisDay } from "./components/OnThisDay";
import { TieredFeed } from "./components/TieredFeed";
import { TrendsStrip } from "./components/TrendsStrip";
import { orderedCategories } from "./lib/categories";
import { useIsMobile, useIsTouch } from "./lib/hooks";
import { isMuted, usePrefs } from "./lib/prefs";
import { useArticlesData } from "./hooks/useArticlesData";
import { useCategoryFilters } from "./hooks/useCategoryFilters";
import { useToast } from "./hooks/useToast";
import { useReadingStreak } from "./hooks/useReadingStreak";
import { useReadSaveTracking } from "./hooks/useReadSaveTracking";
import { useBatchOperations } from "./hooks/useBatchOperations";
import { useDetailPanel } from "./hooks/useDetailPanel";
import { useForYouRanking } from "./hooks/useForYouRanking";
import { useReadingProgress } from "./hooks/useReadingProgress";
import { useKeyboardNav } from "./hooks/useKeyboardNav";
import { usePullToRefresh } from "./hooks/usePullToRefresh";
import { useOnboarding } from "./hooks/useOnboarding";
import type { Article } from "./types";

// Split out of the initial bundle — each is only requested the first time
// it's actually opened (detail panel, preferences sheet, stats sheet), not
// on first paint. All three already return null internally when closed, so
// gating the JSX on that same condition (see render below) means the lazy
// import is only triggered on first open, not on mount.
const DetailPanel = lazy(() => import("./components/DetailPanel").then((m) => ({ default: m.DetailPanel })));
const PrefsPanel = lazy(() => import("./components/PrefsPanel").then((m) => ({ default: m.PrefsPanel })));
const StatsPanel = lazy(() => import("./components/StatsPanel").then((m) => ({ default: m.StatsPanel })));

export default function App() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Static mode (GitHub Pages) defaults to today-only so the first paint
  // loads articles-today.json (a fraction of the size) instead of the full
  // export; live mode is already paginated server-side so it keeps the old
  // default. Either way the user can toggle "Today only" off in Filters.
  const [todayOnly, setTodayOnly] = useState(IS_STATIC_MODE);
  const [compact, setCompact] = useState(false);
  const [hideRead, setHideRead] = useState(false);
  const [filterSheet, setFilterSheet] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [lastVisit] = useState<Date | null>(() => {
    try { const s = localStorage.getItem("signal-last-visit"); return s ? new Date(s) : null; } catch { return null; }
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const searchMRef = useRef<HTMLInputElement>(null);

  const isMobile = useIsMobile();
  const isTouch = useIsTouch();

  const [prefs, updatePrefs, replacePrefs] = usePrefs();

  const {
    profile, stats, meta, trendsData, articlesData, isLoading, error,
    isServerSearch, allArticles, historicalArticles, showing, total, truncated, queryClient,
  } = useArticlesData(todayOnly, debouncedSearch);

  const title = profile?.dashboard_title ?? "Signal Harvester";

  // Latest loaded articles, for id->article lookups in event handlers.
  const articlesDataRef = useRef<Article[]>([]);
  articlesDataRef.current = allArticles;

  const { toast, showToast, dismissToast } = useToast();
  const { streak, recordRead } = useReadingStreak();
  const { readIds, savedIds, toggleRead, toggleSave, toggleReadTracked, toggleSaveTracked } =
    useReadSaveTracking(articlesDataRef, showToast, recordRead);

  // Latest readIds without making the For You order recompute on every toggle.
  const readIdsRef = useRef(readIds);
  readIdsRef.current = readIds;

  const {
    category, subcategory, setSubcategory, selectCategory,
    categoryCounts, subcategoryCounts, subcategoryOptions,
    selectedTags, setSelectedTags, toggleTag, tagFilteredArticles,
  } = useCategoryFilters(allArticles);

  const {
    showSavedOnly, setShowSavedOnly, flatArticles, clusterMembers,
    readProgress, todayUnreadCount, topTags,
  } = useReadingProgress(allArticles, tagFilteredArticles, isServerSearch, search, savedIds, readIds, trendsData);

  const { batchMode, setBatchMode, selectedIds, setSelectedIds, toggleSelect, batchMarkRead, batchSave, batchMute, exitBatch } =
    useBatchOperations(readIds, savedIds, toggleRead, toggleSave, flatArticles, prefs, updatePrefs, showToast);

  const { detailArticle, setDetailArticle, openDetail, closeDetail, openedIdsRef } = useDetailPanel();

  const { sortMode, setSortMode, briefMode, setBriefMode, forYouOrderFn, activateForYou, muteArticle, whyRanked } =
    useForYouRanking(prefs, updatePrefs, readIds, readIdsRef, articlesDataRef, detailArticle, setDetailArticle, showToast);

  const { showOnboarding, completeOnboarding } = useOnboarding(updatePrefs);

  const { focusedId } = useKeyboardNav(
    flatArticles, batchMode, setBatchMode, setSelectedIds,
    toggleSaveTracked, toggleReadTracked, openDetail, searchRef,
  );

  const { pullDistance, refreshing, PULL_THRESHOLD, onPullPointerDown, onPullPointerMove, endPull } =
    usePullToRefresh(isMobile, queryClient);

  // Mobile forces compact cards; the toggle only exists on desktop.
  const effectiveCompact = compact || isMobile;
  // ── Personalization ────────────────────────────────────────────────────────
  const orderedCats = orderedCategories(prefs.categoryOrder);
  const isMutedFn = (a: Article) => isMuted(a, prefs);
  const lowInterestFn = (a: Article) => (prefs.categoryInterest[a.category ?? ""] ?? "normal") === "low";

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

  return (
    <div
      className="min-h-screen bg-neutral-950 text-neutral-100"
      onPointerDown={onPullPointerDown}
      onPointerMove={onPullPointerMove}
      onPointerUp={endPull}
      onPointerCancel={endPull}
    >
      {/* Pull-to-refresh indicator */}
      {pullDistance > 0 && (
        <div
          className="fixed top-0 left-0 right-0 z-50 flex justify-center items-center pointer-events-none"
          style={{ height: pullDistance }}
          aria-hidden
        >
          <span className={`text-2xl transition-transform ${pullDistance > PULL_THRESHOLD ? "rotate-180" : ""}`}>
            {refreshing ? "⟳" : "↓"}
          </span>
        </div>
      )}

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

        {/* Tag filter chips — desktop only. On mobile this is a filter
            control, not content, so it moves into the Filters sheet
            (below) instead of taking a full row above the feed. */}
        {topTags.length > 0 && (
          <div className="hidden sm:flex gap-1.5 overflow-x-auto pb-1 mb-4 -mx-1 px-1">
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
              onClick={activateForYou}
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

        {error !== null && error !== undefined && (
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

        {/* On This Day: T1 memories from 7/30 days ago. Uses historicalArticles
            (not tagFilteredArticles) — a "memory" feature ignoring the
            current category filter is more useful than an empty section
            every time a filter happens to be active. */}
        {articlesData && sortMode === "tiered" && !briefMode && (
          <OnThisDay articles={historicalArticles} onOpen={openDetail} />
        )}

        {/* Blindspots: only shown in the main tiered view, not brief/For You —
            those are already curated/ranked subsets where "only 1 source"
            framing doesn't add the same signal. Same historicalArticles
            source as OnThisDay above, for the same reason (7-day window
            shouldn't be starved to "today" by the static-mode default). */}
        {articlesData && sortMode === "tiered" && !briefMode && (
          <BlindspotPanel articles={historicalArticles} onOpen={openDetail} />
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
            openedIdsRef={openedIdsRef}
            statsSlot={stats ? <KPIStrip stats={stats} title={title} meta={meta ?? null} streak={streak} inline /> : undefined}
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

      {/* First-visit topic picker */}
      <OnboardingSheet open={showOnboarding} onComplete={completeOnboarding} />

      {/* Mobile filter sheet — Settings lives here now (BottomNav dropped its
          own tab for it, Task 2.6) rather than as a 5th nav icon. */}
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

        {/* Tag chips — mobile-only home for the row hidden above. */}
        {topTags.length > 0 && (
          <div className="mt-3 pt-3 border-t border-neutral-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-neutral-400">Tags</span>
              {selectedTags.size > 0 && (
                <button
                  onClick={() => setSelectedTags(new Set())}
                  className="text-xs text-neutral-500 hover:text-neutral-300"
                >
                  ✕ Clear
                </button>
              )}
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {topTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                    selectedTags.has(tag)
                      ? "bg-blue-600 border-blue-500 text-white"
                      : "bg-neutral-800 border-neutral-700 text-neutral-400"
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={() => {
            setFilterSheet(false);
            setPrefsOpen(true);
          }}
          className="mt-3 flex items-center justify-between w-full min-h-[48px] px-3 rounded-lg text-left text-sm text-neutral-300 border-t border-neutral-800 pt-3 active:bg-neutral-800"
        >
          <span>⚙ More settings</span>
          <span className="text-neutral-600">→</span>
        </button>
      </BottomSheet>

      {/* Detail panel */}
      {detailArticle && (
        <Suspense fallback={<div className="fixed inset-0 bg-black/50 z-40" aria-hidden />}>
          <DetailPanel
            article={detailArticle}
            clusterMembers={clusterMembers}
            whyRanked={whyRanked}
            onClose={closeDetail}
            isSaved={savedIds.has(detailArticle.id)}
            isRead={readIds.has(detailArticle.id)}
            onToggleSave={toggleSaveTracked}
            onToggleRead={toggleReadTracked}
            onMute={muteArticle}
          />
        </Suspense>
      )}

      {/* Preferences */}
      {prefsOpen && (
        <Suspense fallback={<div className="fixed inset-0 bg-black/50 z-40" aria-hidden />}>
          <PrefsPanel
            open={prefsOpen}
            onClose={() => setPrefsOpen(false)}
            prefs={prefs}
            onUpdate={updatePrefs}
            onReplacePrefs={replacePrefs}
          />
        </Suspense>
      )}

      {/* Stats panel */}
      {statsOpen && (
        <Suspense fallback={<div className="fixed inset-0 bg-black/50 z-40" aria-hidden />}>
          <StatsPanel
            open={statsOpen}
            articles={historicalArticles}
            readIds={readIds}
            savedIds={savedIds}
            prefs={prefs}
            onClose={() => setStatsOpen(false)}
          />
        </Suspense>
      )}

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

      {/* Undo toast. The live region announcing it is a separate, always-
          mounted element below (not inside <Toast>, which remounts fresh
          — new key — on every toast): a screen reader region that appears
          in the DOM with its content already inside it, at the same
          instant, is unreliably announced by many screen reader/browser
          combinations. A persistent empty region that has its text
          updated afterward is the pattern that actually works. */}
      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          onUndo={toast.undo}
          onDismiss={dismissToast}
        />
      )}
      <div aria-live="polite" role="status" className="sr-only">
        {toast?.message ?? ""}
      </div>

      {/* Mobile bottom navigation */}
      <BottomNav
        todayOnly={todayOnly}
        showSavedOnly={showSavedOnly}
        savedCount={savedIds.size}
        filterCount={[hideRead, selectedTags.size > 0].filter(Boolean).length}
        todayUnreadCount={todayUnreadCount}
        readProgress={readProgress}
        onTodayToggle={() => setTodayOnly((v) => !v)}
        onSearchFocus={() => searchMRef.current?.focus()}
        onSavedToggle={() => setShowSavedOnly((v) => !v)}
        onFilterSheet={() => setFilterSheet(true)}
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
