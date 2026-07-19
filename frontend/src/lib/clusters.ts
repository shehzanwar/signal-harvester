import type { Article } from "../types";

/**
 * Collapse a cluster of corroborating articles down to one representative card.
 *
 * The API returns articles pre-sorted by tier then recency, so the FIRST article
 * seen for a given cluster_id is already its highest-tier, most-recent member —
 * exactly the one we want to surface. Every later member of that cluster is
 * suppressed from the feed (still reachable via the DetailPanel). This is what
 * makes one storyline render as a single card and deflates the T1 wall.
 *
 * Order is preserved, so the result still mirrors the API's tier/recency sort.
 */
export function collapseClusters(articles: Article[]): Article[] {
  const seen = new Set<string>();
  const reps: Article[] = [];
  for (const a of articles) {
    const cid = a.cluster_id || a.id;
    if (seen.has(cid)) continue;
    seen.add(cid);
    reps.push(a);
  }
  return reps;
}

/** Map of cluster_id -> all its member articles (in API order). */
export function clusterMembersMap(articles: Article[]): Map<string, Article[]> {
  const m = new Map<string, Article[]>();
  for (const a of articles) {
    const cid = a.cluster_id || a.id;
    const list = m.get(cid);
    if (list) list.push(a);
    else m.set(cid, [a]);
  }
  return m;
}

/** Sibling members of an article's cluster, excluding the article itself. */
export function clusterSiblings(article: Article, byCluster: Map<string, Article[]>): Article[] {
  const cid = article.cluster_id || article.id;
  return (byCluster.get(cid) ?? []).filter((a) => a.id !== article.id);
}
