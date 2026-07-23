// Online per-user affinity model — a tiny linear model over article features,
// learned entirely client-side from engagement signals. Weights decay with a
// 14-day half-life so interests drift rather than accumulate forever. Mute
// weights decay much slower (90 days) — an explicit mute should last. This is
// the "For You" learning layer; it is deliberately inspectable (see topWeights).
import type { Article } from "../types";

const KEY = "signal-affinity";
const HALF_LIFE_DAYS = 14;
const MUTE_HALF_LIFE_DAYS = 90;
const LEARNING_RATE = 0.04;
const CLAMP = 8;

// "detail" removed — replaced by dwell_long / dwell_medium / dwell_short so the
// model learns from how long you actually spent, not just that you opened it.
export type EngagementType = "open" | "dwell_long" | "dwell_medium" | "dwell_short" | "save" | "mute" | "skip";

const SIGNAL: Record<EngagementType, number> = {
  open: 1.0,         // click to open in new tab (lighter — can't track time)
  dwell_long: 3.0,   // >30 s in detail panel
  dwell_medium: 1.5, // 10–30 s
  dwell_short: -0.5, // <3 s — likely clickbait
  save: 4.0,
  mute: -8.0,
  skip: -0.5,        // was -0.2
};

interface AffinityState {
  weights: Record<string, number>;      // all signals except mutes
  updatedAt: number;
  muteWeights: Record<string, number>;  // mute-only, 90-day decay
  muteUpdatedAt: number;
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
      return {
        weights: s.weights ?? {},
        updatedAt: s.updatedAt ?? Date.now(),
        muteWeights: s.muteWeights ?? {},
        muteUpdatedAt: s.muteUpdatedAt ?? Date.now(),
      };
    }
  } catch {
    /* ignore */
  }
  return { weights: {}, updatedAt: Date.now(), muteWeights: {}, muteUpdatedAt: Date.now() };
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
  let weights = s.weights;
  if (days > 0.001) {
    const factor = Math.pow(0.5, days / HALF_LIFE_DAYS);
    const w: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.weights)) {
      const nv = v * factor;
      if (Math.abs(nv) > 0.02) w[k] = nv;
    }
    weights = w;
  }

  const muteDays = (now - s.muteUpdatedAt) / 86_400_000;
  let muteWeights = s.muteWeights;
  if (muteDays > 0.001) {
    const factor = Math.pow(0.5, muteDays / MUTE_HALF_LIFE_DAYS);
    const w: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.muteWeights)) {
      const nv = v * factor;
      if (Math.abs(nv) > 0.02) w[k] = nv;
    }
    muteWeights = w;
  }

  return { weights, updatedAt: now, muteWeights, muteUpdatedAt: now };
}

/** Current decayed weights merged from regular + mute stores. */
export function getWeights(): Record<string, number> {
  const s = decay(load());
  persist(s);
  const merged: Record<string, number> = { ...s.weights };
  for (const [k, v] of Object.entries(s.muteWeights)) {
    merged[k] = (merged[k] ?? 0) + v;
  }
  return merged;
}

/** SGD-ish update: nudge each present feature's weight toward the signal. */
export function recordEngagement(article: Article, type: EngagementType): void {
  const s = decay(load());
  const signal = SIGNAL[type];

  if (type === "mute") {
    // Mutes go to a separate store with slower 90-day decay so explicit dislikes persist.
    const w = { ...s.muteWeights };
    for (const f of articleFeatures(article)) {
      const nv = (w[f] ?? 0) + LEARNING_RATE * signal;
      w[f] = Math.max(-CLAMP, Math.min(CLAMP, nv));
    }
    persist({ ...s, muteWeights: w, muteUpdatedAt: Date.now() });
  } else {
    const w = { ...s.weights };
    for (const f of articleFeatures(article)) {
      const nv = (w[f] ?? 0) + LEARNING_RATE * signal;
      w[f] = Math.max(-CLAMP, Math.min(CLAMP, nv));
    }
    persist({ ...s, weights: w, updatedAt: Date.now() });
  }

  window.dispatchEvent(new CustomEvent("affinity-change"));
}

export function resetWeights(): void {
  persist({ weights: {}, updatedAt: Date.now(), muteWeights: {}, muteUpdatedAt: Date.now() });
  window.dispatchEvent(new CustomEvent("affinity-change"));
}

/** Replace the regular weight vector (used when importing a backup). Mute weights are preserved. */
export function importWeights(weights: Record<string, number>): void {
  const s = load();
  persist({ ...s, weights: weights ?? {}, updatedAt: Date.now() });
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
