// Feed-derived category navigation. Deterministic (no LLM) — each feed declares
// its category in the profile, and articles inherit it. This is the primary way
// to slice the feed, especially on mobile. Order comes from the user's prefs.
interface Props {
  categories: { key: string; label: string }[]; // already in the user's order
  counts: Record<string, number>; // category key -> story count, plus "all"
  selected: string | null; // null = All
  onSelect: (key: string | null) => void;
}

export function CategoryBar({ categories, counts, selected, onSelect }: Props) {
  // Only show categories that actually have stories, so the bar stays honest
  // across profiles with different feed mixes.
  const visible = categories.filter((c) => (counts[c.key] ?? 0) > 0);

  const chip = (key: string | null, label: string, count: number) => {
    const active = selected === key;
    return (
      <button
        key={key ?? "all"}
        onClick={() => onSelect(key)}
        aria-pressed={active}
        className={`shrink-0 text-sm px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${
          active
            ? "bg-blue-900/40 border-blue-600 text-blue-200"
            : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        }`}
      >
        {label}
        <span className={`ml-1.5 text-xs ${active ? "text-blue-300/70" : "text-neutral-600"}`}>
          {count}
        </span>
      </button>
    );
  };

  return (
    <nav
      aria-label="Categories"
      className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 mb-5
                 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {chip(null, "All", counts.all ?? 0)}
      {visible.map((c) => chip(c.key, c.label, counts[c.key] ?? 0))}
    </nav>
  );
}
