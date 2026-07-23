from __future__ import annotations

import logging
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import feedparser
import httpx

from harvester.config import FeedConfig, ProfileConfig

log = logging.getLogger(__name__)

_HEADERS = {
    "User-Agent": "signal-harvester/0.1 (+https://github.com/shehzad/signal-harvester)",
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
}
_TIMEOUT = 30.0


class RSSSource:
    def __init__(self, cfg: ProfileConfig) -> None:
        self._feeds = cfg.feeds
        self._default_max = cfg.max_articles_per_feed

    def fetch(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Return (articles, health_records).

        health_records: one dict per feed with feed_name, checked_at,
        article_count (raw count before DB dedup), and error (None on success).
        """
        articles: list[dict[str, Any]] = []
        health: list[dict[str, Any]] = []
        checked_at = datetime.now(timezone.utc).isoformat()
        for feed_cfg in self._feeds:
            try:
                cap = feed_cfg.max_articles if feed_cfg.max_articles is not None else self._default_max
                arts = self._fetch_feed(feed_cfg, cap)
                articles.extend(arts)
                log.info("feed_fetched feed=%s count=%d cap=%d", feed_cfg.name, len(arts), cap)
                health.append({
                    "feed_name": feed_cfg.name,
                    "checked_at": checked_at,
                    "article_count": len(arts),
                    "error": None,
                })
            except Exception as exc:
                log.warning("feed_failed feed=%s error=%s", feed_cfg.name, exc)
                health.append({
                    "feed_name": feed_cfg.name,
                    "checked_at": checked_at,
                    "article_count": 0,
                    "error": str(exc)[:500],
                })
        return articles, health

    def _fetch_feed(self, feed_cfg: FeedConfig, max_articles: int) -> list[dict[str, Any]]:
        try:
            resp = httpx.get(
                feed_cfg.url,
                headers=_HEADERS,
                timeout=_TIMEOUT,
                follow_redirects=True,
            )
            resp.raise_for_status()
            content = resp.content
        except httpx.HTTPError as exc:
            raise RuntimeError(f"HTTP error: {exc}") from exc

        parsed = feedparser.parse(content)
        if parsed.bozo and not parsed.entries:
            raise RuntimeError(f"Feed parse error: {parsed.bozo_exception}")

        fetched_at = datetime.now(timezone.utc).isoformat()
        articles = []
        # feedparser returns entries newest-first; slice to cap before looping
        for entry in parsed.entries[:max_articles]:
            url = _canonical_url(entry)
            if not url:
                continue
            articles.append({
                "feed_name": feed_cfg.name,
                "url": url,
                "guid": entry.get("id") or url,
                "title": (entry.get("title") or "(no title)").strip(),
                "published_at": _parse_date(entry),
                "fetched_at": fetched_at,
                "summary": _feed_summary(entry),
            })
        return articles


def _canonical_url(entry: Any) -> str | None:
    url = entry.get("link") or entry.get("id") or ""
    return url if url.startswith("http") else None


def _parse_date(entry: Any) -> str | None:
    raw = entry.get("published") or entry.get("updated")
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw).astimezone(timezone.utc)
        now = datetime.now(timezone.utc)
        if dt > now:
            dt = now  # feeds occasionally publish with clock-skewed or future timestamps
        return dt.isoformat()
    except Exception:
        return raw  # return raw string rather than drop the date


def _feed_summary(entry: Any) -> str:
    content = entry.get("content")
    if content:
        return content[0].get("value", "")
    return entry.get("summary", "")
