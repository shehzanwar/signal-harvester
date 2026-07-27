import { useMemo } from "react";
import { formatRelative } from "../lib/format";
import type { Article } from "../types";

const WINDOW_DAYS = 7;
const LIMIT = 10;

interface Props {
  articles: Article[];
  onOpen: (article: Article) => void;
}

/**
 * Stories covered by exactly one source that are still tier T1/T2 — i.e.
 * the enrichment model judged them editorially important despite the wider
 * media (or at least this profile's feed set) not picking them up.
 * Ground News calls this a "blindspot"; the idea translates directly since
 * `cluster_size` already is "how many sources corroborate this."
 */
export function BlindspotPanel({ articles, onOpen }: Props) {
  const blindspots = useMemo(() => {
    const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
    return articles
      .filter((a) => {
        if ((a.cluster_size ?? 1) !== 1) return false;
        if (a.tier !== "T1" && a.tier !== "T2") return false;
        if (!a.published_at) return false;
        return new Date(a.published_at).getTime() >= cutoff;
      })
      .sort((a, b) => (b.social_score ?? 0) - (a.social_score ?? 0))
      .slice(0, LIMIT);
  }, [articles]);

  if (blindspots.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wide mb-3">
        🔍 Blindspots — Only 1 Source Reporting
      </h2>
      <div className="space-y-2">
        {blindspots.map((a) => (
          <button
            key={a.id}
            onClick={() => onOpen(a)}
            className="w-full text-left p-3 rounded-lg bg-neutral-900/50 border border-neutral-800 hover:border-neutral-600 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full shrink-0 ${a.tier === "T1" ? "bg-red-500" : "bg-amber-500"}`} aria-hidden />
              <span className="text-sm font-medium text-neutral-100 line-clamp-1">{a.title}</span>
            </div>
            <p className="mt-1 ml-4 text-xs text-neutral-500">
              Only reported by <span className="text-neutral-300">{a.feed_name}</span>
              {" · "}
              {formatRelative(a.published_at)}
              {(a.social_score ?? 0) > 0 && ` · ${a.social_score} social`}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
}
