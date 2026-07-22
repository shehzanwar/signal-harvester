import { formatDistanceToNow } from "date-fns";
import { recordEngagement } from "../lib/affinity";
import type { Article } from "../types";
import { SentimentBadge } from "./SentimentBadge";
import { TierBadge, tierBorderClass } from "./TierBadge";

interface Props {
  article: Article;
  compact?: boolean;
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

function relativeTime(iso?: string): string {
  if (!iso) return "unknown";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso.slice(0, 10);
  }
}

function CorroborationBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span
      title={`Covered by ${count} sources`}
      className="text-xs px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-800 font-mono"
    >
      {count} sources
    </span>
  );
}

function SocialChip({ article }: { article: Article }) {
  const social = article.social ?? [];
  if (social.length === 0) return null;

  const totalScore = article.social_score ?? social.reduce((s, x) => s + x.score, 0);
  const totalComments = social.reduce((s, x) => s + x.comments, 0);
  // Link to the highest-scoring source's discussion.
  const best = social.reduce((a, b) => (b.score > a.score ? b : a));

  return (
    <a
      href={best.permalink ?? "#"}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-xs text-orange-400 hover:text-orange-300 transition-colors tabular-nums"
      title={`Discussed on ${social.map((s) => s.source).join(", ")}`}
    >
      {totalScore >= 1000 ? `${(totalScore / 1000).toFixed(1)}k` : totalScore}pts
      {totalComments > 0 && ` · ${totalComments}💬`}
    </a>
  );
}

export function ArticleCard({
  article,
  compact = false,
  isRead = false,
  isSaved = false,
  isFocused = false,
  isNew = false,
  batchMode = false,
  isSelected = false,
  onDetail,
  onToggleSave,
  onToggleRead,
  onToggleSelect,
}: Props) {
  const border = tierBorderClass(article.tier);
  const dimClass = isRead && !batchMode ? "opacity-40" : "";
  const focusRing = isFocused ? "ring-2 ring-blue-500 ring-offset-1 ring-offset-neutral-950" : "";
  const selectedRing = isSelected ? "ring-2 ring-blue-500 ring-offset-1 ring-offset-neutral-950" : "";

  const handleCardClick = (e: React.MouseEvent) => {
    if (batchMode) { onToggleSelect?.(article.id); return; }
    const target = e.target as HTMLElement;
    if (target.closest("a, button")) return;
    onDetail?.(article);
  };

  if (compact) {
    return (
      <div
        className={`relative flex items-start gap-3 py-2 px-3 rounded hover:bg-neutral-800 transition-colors group/card
                    cursor-pointer ${dimClass} ${batchMode ? selectedRing : focusRing}`}
        onClick={handleCardClick}
        data-article-id={article.id}
      >
        <span className="mt-0.5 shrink-0">
          {batchMode ? (
            <span className={`flex items-center justify-center h-4 w-4 rounded border-2 transition-colors
                              ${isSelected ? "bg-blue-600 border-blue-500" : "border-neutral-600"}`}>
              {isSelected && <span className="text-white text-[10px] leading-none">✓</span>}
            </span>
          ) : (
            <TierBadge tier={article.tier} compact />
          )}
        </span>
        <span className="flex-1 min-w-0">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-neutral-200 group-hover/card:text-white line-clamp-2 leading-snug hover:underline block"
            onClick={(e) => {
              e.stopPropagation();
              recordEngagement(article, "open");
            }}
          >
            {article.title}
          </a>
          <span className="flex items-center gap-2 mt-1 flex-wrap">
            {isNew && (
              <span className="text-[10px] font-bold px-1 py-0.5 rounded bg-blue-600 text-white uppercase tracking-wide">
                New
              </span>
            )}
            <span className="text-xs text-neutral-500">{article.feed_name}</span>
            <span className="text-neutral-700">·</span>
            <span className="text-xs text-neutral-500">{relativeTime(article.published_at)}</span>
            <SentimentBadge
              label={article.sentiment_label}
              score={article.sentiment_score}
              rationale={article.sentiment_rationale}
              compact
            />
            <CorroborationBadge count={article.cluster_size ?? 1} />
            <SocialChip article={article} />
          </span>
        </span>
        {/* Actions — hover-reveal on desktop, always visible on touch */}
        <span className="flex items-center gap-1 shrink-0 opacity-0 group-hover/card:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity">
          {onToggleSave && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSave(article.id); }}
              className="flex items-center justify-center h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 rounded hover:bg-neutral-700 text-sm"
              title={isSaved ? "Unsave" : "Save"}
              aria-pressed={isSaved}
            >
              {isSaved ? "★" : "☆"}
            </button>
          )}
          {onToggleRead && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleRead(article.id); }}
              className="flex items-center justify-center h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 rounded hover:bg-neutral-700 text-xs text-neutral-500"
              title={isRead ? "Mark unread" : "Mark read"}
            >
              {isRead ? "●" : "○"}
            </button>
          )}
        </span>
        {/* Hover summary preview — desktop pointer only, 400ms delay to avoid flashing */}
        {article.enrich_summary && (
          <div
            className="[@media(pointer:coarse)]:hidden absolute left-0 top-full mt-0.5 z-50
                       w-72 max-w-[calc(100vw-2rem)] p-3 rounded-lg
                       border border-neutral-700 bg-neutral-900 shadow-2xl
                       opacity-0 pointer-events-none group-hover/card:opacity-100
                       transition-opacity duration-150 delay-[400ms]"
          >
            <p className="text-xs text-neutral-300 leading-relaxed">{article.enrich_summary}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <article
      className={`rounded-lg border border-neutral-800 border-l-4 ${border} bg-neutral-900 p-4
                  hover:bg-neutral-850 transition-colors cursor-pointer ${dimClass} ${batchMode ? selectedRing : focusRing}`}
      onClick={handleCardClick}
      data-article-id={article.id}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          {batchMode ? (
            <span className={`flex items-center justify-center h-5 w-5 rounded border-2 shrink-0 transition-colors
                              ${isSelected ? "bg-blue-600 border-blue-500" : "border-neutral-600"}`}>
              {isSelected && <span className="text-white text-xs leading-none">✓</span>}
            </span>
          ) : (
            <TierBadge tier={article.tier} />
          )}
          {isNew && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-600 text-white uppercase tracking-wide">
              New
            </span>
          )}
          <SentimentBadge
            label={article.sentiment_label}
            score={article.sentiment_score}
            rationale={article.sentiment_rationale}
          />
          {article.predicted_reaction_label && article.predicted_reaction_score != null && (
            <SentimentBadge
              label={article.predicted_reaction_label}
              score={article.predicted_reaction_score}
              rationale={article.predicted_reaction_rationale}
            />
          )}
          {article.perception_gap != null && Math.abs(article.perception_gap) >= 0.2 && (
            <span
              className={`text-xs tabular-nums font-medium ${
                article.perception_gap < 0 ? "text-red-400" : "text-emerald-400"
              }`}
              title={`Perception gap ${article.perception_gap > 0 ? "+" : ""}${article.perception_gap.toFixed(2)}: public ${article.perception_gap < 0 ? "angrier" : "more positive"} than press`}
            >
              {article.perception_gap > 0 ? "↑" : "↓"}{Math.abs(article.perception_gap).toFixed(1)}
            </span>
          )}
          <CorroborationBadge count={article.cluster_size ?? 1} />
          <SocialChip article={article} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onToggleSave && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSave(article.id); }}
              className="flex items-center justify-center text-sm p-1 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 rounded hover:bg-neutral-800 transition-colors"
              title={isSaved ? "Unsave" : "Save"}
              aria-pressed={isSaved}
            >
              {isSaved ? "★" : "☆"}
            </button>
          )}
          {onToggleRead && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleRead(article.id); }}
              className="flex items-center justify-center text-xs p-1 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 rounded hover:bg-neutral-800 transition-colors text-neutral-500"
              title={isRead ? "Mark unread" : "Mark read"}
            >
              {isRead ? "●" : "○"}
            </button>
          )}
          <span className="text-xs text-neutral-500" title={article.published_at ?? ""}>
            {relativeTime(article.published_at)}
          </span>
        </div>
      </div>

      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`block ${article.tier === "T1" ? "text-xl font-bold" : "text-base font-semibold"} text-neutral-100 hover:text-white leading-snug mb-2 hover:underline`}
        onClick={(e) => {
          e.stopPropagation();
          recordEngagement(article, "open");
        }}
      >
        {article.title}
      </a>

      {article.enrich_summary && (
        <p className={`text-sm text-neutral-300 leading-relaxed mb-3 ${article.tier === "T1" ? "" : "line-clamp-2"}`}>
          {article.enrich_summary}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-neutral-500">{article.feed_name}</span>
        {article.tags.length > 0 && (
          <>
            <span className="text-neutral-700">·</span>
            <div className="flex flex-wrap gap-1">
              {article.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 border border-neutral-700"
                >
                  {tag}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {article.tier_rationale && (
        <p className="text-xs text-neutral-500 mt-2 italic">{article.tier_rationale}</p>
      )}
    </article>
  );
}
