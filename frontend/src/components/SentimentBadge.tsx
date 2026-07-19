import type { SentimentLabel } from "../types";

const CONFIG: Record<SentimentLabel, { label: string; icon: string; className: string }> = {
  positive: { label: "positive", icon: "↑", className: "bg-green-950 text-green-400 border-green-800" },
  negative: { label: "negative", icon: "↓", className: "bg-red-950 text-red-400 border-red-800" },
  neutral:  { label: "neutral",  icon: "→", className: "bg-neutral-800 text-neutral-400 border-neutral-700" },
  mixed:    { label: "mixed",    icon: "↕", className: "bg-purple-950 text-purple-400 border-purple-800" },
};

interface Props {
  label: SentimentLabel;
  score: number;
  rationale?: string;
  compact?: boolean;
}

export function SentimentBadge({ label, score, rationale, compact = false }: Props) {
  const cfg = CONFIG[label] ?? CONFIG.neutral;
  const sign = score >= 0 ? "+" : "";

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-medium ${cfg.className}`}
      title={rationale}
      aria-label={`Sentiment: ${label} (${sign}${score.toFixed(2)})${rationale ? ` — ${rationale}` : ""}`}
    >
      <span aria-hidden="true">{cfg.icon}</span>
      {!compact && <span>{cfg.label}</span>}
      <span className="opacity-70">{sign}{score.toFixed(2)}</span>
    </span>
  );
}
