import { useState } from "react";
import { collapseClusters } from "../lib/clusters";
import type { Article } from "../types";
import { ArticleCard } from "./ArticleCard";

interface Props {
  articles: Article[];
  search: string;
  compact: boolean;
  mode?: "tiered" | "foryou";
  forYouOrder?: (reps: Article[]) => Article[];
  isMuted?: (a: Article) => boolean;
  lowInterest?: (a: Article) => boolean;
  readIds: Set<string>;
  savedIds: Set<string>;
  hideRead: boolean;
  showSavedOnly: boolean;
  focusedId: string | null;
  onDetail: (article: Article) => void;
  onToggleSave: (id: string) => void;
  onToggleRead: (id: string) => void;
}

const T1_PREVIEW_COUNT = 10;

export function TieredFeed({
  articles,
  search,
  compact,
  mode = "tiered",
  forYouOrder,
  isMuted,
  lowInterest,
  readIds,
  savedIds,
  hideRead,
  showSavedOnly,
  focusedId,
  onDetail,
  onToggleSave,
  onToggleRead,
}: Props) {
  const [showNoise, setShowNoise] = useState(false);
  const [showT3, setShowT3] = useState(true);
  const [showAllT1, setShowAllT1] = useState(false);

  let filtered = articles;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        (a.enrich_summary ?? "").toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  if (showSavedOnly) {
    filtered = filtered.filter((a) => savedIds.has(a.id));
  }

  if (hideRead) {
    filtered = filtered.filter((a) => !readIds.has(a.id));
  }

  // Muted tags/keywords hide cards everywhere.
  if (isMuted) {
    filtered = filtered.filter((a) => !isMuted(a));
  }

  // Collapse corroborating clusters to one representative each BEFORE splitting
  // into tiers, so a T1 representative also suppresses its lower-tier members.
  const reps = collapseClusters(filtered);

  const cardProps = (a: Article) => ({
    isRead: readIds.has(a.id),
    isSaved: savedIds.has(a.id),
    isFocused: focusedId === a.id,
    onDetail,
    onToggleSave,
    onToggleRead,
  });
  // Low-interest categories render compact so they take less space.
  const compactFor = (a: Article) => compact || (lowInterest?.(a) ?? false);

  if (filtered.length === 0) {
    return (
      <div className="text-center py-20 text-neutral-500">
        {search
          ? `No articles match "${search}"`
          : showSavedOnly
          ? "No saved articles. Star items to save them."
          : "Nothing here — try a different category or clear your mutes."}
      </div>
    );
  }

  // ── For You: a single ranked, cross-tier list ────────────────────────────────
  if (mode === "foryou") {
    const ranked = (forYouOrder ? forYouOrder(reps) : reps).filter((a) => a.tier !== "NOISE");
    return (
      <div className="space-y-3">
        {ranked.map((a) => (
          <ArticleCard key={a.id} article={a} compact={compactFor(a)} {...cardProps(a)} />
        ))}
      </div>
    );
  }

  const t1 = reps.filter((a) => a.tier === "T1");
  const t2 = reps.filter((a) => a.tier === "T2");
  const t3 = reps.filter((a) => a.tier === "T3");
  const noise = reps.filter((a) => a.tier === "NOISE");

  const visibleT1 = showAllT1 ? t1 : t1.slice(0, T1_PREVIEW_COUNT);

  return (
    <div className="space-y-10">
      {/* T1 */}
      {t1.length > 0 && (
        <Section title="Critical" emoji="🔴" count={t1.length} accent="text-red-400">
          <div className="space-y-4">
            {visibleT1.map((a) => (
              <ArticleCard key={a.id} article={a} compact={compact} {...cardProps(a)} />
            ))}
          </div>
          {t1.length > T1_PREVIEW_COUNT && (
            <button
              onClick={() => setShowAllT1((v) => !v)}
              className="mt-3 text-xs text-neutral-500 hover:text-neutral-300 underline underline-offset-2 transition-colors"
            >
              {showAllT1 ? "Show fewer" : `Show all ${t1.length} critical items`}
            </button>
          )}
        </Section>
      )}

      {/* T2 */}
      {t2.length > 0 && (
        <Section title="Notable" emoji="🟡" count={t2.length} accent="text-amber-400">
          <div
            className={
              compact
                ? "divide-y divide-neutral-800 rounded-lg border border-neutral-800 overflow-hidden"
                : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            }
          >
            {t2.map((a) => (
              <ArticleCard key={a.id} article={a} compact={compact} {...cardProps(a)} />
            ))}
          </div>
        </Section>
      )}

      {/* T3 */}
      {t3.length > 0 && (
        <Section
          title="Background"
          emoji="🔵"
          count={t3.length}
          accent="text-blue-400"
          collapsible
          open={showT3}
          onToggle={() => setShowT3((v) => !v)}
        >
          {showT3 && (
            <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800 overflow-hidden">
              {t3.map((a) => (
                <ArticleCard key={a.id} article={a} compact {...cardProps(a)} />
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Noise */}
      <div className="text-xs text-neutral-600 text-center pt-2 border-t border-neutral-800">
        {noise.length > 0 && (
          <>
            <button
              onClick={() => setShowNoise((v) => !v)}
              className="hover:text-neutral-400 underline underline-offset-2 transition-colors"
            >
              {noise.length} item{noise.length !== 1 ? "s" : ""} filtered as noise
            </button>
            {showNoise && (
              <div className="mt-3 divide-y divide-neutral-800 rounded border border-neutral-800 text-left">
                {noise.map((a) => (
                  <ArticleCard key={a.id} article={a} compact {...cardProps(a)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  emoji,
  count,
  accent,
  children,
  collapsible,
  open,
  onToggle,
}: {
  title: string;
  emoji: string;
  count: number;
  accent: string;
  children: React.ReactNode;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        {collapsible ? (
          <button
            onClick={onToggle}
            className="flex items-center gap-2 text-left"
            aria-expanded={open}
          >
            <h2 className={`text-sm font-semibold uppercase tracking-wider ${accent}`}>
              {emoji} {title}
            </h2>
            <span className="text-neutral-500 text-sm">({count})</span>
            <span className="text-neutral-600 text-xs ml-1">{open ? "▲" : "▼"}</span>
          </button>
        ) : (
          <>
            <h2 className={`text-sm font-semibold uppercase tracking-wider ${accent}`}>
              {emoji} {title}
            </h2>
            <span className="text-neutral-500 text-sm">({count})</span>
          </>
        )}
        <div className="flex-1 h-px bg-neutral-800" />
      </div>
      {children}
    </section>
  );
}
