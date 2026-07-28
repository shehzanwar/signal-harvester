import { useMemo, useState } from "react";
import { useWikipediaOnThisDay } from "../hooks/useWikipediaOnThisDay";
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

  const { events, error } = useWikipediaOnThisDay();
  const [expanded, setExpanded] = useState<number | null>(null);
  // Collapsed by default — a "look back" section shouldn't compete with
  // today's actual news for the first screen on mobile. Not persisted
  // across sessions: this defaults shut every visit, same as a social
  // feed's "On this day" memory card you tap open rather than one that's
  // already expanded and pushing today's posts down.
  const [sectionOpen, setSectionOpen] = useState(false);

  if (memories.length === 0 && events.length === 0) return null;

  const itemCount = memories.length + events.length;

  return (
    <section className="mb-6 rounded-xl bg-neutral-900/30 border border-neutral-800/50">
      <button
        onClick={() => setSectionOpen((v) => !v)}
        className="flex w-full items-center justify-between p-4 text-left"
        aria-expanded={sectionOpen}
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          🕰 On This Day
          <span className="ml-2 normal-case text-neutral-600">
            {itemCount} {itemCount === 1 ? "item" : "items"}
          </span>
        </h2>
        <span className={`text-neutral-600 transition-transform ${sectionOpen ? "rotate-180" : ""}`} aria-hidden>
          ▾
        </span>
      </button>

      {sectionOpen && (
        <div className="px-4 pb-4">
          {memories.length > 0 && (
            <div className="flex flex-col gap-2 mb-3">
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
          )}

          {/* Wikipedia historical events for today's month/day — a separate
              subsection from the T1 memories above, since these are years-ago
              history rather than recent coverage. Silently omitted on fetch
              failure (no API key/backend involved, so a network hiccup here
              shouldn't show as an error state in the middle of the dashboard). */}
          {!error && events.length > 0 && (
            <div className={memories.length > 0 ? "pt-3 border-t border-neutral-800/50" : ""}>
              <p className="text-xs text-neutral-600 mb-2">In history</p>
              <div className="flex flex-col gap-1.5">
                {events.map((event, i) => {
                  const page = event.pages[0];
                  const isOpen = expanded === i;
                  return (
                    <div key={`${event.year}-${i}`}>
                      <button
                        onClick={() => setExpanded(isOpen ? null : i)}
                        className="block w-full text-left"
                        aria-expanded={isOpen}
                      >
                        <span className="text-xs text-neutral-500">{event.year}:</span>
                        <span className="ml-2 text-sm text-neutral-300 hover:text-white transition-colors line-clamp-1">
                          {event.text}
                        </span>
                      </button>
                      {isOpen && page && (
                        <div className="mt-1.5 ml-1 pl-3 border-l border-neutral-800 text-xs text-neutral-500">
                          <p className="mb-1">{page.extract}</p>
                          {page.url && (
                            <a
                              href={page.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-neutral-400 hover:text-neutral-200 underline underline-offset-2"
                            >
                              {page.title} on Wikipedia →
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
