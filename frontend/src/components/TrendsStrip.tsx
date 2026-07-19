import { useState } from "react";
import type { TrendsDay, TrendingTag, TrendsResponse } from "../types";

interface Props {
  trends: TrendsResponse;
}

// ── Sentiment Sparkline (SVG) ────────────────────────────────────────────────
function Sparkline({ days }: { days: TrendsDay[] }) {
  const recent = days.slice(-14);
  if (recent.length < 2) return <span className="text-neutral-600 text-xs">not enough data</span>;

  const W = 160;
  const H = 32;
  const pad = 2;

  const points = recent.map((d, i) => {
    const x = pad + (i / (recent.length - 1)) * (W - pad * 2);
    const score = d.avg_sentiment ?? 0;
    // Map [-1, 1] to [H-pad, pad]
    const y = pad + ((1 - score) / 2) * (H - pad * 2);
    return { x, y, score };
  });

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const avgScore =
    points.reduce((s, p) => s + p.score, 0) / points.length;
  const lineColor =
    avgScore > 0.05 ? "#4ade80" : avgScore < -0.05 ? "#f87171" : "#737373";
  const midY = (H / 2).toFixed(1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-32 h-8" aria-hidden>
      {/* zero line */}
      <line x1={pad} y1={midY} x2={W - pad} y2={midY} stroke="#404040" strokeWidth="0.5" />
      <polyline
        points={polyline}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* End dot */}
      <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="2" fill={lineColor} />
    </svg>
  );
}

// ── Mini stacked tier bars ───────────────────────────────────────────────────
function TierBars({ days }: { days: TrendsDay[] }) {
  const recent = days.slice(-7);
  const maxTotal = Math.max(
    ...recent.map((d) => (d.T1 ?? 0) + (d.T2 ?? 0) + (d.T3 ?? 0)),
    1,
  );

  return (
    <div className="flex items-end gap-0.5 h-8">
      {recent.map((d, i) => {
        const t1 = d.T1 ?? 0;
        const t2 = d.T2 ?? 0;
        const t3 = d.T3 ?? 0;
        const total = t1 + t2 + t3;
        const barH = Math.max((total / maxTotal) * 32, total > 0 ? 2 : 0);

        return (
          <div
            key={d.date ?? i}
            className="flex flex-col-reverse w-4 overflow-hidden rounded-t"
            style={{ height: `${barH}px` }}
            title={`${d.date}: T1=${t1} T2=${t2} T3=${t3}`}
          >
            {t3 > 0 && (
              <div
                className="bg-blue-600"
                style={{ height: `${(t3 / total) * 100}%` }}
              />
            )}
            {t2 > 0 && (
              <div
                className="bg-amber-500"
                style={{ height: `${(t2 / total) * 100}%` }}
              />
            )}
            {t1 > 0 && (
              <div
                className="bg-red-500"
                style={{ height: `${(t1 / total) * 100}%` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main TrendsStrip ─────────────────────────────────────────────────────────
export function TrendsStrip({ trends }: Props) {
  const [open, setOpen] = useState(false);

  const hasData = trends.daily.length > 0;

  return (
    <div className="border-t border-neutral-800 mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
        aria-expanded={open}
      >
        <span className="font-semibold uppercase tracking-wider">Trends</span>
        <span>{open ? "▲" : "▼"}</span>
      </button>

      {open && hasData && (
        <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-3 gap-6">
          {/* Sentiment sparkline */}
          <div>
            <p className="text-xs text-neutral-500 mb-2 font-medium">Sentiment (14d)</p>
            <div className="flex items-center gap-3">
              <Sparkline days={trends.daily} />
              {trends.daily.length > 0 && (() => {
                const last = trends.daily[trends.daily.length - 1];
                const s = last.avg_sentiment;
                return s != null ? (
                  <span
                    className={`text-sm font-bold tabular-nums ${
                      s > 0.05 ? "text-green-400" : s < -0.05 ? "text-red-400" : "text-neutral-400"
                    }`}
                  >
                    {s >= 0 ? "+" : ""}{s.toFixed(2)}
                  </span>
                ) : null;
              })()}
            </div>
          </div>

          {/* Tier volume */}
          <div>
            <p className="text-xs text-neutral-500 mb-2 font-medium">Daily Volume (7d)</p>
            <div className="flex items-end gap-1">
              <TierBars days={trends.daily} />
              <div className="flex flex-col gap-0.5 ml-2 text-xs text-neutral-600">
                <span><span className="inline-block w-2 h-2 bg-red-500 rounded-sm mr-1" />T1</span>
                <span><span className="inline-block w-2 h-2 bg-amber-500 rounded-sm mr-1" />T2</span>
                <span><span className="inline-block w-2 h-2 bg-blue-600 rounded-sm mr-1" />T3</span>
              </div>
            </div>
          </div>

          {/* Trending tags */}
          <div>
            <p className="text-xs text-neutral-500 mb-2 font-medium">
              {trends.trending.length > 0 ? "Trending Today" : "Top Tags (30d)"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(trends.trending.length > 0 ? trends.trending : trends.top_tags.slice(0, 8)).map(
                (item) => {
                  const isTrending = "ratio" in item;
                  const tag = item.tag;
                  const extra = isTrending
                    ? `${(item as TrendingTag).ratio}x`
                    : `${(item as { count: number }).count}`;
                  return (
                    <span
                      key={tag}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        isTrending
                          ? "bg-amber-900/30 text-amber-300 border-amber-700"
                          : "bg-neutral-800 text-neutral-400 border-neutral-700"
                      }`}
                    >
                      {tag}
                      {" "}
                      <span className="opacity-60">{extra}</span>
                    </span>
                  );
                },
              )}
            </div>
          </div>
        </div>
      )}

      {open && !hasData && (
        <p className="px-4 pb-4 text-xs text-neutral-600">
          No trend data yet — run the pipeline a few days to build history.
        </p>
      )}
    </div>
  );
}
