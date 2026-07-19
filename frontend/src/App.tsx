import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IS_STATIC_MODE, api } from "./api/client";
import { DetailPanel } from "./components/DetailPanel";
import { KPIStrip } from "./components/KPIStrip";
import { TieredFeed } from "./components/TieredFeed";
import { TrendsStrip } from "./components/TrendsStrip";
import { clusterMembersMap, collapseClusters } from "./lib/clusters";
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
  const [todayOnly, setTodayOnly] = useState(false);
  const [compact, setCompact] = useState(false);
  const [hideRead, setHideRead] = useState(false);
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [detailArticle, setDetailArticle] = useState<Article | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [readIds, toggleRead] = useLocalSet("signal-read");
  const [savedIds, toggleSave] = useLocalSet("signal-saved");

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
  const showing = articlesData?.items.length ?? 0;
  const total = articlesData?.total ?? 0;
  const truncated = showing < total;

  // Flat list of visible articles for keyboard navigation
  const flatArticles = flattenArticles(allArticles, search, showSavedOnly, savedIds);

  // cluster_id -> all members, for listing corroborating coverage in the detail panel
  const clusterMembers = useMemo(() => clusterMembersMap(allArticles), [allArticles]);

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
        if (art) window.open(art.url, "_blank", "noopener,noreferrer");
        return;
      }

      if (e.key === "s" && focusedId) {
        toggleSave(focusedId);
        return;
      }

      if (e.key === "r" && focusedId) {
        toggleRead(focusedId);
        return;
      }

      if (e.key === "d" && focusedId) {
        const art = flatArticles.find((a) => a.id === focusedId);
        if (art) setDetailArticle(art);
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [flatArticles, focusedId, toggleSave, toggleRead]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Header / KPI strip */}
      {stats && <KPIStrip stats={stats} title={title} meta={meta ?? null} />}

      {/* Trends strip (collapsible) */}
      {trendsData && <TrendsStrip trends={trendsData} />}

      <main className="max-w-7xl mx-auto px-4 py-6" role="main">
        {/* Toolbar */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
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

        {/* Keyboard hint */}
        <p className="text-xs text-neutral-700 mb-4">
          j/k navigate · Enter open · s save · r read · d detail · / search
        </p>

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
            articles={allArticles}
            search={search}
            compact={compact}
            readIds={readIds}
            savedIds={savedIds}
            hideRead={hideRead}
            showSavedOnly={showSavedOnly}
            focusedId={focusedId}
            onDetail={setDetailArticle}
            onToggleSave={toggleSave}
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

      {/* Detail panel */}
      <DetailPanel
        article={detailArticle}
        clusterMembers={clusterMembers}
        onClose={() => setDetailArticle(null)}
        isSaved={detailArticle ? savedIds.has(detailArticle.id) : false}
        isRead={detailArticle ? readIds.has(detailArticle.id) : false}
        onToggleSave={toggleSave}
        onToggleRead={toggleRead}
      />
    </div>
  );
}
