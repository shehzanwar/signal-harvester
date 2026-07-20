import { useCallback, useEffect, useState } from "react";

export type Interest = "high" | "normal" | "low";

export interface Prefs {
  mutedTags: string[]; // exact (lowercased) tag matches -> hide card
  mutedKeywords: string[]; // substring match on title/summary -> hide card
  categoryInterest: Record<string, Interest>; // per category key
  categoryOrder: string[]; // ordering of category keys in the bar
}

export const DEFAULT_CATEGORY_ORDER = ["technology", "finance", "politics", "sports", "world"];

export const DEFAULT_PREFS: Prefs = {
  mutedTags: [],
  mutedKeywords: [],
  categoryInterest: {},
  categoryOrder: DEFAULT_CATEGORY_ORDER,
};

const KEY = "signal-prefs";

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<Prefs>;
    // Merge any categories missing from a stored order (e.g. a new category was added).
    const order = p.categoryOrder?.length ? [...p.categoryOrder] : [...DEFAULT_CATEGORY_ORDER];
    for (const c of DEFAULT_CATEGORY_ORDER) if (!order.includes(c)) order.push(c);
    return {
      mutedTags: p.mutedTags ?? [],
      mutedKeywords: p.mutedKeywords ?? [],
      categoryInterest: p.categoryInterest ?? {},
      categoryOrder: order,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage disabled — ignore */
  }
}

export function usePrefs(): [Prefs, (updater: (p: Prefs) => Prefs) => void, (p: Prefs) => void] {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const update = useCallback((updater: (p: Prefs) => Prefs) => {
    setPrefs((prev) => {
      const next = updater(prev);
      savePrefs(next);
      return next;
    });
  }, []);
  const replace = useCallback((p: Prefs) => {
    savePrefs(p);
    setPrefs(p);
  }, []);
  // Keep in sync if another tab edits prefs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setPrefs(loadPrefs());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return [prefs, update, replace];
}

/** True if the article should be hidden by the user's mute rules. */
export function isMuted(
  article: { tags?: string[]; title?: string; enrich_summary?: string },
  prefs: Prefs,
): boolean {
  if (prefs.mutedTags.length) {
    const muted = new Set(prefs.mutedTags.map((t) => t.toLowerCase()));
    if ((article.tags ?? []).some((t) => muted.has(t.toLowerCase()))) return true;
  }
  if (prefs.mutedKeywords.length) {
    const hay = `${article.title ?? ""} ${article.enrich_summary ?? ""}`.toLowerCase();
    if (prefs.mutedKeywords.some((k) => k && hay.includes(k.toLowerCase()))) return true;
  }
  return false;
}
