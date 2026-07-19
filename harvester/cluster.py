"""Greedy story clustering using Jaccard similarity of title tokens.

Articles within the same pipeline window with title-token Jaccard similarity
>= threshold are grouped into a cluster. The first article to define a cluster
is the representative (cluster_id == its own id).
"""
from __future__ import annotations

import re
from typing import Any

_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "is", "was", "are", "were", "has", "have", "had", "this", "that",
    "it", "its", "be", "been", "but", "not", "as", "up", "do", "did", "will",
    "would", "could", "should", "may", "might", "can", "than", "then", "into",
    "over", "out", "after", "before", "about", "all", "also", "new", "more",
    "one", "two", "three", "said", "says", "say", "get", "got", "set", "use",
    "used", "via", "per", "both", "who", "what", "when", "where", "how", "which",
})


def _title_tokens(title: str) -> frozenset[str]:
    words = re.findall(r"\b[a-z]{3,}\b", title.lower())
    return frozenset(w for w in words if w not in _STOPWORDS)


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def cluster_articles(
    articles: list[dict[str, Any]],
    threshold: float = 0.40,
) -> list[dict[str, Any]]:
    """Assign cluster_id to each article in-place.

    cluster_id is the id of the first article that founded the cluster.
    Articles should be sorted with the preferred representative first
    (e.g. highest-trust feed, earliest publish_at DESC).

    Returns the same list (mutated in-place) for convenience.
    """
    cluster_centers: list[tuple[frozenset[str], str]] = []

    for art in articles:
        tokens = _title_tokens(art.get("title", ""))
        best_sim = 0.0
        best_id: str | None = None

        for center_tokens, center_id in cluster_centers:
            sim = _jaccard(tokens, center_tokens)
            if sim > best_sim:
                best_sim = sim
                best_id = center_id

        if best_sim >= threshold and best_id is not None:
            art["cluster_id"] = best_id
        else:
            art["cluster_id"] = art["id"]
            cluster_centers.append((tokens, art["id"]))

    return articles


def attach_cluster_metadata(articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """After cluster_articles(), populate cluster_size and cluster_sources on each article.

    These are display-only; cluster_id is the authoritative DB field.
    """
    sizes: dict[str, int] = {}
    sources: dict[str, list[str]] = {}

    for art in articles:
        cid = art.get("cluster_id") or art["id"]
        sizes[cid] = sizes.get(cid, 0) + 1
        sources.setdefault(cid, [])
        feed = art.get("feed_name", "")
        if feed and feed not in sources[cid]:
            sources[cid].append(feed)

    for art in articles:
        cid = art.get("cluster_id") or art["id"]
        art["cluster_size"] = sizes.get(cid, 1)
        art["cluster_sources"] = sources.get(cid, [])

    return articles
