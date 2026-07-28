import { useEffect, useState, type RefObject } from "react";
import { recordEngagement } from "../lib/affinity";
import type { Article } from "../types";

export interface KeyboardNavResult {
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
}

/**
 * Global keyboard shortcuts: `/` focus search, `x` toggle batch mode,
 * `1`/`2`/`3` jump to tier sections, `j`/`k` move focus, `Enter`/`o` open
 * in a new tab, `s` save, `r` mark read, `d` open detail panel. Ignored
 * while an input/textarea has focus (except `/`, which still works so you
 * can jump back into search from anywhere).
 */
export function useKeyboardNav(
  flatArticles: Article[],
  batchMode: boolean,
  setBatchMode: (v: boolean | ((prev: boolean) => boolean)) => void,
  setSelectedIds: (ids: ReadonlySet<string>) => void,
  toggleSaveTracked: (id: string) => void,
  toggleReadTracked: (id: string) => void,
  openDetail: (article: Article) => void,
  searchRef: RefObject<HTMLInputElement | null>,
): KeyboardNavResult {
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput =
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement;

      if (e.key === "/") {
        if (!inInput) {
          e.preventDefault();
          searchRef.current?.focus();
        }
        return;
      }

      if (inInput) return;

      if (e.key === "x") {
        setBatchMode((v) => !v);
        if (batchMode) setSelectedIds(new Set());
        return;
      }

      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const idMap = { "1": "section-t1", "2": "section-t2", "3": "section-t3" } as const;
        document.getElementById(idMap[e.key])?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setFocusedId((prev) => {
          if (!flatArticles.length) return null;
          const idx = flatArticles.findIndex((a) => a.id === prev);
          const next = e.key === "j" ? Math.min(idx + 1, flatArticles.length - 1) : Math.max(idx - 1, 0);
          const nextId = flatArticles[idx === -1 ? 0 : next]?.id ?? null;
          if (nextId) {
            document.querySelector(`[data-article-id="${nextId}"]`)?.scrollIntoView({
              block: "nearest",
              behavior: "smooth",
            });
          }
          return nextId;
        });
        return;
      }

      if ((e.key === "Enter" || e.key === "o") && focusedId) {
        const art = flatArticles.find((a) => a.id === focusedId);
        if (art) {
          recordEngagement(art, "open");
          window.open(art.url, "_blank", "noopener,noreferrer");
        }
        return;
      }

      if (e.key === "s" && focusedId) {
        toggleSaveTracked(focusedId);
        return;
      }

      if (e.key === "r" && focusedId) {
        toggleReadTracked(focusedId);
        return;
      }

      if (e.key === "d" && focusedId) {
        const art = flatArticles.find((a) => a.id === focusedId);
        if (art) openDetail(art);
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [flatArticles, focusedId, batchMode, setBatchMode, setSelectedIds, toggleSaveTracked, toggleReadTracked, openDetail, searchRef]);

  return { focusedId, setFocusedId };
}
