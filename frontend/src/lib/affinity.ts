// Online per-user affinity model — a tiny linear model over article features,
// learned entirely client-side from engagement signals. Weights decay with a
// 14-day half-life so interests drift rather than accumulate forever. This is
// the "For You" learning layer; it is deliberately inspectable (see topWeights).
import type { Article } from "../types";

const KEY = "signal-affinity";
const HALF_LIFE_DAYS = 14;
const LEARNING_RATE = 0.04;
const CLAMP = 8; // keep any single weight bounded

export type EngagementType = "open" | "detail" | "dwell" | "save" | "mute" | "skip";

// Reward per signal. Mobile taps (open) are the strongest positive; explicit
// mute is the strongest negative. Tuned to be readable, not optimal.
const SIGNAL: Record<EngagementType, number> = {
  open: 3,
  detail: 2,
  dwell: 1,
  save: 4,
  mute: -5,
  skip: -0.2,
};

interface AffinityState {
  weights: Record<string, number>;
  updatedAt: number; // ms epoch when decay was last applied
}

/** Feature keys for an article: its tags, category, feed, and tier. */
export function articleFeatures(a: Article): string[] {
  const f: string[] = [];
  for (const t of a.tags ?? []) f.push("tag:" + t.toLowerCase());
  if (a.category) f.push("cat:" + a.category);
  if (a.feed_name) f.push("feed:" + a.feed_name);
  if (a.tier) f.push("tier:" + a.tier);
  return f;
}

function load(): AffinityState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<AffinityState>;
      return { weights: s.weights ?? {}, updatedAt: s.updatedAt ?? Date.now() };
    }
  } catch {
    /* ignore */
  }
  return { weights: {}, updatedAt: Date.now() };
}

function persist(s: AffinityState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Apply time decay since the last update; prune negligible weights. */
function decay(s: AffinityState, now = Date.now()): AffinityState {
  const days = (now - s.updatedAt) / 86_400_000;
  if (days <= 0.001) return s;
  const factor = Math.pow(0.5, days / HALF_LIFE_DAYS);
  const w: Record<string, number> = {};
  for (const [k, v] of Object.entries(s.weights)) {
    const nv = v * factor;
    if (Math.abs(nv) > 0.02) w[k] = nv;
  }
  return { weights: w, updatedAt: now };
}

/** Current decayed weights (also persists the decay so it compounds correctly). */
export function getWeights(): Record<string, number> {
  const s = decay(load());
  persist(s);
  return s.weights;
}

/** SGD-ish update: nudge each present feature's weight toward the signal. */
export function recordEngagement(article: Article, type: EngagementType): void {
  const s = decay(load());
  const signal = SIGNAL[type];
  const w = { ...s.weights };
  for (const f of articleFeatures(article)) {
    const nv = (w[f] ?? 0) + LEARNING_RATE * signal;
    w[f] = Math.max(-CLAMP, Math.min(CLAMP, nv));
  }
  const next = { weights: w, updatedAt: Date.now() };
  persist(next);
  // Let interested views (prefs panel) refresh.
  window.dispatchEvent(new CustomEvent("affinity-change"));
}

export function resetWeights(): void {
  persist({ weights: {}, updatedAt: Date.now() });
  window.dispatchEvent(new CustomEvent("affinity-change"));
}

/** Replace the weight vector (used when importing a backup). */
export function importWeights(weights: Record<string, number>): void {
  persist({ weights: weights ?? {}, updatedAt: Date.now() });
  window.dispatchEvent(new CustomEvent("affinity-change"));
}

/** Raw dot product of an article's features with the weight vector. */
export function rawAffinity(features: string[], weights: Record<string, number>): number {
  let s = 0;
  for (const f of features) s += weights[f] ?? 0;
  return s;
}

export interface WeightRow {
  feature: string;
  label: string; // human-friendly, e.g. "tag: us-iran-conflict"
  weight: number;
}

/** Top positive and negative weights, for the transparency panel. */
export function topWeights(n = 6): { liked: WeightRow[]; disliked: WeightRow[] } {
  const rows: WeightRow[] = Object.entries(getWeights()).map(([feature, weight]) => {
    const [kind, ...rest] = feature.split(":");
    const value = rest.join(":");
    const label =
      kind === "tag" ? value : kind === "cat" ? `category: ${value}` : kind === "feed" ? value : `tier ${value}`;
    return { feature, label, weight };
  });
  const liked = rows.filter((r) => r.weight > 0.05).sort((a, b) => b.weight - a.weight).slice(0, n);
  const disliked = rows.filter((r) => r.weight < -0.05).sort((a, b) => a.weight - b.weight).slice(0, n);
  return { liked, disliked };
}
