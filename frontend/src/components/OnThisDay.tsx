import { useMemo } from "react";
import type { Article } from "../types";

const TARGETS = [
  { days: 7, label: "1 week ago" },
  { days: 30, label: "1 month ago" },
] as const;

interface Props {
  articles: Article[];
  onOpen: (article: Article) => void;
}

/**
 * T1 articles from exactly 7 and 30 days ago — cheap to offer since T1 is
 * the one tier exempt from retention pruning (see RetentionConfig in
 * harvester/config.py: T2/untiered 90 days, T3 21 days, T1 kept forever),
 * so "a month ago" reliably still has data to show, not an empty gap.
 */
export function OnThisDay({ articles, onOpen }: Props) {
  const memories = useMemo(() => {
    const now = new Date();
    const results: { label: string; article: Article }[] = [];

    for (const { days, label } of TARGETS) {
      const target = new Date(now.getTime() - days * 86_400_000);
      const dayStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;

      const fromDay = articles.filter((a) => a.tier === "T1" && a.published_at?.startsWith(dayStr));
      if (fromDay.length === 0) continue;

      const top = fromDay.slice().sort((a, b) => (b.social_score ?? 0) - (a.social_score ?? 0))[0];
      results.push({ label, article: top });
    }
    return results;
  }, [articles]);

  if (memories.length === 0) return null;

  return (
    <section className="mb-6 p-4 rounded-xl bg-neutral-900/30 border border-neutral-800/50">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">
        🕰 On This Day
      </h2>
      <div className="flex flex-col gap-2">
        {memories.map(({ label, article }) => (
          <button
            key={article.id}
            onClick={() => onOpen(article)}
            className="block w-full text-left"
          >
            <span className="text-xs text-neutral-500">{label}:</span>
            <span className="ml-2 text-sm text-neutral-300 hover:text-white transition-colors line-clamp-1">
              {article.title}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
