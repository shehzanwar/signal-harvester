// Canonical category display definitions, shared by the category bar and the
// preferences panel. Keys must match FeedConfig.category in the backend profile.
export const CATEGORY_DEFS: { key: string; label: string }[] = [
  { key: "technology", label: "Tech" },
  { key: "finance", label: "Finance" },
  { key: "politics", label: "Politics" },
  { key: "sports", label: "Sports" },
  { key: "world", label: "World" },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORY_DEFS.map((c) => [c.key, c.label]),
);

/** Category defs in the user's preferred order (falls back to canonical). */
export function orderedCategories(order: string[]): { key: string; label: string }[] {
  const known = new Map(CATEGORY_DEFS.map((c) => [c.key, c]));
  const out: { key: string; label: string }[] = [];
  for (const key of order) {
    const def = known.get(key);
    if (def) {
      out.push(def);
      known.delete(key);
    }
  }
  for (const def of known.values()) out.push(def); // any not in order, appended
  return out;
}
