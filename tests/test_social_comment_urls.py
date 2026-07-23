"""Tests that comment fetchers populate a per-comment `url` pointing at the
actual post/comment, not just the article — the fix for broken social links
where the frontend previously had nowhere real to send the user."""
from __future__ import annotations

import harvester.social as social


class _FakeResp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def test_hn_comments_get_per_item_url(monkeypatch):
    tree = {
        "children": [
            {
                "id": 111,
                "author": "alice",
                "text": "a" * 50,
                "children": [
                    {"id": 222, "author": "bob", "text": "b" * 50, "children": []},
                ],
            },
        ],
    }
    monkeypatch.setattr(social.httpx, "get", lambda *a, **k: _FakeResp(tree))

    comments = social.fetch_hn_comments("999", top_n=10)

    urls = {c["url"] for c in comments}
    assert urls == {
        "https://news.ycombinator.com/item?id=111",
        "https://news.ycombinator.com/item?id=222",
    }


def test_reddit_comments_use_own_permalink_not_submission(monkeypatch):
    listing = [
        {},  # index 0: submission listing (unused by fetch_reddit_comments)
        {
            "data": {
                "children": [
                    {
                        "data": {
                            "body": "c" * 50,
                            "score": 42,
                            "author": "carol",
                            "permalink": "/r/test/comments/abc/title/def456/",
                        }
                    },
                ]
            }
        },
    ]
    monkeypatch.setattr(social.httpx, "get", lambda *a, **k: _FakeResp(listing))
    social._reddit_comments_throttle._last = 0  # avoid real sleep in test

    comments = social.fetch_reddit_comments("/r/test/comments/abc/title/", top_n=10)

    assert comments[0]["url"] == "https://reddit.com/r/test/comments/abc/title/def456/"


def test_youtube_comments_get_per_comment_deep_link(monkeypatch):
    search_payload = {"items": [{"id": {"videoId": "VID123"}, "snippet": {"channelTitle": "Some Channel"}}]}
    comments_payload = {
        "items": [
            {
                "id": "COMMENT_ID_1",
                "snippet": {
                    "topLevelComment": {
                        "snippet": {
                            "textDisplay": "d" * 50,
                            "likeCount": 7,
                            "authorDisplayName": "dave",
                        }
                    }
                },
            },
        ]
    }

    calls = {"n": 0}

    def fake_get(url, **kwargs):
        calls["n"] += 1
        if "search" in url:
            return _FakeResp(search_payload)
        return _FakeResp(comments_payload)

    monkeypatch.setattr(social.httpx, "get", fake_get)
    monkeypatch.setenv("YOUTUBE_API_KEY", "fake-key-for-test")
    social._yt_throttle._last = 0

    comments = social.fetch_youtube_comments("some article title", top_n=10)

    assert comments[0]["url"] == "https://www.youtube.com/watch?v=VID123&lc=COMMENT_ID_1"


def test_youtube_comment_without_id_falls_back_to_video_url(monkeypatch):
    search_payload = {"items": [{"id": {"videoId": "VID999"}, "snippet": {"channelTitle": "X"}}]}
    comments_payload = {
        "items": [
            {
                # no "id" key on the comment thread itself
                "snippet": {
                    "topLevelComment": {
                        "snippet": {"textDisplay": "e" * 50, "likeCount": 1, "authorDisplayName": "eve"}
                    }
                },
            },
        ]
    }

    def fake_get(url, **kwargs):
        return _FakeResp(search_payload) if "search" in url else _FakeResp(comments_payload)

    monkeypatch.setattr(social.httpx, "get", fake_get)
    monkeypatch.setenv("YOUTUBE_API_KEY", "fake-key-for-test")
    social._yt_throttle._last = 0

    comments = social.fetch_youtube_comments("title", top_n=10)

    assert comments[0]["url"] == "https://www.youtube.com/watch?v=VID999"
