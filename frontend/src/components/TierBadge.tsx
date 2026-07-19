import type { Tier } from "../types";

const CONFIG: Record<Tier, { label: string; className: string; borderClass: string }> = {
  T1:    { label: "T1 Critical", className: "bg-red-950 text-red-300 border-red-700",      borderClass: "border-l-red-500" },
  T2:    { label: "T2 Notable",  className: "bg-amber-950 text-amber-300 border-amber-700", borderClass: "border-l-amber-500" },
  T3:    { label: "T3 Background", className: "bg-blue-950 text-blue-300 border-blue-800", borderClass: "border-l-blue-600" },
  NOISE: { label: "Noise",       className: "bg-neutral-800 text-neutral-500 border-neutral-700", borderClass: "border-l-neutral-600" },
};

interface Props {
  tier: Tier;
  compact?: boolean;
}

export function TierBadge({ tier, compact = false }: Props) {
  const cfg = CONFIG[tier] ?? CONFIG.NOISE;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-xs font-semibold tracking-wide ${cfg.className}`}>
      {compact ? tier : cfg.label}
    </span>
  );
}

export function tierBorderClass(tier: Tier): string {
  return CONFIG[tier]?.borderClass ?? CONFIG.NOISE.borderClass;
}
