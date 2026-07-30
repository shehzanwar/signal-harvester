import { useCallback, useMemo, useState } from "react";
import { collapseClusters } from "../lib/clusters";
import type { Article } from "../types";

export interface CategoryFiltersResult {
  category: string | null;
  subcategory: string | null;
  setSubcategory: (key: string | null) => void;
  selectCategory: (key: string | null) => void;
  categoryCounts: Record<string, number>;
  subcategoryCounts: Record<string, number>;
  subcategoryOptions: { key: string; label: string }[];
  selectedTags: ReadonlySet<string>;
  setSelectedTags: (tags: ReadonlySet<string>) => void;
  toggleTag: (tag: string) => void;
  /** Selected personal-interest niche key (see NicheConfig), or null for "all". */
  nicheFilter: string | null;
  setNicheFilter: (key: string | null) => void;
  /** Post category → subcategory → tag → niche filter chain, in that order. */
  tagFilteredArticles: Article[];
}

/**
 * Category/subcategory/tag filtering pipeline. Each stage narrows the
 * previous one (category → subcategory → tags), so the counts/options for
 * a later stage are naturally scoped to whatever the earlier stages left —
 * a subcategory bar for "world" only ever shows subcategories that exist
 * within "world", not the whole site.
 */
export function useCategoryFilters(allArticles: Article[]): CategoryFiltersResult {
  const [category, setCategory] = useState<string | null>(null);
  const [subcategory, setSubcategory] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set());
  const [nicheFilter, setNicheFilter] = useState<string | null>(null);

  // Selecting a new top-level category invalidates whatever subcategory was
  // active — a subcategory value from one category is meaningless in another.
  const selectCategory = useCallback((key: string | null) => {
    setCategory(key);
    setSubcategory(null);
  }, []);

  // Per-category story counts (collapsed reps, non-noise) for the category bar.
  // Independent of search/filters so the nav stays stable.
  const categoryCounts = useMemo(() => {
    const reps = collapseClusters(allArticles).filter((a) => a.tier !== "NOISE");
    const counts: Record<string, number> = { all: reps.length };
    for (const a of reps) {
      const c = a.category || "general";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [allArticles]);

  // Feed scoped to the selected category (null = All).
  const categoryArticles = useMemo(
    () =>
      category
        ? allArticles.filter((a) => (a.category || "general") === category)
        : allArticles,
    [allArticles, category],
  );

  // Subcategory counts/options within the CURRENT category only — a
  // subcategory bar for "world" showing "science"/"health" makes no sense
  // once the user has switched to "technology". Only feeds that declared a
  // non-empty subcategory contribute; feeds without one fall through
  // ungrouped (no "general" bucket forced onto sources that didn't ask for it).
  const subcategoryCounts = useMemo(() => {
    if (!category) return { all: 0 };
    const reps = collapseClusters(categoryArticles).filter((a) => a.tier !== "NOISE");
    const counts: Record<string, number> = { all: reps.length };
    for (const a of reps) {
      if (a.subcategory) counts[a.subcategory] = (counts[a.subcategory] ?? 0) + 1;
    }
    return counts;
  }, [categoryArticles, category]);

  const subcategoryOptions = useMemo(
    () =>
      Object.keys(subcategoryCounts)
        .filter((key) => key !== "all")
        .sort((a, b) => subcategoryCounts[b] - subcategoryCounts[a])
        .map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) })),
    [subcategoryCounts],
  );

  const subcategoryArticles = useMemo(
    () => (subcategory ? categoryArticles.filter((a) => a.subcategory === subcategory) : categoryArticles),
    [categoryArticles, subcategory],
  );

  // Tag filter applied after category/subcategory filter (client-side; OR semantics across selected tags).
  const tagOnlyFilteredArticles = useMemo(
    () =>
      selectedTags.size > 0
        ? subcategoryArticles.filter((a) => a.tags.some((t) => selectedTags.has(t)))
        : subcategoryArticles,
    [subcategoryArticles, selectedTags],
  );

  // Niche filter — last stage of the chain. A niche cuts across categories
  // (e.g. "soccer" spans sports + whatever else mentions it), so unlike
  // category/subcategory/tag this doesn't narrow within a single category;
  // it's an independent lens applied on top of whatever the rest of the
  // chain already produced.
  const tagFilteredArticles = useMemo(
    () =>
      nicheFilter
        ? tagOnlyFilteredArticles.filter((a) => (a.niches ?? []).includes(nicheFilter))
        : tagOnlyFilteredArticles,
    [tagOnlyFilteredArticles, nicheFilter],
  );

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  return {
    category,
    subcategory,
    setSubcategory,
    selectCategory,
    categoryCounts,
    subcategoryCounts,
    subcategoryOptions,
    selectedTags,
    setSelectedTags,
    toggleTag,
    nicheFilter,
    setNicheFilter,
    tagFilteredArticles,
  };
}
