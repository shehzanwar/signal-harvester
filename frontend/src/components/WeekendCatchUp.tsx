import { useMemo, useState } from "react";
import { formatRelative } from "../lib/format";
import type { Article } from "../types";

const WINDOW_DAYS = 7;
const MIN_AGE_HOURS = 48;
const MIN_SOCIAL = 100;
const LIMIT = 3;

interface Props {
  articles: Article[];
  readIds: Set<string>;
  onOpen: (article: Article) => void;
}

/**
 * Sunday-only "weekend catch-up" (Part 3, Move 4 of the niches/T2-T3
 * proposal) — the flip side of demoting T3 to archive: unread T2/T3 stops
 * being a guilt pile and becomes a short, deliberate Sunday read instead.
 * Surfaces up to 3 unread stories from the past week that are old enough
 * to be settled (>=48h, so same-day noise doesn't qualify) and clearly
 * resonated with real engagement elsewhere.
 *
 * The original proposal describes this as a Sunday Discord digest line —
 * implemented here as a frontend panel instead, because read/save state
 * is client-side only (localStorage); the backend's weekly-digest job has
 * no way to know what was actually opened, so it can't compute "unread"
 * on its own.
 */
export function WeekendCatchUp({ articles, readIds, onOpen }: Props) {
  const isSunday = new Date().getDay() === 0;

  const picks = useMemo(() => {
    if (!isSunday) return [];
    const now = Date.now();
    const windowCutoff = now - WINDOW_DAYS * 86_400_000;
    const ageCutoff = now - MIN_AGE_HOURS * 3_600_000;
    return articles
      .filter((a) => {
        if (a.tier !== "T2" && a.tier !== "T3") return false;
        if (readIds.has(a.id)) return false;
        if ((a.social_score ?? 0) < MIN_SOCIAL) return false;
        if (!a.published_at) return false;
        const t = new Date(a.published_at).getTime();
        return t >= windowCutoff && t <= ageCutoff;
      })
      .sort((a, b) => (b.social_score ?? 0) - (a.social_score ?? 0))
      .slice(0, LIMIT);
    // readIds mutating shouldn't re-roll this list mid-session (marking one
    // read shouldn't make the next-best pick pop in) — recompute on article
    // set change or an explicit day change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articles, isSunday]);

  const [open, setOpen] = useState(false);

  if (!isSunday || picks.length === 0) return null;

  return (
    <section className="mb-6 rounded-xl bg-neutral-900/30 border border-neutral-800/50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-4 text-left"
        aria-expanded={open}
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          📚 Weekend Catch-Up
          <span className="ml-2 normal-case text-neutral-600">
            {picks.length} {picks.length === 1 ? "story" : "stories"}
          </span>
        </h2>
        <span className={`text-neutral-600 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-xs text-neutral-600 mb-1">
            Stories you skipped this week that readers everywhere loved.
          </p>
          {picks.map((a) => (
            <button
              key={a.id}
              onClick={() => onOpen(a)}
              className="w-full text-left p-3 rounded-lg bg-neutral-900/50 border border-neutral-800 hover:border-neutral-600 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full shrink-0 ${a.tier === "T2" ? "bg-amber-500" : "bg-blue-500"}`} aria-hidden />
                <span className="text-sm font-medium text-neutral-100 line-clamp-1">{a.title}</span>
              </div>
              <p className="mt-1 ml-4 text-xs text-neutral-500">
                <span className="text-neutral-300">{a.feed_name}</span>
                {" · "}
                {formatRelative(a.published_at)}
                {` · ${a.social_score} social`}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
