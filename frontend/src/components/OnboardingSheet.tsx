import { useState } from "react";
import { CATEGORY_DEFS } from "../lib/categories";
import { BottomSheet } from "./BottomSheet";

// Emoji per real category key (CATEGORY_DEFS — technology/finance/politics/
// sports/world). The original sketch this is based on invented eight topics
// (science, ai, geopolitics, ...) that don't exist as categories in this
// app's data model — matched to what's actually in frontend/src/lib/categories.ts.
const TOPIC_EMOJI: Record<string, string> = {
  technology: "💻",
  finance: "📈",
  politics: "🏛",
  sports: "⚽",
  world: "🌍",
};

interface Props {
  open: boolean;
  /** Empty set means "skipped" — caller decides what that means for prefs/weights. */
  onComplete: (selected: Set<string>) => void;
}

export function OnboardingSheet({ open, onComplete }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <BottomSheet open={open} onClose={() => onComplete(new Set())} title="What do you care about?">
      <p className="text-sm text-neutral-400 mb-4">
        Pick a few topics — "For You" mode uses this to personalize your feed
        immediately instead of starting from zero. No account needed.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {CATEGORY_DEFS.map((c) => (
          <button
            key={c.key}
            onClick={() => toggle(c.key)}
            aria-pressed={selected.has(c.key)}
            className={`p-3 rounded-xl border text-left transition-colors ${
              selected.has(c.key)
                ? "border-red-500 bg-red-500/10"
                : "border-neutral-700 bg-neutral-800/50"
            }`}
          >
            <span className="text-lg">{TOPIC_EMOJI[c.key] ?? "📰"}</span>
            <span className="block text-sm mt-1 text-neutral-200">{c.label}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => onComplete(new Set())}
          className="flex-1 py-3 rounded-xl border border-neutral-700 text-neutral-400 text-sm active:bg-neutral-800"
        >
          Skip
        </button>
        <button
          onClick={() => onComplete(selected)}
          disabled={selected.size === 0}
          className="flex-1 py-3 rounded-xl bg-red-600 text-white font-medium text-sm disabled:opacity-40"
        >
          Start my briefing{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
      </div>
    </BottomSheet>
  );
}
