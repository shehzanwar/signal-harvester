// Reading streak + weekly goal — pure localStorage bookkeeping, no server
// involvement. Deliberately subtle (see KPIStrip's rendering): a small
// "days · this week" readout, not a gamification-heavy badge system.
const KEY = "signal-streak";
export const WEEKLY_GOAL = 50; // ~7/day — sized to the tiered feed's T1/T2 subset, not the full firehose

export interface StreakData {
  current: number;
  longest: number;
  lastVisit: string; // YYYY-MM-DD, local calendar day
  weeklyRead: number;
  weekStart: string; // YYYY-MM-DD, the Monday of the current week
}

function todayStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getMonday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  d.setDate(d.getDate() - diff);
  return todayStr(d);
}

function load(): StreakData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as StreakData;
  } catch {
    /* ignore */
  }
  const today = todayStr();
  return { current: 0, longest: 0, lastVisit: "", weeklyRead: 0, weekStart: getMonday(today) };
}

function persist(d: StreakData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

/**
 * Call once per session (on mount). Increments the streak if the last
 * visit was yesterday, resets it to 1 if there's a gap of more than a day,
 * and leaves it alone if already visited today. Also rolls the weekly
 * counter over on a new Monday.
 */
export function updateStreak(): StreakData {
  const data = load();
  const today = todayStr();

  if (data.lastVisit !== today) {
    const yesterday = todayStr(new Date(Date.now() - 86_400_000));
    if (data.lastVisit === yesterday) {
      data.current += 1;
    } else {
      data.current = 1;
    }
    data.longest = Math.max(data.longest, data.current);
    data.lastVisit = today;
  }

  const weekStart = getMonday(today);
  if (data.weekStart !== weekStart) {
    data.weeklyRead = 0;
    data.weekStart = weekStart;
  }

  persist(data);
  return data;
}

/** Call when the user marks an article read (not on unread). */
export function incrementWeeklyRead(): StreakData {
  const data = load();
  data.weeklyRead += 1;
  persist(data);
  return data;
}
