import { memo } from "react";
import { recordEngagement } from "../lib/affinity";
import { formatRelative } from "../lib/format";
import type { Article, SentimentLabel, Tier } from "../types";

// Mobile-first headline card: title + one meta line, ~72-80px tall.
// Desktop's ArticleCard (even its "compact" variant) still shows a hover
// preview, corroboration chip, and full SentimentBadge chip unconditionally
// — none of which fit a 375px-wide touch screen. This trims to what
// actually fits on one line at that width and defers everything else (full
// summary, tags, tier rationale, save/read *buttons*) to either the detail
// panel on tap or swipe gestures (Task 2.3) — a bordered SentimentBadge
// chip plus two 32px icon buttons reliably wrapped the meta row to a
// second line in testing, blowing the height target past 120px.
const TIER_DOT: Record<Tier, string> = {
  T1: "bg-red-500",
  T2: "bg-amber-500",
  T3: "bg-blue-500",
  NOISE: "bg-neutral-600",
};

const SENTIMENT: Record<SentimentLabel, { icon: string; className: string }> = {
  positive: { icon: "↑", className: "text-green-400" },
  negative: { icon: "↓", className: "text-red-400" },
  neutral: { icon: "→", className: "text-neutral-400" },
  mixed: { icon: "↕", className: "text-purple-400" },
};

interface Props {
  article: Article;
  isRead?: boolean;
  isSaved?: boolean;
  isFocused?: boolean;
  isNew?: boolean;
  batchMode?: boolean;
  isSelected?: boolean;
  onDetail?: (article: Article) => void;
  onToggleSave?: (id: string) => void;
  onToggleRead?: (id: string) => void;
  onToggleSelect?: (id: string) => void;
}

export const MobileHeadlineCard = memo(function MobileHeadlineCard({
  article,
  isRead = false,
  isSaved = false,
  isFocused = false,
  isNew = false,
  batchMode = false,
  isSelected = false,
  onDetail,
  onToggleSelect,
}: Props) {
  const handleClick = (e: React.MouseEvent) => {
    if (batchMode) { onToggleSelect?.(article.id); return; }
    const target = e.target as HTMLElement;
    if (target.closest("a, button")) return;
    onDetail?.(article);
  };

  const focusRing = isFocused || isSelected ? "ring-2 ring-blue-500 ring-offset-1 ring-offset-neutral-950" : "";
  const sentiment = SENTIMENT[article.sentiment_label] ?? SENTIMENT.neutral;

  return (
    <article
      onClick={handleClick}
      data-article-id={article.id}
      className={`relative px-3 py-2.5 cursor-pointer active:bg-white/5 transition-colors ${focusRing}`}
      aria-label={`${article.title}. ${article.feed_name}. ${formatRelative(article.published_at)}.`}
    >
      <div className="flex items-start gap-2">
        {batchMode ? (
          <span
            className={`mt-1 flex items-center justify-center h-4 w-4 rounded border-2 shrink-0 transition-colors
                        ${isSelected ? "bg-blue-600 border-blue-500" : "border-neutral-600"}`}
          >
            {isSelected && <span className="text-white text-[10px] leading-none">✓</span>}
          </span>
        ) : (
          <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${TIER_DOT[article.tier]}`} aria-hidden />
        )}

        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.stopPropagation();
            recordEngagement(article, "open");
          }}
          className={`flex-1 min-w-0 text-[15px] leading-snug font-medium line-clamp-2 hover:underline
                      ${isRead ? "text-neutral-400" : "text-neutral-100"}`}
        >
          {article.title}
        </a>

        {isSaved && <span className="mt-0.5 shrink-0 text-amber-400 text-xs" aria-hidden>★</span>}
      </div>

      <div className="mt-1 ml-4 flex items-center gap-1.5 overflow-hidden text-xs text-neutral-500">
        {isNew && (
          <span className="shrink-0 text-[10px] font-bold px-1 py-0.5 rounded bg-blue-600 text-white uppercase tracking-wide">
            New
          </span>
        )}
        <span className="shrink-0 font-medium text-neutral-400 truncate max-w-[35%]">{article.feed_name}</span>
        <span className="shrink-0">·</span>
        <time className="shrink-0">{formatRelative(article.published_at)}</time>

        {article.sentiment_label !== "neutral" && (
          <span className={`shrink-0 tabular-nums ${sentiment.className}`} title={`Sentiment: ${article.sentiment_label}`}>
            {sentiment.icon}{Math.abs(article.sentiment_score).toFixed(1)}
          </span>
        )}

        {(article.social_score ?? 0) > 50 && (
          <span className="shrink-0 text-orange-400 tabular-nums">{article.social_score}pts</span>
        )}

        {article.perception_gap != null && Math.abs(article.perception_gap) >= 0.8 && (
          <span
            className={`shrink-0 ${article.perception_gap < 0 ? "text-red-400" : "text-emerald-400"}`}
            title={`Perception gap ${article.perception_gap > 0 ? "+" : ""}${article.perception_gap.toFixed(2)}`}
          >
            {article.perception_gap > 0 ? "↑" : "↓"}{Math.abs(article.perception_gap).toFixed(1)}
          </span>
        )}
      </div>
    </article>
  );
});
