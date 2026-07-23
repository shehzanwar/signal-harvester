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
  perceptionGap: number;
  fatigue: number;
}

export function scoreArticle(
  a: Article,
  opts: {
    prefs: Prefs;
    weights: Record<string, number>;
    isRead: boolean;
    now: number;
    readClusterCount?: number;
  },
): ScoreBreakdown {
  const { prefs, weights, isRead, now } = opts;

  const tier = TIER_WEIGHT[a.tier] ?? 0;
  const interest = INTEREST_WEIGHT[prefs.categoryInterest[a.category ?? ""] ?? "normal"];

  const size = a.cluster_size ?? 1;
  const cluster = size > 1 ? Math.log2(size) * 0.6 : 0;

  const socialScore = a.social_score ?? 0;
  const social = socialScore > 0 ? Math.log10(socialScore + 1) * 0.5 : 0;

  let recency = 0;
  if (a.published_at) {
    const hrs = (now - new Date(a.published_at).getTime()) / 3_600_000;
    if (hrs >= 0) recency = 1.5 * Math.exp(-hrs / 36); // 36-h half-life
  }

  const read = isRead ? -3 : 0;

  // Bounded via tanh so learned affinity nudges the order but never dominates
  // the editorial tier signal. T1 floor of -1.0 (was hard 0) so genuine
  // disinterest still slightly demotes but can't bury breaking news.
  const raw = rawAffinity(articleFeatures(a), weights);
  let affinity = Math.tanh(raw / 4) * 2;
  if (a.tier === "T1") affinity = Math.max(-1.0, affinity);

  // Perception gap bonus: surprising sentiment gap rewards discovery.
  const perceptionGap =
    a.perception_gap != null && (a.sentiment_confidence === "high" || a.sentiment_confidence === "medium")
      ? Math.abs(a.perception_gap) * 0.8
      : 0;

  // Story fatigue: penalise if you've already read other articles in this cluster.
  const readClusterCount = opts.readClusterCount ?? 0;
  const fatigue = readClusterCount > 0 ? -Math.min(0.5 * readClusterCount, 2.0) : 0;

  const total = tier + interest + cluster + social + recency + read + affinity + perceptionGap + fatigue;
  return { total, tier, interest, cluster, social, recency, read, affinity, perceptionGap, fatigue };
}

// Jaccard + source/category/cluster overlap — cheap proxy for semantic similarity.
function articleSimilarity(a: Article, b: Article): number {
  const tA = new Set((a.tags ?? []).map((t) => t.toLowerCase()));
  const tB = new Set((b.tags ?? []).map((t) => t.toLowerCase()));
  const union = new Set([...tA, ...tB]);
  const isect = [...tA].filter((t) => tB.has(t)).length;
  const tagOverlap = union.size > 0 ? isect / union.size : 0;
  const sameSource = a.feed_name && a.feed_name === b.feed_name ? 1.0 : 0.0;
  const sameCat = a.category && a.category === b.category ? 1.0 : 0.0;
  const sameCluster = a.cluster_id && a.cluster_id === b.cluster_id ? 1.0 : 0.0;
  return 0.35 * tagOverlap + 0.25 * sameSource + 0.15 * sameCat + 0.25 * sameCluster;
}

/**
 * Rank reps using Maximal Marginal Relevance (λ=0.7): each pick maximises
 * 70% score + 30% diversity from already-selected items. Applied to the top-50
 * candidates; the tail is appended in score order. This replaces the rigid
 * 1-in-7 exploration slot — MMR provides exploration-like diversity inherently.
 */
export function forYouOrder(reps: Article[], scoreOf: (a: Article) => number): Article[] {
  if (reps.length === 0) return [];

  const scored = reps.map((a) => ({ a, s: scoreOf(a) })).sort((x, y) => y.s - x.s);
  if (scored.length === 1) return [scored[0].a];

  const MMR_TOP_N = 50;
  const MMR_LAMBDA = 0.7;

  const maxS = scored[0].s;
  const minS = scored[scored.length - 1].s;
  const range = maxS - minS || 1;

  const top = scored.slice(0, MMR_TOP_N).map((x) => ({ a: x.a, ns: (x.s - minS) / range }));
  const tail = scored.slice(MMR_TOP_N).map((x) => x.a);

  const selected: Article[] = [];
  const remaining = [...top];

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const { a, ns } = remaining[i];
      // Compare to last 10 selected to bound O(n²k) cost.
      const window = selected.slice(-10);
      const maxSim = window.length > 0 ? Math.max(...window.map((sel) => articleSimilarity(a, sel))) : 0;
      const mmr = MMR_LAMBDA * ns - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx].a);
    remaining.splice(bestIdx, 1);
  }

  return [...selected, ...tail];
}

const BREAKDOWN_LABELS: { key: keyof Omit<ScoreBreakdown, "total">; label: string }[] = [
  { key: "tier", label: "Tier" },
  { key: "affinity", label: "Your taps" },
  { key: "interest", label: "Category interest" },
  { key: "recency", label: "Recency" },
  { key: "cluster", label: "Corroboration" },
  { key: "social", label: "Social" },
  { key: "perceptionGap", label: "Perception gap" },
  { key: "read", label: "Already read" },
  { key: "fatigue", label: "Story fatigue" },
];

/** Non-zero contributions, largest magnitude first, for the "why ranked" view. */
export function breakdownRows(b: ScoreBreakdown): { label: string; value: number }[] {
  return BREAKDOWN_LABELS.map(({ key, label }) => ({ label, value: b[key] }))
    .filter((r) => Math.abs(r.value) > 0.001)
    .sort((x, y) => Math.abs(y.value) - Math.abs(x.value));
}
