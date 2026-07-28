import { useCallback, useState } from "react";
import type { Prefs } from "../lib/prefs";
import type { Article } from "../types";

export interface BatchOperationsResult {
  batchMode: boolean;
  setBatchMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  selectedIds: ReadonlySet<string>;
  setSelectedIds: (ids: ReadonlySet<string>) => void;
  toggleSelect: (id: string) => void;
  batchMarkRead: () => void;
  batchSave: () => void;
  batchMute: () => void;
  exitBatch: () => void;
}

/**
 * Multi-select mode: mark-read/save/mute several articles at once, each
 * with its own undo toast. Mutates the same readIds/savedIds sets the
 * single-article actions do (via the raw `toggleRead`/`toggleSave`, not
 * the "Tracked" wrappers — batch shows one summary toast, not N individual
 * ones).
 */
export function useBatchOperations(
  readIds: Set<string>,
  savedIds: Set<string>,
  toggleRead: (id: string) => void,
  toggleSave: (id: string) => void,
  flatArticles: Article[],
  prefs: Prefs,
  updatePrefs: (updater: (p: Prefs) => Prefs) => void,
  showToast: (message: string, undo: () => void) => void,
): BatchOperationsResult {
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const batchMarkRead = useCallback(() => {
    selectedIds.forEach((id) => { if (!readIds.has(id)) toggleRead(id); });
    setBatchMode(false);
    setSelectedIds(new Set());
    showToast(`Marked ${selectedIds.size} read`, () => {
      selectedIds.forEach((id) => toggleRead(id));
    });
  }, [selectedIds, readIds, toggleRead, showToast]);

  const batchSave = useCallback(() => {
    selectedIds.forEach((id) => { if (!savedIds.has(id)) toggleSave(id); });
    setBatchMode(false);
    setSelectedIds(new Set());
    showToast(`Saved ${selectedIds.size}`, () => {
      selectedIds.forEach((id) => toggleSave(id));
    });
  }, [selectedIds, savedIds, toggleSave, showToast]);

  const batchMute = useCallback(() => {
    const prevMuted = [...prefs.mutedTags];
    const selected = flatArticles.filter((a) => selectedIds.has(a.id));
    const tags = [...new Set(selected.flatMap((a) => (a.tags ?? []).map((t) => t.toLowerCase())))];
    if (tags.length === 0) return;
    updatePrefs((p) => ({ ...p, mutedTags: [...new Set([...p.mutedTags, ...tags])] }));
    const count = selectedIds.size;
    setBatchMode(false);
    setSelectedIds(new Set());
    showToast(
      `Muted ${tags.length} tag${tags.length !== 1 ? "s" : ""} from ${count} article${count !== 1 ? "s" : ""}`,
      () => updatePrefs((p) => ({ ...p, mutedTags: prevMuted })),
    );
  }, [selectedIds, flatArticles, prefs.mutedTags, updatePrefs, showToast]);

  const exitBatch = useCallback(() => {
    setBatchMode(false);
    setSelectedIds(new Set());
  }, []);

  return { batchMode, setBatchMode, selectedIds, setSelectedIds, toggleSelect, batchMarkRead, batchSave, batchMute, exitBatch };
}
