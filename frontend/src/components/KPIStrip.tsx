import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { useIsMobile, useScrollDirectionVisible } from "../lib/hooks";
import type { Stats, StaticMeta } from "../types";

interface Props {
  stats: Stats;
  title: string;
  meta?: StaticMeta | null;
}

function sentimentColor(score: number): string {
  return score > 0.1 ? "text-green-400" : score < -0.1 ? "text-red-400" : "text-neutral-400";
}

function relativeTime(iso?: string | null): string {
  if (!iso) return "never";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso.slice(0, 16);
  }
}

function SentimentBar({ score }: { score: number | null }) {
  if (score == null) return <span className="text-neutral-500">—</span>;
  const pct = ((score + 1) / 2) * 100;
  const color =
    score > 0.1 ? "bg-green-500" : score < -0.1 ? "bg-red-500" : "bg-neutral-500";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-neutral-700 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={score > 0.1 ? "text-green-400" : score < -0.1 ? "text-red-400" : "text-neutral-400"}>
        {score >= 0 ? "+" : ""}{score.toFixed(2)}
      </span>
    </div>
  );
}

export function KPIStrip({ stats, title, meta }: Props) {
  const t1_7d = stats.t1_7d ?? 0;
  const lastRun = stats.last_run;
  const lastRunAt = lastRun?.finished_at;
  const pipelineOk = lastRunAt
    ? Date.now() - new Date(lastRunAt).getTime() < 26 * 3_600_000
    : false;

  const lastRunNew = lastRun?.new ?? 0;
  const lastRunFailed = lastRun?.failed ?? 0;
  const failureRate = lastRunNew > 0 ? lastRunFailed / lastRunNew : 0;
  const highFailureRate = failureRate > 0.1 && lastRunNew > 0;

  const isStatic = !!meta;
  const isMobile = useIsMobile();
  const headerVisible = useScrollDirectionVisible(isMobile);
  const [expanded, setExpanded] = useState(false);
  const sent7d = stats.avg_sentiment_7d ?? null;

  return (
    <header
      className={`border-b border-neutral-800 bg-neutral-950 sticky top-0 z-20
                  transition-transform duration-200 ${
                    isMobile && !headerVisible ? "-translate-y-full" : "translate-y-0"
                  }`}
    >
      <div className="max-w-7xl mx-auto px-4 py-3">
        {/* ── Mobile: condensed, tap-to-expand ─────────────────────────────── */}
        <div className="sm:hidden">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center justify-between gap-3 min-h-[40px]"
            aria-expanded={expanded}
            aria-label="Toggle pipeline statistics"
          >
            <span className="flex items-center gap-2 min-w-0">
              <h1 className="text-base font-bold text-white tracking-tight truncate">{title}</h1>
              {isStatic && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-800 shrink-0">
                  snapshot
                </span>
              )}
            </span>
            <span className="flex items-center gap-3 shrink-0 tabular-nums">
              <span className="text-sm">
                <span className="text-neutral-500 text-xs mr-1">Today</span>
                <span className="font-bold text-white">{stats.today_new}</span>
              </span>
              <span className="text-sm">
                <span className="text-neutral-500 text-xs mr-1">T1</span>
                <span className={`font-bold ${t1_7d > 0 ? "text-red-400" : "text-neutral-400"}`}>{t1_7d}</span>
              </span>
              {sent7d != null && (
                <span className={`text-sm font-bold ${sentimentColor(sent7d)}`}>
                  {sent7d >= 0 ? "+" : ""}{sent7d.toFixed(2)}
                </span>
              )}
              <span className="text-neutral-600 text-xs">{expanded ? "▲" : "▼"}</span>
            </span>
          </button>

          {expanded && (
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-neutral-800 pt-3">
              <Kpi label="Today (UTC)" value={stats.today_new} />
              <Kpi label="T1 (7d)" value={t1_7d} valueClass={t1_7d > 0 ? "text-red-400" : "text-neutral-400"} />
              <div>
                <span className="text-xs text-neutral-500 block mb-0.5">Sentiment (7d)</span>
                <SentimentBar score={sent7d} />
              </div>
              <Kpi label="Noise Filtered" value={stats.noise_filtered ?? 0} valueClass="text-neutral-500" />
              {isStatic ? (
                <div>
                  <span className="text-xs text-neutral-500 block mb-0.5">Snapshot</span>
                  <span className="text-sm text-neutral-300">{relativeTime(meta?.exported_at)}</span>
                </div>
              ) : lastRun ? (
                <div>
                  <span className="text-xs text-neutral-500 block mb-0.5">Last Run</span>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${pipelineOk ? "bg-green-500" : "bg-red-500"}`}
                      aria-label={pipelineOk ? "Pipeline healthy" : "Pipeline stale"}
                    />
                    <span className="text-sm text-neutral-300">{relativeTime(lastRunAt)}</span>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* ── Desktop: full strip ──────────────────────────────────────────── */}
        <div className="hidden sm:flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-bold text-white tracking-tight">{title}</h1>
            {isStatic && (
              <span className="text-xs px-2 py-0.5 rounded bg-blue-900/40 text-blue-300 border border-blue-800">
                snapshot
              </span>
            )}
          </div>

          <nav className="flex items-center gap-6 flex-wrap" aria-label="Pipeline statistics">
            <Kpi label="Today (UTC)" value={stats.today_new} />
            <Kpi
              label="T1 (7d)"
              value={t1_7d}
              valueClass={t1_7d > 0 ? "text-red-400" : "text-neutral-400"}
            />
            <div>
              <span className="text-xs text-neutral-500 block mb-0.5">Sentiment (7d)</span>
              <SentimentBar score={stats.avg_sentiment_7d ?? null} />
            </div>
            <Kpi label="Noise Filtered" value={stats.noise_filtered ?? 0} valueClass="text-neutral-500" />

            {/* Last run / snapshot date */}
            {isStatic ? (
              <div>
                <span className="text-xs text-neutral-500 block mb-0.5">Snapshot</span>
                <span className="text-sm text-neutral-300">
                  {relativeTime(meta?.exported_at)}
                </span>
              </div>
            ) : lastRun ? (
              <div>
                <span className="text-xs text-neutral-500 block mb-0.5">Last Run</span>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${pipelineOk ? "bg-green-500" : "bg-red-500"}`}
                    aria-label={pipelineOk ? "Pipeline healthy" : "Pipeline stale"}
                  />
                  <span className="text-sm text-neutral-300">{relativeTime(lastRunAt)}</span>
                  {lastRunFailed > 0 && (
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                        highFailureRate
                          ? "bg-amber-900/50 text-amber-400 border border-amber-700"
                          : "text-neutral-500"
                      }`}
                      title={`${lastRunFailed} of ${lastRunNew} new articles failed enrichment`}
                    >
                      {lastRunFailed} failed
                    </span>
                  )}
                </div>
              </div>
            ) : null}
          </nav>
        </div>
      </div>
    </header>
  );
}

function Kpi({
  label,
  value,
  valueClass = "text-white",
}: {
  label: string;
  value: number;
  valueClass?: string;
}) {
  return (
    <div>
      <span className="text-xs text-neutral-500 block mb-0.5">{label}</span>
      <span className={`text-xl font-bold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}
