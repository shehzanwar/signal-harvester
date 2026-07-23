import { useEffect, useState } from "react";
import { topWeights } from "../lib/affinity";
import { collapseClusters } from "../lib/clusters";
import type { Prefs } from "../lib/prefs";
import type { Article } from "../types";

interface Props {
  open: boolean;
  articles: Article[];
  readIds: Set<string>;
  savedIds: Set<string>;
  prefs: Prefs;
  onClose: () => void;
}

function Bar({ value, max, className = "" }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-neutral-800 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${className}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-neutral-500 w-12 text-right">
        {value} / {max}
      </span>
    </div>
  );
}

export function StatsPanel({ open, articles, readIds, savedIds, prefs, onClose }: Props) {
  const [weights, setWeights] = useState(() => topWeights(8));

  useEffect(() => {
    if (!open) return;
    setWeights(topWeights(8));
    const handler = () => setWeights(topWeights(8));
    window.addEventListener("affinity-change", handler);
    return () => window.removeEventListener("affinity-change", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const reps = collapseClusters(articles).filter((a) => a.tier !== "NOISE");

  // Tier breakdown
  const tiers = ["T1", "T2", "T3"] as const;
  const tierLabel: Record<string, string> = { T1: "🔴 Critical", T2: "🟡 Notable", T3: "🔵 Background" };
  const tierColor: Record<string, string> = { T1: "bg-red-500", T2: "bg-amber-400", T3: "bg-blue-500" };
  const tierStats = tiers.map((t) => {
    const all = reps.filter((a) => a.tier === t);
    const read = all.filter((a) => readIds.has(a.id)).length;
    return { tier: t, total: all.length, read };
  });
  const totalRead = tierStats.reduce((s, t) => s + t.read, 0);
  const totalAll = reps.length;

  // Top sources by articles read
  const sourceCounts: Record<string, { total: number; read: number }> = {};
  for (const a of reps) {
    const src = a.feed_name ?? "Unknown";
    if (!sourceCounts[src]) sourceCounts[src] = { total: 0, read: 0 };
    sourceCounts[src].total++;
    if (readIds.has(a.id)) sourceCounts[src].read++;
  }
  const topSources = Object.entries(sourceCounts)
    .filter(([, v]) => v.read > 0)
    .sort(([, a], [, b]) => b.read - a.read)
    .slice(0, 6);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <aside
        className="fixed right-0 top-0 h-full w-full max-w-sm bg-neutral-900 border-l border-neutral-700
                   z-50 overflow-y-auto shadow-2xl flex flex-col"
        role="dialog"
        aria-modal
        aria-label="Reading stats"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-neutral-800 sticky top-0 bg-neutral-900">
          <h2 className="text-sm font-semibold text-neutral-200">📊 Reading Stats</h2>
          <button
            onClick={onClose}
            aria-label="Close stats"
            className="flex items-center justify-center h-8 w-8 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-6 flex-1">
          {/* Overall progress */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">
              Overall Progress
            </h3>
            <Bar value={totalRead} max={totalAll} className="bg-neutral-400" />
            {totalRead === totalAll && totalAll > 0 && (
              <p className="text-xs text-emerald-500 mt-1.5">All caught up ✓</p>
            )}
          </section>

          {/* By tier */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">
              By Tier
            </h3>
            <div className="space-y-2.5">
              {tierStats.filter((t) => t.total > 0).map((t) => (
                <div key={t.tier}>
                  <div className="flex justify-between text-xs text-neutral-400 mb-1">
                    <span>{tierLabel[t.tier]}</span>
                  </div>
                  <Bar value={t.read} max={t.total} className={tierColor[t.tier]} />
                </div>
              ))}
            </div>
          </section>

          {/* Saved */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1">
              Saved
            </h3>
            <p className="text-2xl font-bold text-neutral-200">{savedIds.size}</p>
            <p className="text-xs text-neutral-600">articles bookmarked</p>
          </section>

          {/* Top sources read */}
          {topSources.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">
                Sources Read
              </h3>
              <div className="space-y-1.5">
                {topSources.map(([src, { read, total }]) => (
                  <div key={src} className="flex items-center justify-between text-xs">
                    <span className="text-neutral-300 truncate flex-1 mr-2">{src}</span>
                    <span className="text-neutral-500 tabular-nums shrink-0">{read} / {total}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* What you engage with — learned from opens/saves/mutes, not site-wide tags */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1">
              What You Engage With
            </h3>
            <p className="text-[10px] text-neutral-600 mb-3">
              Learned from your opens, saves, and mutes — not site-wide trending topics
            </p>
            {weights.liked.length === 0 && weights.disliked.length === 0 ? (
              <p className="text-xs text-neutral-600">
                Open or save articles to build your engagement profile. This drives the For You feed.
              </p>
            ) : (
              <div className="space-y-3">
                {weights.liked.length > 0 && (
                  <div>
                    <div className="text-[10px] text-neutral-600 uppercase tracking-wider mb-1.5">Boosted</div>
                    <div className="space-y-1">
                      {weights.liked.map((r) => (
                        <div key={r.feature} className="flex items-center justify-between text-xs gap-2">
                          <span className="text-neutral-300 truncate">{r.label}</span>
                          <span className="text-[10px] text-neutral-600 shrink-0">
                            {r.feature.startsWith("feed:") ? "source" : r.feature.startsWith("cat:") ? "category" : "topic"}
                          </span>
                          <span className="text-emerald-500 tabular-nums shrink-0">+{r.weight.toFixed(1)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {weights.disliked.length > 0 && (
                  <div>
                    <div className="text-[10px] text-neutral-600 uppercase tracking-wider mb-1.5">Suppressed</div>
                    <div className="space-y-1">
                      {weights.disliked.map((r) => (
                        <div key={r.feature} className="flex items-center justify-between text-xs gap-2">
                          <span className="text-neutral-500 truncate">{r.label}</span>
                          <span className="text-[10px] text-neutral-600 shrink-0">
                            {r.feature.startsWith("feed:") ? "source" : r.feature.startsWith("cat:") ? "category" : "topic"}
                          </span>
                          <span className="text-red-500 tabular-nums shrink-0">{r.weight.toFixed(1)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Muted topics */}
          {prefs.mutedTags.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Muted Topics ({prefs.mutedTags.length})
              </h3>
              <div className="flex flex-wrap gap-1">
                {prefs.mutedTags.slice(0, 20).map((tag) => (
                  <span
                    key={tag}
                    className="text-xs px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500 border border-neutral-700"
                  >
                    {tag}
                  </span>
                ))}
                {prefs.mutedTags.length > 20 && (
                  <span className="text-xs text-neutral-600">+{prefs.mutedTags.length - 20} more</span>
                )}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
