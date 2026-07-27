// Zero-dependency relative-time formatter — replaces date-fns's
// formatDistanceToNow (~15KB gzipped) with the built-in Intl API.
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function formatRelative(iso?: string, now: number = Date.now()): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const diff = (date.getTime() - now) / 1000;
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(diff) >= seconds || unit === "minute") {
      return rtf.format(Math.round(diff / seconds), unit);
    }
  }
  return "just now";
}
