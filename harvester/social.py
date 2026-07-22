"""Pluggable social-signal providers.

Every provider returns the same shape: {source, score, comments, permalink}.
Two providers need no setup (HN via Algolia, Lemmy via public search) plus a
batch Mastodon trending-links overlay. Two more are gated behind env-var
credentials (Bluesky app-password, Reddit OAuth script app) because their
unauthenticated APIs are dead as of mid-2026.

All failures are swallowed at DEBUG — social signals are optional enrichment.
Create one SocialFetcher per pipeline run (it does the batch prefetch and auth
once) and call .fetch(url) per article.
"""
from __future__ import annotations

import base64
import logging
import os
import threading
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

log = logging.getLogger(__name__)

_UA = "signal-harvester/0.1 (local intelligence pipeline)"
_TIMEOUT = 15.0

_HN_SEARCH = "https://hn.algolia.com/api/v1/search"
_HN_ITEM = "https://hn.algolia.com/api/v1/items"
_LEMMY_SEARCH = "https://lemmy.world/api/v3/search"
_MASTODON_TRENDS = "https://mastodon.social/api/v1/trends/links"
_BSKY_BASE = "https://bsky.social/xrpc"
_BSKY_PUBLIC = "https://public.api.bsky.app/xrpc"
_REDDIT_TOKEN = "https://www.reddit.com/api/v1/access_token"
_REDDIT_INFO = "https://oauth.reddit.com/api/info.json"


class _Throttle:
    """Minimum interval between calls, shared across threads."""

    def __init__(self, interval: float) -> None:
        self._interval = interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            elapsed = time.monotonic() - self._last
            if elapsed < self._interval:
                time.sleep(self._interval - elapsed)
            self._last = time.monotonic()


_lemmy_throttle = _Throttle(1.1)
_bsky_throttle = _Throttle(0.5)
_bsky_replies_throttle = _Throttle(0.6)
_reddit_throttle = _Throttle(1.1)
_reddit_comments_throttle = _Throttle(1.1)


def _norm_url(u: str) -> str:
    """Canonicalize a URL for cross-source matching (drop query/fragment/trailing slash)."""
    try:
        p = urlsplit(u.strip())
        return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), "", "")).lower()
    except Exception:
        return u.strip().lower()


# ── HN (no auth) ─────────────────────────────────────────────────────────────
def fetch_hn(url: str) -> dict[str, Any] | None:
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


# ── Lemmy (no auth) ──────────────────────────────────────────────────────────
def fetch_lemmy(url: str) -> dict[str, Any] | None:
    _lemmy_throttle.wait()
    try:
        resp = httpx.get(
            _LEMMY_SEARCH,
            params={"q": url, "type_": "Url", "limit": 10},
            headers={"User-Agent": _UA},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        posts = resp.json().get("posts", [])
        if not posts:
            return None
        score = sum(p.get("counts", {}).get("score", 0) or 0 for p in posts)
        comments = sum(p.get("counts", {}).get("comments", 0) or 0 for p in posts)
        best = max(posts, key=lambda p: p.get("counts", {}).get("score", 0) or 0)
        permalink = best.get("post", {}).get("ap_id") or "https://lemmy.world"
        return {"score": score, "comments": comments, "permalink": permalink}
    except Exception as exc:
        log.debug("lemmy_fetch_failed url=%s err=%s", url[:60], exc)
        return None


# ── Mastodon trending (batch, no auth) ───────────────────────────────────────
def fetch_mastodon_trending() -> dict[str, dict[str, Any]]:
    """One call per run: map normalized URL -> aggregated trending signal."""
    out: dict[str, dict[str, Any]] = {}
    try:
        resp = httpx.get(_MASTODON_TRENDS, headers={"User-Agent": _UA}, timeout=_TIMEOUT)
        resp.raise_for_status()
        for link in resp.json():
            url = link.get("url")
            if not url:
                continue
            hist = link.get("history", []) or []
            uses = sum(int(h.get("uses", 0) or 0) for h in hist)
            accounts = sum(int(h.get("accounts", 0) or 0) for h in hist)
            if uses == 0 and accounts == 0:
                continue
            out[_norm_url(url)] = {
                "score": uses,
                "comments": accounts,
                "permalink": "https://mastodon.social/explore",
            }
    except Exception as exc:
        log.debug("mastodon_trends_failed err=%s", exc)
    return out


# ── Bluesky (gated on BSKY_HANDLE / BSKY_APP_PASSWORD) ────────────────────────
def bluesky_session() -> str | None:
    handle = os.environ.get("BSKY_HANDLE")
    password = os.environ.get("BSKY_APP_PASSWORD")
    if not handle or not password:
        return None
    try:
        resp = httpx.post(
            f"{_BSKY_BASE}/com.atproto.server.createSession",
            json={"identifier": handle, "password": password},
            headers={"User-Agent": _UA},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json().get("accessJwt")
    except Exception as exc:
        log.debug("bluesky_auth_failed err=%s", exc)
        return None


def fetch_bluesky(url: str, token: str) -> dict[str, Any] | None:
    _bsky_throttle.wait()
    try:
        resp = httpx.get(
            f"{_BSKY_BASE}/app.bsky.feed.searchPosts",
            params={"q": url, "limit": 25},
            headers={"User-Agent": _UA, "Authorization": f"Bearer {token}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        posts = resp.json().get("posts", [])
        if not posts:
            return None
        score = sum((p.get("likeCount", 0) or 0) + (p.get("repostCount", 0) or 0) for p in posts)
        comments = sum(p.get("replyCount", 0) or 0 for p in posts)
        best = max(posts, key=lambda p: p.get("likeCount", 0) or 0)
        permalink = _bsky_permalink(best) or "https://bsky.app"
        return {"score": score, "comments": comments, "permalink": permalink}
    except Exception as exc:
        log.debug("bluesky_fetch_failed url=%s err=%s", url[:60], exc)
        return None


def _bsky_permalink(post: dict[str, Any]) -> str | None:
    uri = post.get("uri", "")  # at://did/app.bsky.feed.post/rkey
    handle = post.get("author", {}).get("handle")
    rkey = uri.rsplit("/", 1)[-1] if uri else ""
    if handle and rkey:
        return f"https://bsky.app/profile/{handle}/post/{rkey}"
    return None


# ── Reddit (gated on REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET) ─────────────────
def reddit_token() -> str | None:
    cid = os.environ.get("REDDIT_CLIENT_ID")
    secret = os.environ.get("REDDIT_CLIENT_SECRET")
    if not cid or not secret:
        return None
    try:
        auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
        resp = httpx.post(
            _REDDIT_TOKEN,
            data={"grant_type": "client_credentials"},
            headers={"User-Agent": _UA, "Authorization": f"Basic {auth}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json().get("access_token")
    except Exception as exc:
        log.debug("reddit_auth_failed err=%s", exc)
        return None


def fetch_reddit(url: str, token: str) -> dict[str, Any] | None:
    _reddit_throttle.wait()
    try:
        resp = httpx.get(
            _REDDIT_INFO,
            params={"url": url},
            headers={"User-Agent": _UA, "Authorization": f"Bearer {token}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        children = resp.json().get("data", {}).get("children", [])
        if not children:
            return None
        score = sum(c["data"].get("score", 0) for c in children)
        comments = sum(c["data"].get("num_comments", 0) for c in children)
        best = max(children, key=lambda c: c["data"].get("score", 0))
        return {
            "score": score,
            "comments": comments,
            "permalink": "https://reddit.com" + best["data"].get("permalink", ""),
        }
    except Exception as exc:
        log.debug("reddit_fetch_failed url=%s err=%s", url[:60], exc)
        return None


class SocialFetcher:
    """Aggregates all enabled providers. Construct once per run."""

    def __init__(self) -> None:
        self._mastodon = fetch_mastodon_trending()
        self._bsky_token = bluesky_session()
        self._reddit_token = reddit_token()
        enabled = ["hn", "lemmy", "mastodon"]
        if self._bsky_token:
            enabled.append("bluesky")
        if self._reddit_token:
            enabled.append("reddit")
        log.info("social_providers enabled=%s mastodon_links=%d", enabled, len(self._mastodon))

    def fetch(self, url: str) -> list[dict[str, Any]]:
        signals: list[dict[str, Any]] = []
        hn = fetch_hn(url)
        if hn:
            signals.append({"source": "hn", **hn})
        lemmy = fetch_lemmy(url)
        if lemmy:
            signals.append({"source": "lemmy", **lemmy})
        mast = self._mastodon.get(_norm_url(url))
        if mast:
            signals.append({"source": "mastodon", **mast})
        if self._bsky_token:
            bsky = fetch_bluesky(url, self._bsky_token)
            if bsky:
                signals.append({"source": "bluesky", **bsky})
        if self._reddit_token:
            reddit = fetch_reddit(url, self._reddit_token)
            if reddit:
                signals.append({"source": "reddit", **reddit})
        return signals


def fetch_social_signals(url: str) -> list[dict[str, Any]]:
    """Backwards-compatible one-shot fetch (creates a fresh fetcher each call)."""
    return SocialFetcher().fetch(url)


# ── Comment fetchers ──────────────────────────────────────────────────────────

import re as _re  # noqa: E402 — placed here to avoid cluttering the top-level imports


def _strip_html(text: str) -> str:
    """Strip HTML tags and decode common entities."""
    text = _re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&#x27;", "'").replace("&quot;", '"')
    return " ".join(text.split())


def fetch_hn_comments(story_id: str, top_n: int = 10) -> list[dict[str, Any]]:
    """Fetch top comments for an HN story via the Algolia items endpoint.

    Returns [{text, score, author}], truncated to top_n by text length (a rough
    proxy for substance — very short comments are usually noise).
    """
    try:
        resp = httpx.get(
            f"{_HN_ITEM}/{story_id}",
            headers={"User-Agent": _UA},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        item = resp.json()
        comments: list[dict[str, Any]] = []

        def _walk(node: dict[str, Any], depth: int = 0) -> None:
            if depth > 2:  # top 2 reply levels only
                return
            raw = node.get("text") or ""
            text = _strip_html(raw)
            if len(text) > 40:
                comments.append({
                    "text": text[:500],
                    "score": None,  # HN comments don't surface vote counts in the API
                    "author": node.get("author"),
                })
            for child in node.get("children", []):
                _walk(child, depth + 1)

        for child in item.get("children", []):
            _walk(child)

        comments.sort(key=lambda c: len(c["text"]), reverse=True)
        return comments[:top_n]
    except Exception as exc:
        log.debug("hn_comments_failed story_id=%s err=%s", story_id, exc)
        return []


def fetch_reddit_comments(permalink: str, top_n: int = 10) -> list[dict[str, Any]]:
    """Fetch top Reddit comments from a submission permalink.

    permalink may be the full https://reddit.com/... URL or a bare /r/... path.
    Returns [{text, score, author}].
    """
    _reddit_comments_throttle.wait()
    path = permalink.replace("https://reddit.com", "").replace("https://www.reddit.com", "")
    path = path.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    url = f"https://www.reddit.com{path}.json?limit={top_n}&sort=top"
    try:
        resp = httpx.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        children = data[1]["data"]["children"]
        comments: list[dict[str, Any]] = []
        for child in children:
            body = (child["data"].get("body") or "").strip()
            if len(body) > 40 and body not in ("[deleted]", "[removed]"):
                comments.append({
                    "text": body[:500],
                    "score": child["data"].get("score") or 0,
                    "author": child["data"].get("author"),
                })
        return comments[:top_n]
    except Exception as exc:
        log.debug("reddit_comments_failed permalink=%s err=%s", permalink[:60], exc)
        return []


def fetch_bluesky_replies(article_url: str, top_n: int = 10) -> list[dict[str, Any]]:
    """Fetch Bluesky posts discussing article_url via the unauthenticated public API.

    Searches by exact URL; falls back to domain if <2 hits. Expands one level
    of replies for posts with reply_count > 0. Returns [{text, score, author}].
    """
    _bsky_replies_throttle.wait()
    try:
        resp = httpx.get(
            f"{_BSKY_PUBLIC}/app.bsky.feed.searchPosts",
            params={"q": article_url, "limit": 15, "sort": "top"},
            headers={"User-Agent": _UA},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        posts = resp.json().get("posts", [])

        if len(posts) < 2:
            domain = urlsplit(article_url).netloc.lstrip("www.")
            if not domain:
                return []
            _bsky_replies_throttle.wait()
            resp2 = httpx.get(
                f"{_BSKY_PUBLIC}/app.bsky.feed.searchPosts",
                params={"q": domain, "limit": 25, "sort": "top"},
                headers={"User-Agent": _UA},
                timeout=_TIMEOUT,
            )
            resp2.raise_for_status()
            domain_posts = resp2.json().get("posts", [])
            # Keep only posts whose text mentions the domain (reduce off-topic noise)
            posts = [p for p in domain_posts if domain in (p.get("record", {}).get("text", "") or "")]

        if not posts:
            return []

        comments: list[dict[str, Any]] = []
        for post in posts[:8]:
            record = post.get("record", {})
            post_text = (record.get("text") or "").strip()
            score = (post.get("likeCount", 0) or 0) + (post.get("repostCount", 0) or 0)
            if len(post_text) > 40:
                comments.append({
                    "text": post_text[:500],
                    "score": score,
                    "author": post.get("author", {}).get("handle"),
                })

            # Expand one level of replies for posts that have them
            uri = post.get("uri", "")
            if (post.get("replyCount", 0) or 0) > 0 and uri and len(comments) < top_n:
                _bsky_replies_throttle.wait()
                try:
                    thread_resp = httpx.get(
                        f"{_BSKY_PUBLIC}/app.bsky.feed.getPostThread",
                        params={"uri": uri, "depth": 1, "parentHeight": 0},
                        headers={"User-Agent": _UA},
                        timeout=_TIMEOUT,
                    )
                    thread_resp.raise_for_status()
                    for reply in (thread_resp.json().get("thread", {}).get("replies") or [])[:3]:
                        rp = reply.get("post", {})
                        rt = (rp.get("record", {}).get("text") or "").strip()
                        if len(rt) > 40:
                            comments.append({
                                "text": rt[:500],
                                "score": rp.get("likeCount", 0) or 0,
                                "author": rp.get("author", {}).get("handle"),
                            })
                except Exception as exc:
                    log.debug("bsky_thread_failed uri=%s err=%s", uri[:60], exc)

        comments.sort(key=lambda c: c.get("score") or 0, reverse=True)
        return comments[:top_n]
    except Exception as exc:
        log.debug("bluesky_replies_failed url=%s err=%s", article_url[:60], exc)
        return []
