"""Taste profile: Letterboxd + Trakt watch history, feeding the "Screen"
niche's title matching (see Part 2 of the niches/taste-feeds proposal).

Letterboxd has no usable public API (v2 closed, v3 waitlist-only as of
2026-07), so this uses the public diary RSS feed instead — no API key,
already a pipeline dependency (feedparser). The watchlist RSS
(/watchlist/rss/) is Cloudflare-gated and returns 403 even with a
browser-like User-Agent (confirmed 2026-07-30); only the diary feed
(watched + rated films) is fetched. Trakt's watchlist endpoint below
covers watchlist status instead, when a Trakt username/client ID is set.

Trakt has a free public API — no OAuth needed for reading a public
profile's watched/watchlist/ratings, just a registered app's Client ID
(https://trakt.tv/oauth/applications) sent as the trakt-api-key header.
Gated on the TRAKT_CLIENT_ID env var, same silently-skip-if-absent
pattern as YOUTUBE_API_KEY — Trakt being unconfigured has zero pipeline
impact.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

import feedparser
import httpx

from harvester.config import ProfileConfig

log = logging.getLogger(__name__)

_LETTERBOXD_TIMEOUT = 15.0
_TRAKT_TIMEOUT = 15.0
_TRAKT_BASE = "https://api.trakt.tv"

_STOPWORDS = frozenset({"the", "a", "an", "and", "of", "in", "on", "at", "to", "for", "is", "it", "its"})


def fetch_letterboxd_diary(username: str, limit: int = 100) -> list[dict[str, Any]]:
    """Recently watched/rated films via Letterboxd's public diary RSS."""
    try:
        d = feedparser.parse(f"https://letterboxd.com/{username}/rss/")
    except Exception as exc:
        log.warning("letterboxd_diary_fetch_failed username=%s error=%s", username, exc)
        return []
    if not d.entries:
        log.warning("letterboxd_diary_empty username=%s bozo=%s", username, getattr(d, "bozo", None))
        return []
    rows: list[dict[str, Any]] = []
    for e in d.entries[:limit]:
        title = e.get("letterboxd_filmtitle")
        if not title:
            continue
        year_raw = e.get("letterboxd_filmyear")
        rating_raw = e.get("letterboxd_memberrating")
        rows.append({
            "title": title,
            "year": int(year_raw) if year_raw and str(year_raw).isdigit() else None,
            "type": "movie",
            "status": "watched",
            "rating": float(rating_raw) if rating_raw else None,
            "source": "letterboxd",
        })
    return rows


def _trakt_headers(client_id: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": client_id,
    }


def _trakt_get(path: str, client_id: str) -> Any | None:
    try:
        resp = httpx.get(f"{_TRAKT_BASE}{path}", headers=_trakt_headers(client_id), timeout=_TRAKT_TIMEOUT)
        if resp.status_code != 200:
            log.warning("trakt_fetch_failed path=%s status=%d", path, resp.status_code)
            return None
        return resp.json()
    except Exception as exc:
        log.warning("trakt_fetch_failed path=%s error=%s", path, exc)
        return None


def fetch_trakt_watched(username: str, client_id: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for kind, item_key in (("movies", "movie"), ("shows", "show")):
        data = _trakt_get(f"/users/{username}/watched/{kind}", client_id)
        if not data:
            continue
        for entry in data:
            item = entry.get(item_key) or {}
            title = item.get("title")
            if not title:
                continue
            rows.append({
                "title": title,
                "year": item.get("year"),
                "type": item_key,
                "status": "watched",
                "rating": None,
                "source": "trakt",
            })
    return rows


def fetch_trakt_watchlist(username: str, client_id: str) -> list[dict[str, Any]]:
    data = _trakt_get(f"/users/{username}/watchlist", client_id)
    if not data:
        return []
    rows: list[dict[str, Any]] = []
    for entry in data:
        item_type = entry.get("type") or "movie"
        item = entry.get(item_type) or {}
        title = item.get("title")
        if not title:
            continue
        rows.append({
            "title": title,
            "year": item.get("year"),
            "type": item_type,
            "status": "watchlist",
            "rating": None,
            "source": "trakt",
        })
    return rows


def fetch_trakt_ratings(username: str, client_id: str) -> list[dict[str, Any]]:
    data = _trakt_get(f"/users/{username}/ratings", client_id)
    if not data:
        return []
    rows: list[dict[str, Any]] = []
    for entry in data:
        item_type = entry.get("type") or "movie"
        item = entry.get(item_type) or {}
        title = item.get("title")
        if not title:
            continue
        rows.append({
            "title": title,
            "year": item.get("year"),
            "type": item_type,
            "status": "rated",
            "rating": entry.get("rating"),
            "source": "trakt",
        })
    return rows


def build_taste_profile(cfg: ProfileConfig) -> list[dict[str, Any]]:
    """Combine Letterboxd + Trakt into one normalized list. Best-effort per
    source — either being unreachable/unconfigured doesn't affect the other,
    and an empty result here means "keep whatever's already cached," not
    "wipe the taste profile" (see pipeline.py's refresh call site)."""
    rows: list[dict[str, Any]] = []
    if cfg.taste.letterboxd_username:
        rows.extend(fetch_letterboxd_diary(cfg.taste.letterboxd_username))
    if cfg.taste.trakt_username:
        client_id = os.environ.get("TRAKT_CLIENT_ID", "")
        if client_id:
            rows.extend(fetch_trakt_watched(cfg.taste.trakt_username, client_id))
            rows.extend(fetch_trakt_watchlist(cfg.taste.trakt_username, client_id))
            rows.extend(fetch_trakt_ratings(cfg.taste.trakt_username, client_id))
        else:
            log.debug("trakt_skipped reason=no_client_id")
    return rows


def _tokenize(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if w not in _STOPWORDS and len(w) > 1}


def match_taste_candidates(
    article_title: str,
    taste_rows: list[dict[str, Any]],
    min_overlap: int = 2,
) -> list[dict[str, Any]]:
    """Cheap token-overlap pre-filter (mechanism 1) — narrows the taste
    profile down to plausible candidates before spending an LLM call on
    confirmation. Title matching alone is treacherous (a one-word title
    like "Her" matches almost any article mentioning "her"), so this
    requires at least `min_overlap` shared content tokens, not just one —
    and never more than the candidate's own token count, so a two-word
    title only needs both words, not an arbitrary higher bar."""
    article_tokens = _tokenize(article_title)
    if len(article_tokens) < 2:
        return []
    seen_titles: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for row in taste_rows:
        title = row["title"]
        if title in seen_titles:
            continue
        row_tokens = _tokenize(title)
        if not row_tokens:
            continue
        overlap = article_tokens & row_tokens
        if len(overlap) < min(min_overlap, len(row_tokens)):
            continue
        candidates.append(row)
        seen_titles.add(title)
    # A title matching double digits of taste-profile entries is a sign of
    # an overly generic title (stopword-heavy), not real signal — cap
    # rather than pass all of them to the LLM as a long, noisy prompt.
    return candidates[:10]


def resolve_taste_match(confirmed_title: str, candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Map the LLM's confirmed title string back to the richest matching
    taste-profile row (the LLM only echoes a title; it doesn't know
    status/rating/source). When the same title appears multiple times
    (e.g. both "watched" and separately "rated"), prefers the row with the
    most specific status and an actual rating over a bare watched entry."""
    norm = confirmed_title.strip().lower()
    matches = [c for c in candidates if c["title"].strip().lower() == norm]
    if not matches:
        return None
    status_rank = {"rated": 0, "watched": 1, "watchlist": 2}
    matches.sort(key=lambda c: (status_rank.get(c["status"], 3), c.get("rating") is None))
    best = matches[0]
    return {
        "title": best["title"],
        "type": best["type"],
        "status": best["status"],
        "rating": best.get("rating"),
        "source": best["source"],
    }
