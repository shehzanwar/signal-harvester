import { formatDistanceToNow } from "date-fns";
import { useEffect } from "react";
import { recordEngagement } from "../lib/affinity";
import { clusterSiblings } from "../lib/clusters";
import type { Article } from "../types";
import { SentimentBadge } from "./SentimentBadge";
import { TierBadge } from "./TierBadge";

interface Props {
  article: Article | null;
  clusterMembers?: Map<string, Article[]>;
  whyRanked?: { label: string; value: number }[] | null;
  onClose: () => void;
  isSaved: boolean;
  isRead: boolean;
  onToggleSave: (id: string) => void;
  onToggleRead: (id: string) => void;
  onMute?: (a: Article) => void;
}

function relativeTime(iso?: string): string {
  if (!iso) return "unknown";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso.slice(0, 10);
  }
}

export function DetailPanel({
  article,
  clusterMembers,
  whyRanked,
  onClose,
  isSaved,
  isRead,
  onToggleSave,
  onToggleRead,
  onMute,
}: Props) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Dwell signal: a read of >10s in the panel is a positive engagement.
  useEffect(() => {
    if (!article) return;
    const a = article;
    const start = Date.now();
    return () => {
      if (Date.now() - start > 10_000) recordEngagement(a, "dwell");
    };
  }, [article?.id]);

  if (!article) return null;

  const siblings = clusterMembers ? clusterSiblings(article, clusterMembers) : [];
  const hasCluster = (article.cluster_size ?? 1) > 1;
  const hnScore = article.hn_score ?? 0;
  const hnComments = article.hn_comments ?? 0;
  const redditScore = article.reddit_score ?? 0;
  const redditComments = article.reddit_comments ?? 0;
  const hasSocial = hnScore > 0 || redditScore > 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <aside
        className="fixed right-0 top-0 h-full w-full max-w-lg bg-neutral-900 border-l border-neutral-700
                   z-50 overflow-y-auto shadow-2xl flex flex-col"
        role="dialog"
        aria-modal
        aria-label="Article detail"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-4 border-b border-neutral-800 sticky top-0 bg-neutral-900">
          <div className="flex items-center gap-2 flex-wrap">
            <TierBadge tier={article.tier} />
            <SentimentBadge
              label={article.sentiment_label}
              score={article.sentiment_score}
              rationale={article.sentiment_rationale}
              compact
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onToggleSave(article.id)}
              title={isSaved ? "Unsave" : "Save"}
              className="flex items-center justify-center text-lg leading-none p-1 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 rounded hover:bg-neutral-800 transition-colors"
              aria-pressed={isSaved}
            >
              {isSaved ? "★" : "☆"}
            </button>
            <button
              onClick={() => onToggleRead(article.id)}
              title={isRead ? "Mark unread" : "Mark read"}
              className="text-xs px-2 py-1 [@media(pointer:coarse)]:min-h-[40px] rounded border border-neutral-700 hover:bg-neutral-800 transition-colors text-neutral-400"
            >
              {isRead ? "Unread" : "Read"}
            </button>
            <button
              onClick={onClose}
              aria-label="Close detail panel"
              className="flex items-center justify-center text-neutral-500 hover:text-neutral-200 text-xl leading-none p-1 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10 rounded hover:bg-neutral-800 transition-colors"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 flex-1 space-y-5">
          {/* Title */}
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => recordEngagement(article, "open")}
            className="block text-lg font-semibold text-neutral-100 hover:text-white hover:underline leading-snug"
          >
            {article.title}
          </a>

          {/* Metadata row */}
          <p className="text-xs text-neutral-500">
            {article.feed_name}
            {article.published_at && (
              <> · {relativeTime(article.published_at)}</>
            )}
            {article.enriched_at && (
              <> · enriched {relativeTime(article.enriched_at)}</>
            )}
          </p>

          {/* Why ranked here (For You mode) */}
          {whyRanked && whyRanked.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Why ranked here
              </h3>
              <div className="flex flex-col gap-1">
                {whyRanked.map((r) => (
                  <div key={r.label} className="flex items-center gap-2 text-xs">
                    <span className="w-32 text-neutral-400">{r.label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-neutral-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${r.value >= 0 ? "bg-green-500" : "bg-red-500"}`}
                        style={{ width: `${Math.min(100, (Math.abs(r.value) / 3) * 100)}%` }}
                      />
                    </div>
                    <span
                      className={`tabular-nums w-10 text-right ${r.value >= 0 ? "text-green-400" : "text-red-400"}`}
                    >
                      {r.value >= 0 ? "+" : ""}
                      {r.value.toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Less like this — mute this story's tags */}
          {onMute && article.tags.length > 0 && (
            <button
              onClick={() => onMute(article)}
              className="text-xs px-3 py-1.5 rounded border border-neutral-700 text-neutral-400 hover:border-red-700 hover:text-red-400 transition-colors"
            >
              🔇 Less like this
            </button>
          )}

          {/* Summary */}
          {article.enrich_summary && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1">
                Summary
              </h3>
              <p className="text-sm text-neutral-200 leading-relaxed">
                {article.enrich_summary}
              </p>
            </section>
          )}

          {/* Tier rationale */}
          {article.tier_rationale && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1">
                Tier Rationale
              </h3>
              <p className="text-sm text-neutral-400 italic">{article.tier_rationale}</p>
            </section>
          )}

          {/* Sentiment rationale */}
          {article.sentiment_rationale && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-1">
                Sentiment
              </h3>
              <p className="text-sm text-neutral-400">{article.sentiment_rationale}</p>
            </section>
          )}

          {/* Tags */}
          {article.tags.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Tags
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {article.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-300 border border-neutral-700"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Cluster corroboration */}
          {hasCluster && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Covered by {article.cluster_size} sources
              </h3>
              {siblings.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {siblings.map((m) => (
                    <li key={m.id}>
                      <a
                        href={m.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex flex-col gap-0.5"
                      >
                        <span className="text-sm text-neutral-300 group-hover:text-blue-300 transition-colors leading-snug">
                          {m.title}
                        </span>
                        <span className="text-xs text-neutral-600">
                          {m.feed_name}
                          {m.tier !== article.tier ? ` · ${m.tier}` : ""}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(article.cluster_sources ?? []).map((src) => (
                    <span
                      key={src}
                      className="text-xs px-2 py-0.5 rounded bg-blue-950 text-blue-300 border border-blue-800"
                    >
                      {src}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Social signals */}
          {hasSocial && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-2">
                Social
              </h3>
              <div className="flex flex-col gap-2">
                {hnScore > 0 && (
                  <a
                    href={article.hn_url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-orange-400 hover:text-orange-300 transition-colors"
                  >
                    <span className="font-semibold">HN</span>
                    <span>{hnScore.toLocaleString()} pts · {hnComments.toLocaleString()} comments</span>
                    <span className="text-neutral-600 text-xs">→</span>
                  </a>
                )}
                {redditScore > 0 && (
                  <a
                    href={article.reddit_url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-orange-400 hover:text-orange-300 transition-colors"
                  >
                    <span className="font-semibold">Reddit</span>
                    <span>{redditScore.toLocaleString()} pts · {redditComments.toLocaleString()} comments</span>
                    <span className="text-neutral-600 text-xs">→</span>
                  </a>
                )}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-neutral-800">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700
                       text-sm text-neutral-200 hover:text-white transition-colors"
          >
            Open original article
          </a>
        </div>
      </aside>
    </>
  );
}
