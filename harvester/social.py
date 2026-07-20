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
_LEMMY_SEARCH = "https://lemmy.world/api/v3/search"
_MASTODON_TRENDS = "https://mastodon.social/api/v1/trends/links"
_BSKY_BASE = "https://bsky.social/xrpc"
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
_reddit_throttle = _Throttle(1.1)


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
