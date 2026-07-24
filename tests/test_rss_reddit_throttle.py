"""Tests that reddit.com feeds get throttled/retried and other feeds don't.

Reddit rate-limits its RSS endpoints to ~1 req/min regardless of User-Agent;
fetching several subreddit feeds back-to-back (the normal no-delay behavior
for distinct-domain feeds) would 429 every one after the first without this."""
from __future__ import annotations

from harvester.config import FeedConfig, ProfileConfig
from harvester.sources import rss as rss_module
from harvester.sources.rss import RSSSource

_MINIMAL_FEED_XML = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>t</title>
<item><title>Hello</title><link>https://example.com/a</link></item>
</channel></rss>"""


def _cfg_with_feeds(*urls: str) -> ProfileConfig:
    return ProfileConfig(
        profile="test",
        feeds=[FeedConfig(name=f"feed{i}", url=u) for i, u in enumerate(urls)],
        watch_topics=["x"],
        sentiment_target="x",
        tiers={"T1": "x", "T2": "x", "T3": "x"},
    )


class _FakeResp:
    def __init__(self, status_code=200, content=_MINIMAL_FEED_XML):
        self.status_code = status_code
        self.content = content

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            raise httpx.HTTPStatusError("error", request=None, response=self)


def test_reddit_url_waits_on_throttle(monkeypatch):
    waited = {"n": 0}
    monkeypatch.setattr(rss_module._reddit_throttle, "wait", lambda: waited.__setitem__("n", waited["n"] + 1))
    monkeypatch.setattr(rss_module.httpx, "get", lambda *a, **k: _FakeResp())

    source = RSSSource(_cfg_with_feeds("https://www.reddit.com/r/worldnews/top/.rss"))
    articles, health = source.fetch()

    assert waited["n"] == 1
    assert health[0]["error"] is None


def test_non_reddit_url_does_not_touch_throttle(monkeypatch):
    waited = {"n": 0}
    monkeypatch.setattr(rss_module._reddit_throttle, "wait", lambda: waited.__setitem__("n", waited["n"] + 1))
    monkeypatch.setattr(rss_module.httpx, "get", lambda *a, **k: _FakeResp())

    source = RSSSource(_cfg_with_feeds("https://example.com/feed.xml"))
    source.fetch()

    assert waited["n"] == 0


def test_reddit_429_retries_once_after_backoff(monkeypatch):
    monkeypatch.setattr(rss_module._reddit_throttle, "wait", lambda: None)
    monkeypatch.setattr(rss_module.time, "sleep", lambda *_: None)

    calls = {"n": 0}

    def fake_get(*a, **k):
        calls["n"] += 1
        return _FakeResp(status_code=429 if calls["n"] == 1 else 200)

    monkeypatch.setattr(rss_module.httpx, "get", fake_get)

    source = RSSSource(_cfg_with_feeds("https://www.reddit.com/r/worldnews/top/.rss"))
    articles, health = source.fetch()

    assert calls["n"] == 2
    assert health[0]["error"] is None
    assert len(articles) == 1
