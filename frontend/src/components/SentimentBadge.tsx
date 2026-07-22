import type { SentimentLabel } from "../types";

const CONFIG: Record<SentimentLabel, { label: string; icon: string; className: string }> = {
  positive: { label: "positive", icon: "↑", className: "bg-green-950 text-green-400 border-green-800" },
  negative: { label: "negative", icon: "↓", className: "bg-red-950 text-red-400 border-red-800" },
  neutral:  { label: "neutral",  icon: "→", className: "bg-neutral-800 text-neutral-400 border-neutral-700" },
  mixed:    { label: "mixed",    icon: "↕", className: "bg-purple-950 text-purple-400 border-purple-800" },
};

const KIND_META: Record<string, { prefix: string; borderStyle: string; title: string }> = {
  editorial: { prefix: "Ed",  borderStyle: "border-solid",  title: "Editorial tone — how the press framed this story" },
  predicted: { prefix: "Est", borderStyle: "border-dashed", title: "Estimated public reaction — model prediction" },
  public:    { prefix: "Pub", borderStyle: "border-dotted", title: "Actual public sentiment from comments" },
};

interface Props {
  label: SentimentLabel;
  score: number;
  rationale?: string;
  compact?: boolean;
  kind?: "editorial" | "predicted" | "public";
}

export function SentimentBadge({ label, score, rationale, compact = false, kind }: Props) {
  const cfg = CONFIG[label] ?? CONFIG.neutral;
  const km = kind ? KIND_META[kind] : null;
  const sign = score >= 0 ? "+" : "";
  const titleText = km ? `${km.title}${rationale ? ` — ${rationale}` : ""}` : rationale;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border ${km?.borderStyle ?? "border-solid"} ${cfg.className}`}
      title={titleText}
      aria-label={`${kind ? `${kind} ` : ""}sentiment: ${label} (${sign}${score.toFixed(2)})${rationale ? ` — ${rationale}` : ""}`}
    >
      {km && <span className="opacity-40 font-normal">{km.prefix}·</span>}
      <span aria-hidden="true">{cfg.icon}</span>
      {!compact && <span>{cfg.label}</span>}
      <span className="opacity-70">{sign}{score.toFixed(2)}</span>
    </span>
  );
}
