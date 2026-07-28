import { useCallback, type RefObject } from "react";
import { recordEngagement } from "../lib/affinity";
import { useLocalSet } from "../lib/hooks";
import type { Article } from "../types";

export interface ReadSaveTrackingResult {
  readIds: Set<string>;
  savedIds: Set<string>;
  /** Raw toggles, no toast/engagement side effects — for batch operations, which show their own summary toast. */
  toggleRead: (id: string) => void;
  toggleSave: (id: string) => void;
  /** Single-article toggles: records the affinity signal, bumps the reading streak, and shows an undo toast. */
  toggleReadTracked: (id: string) => void;
  toggleSaveTracked: (id: string) => void;
}

/**
 * Read/saved id sets plus the "tracked" wrappers used by individual card/
 * detail-panel actions (as opposed to batch operations, which mutate the
 * same underlying sets directly and show their own summary toast instead).
 */
export function useReadSaveTracking(
  articlesDataRef: RefObject<Article[]>,
  showToast: (message: string, undo: () => void) => void,
  onMarkRead: () => void,
): ReadSaveTrackingResult {
  const [readIds, toggleRead] = useLocalSet("signal-read");
  const [savedIds, toggleSave] = useLocalSet("signal-saved");

  const toggleSaveTracked = useCallback(
    (id: string) => {
      const isSaving = !savedIds.has(id);
      if (isSaving) {
        const a = (articlesDataRef.current ?? []).find((x) => x.id === id);
        if (a) recordEngagement(a, "save");
      }
      toggleSave(id);
      showToast(isSaving ? "Saved ★" : "Unsaved", () => toggleSave(id));
    },
    [savedIds, toggleSave, showToast, articlesDataRef],
  );

  const toggleReadTracked = useCallback(
    (id: string) => {
      const isMarkingRead = !readIds.has(id);
      toggleRead(id);
      if (isMarkingRead) onMarkRead();
      showToast(isMarkingRead ? "Marked read" : "Marked unread", () => toggleRead(id));
    },
    [readIds, toggleRead, showToast, onMarkRead],
  );

  return { readIds, savedIds, toggleRead, toggleSave, toggleReadTracked, toggleSaveTracked };
}
