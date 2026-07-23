import React, { useState } from "react";
import { collapseClusters } from "../lib/clusters";
import { useIsMobile } from "../lib/hooks";
import type { Article } from "../types";
import { ArticleCard } from "./ArticleCard";

interface Props {
  articles: Article[];
  search: string;
  skipSearchFilter?: boolean;
  compact: boolean;
  mode?: "tiered" | "foryou";
  briefMode?: boolean;
  newSince?: Date | null;
  batchMode?: boolean;
  selectedIds?: ReadonlySet<string>;
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
  onToggleSelect?: (id: string) => void;
  onExitBriefMode?: () => void;
  statsSlot?: React.ReactNode;
}

const T1_PREVIEW_COUNT = 10;
const BRIEF_T1_LIMIT = 7;

function dateBucket(publishedAt?: string): "Today" | "Yesterday" | "Earlier" {
  if (!publishedAt) return "Earlier";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const d = new Date(publishedAt);
  const pub = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (pub >= today) return "Today";
  if (pub >= yesterday) return "Yesterday";
  return "Earlier";
}

function groupByDate(items: Article[]): Array<{ label: string; items: Article[] }> {
  const buckets: Partial<Record<string, Article[]>> = {};
  for (const a of items) {
    const b = dateBucket(a.published_at);
    (buckets[b] ??= []).push(a);
  }
  return (["Today", "Yesterday", "Earlier"] as const)
    .filter((l) => buckets[l])
    .map((l) => ({ label: l, items: buckets[l]! }));
}

function DateLabel({ label }: { label: string }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-widest text-neutral-600 mb-2 mt-1">
      {label}
    </div>
  );
}

export function TieredFeed({
  articles,
  search,
  skipSearchFilter,
  compact,
  mode = "tiered",
  briefMode = false,
  newSince,
  batchMode = false,
  selectedIds,
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
  onToggleSelect,
  onExitBriefMode,
  statsSlot,
}: Props) {
  const isMobile = useIsMobile();
  // T1 and T2 compact list mode is only available on desktop — on mobile both
  // always render as full cards so all badges and the inline summary remain visible.
  const t1Compact = compact && !isMobile;
  const t2Compact = compact && !isMobile;

  const [showNoise, setShowNoise] = useState(false);
  const [showT3, setShowT3] = useState(true);
  const [showAllT1, setShowAllT1] = useState(false);

  let filtered = articles;

  if (search && !skipSearchFilter) {
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
    isNew: newSince != null && !!a.published_at && new Date(a.published_at) > newSince,
    batchMode,
    isSelected: selectedIds?.has(a.id) ?? false,
    onDetail,
    onToggleSave,
    onToggleRead,
    onToggleSelect,
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

  // ── 5-Minute Brief: all T1 + top 3 T2 by social score, T3/NOISE hidden ────────
  if (briefMode) {
    const t1All = reps.filter((a) => a.tier === "T1");
    const t1b = t1All.slice(0, BRIEF_T1_LIMIT);
    const t2b = reps.filter((a) => a.tier === "T2");
    const top3 = [...t2b].sort((a, b) => (b.social_score ?? 0) - (a.social_score ?? 0)).slice(0, 3);
    const hiddenT1 = t1All.length - t1b.length;
    const hiddenT2 = t2b.length - top3.length;
    const hiddenOther = reps.filter((a) => a.tier === "T3" || a.tier === "NOISE").length;

    return (
      <div className="space-y-10">
        {t1b.length > 0 && (
          <Section title="Critical" emoji="🔴" count={t1All.length} accent="text-red-400">
            <div className="space-y-4">
              {t1b.map((a) => (
                <ArticleCard key={a.id} article={a} compact={compact} {...cardProps(a)} />
              ))}
            </div>
          </Section>
        )}
        {top3.length > 0 && (
          <Section title="Notable" emoji="🟡" count={t2b.length} accent="text-amber-400">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {top3.map((a) => (
                <ArticleCard key={a.id} article={a} compact={false} {...cardProps(a)} />
              ))}
            </div>
          </Section>
        )}
        <div className="text-center py-4 border-t border-neutral-800">
          <p className="text-sm text-neutral-500 mb-2">
            {[hiddenT1 > 0 && `${hiddenT1} more critical`, hiddenT2 > 0 && `${hiddenT2} more notable`, hiddenOther > 0 && `${hiddenOther} background`]
              .filter(Boolean).join(" · ")} articles in the full briefing
          </p>
          {onExitBriefMode && (
            <button
              onClick={onExitBriefMode}
              className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-400
                         hover:text-neutral-200 hover:border-neutral-500 transition-colors"
            >
              Read full briefing →
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── For You: a single ranked, cross-tier list ────────────────────────────────
  if (mode === "foryou") {
    const ranked = (forYouOrder ? forYouOrder(reps) : reps).filter((a) => a.tier !== "NOISE");
    return (
      <div className="space-y-3">
        {ranked.map((a) => (
          <ArticleCard
            key={a.id}
            article={a}
            compact={a.tier === "T1" || a.tier === "T2" ? false : compactFor(a)}
            {...cardProps(a)}
          />
        ))}
      </div>
    );
  }

  const t1 = reps.filter((a) => a.tier === "T1");
  const t2 = reps.filter((a) => a.tier === "T2");
  const t3 = reps.filter((a) => a.tier === "T3");
  const noise = reps.filter((a) => a.tier === "NOISE");

  const visibleT1 = showAllT1 ? t1 : t1.slice(0, T1_PREVIEW_COUNT);
  const injectInT1 = !!statsSlot && t1.length > 0;

  return (
    <div className="space-y-10">
      {/* T1 */}
      {t1.length > 0 && (
        <Section id="section-t1" title="Critical" emoji="🔴" count={t1.length} accent="text-red-400">
          {(() => {
            const groups = groupByDate(visibleT1);
            const showHeaders = groups.length > 1;
            const [firstGroup, ...tailGroups] = groups;
            const firstCard = firstGroup?.items[0];
            const firstGroupTail = firstGroup?.items.slice(1) ?? [];
            return (
              <div className="space-y-6">
                {firstGroup && firstCard && (
                  <div>
                    {showHeaders && <DateLabel label={firstGroup.label} />}
                    <div className={t1Compact ? "divide-y divide-neutral-800 rounded-lg border border-neutral-800" : "space-y-4"}>
                      <ArticleCard article={firstCard} compact={t1Compact} {...cardProps(firstCard)} />
                    </div>
                    {injectInT1 && <div className="mt-6">{statsSlot}</div>}
                    {firstGroupTail.length > 0 && (
                      <div className={`mt-4 ${t1Compact ? "divide-y divide-neutral-800 rounded-lg border border-neutral-800" : "space-y-4"}`}>
                        {firstGroupTail.map((a) => (
                          <ArticleCard key={a.id} article={a} compact={t1Compact} {...cardProps(a)} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {tailGroups.map(({ label, items }) => (
                  <div key={label}>
                    {showHeaders && <DateLabel label={label} />}
                    <div className={t1Compact ? "divide-y divide-neutral-800 rounded-lg border border-neutral-800" : "space-y-4"}>
                      {items.map((a) => (
                        <ArticleCard key={a.id} article={a} compact={t1Compact} {...cardProps(a)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
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

      {/* Stats slot fallback: shown before T2 when no T1 articles exist */}
      {!injectInT1 && statsSlot && <div className="mb-2">{statsSlot}</div>}

      {/* T2 */}
      {t2.length > 0 && (
        <Section id="section-t2" title="Notable" emoji="🟡" count={t2.length} accent="text-amber-400">
          {(() => {
            const groups = groupByDate(t2);
            const showHeaders = groups.length > 1;
            return (
              <div className="space-y-4">
                {groups.map(({ label, items }) => (
                  <div key={label}>
                    {showHeaders && <DateLabel label={label} />}
                    <div
                      className={
                        t2Compact
                          ? "divide-y divide-neutral-800 rounded-lg border border-neutral-800"
                          : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
                      }
                    >
                      {items.map((a) => (
                        <ArticleCard key={a.id} article={a} compact={t2Compact} {...cardProps(a)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>
      )}

      {/* T3 */}
      {t3.length > 0 && (
        <Section
          id="section-t3"
          title="Background"
          emoji="🔵"
          count={t3.length}
          accent="text-blue-400"
          collapsible
          open={showT3}
          onToggle={() => setShowT3((v) => !v)}
        >
          {showT3 && (() => {
            const groups = groupByDate(t3);
            const showHeaders = groups.length > 1;
            return (
              <div className="space-y-4">
                {groups.map(({ label, items }) => (
                  <div key={label}>
                    {showHeaders && <DateLabel label={label} />}
                    <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
                      {items.map((a) => (
                        <ArticleCard key={a.id} article={a} compact {...cardProps(a)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
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
  id,
  title,
  emoji,
  count,
  accent,
  children,
  collapsible,
  open,
  onToggle,
}: {
  id?: string;
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
    <section id={id}>
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
