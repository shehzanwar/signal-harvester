import { useCallback, useState } from "react";
import { importWeights } from "../lib/affinity";
import type { Prefs } from "../lib/prefs";

export interface OnboardingResult {
  showOnboarding: boolean;
  completeOnboarding: (selected: Set<string>) => void;
}

/**
 * First-run category picker. Selections seed both `categoryInterest`
 * (prefs.ts) and an initial affinity weight boost (affinity.ts) so For You
 * doesn't look identical to Tiered until ~20 articles of organic reading
 * have accumulated.
 */
export function useOnboarding(updatePrefs: (updater: (p: Prefs) => Prefs) => void): OnboardingResult {
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return localStorage.getItem("signal-onboarded") == null;
    } catch {
      return false;
    }
  });

  const completeOnboarding = useCallback(
    (selected: Set<string>) => {
      if (selected.size > 0) {
        updatePrefs((p) => {
          const categoryInterest = { ...p.categoryInterest };
          for (const key of selected) categoryInterest[key] = "high";
          return { ...p, categoryInterest };
        });
        const weights: Record<string, number> = {};
        for (const key of selected) weights[`cat:${key}`] = 3.0;
        importWeights(weights);
      }
      try {
        localStorage.setItem("signal-onboarded", "1");
      } catch {
        /* ignore */
      }
      setShowOnboarding(false);
    },
    [updatePrefs],
  );

  return { showOnboarding, completeOnboarding };
}
