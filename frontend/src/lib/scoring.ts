// Deterministic, inspectable "For You" scoring. Every card's rank is the sum of
// named contributions (tier, category interest, corroboration, social, recency,
// read penalty, learned affinity) — so we can always show *why* it ranked where
// it did. That transparency is the anti-Twitter differentiator.
import type { Article } from "../types";
import { articleFeatures, rawAffinity } from "./affinity";
import type { Interest, Prefs } from "./prefs";

const TIER_WEIGHT: Record<string, number> = { T1: 3, T2: 1.5, T3: 0.3, NOISE: -5 };
const INTEREST_WEIGHT: Record<Interest, number> = { high: 1.5, normal: 0, low: -1.5 };

export interface ScoreBreakdown {
  total: number;
  tier: number;
  interest: number;
  cluster: number;
  social: number;
  recency: number;
  read: number;
  affinity: number;
}

export function scoreArticle(
  a: Article,
  opts: { prefs: Prefs; weights: Record<string, number>; isRead: boolean; now: number },
): ScoreBreakdown {
  const { prefs, weights, isRead, now } = opts;

  const tier = TIER_WEIGHT[a.tier] ?? 0;
  const interest = INTEREST_WEIGHT[prefs.categoryInterest[a.category ?? ""] ?? "normal"];

  const size = a.cluster_size ?? 1;
  const cluster = size > 1 ? Math.log2(size) * 0.4 : 0;

  const socialScore = (a.hn_score ?? 0) + (a.reddit_score ?? 0);
  const social = socialScore > 0 ? Math.log10(socialScore + 1) * 0.3 : 0;

  let recency = 0;
  if (a.published_at) {
    const hrs = (now - new Date(a.published_at).getTime()) / 3_600_000;
    if (hrs >= 0) recency = 1.5 * Math.exp(-hrs / 72); // ~3-day decay
  }

  const read = isRead ? -3 : 0;

  // Bounded via tanh so learned affinity nudges the order but never dominates
  // the editorial tier signal.
  const raw = rawAffinity(articleFeatures(a), weights);
  let affinity = Math.tanh(raw / 4) * 2;
  // Anti-filter-bubble: never let negative affinity demote a T1.
  if (a.tier === "T1" && affinity < 0) affinity = 0;

  const total = tier + interest + cluster + social + recency + read + affinity;
  return { total, tier, interest, cluster, social, recency, read, affinity };
}

/**
 * Rank reps by score, but reserve ~1-in-7 slots for the freshest item not yet
 * placed. That exploration keeps a personalized feed from collapsing into a
 * filter bubble — you always see some new, non-personalized signal.
 */
export function forYouOrder(reps: Article[], scoreOf: (a: Article) => number): Article[] {
  const scored = reps
    .map((a) => ({ a, s: scoreOf(a) }))
    .sort((x, y) => y.s - x.s);
  const byRecency = [...reps].sort((x, y) =>
    (y.published_at ?? "").localeCompare(x.published_at ?? ""),
  );

  const out: Article[] = [];
  const placed = new Set<string>();
  let ri = 0;
  let ei = 0;
  for (let i = 0; i < reps.length; i++) {
    const explore = (i + 1) % 7 === 0;
    if (explore) {
      while (ei < byRecency.length && placed.has(byRecency[ei].id)) ei++;
      if (ei < byRecency.length) {
        const a = byRecency[ei++];
        out.push(a);
        placed.add(a.id);
        continue;
      }
    }
    while (ri < scored.length && placed.has(scored[ri].a.id)) ri++;
    if (ri < scored.length) {
      const a = scored[ri++].a;
      out.push(a);
      placed.add(a.id);
    }
  }
  return out;
}

const BREAKDOWN_LABELS: { key: keyof Omit<ScoreBreakdown, "total">; label: string }[] = [
  { key: "tier", label: "Tier" },
  { key: "affinity", label: "Your taps" },
  { key: "interest", label: "Category interest" },
  { key: "recency", label: "Recency" },
  { key: "cluster", label: "Corroboration" },
  { key: "social", label: "Social" },
  { key: "read", label: "Already read" },
];

/** Non-zero contributions, largest magnitude first, for the "why ranked" view. */
export function breakdownRows(b: ScoreBreakdown): { label: string; value: number }[] {
  return BREAKDOWN_LABELS.map(({ key, label }) => ({ label, value: b[key] }))
    .filter((r) => Math.abs(r.value) > 0.001)
    .sort((x, y) => Math.abs(y.value) - Math.abs(x.value));
}
