"""Greedy story clustering over IDF-weighted title + tag tokens.

Each article is reduced to a bag of informative tokens drawn from BOTH its title
and its (word-split) tags — the LLM tags are topic-normalized, so even when their
surface form varies ("us-iran-conflict" vs "us-iran conflict") they share the same
word tokens {iran, conflict}. Tokens are IDF-weighted across the batch so that
rare, discriminating words ("jordan", "hormuz") dominate the similarity while
ubiquitous ones barely move it.

Similarity is IDF-weighted cosine (binary TF). Cosine — unlike Jaccard — does not
penalize for union size, so same-event headlines from different outlets with quite
different wording still score highly (measured: same-story Iran headlines 0.29-1.0
vs <0.07 for merely topic-adjacent stories, a wide clean valley at threshold 0.25).

Greedy single pass: an article joins the existing cluster whose founding member is
most similar (cosine >= threshold) provided they share at least `min_shared`
tokens; otherwise it founds a new cluster. Articles should be passed in
representative-preferred order (highest-trust feed first) so the founding member
is the one surfaced as the cluster's card.
"""
from __future__ import annotations

import math
import re
from collections import Counter
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


def _article_features(article: dict[str, Any]) -> frozenset[str]:
    """Bag of informative tokens: title words UNION word-split tag tokens."""
    toks: set[str] = set(_title_tokens(article.get("title", "")))
    for tag in article.get("tags") or []:
        for w in re.findall(r"[a-z]{3,}", str(tag).lower()):
            if w not in _STOPWORDS:
                toks.add(w)
    return frozenset(toks)


def _compute_idf(feature_sets: list[frozenset[str]]) -> dict[str, float]:
    """Smoothed IDF over the batch. +1.0 floor keeps common tokens contributing
    a little rather than zero, so similarity stays well-behaved."""
    n = len(feature_sets)
    df: Counter[str] = Counter()
    for f in feature_sets:
        for t in f:
            df[t] += 1
    return {t: math.log((n + 1) / (c + 0.5)) + 1.0 for t, c in df.items()}


def _idf_cosine(a: frozenset[str], b: frozenset[str], idf: dict[str, float]) -> float:
    """Cosine similarity over IDF-weighted binary term vectors, in [0, 1]."""
    inter = a & b
    if not inter:
        return 0.0
    num = sum(idf.get(t, 1.0) ** 2 for t in inter)
    na = math.sqrt(sum(idf.get(t, 1.0) ** 2 for t in a))
    nb = math.sqrt(sum(idf.get(t, 1.0) ** 2 for t in b))
    return num / (na * nb) if na > 0 and nb > 0 else 0.0


def cluster_articles(
    articles: list[dict[str, Any]],
    threshold: float = 0.25,
    min_shared: int = 2,
) -> list[dict[str, Any]]:
    """Assign cluster_id to each article in-place.

    cluster_id is the id of the first article that founded the cluster. Pass
    articles sorted with the preferred representative first (highest-trust feed,
    then most recent) so the founder is the article shown for the cluster.

    An article joins a cluster only if it shares >= `min_shared` tokens with the
    founder AND their IDF-weighted Jaccard similarity is >= `threshold`. The
    shared-token floor stops a single coincidental common word from merging two
    unrelated stories; the weighting stops common words from inflating the score.

    Returns the same list (mutated in-place) for convenience.
    """
    feats = [_article_features(a) for a in articles]
    idf = _compute_idf(feats)

    cluster_centers: list[tuple[frozenset[str], str]] = []

    for art, tokens in zip(articles, feats):
        best_sim = 0.0
        best_id: str | None = None

        for center_tokens, center_id in cluster_centers:
            if len(tokens & center_tokens) < min_shared:
                continue
            sim = _idf_cosine(tokens, center_tokens, idf)
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
