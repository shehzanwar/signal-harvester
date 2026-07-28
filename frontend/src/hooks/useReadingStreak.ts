import { useCallback, useEffect, useState } from "react";
import { incrementWeeklyRead, updateStreak, type StreakData } from "../lib/streak";

export interface ReadingStreakResult {
  streak: StreakData | null;
  /** Call when an article is marked read (not on unread) — bumps the weekly count. */
  recordRead: () => void;
}

/**
 * Reading streak + weekly goal (Task 4.4). Rolled over once per session on
 * mount (new day / new week), then bumped again each time an article is
 * marked read so the KPI strip reflects the current count without a reload.
 */
export function useReadingStreak(): ReadingStreakResult {
  const [streak, setStreak] = useState<StreakData | null>(null);
  useEffect(() => {
    setStreak(updateStreak());
  }, []);
  const recordRead = useCallback(() => {
    setStreak(incrementWeeklyRead());
  }, []);
  return { streak, recordRead };
}
