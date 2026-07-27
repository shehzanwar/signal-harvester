// Thompson Sampling for category exploration in "For You" mode. MMR (see
// scoring.ts) gives diversity within the ranked candidate set, but never
// surfaces a category the user hasn't engaged with at all — a tech-only
// reader never sees sports. This periodically samples an under-explored
// category and, with the exploration budget below, swaps one candidate in.
//
// Maintains a Beta(alpha, beta) posterior per category: alpha = engagements
// + 1, beta = impressions-without-engagement + 1. Sampling from the actual
// posterior (not an approximation of it) is what makes this Thompson
// Sampling rather than just "occasionally do something random" — a fresh
// category (alpha=beta=1) samples uniformly on [0,1], so it's just as
// likely to win one comparison as a well-established one, while a category
// with a long history of impressions-without-engagement concentrates near 0
// and stops winning.
import type { Article } from "../types";

const KEY = "signal-exploration";
const DECAY = 0.995; // slow decay so old data fades rather than accumulating forever
const EXPLORE_PROBABILITY = 0.1;
const EXPLORE_POSITION = 7; // 0-indexed — lands at position 8, never in the top 7

interface BetaState {
  alpha: number;
  beta: number;
}

function load(): Record<string, BetaState> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, BetaState>) : {};
  } catch {
    return {};
  }
}

function persist(state: Record<string, BetaState>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function getOrInit(state: Record<string, BetaState>, category: string): BetaState {
  return state[category] ?? { alpha: 1, beta: 1 };
}

export function recordCategoryImpression(category: string): void {
  const state = load();
  const s = getOrInit(state, category);
  state[category] = { alpha: s.alpha * DECAY, beta: s.beta * DECAY + 1 };
  persist(state);
}

export function recordCategoryEngagement(category: string): void {
  const state = load();
  const s = getOrInit(state, category);
  state[category] = { alpha: s.alpha * DECAY + 1, beta: s.beta * DECAY };
  persist(state);
}

// Box-Muller standard normal — used by the Gamma sampler below.
function sampleStandardNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Marsaglia-Tsang: samples Gamma(shape, 1). Standard, correct method for
// shape >= 1, with the usual boost transform for 0 < shape < 1
// (Gamma(shape) = Gamma(shape+1) * U^(1/shape)).
function sampleGamma(shape: number): number {
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleStandardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** A genuine Beta(alpha, beta) draw via the Gamma ratio X/(X+Y), X~Gamma(alpha), Y~Gamma(beta). */
function sampleBetaDistribution(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

export function sampleCategoryScore(category: string): number {
  const state = load();
  const { alpha, beta } = getOrInit(state, category);
  return sampleBetaDistribution(alpha, beta);
}

/**
 * With a 10% chance, replace one candidate with a Thompson-sampled pick
 * from a category not already in the ranked list's top 10 — placed at
 * position 8 (index 7), never higher, so exploration nudges rather than
 * dominates. `allReps` is the full candidate pool `ranked` was drawn from
 * (pre-tier-filtered upstream, same as `ranked`).
 */
export function maybeExplore(ranked: Article[], allReps: Article[]): Article[] {
  if (Math.random() > EXPLORE_PROBABILITY || ranked.length <= EXPLORE_POSITION) return ranked;

  const rankedCats = new Set(ranked.slice(0, 10).map((a) => a.category).filter((c): c is string => !!c));
  const candidates = allReps.filter((a) => a.category && !rankedCats.has(a.category));
  if (candidates.length === 0) return ranked;

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates.slice(0, 20)) {
    const s = sampleCategoryScore(c.category!);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  const withoutDuplicate = ranked.filter((a) => a.id !== best.id);
  const result = [...withoutDuplicate];
  result.splice(EXPLORE_POSITION, 0, best);
  return result.slice(0, ranked.length);
}
