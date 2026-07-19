"""Social signal fetching: Hacker News (Algolia API) + Reddit (public JSON API).

Both endpoints are unauthenticated. Reddit requires a real User-Agent and a
soft throttle (~1 req/s via a module-level lock). All failures are silently
logged at DEBUG level — most articles have no social presence, and social
signals are optional enrichment, not critical data.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)

_HN_SEARCH = "https://hn.algolia.com/api/v1/search"
_REDDIT_INFO = "https://www.reddit.com/api/info.json"
_UA = "signal-harvester/0.1 (local intelligence pipeline)"
_TIMEOUT = 15.0

_reddit_lock = threading.Lock()
_reddit_last: float = 0.0
_REDDIT_INTERVAL = 1.1  # seconds between Reddit requests


def fetch_hn(url: str) -> dict[str, Any] | None:
    """Return aggregated HN engagement for a URL, or None if no hits."""
    try:
        resp = httpx.get(
            _HN_SEARCH,
            params={"query": url, "restrictSearchableAttributes": "url"},
            headers={"User-Agent": _UA},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        hits = resp.json().get("hits", [])
        if not hits:
            return None
        score = sum(h.get("points", 0) or 0 for h in hits)
        comments = sum(h.get("num_comments", 0) or 0 for h in hits)
        best = max(hits, key=lambda h: h.get("points") or 0)
        return {
            "score": score,
            "comments": comments,
            "permalink": f"https://news.ycombinator.com/item?id={best.get('objectID', '')}",
        }
    except Exception as exc:
        log.debug("hn_fetch_failed url=%s err=%s", url[:60], exc)
        return None


def fetch_reddit(url: str) -> dict[str, Any] | None:
    """Return aggregated Reddit engagement for a URL, or None if no posts."""
    global _reddit_last
    with _reddit_lock:
        elapsed = time.monotonic() - _reddit_last
        if elapsed < _REDDIT_INTERVAL:
            time.sleep(_REDDIT_INTERVAL - elapsed)
        _reddit_last = time.monotonic()

    try:
        resp = httpx.get(
            _REDDIT_INFO,
            params={"url": url},
            headers={"User-Agent": _UA},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        children = resp.json().get("data", {}).get("children", [])
        if not children:
            return None
        score = sum(c["data"].get("score", 0) for c in children)
        comments = sum(c["data"].get("num_comments", 0) for c in children)
        best = max(children, key=lambda c: c["data"].get("score", 0))
        permalink = "https://reddit.com" + best["data"].get("permalink", "")
        return {"score": score, "comments": comments, "permalink": permalink}
    except Exception as exc:
        log.debug("reddit_fetch_failed url=%s err=%s", url[:60], exc)
        return None


def fetch_social_signals(url: str) -> list[dict[str, Any]]:
    """Fetch HN and Reddit signals for an article URL.

    Returns a list of dicts with keys: source, score, comments, permalink.
    Returns empty list if the URL has no social presence.
    """
    signals = []
    hn = fetch_hn(url)
    if hn:
        signals.append({"source": "hn", **hn})
    reddit = fetch_reddit(url)
    if reddit:
        signals.append({"source": "reddit", **reddit})
    return signals
