import { formatDistanceToNow } from "date-fns";
import type { Article } from "../types";
import { SentimentBadge } from "./SentimentBadge";
import { TierBadge, tierBorderClass } from "./TierBadge";

interface Props {
  article: Article;
  compact?: boolean;
  isRead?: boolean;
  isSaved?: boolean;
  isFocused?: boolean;
  onDetail?: (article: Article) => void;
  onToggleSave?: (id: string) => void;
  onToggleRead?: (id: string) => void;
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
  const hnScore = article.hn_score ?? 0;
  const redditScore = article.reddit_score ?? 0;
  const hnComments = article.hn_comments ?? 0;
  const redditComments = article.reddit_comments ?? 0;

  if (hnScore === 0 && redditScore === 0) return null;

  const totalScore = hnScore + redditScore;
  const totalComments = hnComments + redditComments;
  const link = hnScore >= redditScore ? (article.hn_url ?? "#") : (article.reddit_url ?? "#");

  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-xs text-orange-400 hover:text-orange-300 transition-colors tabular-nums"
      title="View social discussion"
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
  onDetail,
  onToggleSave,
  onToggleRead,
}: Props) {
  const border = tierBorderClass(article.tier);
  const dimClass = isRead ? "opacity-40" : "";
  const focusRing = isFocused ? "ring-2 ring-blue-500 ring-offset-1 ring-offset-neutral-950" : "";

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't open detail if clicking a link/button inside the card
    const target = e.target as HTMLElement;
    if (target.closest("a, button")) return;
    onDetail?.(article);
  };

  if (compact) {
    return (
      <div
        className={`flex items-start gap-3 py-2 px-3 rounded hover:bg-neutral-800 transition-colors group
                    cursor-pointer ${dimClass} ${focusRing}`}
        onClick={handleCardClick}
        data-article-id={article.id}
      >
        <span className="mt-0.5 shrink-0">
          <TierBadge tier={article.tier} compact />
        </span>
        <span className="flex-1 min-w-0">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-neutral-200 group-hover:text-white line-clamp-2 leading-snug hover:underline block"
            onClick={(e) => e.stopPropagation()}
          >
            {article.title}
          </a>
          <span className="flex items-center gap-2 mt-1 flex-wrap">
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
        {/* Actions — hover-reveal on desktop, always visible + 40px on touch */}
        <span className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity">
          {onToggleSave && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSave(article.id); }}
              className="flex items-center justify-center h-8 w-8 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 rounded hover:bg-neutral-700 text-sm"
              title={isSaved ? "Unsave" : "Save"}
              aria-pressed={isSaved}
            >
              {isSaved ? "★" : "☆"}
            </button>
          )}
          {onToggleRead && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleRead(article.id); }}
              className="flex items-center justify-center h-8 w-8 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 rounded hover:bg-neutral-700 text-xs text-neutral-500"
              title={isRead ? "Mark unread" : "Mark read"}
            >
              {isRead ? "●" : "○"}
            </button>
          )}
        </span>
      </div>
    );
  }

  return (
    <article
      className={`rounded-lg border border-neutral-800 border-l-4 ${border} bg-neutral-900 p-4
                  hover:bg-neutral-850 transition-colors cursor-pointer ${dimClass} ${focusRing}`}
      onClick={handleCardClick}
      data-article-id={article.id}
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <TierBadge tier={article.tier} />
          <SentimentBadge
            label={article.sentiment_label}
            score={article.sentiment_score}
            rationale={article.sentiment_rationale}
          />
          <CorroborationBadge count={article.cluster_size ?? 1} />
          <SocialChip article={article} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onToggleSave && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleSave(article.id); }}
              className="flex items-center justify-center text-sm p-1 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 rounded hover:bg-neutral-800 transition-colors"
              title={isSaved ? "Unsave" : "Save"}
              aria-pressed={isSaved}
            >
              {isSaved ? "★" : "☆"}
            </button>
          )}
          {onToggleRead && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleRead(article.id); }}
              className="flex items-center justify-center text-xs p-1 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 rounded hover:bg-neutral-800 transition-colors text-neutral-500"
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
        className="block text-base font-semibold text-neutral-100 hover:text-white leading-snug mb-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {article.title}
      </a>

      {article.enrich_summary && (
        <p className="text-sm text-neutral-300 leading-relaxed mb-3 line-clamp-3">
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
