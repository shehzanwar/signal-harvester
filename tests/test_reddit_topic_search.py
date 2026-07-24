"""Tests for Reddit topic-subreddit search — catches discussion that never
links the specific article, unlike fetch_reddit()'s URL-match search."""
from __future__ import annotations

import harvester.social as social


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _post(permalink, score):
    return {"data": {"permalink": permalink, "score": score}}


# ── extract_search_keywords ────────────────────────────────────────────────

def test_keywords_prefer_tags_over_title():
    kw = social.extract_search_keywords(
        "Some very long headline about things happening",
        ["iran conflict", "cyberattack", "critical infrastructure"],
    )
    assert kw == "iran conflict cyberattack critical infrastructure"


def test_keywords_fall_back_to_title_when_tags_insufficient():
    kw = social.extract_search_keywords("Houthis attack Saudi tankers", [])
    # stopwords ("attack" isn't a stopword) filtered; short words dropped
    words = kw.split()
    assert "Houthis" in words or "houthis" in kw.lower()
    assert len(words) <= 3


def test_keywords_empty_when_nothing_usable():
    kw = social.extract_search_keywords("as of to in", [])
    assert kw == ""


# ── fetch_reddit_topic_comments ────────────────────────────────────────────

def test_topic_search_dedupes_comments_across_subreddits(monkeypatch):
    """The same comment text turning up under two subreddits (crossposts are
    common) must only appear once in the result."""
    search_calls = {"n": 0}

    def fake_get(url, **kwargs):
        search_calls["n"] += 1
        return _FakeResp({"data": {"children": [_post("/r/worldnews/comments/abc/x/", 100)]}})

    monkeypatch.setattr(social.httpx, "get", fake_get)
    monkeypatch.setattr(
        social, "fetch_reddit_comments",
        lambda permalink, token=None, top_n=5: [{"text": "same comment text here", "score": 50, "author": "x", "url": "https://reddit.com/r/x"}],
    )

    comments = social.fetch_reddit_topic_comments(
        "Iran cyberattack on water infrastructure",
        ["iran", "cyberattack"],
        token="fake-token",
        subreddits=["worldnews", "technology"],
    )

    assert len(comments) == 1
    assert search_calls["n"] == 2  # both subreddits were searched


def test_topic_search_filters_low_score_posts(monkeypatch):
    monkeypatch.setattr(
        social.httpx, "get",
        lambda *a, **k: _FakeResp({"data": {"children": [_post("/r/worldnews/comments/low/x/", 5)]}}),
    )
    called = {"n": 0}
    monkeypatch.setattr(social, "fetch_reddit_comments", lambda *a, **k: called.__setitem__("n", called["n"] + 1) or [])

    comments = social.fetch_reddit_topic_comments("some topic", ["tag"], token="fake-token", subreddits=["worldnews"])

    assert comments == []
    assert called["n"] == 0  # score 5 < min score 20 — never even fetched comments


def test_topic_search_returns_empty_with_no_extractable_keywords(monkeypatch):
    def fail_if_called(*a, **k):
        raise AssertionError("should not make any HTTP call with no keywords")
    monkeypatch.setattr(social.httpx, "get", fail_if_called)

    comments = social.fetch_reddit_topic_comments("as of to in", [], token="fake-token", subreddits=["worldnews"])

    assert comments == []


def test_topic_search_sorts_by_score_descending(monkeypatch):
    monkeypatch.setattr(
        social.httpx, "get",
        lambda *a, **k: _FakeResp({"data": {"children": [_post("/r/worldnews/comments/x/y/", 100)]}}),
    )
    monkeypatch.setattr(
        social, "fetch_reddit_comments",
        lambda *a, **k: [
            {"text": "low score comment", "score": 5, "author": "a", "url": None},
            {"text": "high score comment", "score": 500, "author": "b", "url": None},
        ],
    )

    comments = social.fetch_reddit_topic_comments("topic", ["tag"], token="fake-token", subreddits=["worldnews"])

    assert comments[0]["text"] == "high score comment"


def test_topic_search_returns_empty_without_token(monkeypatch):
    """No REDDIT_CLIENT_ID/SECRET configured -> no request at all, since the
    unauthenticated search endpoint always 403s (see module docstring note)."""
    def fail_if_called(*a, **k):
        raise AssertionError("should not make any HTTP call without a token")
    monkeypatch.setattr(social.httpx, "get", fail_if_called)

    comments = social.fetch_reddit_topic_comments("Iran cyberattack", ["iran"], token=None, subreddits=["worldnews"])

    assert comments == []
