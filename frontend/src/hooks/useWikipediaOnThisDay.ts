import { useEffect, useState } from "react";

export interface WikiOtdPage {
  title: string;
  extract: string;
  thumbnailUrl: string | null;
  url: string | null;
}

export interface WikiOtdEvent {
  year: number;
  text: string;
  pages: WikiOtdPage[];
}

interface WikiRestPage {
  title: string;
  extract?: string;
  thumbnail?: { source: string };
  content_urls?: { desktop?: { page?: string } };
}

interface WikiRestEvent {
  year: number;
  text: string;
  pages?: WikiRestPage[];
}

const CACHE_PREFIX = "signal-wiki-otd-";
// Historical "on this day" events for a given month/day never change, so the
// cache has no expiry — it's keyed by calendar day (MM-DD), not by year.
const MAX_EVENTS = 6;

function cacheKey(month: string, day: string): string {
  return `${CACHE_PREFIX}${month}-${day}`;
}

function normalize(raw: WikiRestEvent[]): WikiOtdEvent[] {
  return raw
    .filter((e) => (e.pages ?? []).some((p) => p.extract))
    .slice(0, MAX_EVENTS)
    .map((e) => ({
      year: e.year,
      text: e.text,
      pages: (e.pages ?? [])
        .filter((p) => p.extract)
        .map((p) => ({
          title: p.title,
          extract: p.extract ?? "",
          thumbnailUrl: p.thumbnail?.source ?? null,
          url: p.content_urls?.desktop?.page ?? null,
        })),
    }));
}

export interface WikipediaOnThisDayResult {
  events: WikiOtdEvent[];
  loading: boolean;
  error: boolean;
}

/**
 * Wikipedia's public "on this day" REST API (CORS-enabled, no API key —
 * designed for direct browser use: https://en.wikipedia.org/api/rest_v1/).
 * Fetched once per calendar day and cached in localStorage forever after
 * that (the events for July 28 don't change year to year), so this never
 * re-fetches on remount within the same day and works identically in
 * static-export mode (no backend involved at all).
 */
export function useWikipediaOnThisDay(): WikipediaOnThisDayResult {
  const [events, setEvents] = useState<WikiOtdEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const key = cacheKey(month, day);

    try {
      const cached = localStorage.getItem(key);
      if (cached) {
        setEvents(JSON.parse(cached) as WikiOtdEvent[]);
        setLoading(false);
        return;
      }
    } catch {
      /* corrupt cache entry — fall through to a fresh fetch */
    }

    fetch(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/${month}/${day}`)
      .then((res) => {
        if (!res.ok) throw new Error(`wikipedia otd: ${res.status}`);
        return res.json();
      })
      .then((data: { selected?: WikiRestEvent[] }) => {
        if (cancelled) return;
        const normalized = normalize(data.selected ?? []);
        setEvents(normalized);
        try {
          localStorage.setItem(key, JSON.stringify(normalized));
        } catch {
          /* quota / disabled storage — ignore, just re-fetches next time */
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { events, loading, error };
}
