"""Tests for ntfy.sh push notifications — gated on NTFY_TOPIC, must never
raise (a notification failure must not take down the pipeline run it's
reporting on)."""
from __future__ import annotations

import httpx

from harvester.notify import notify


def test_notify_noop_without_topic(monkeypatch):
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    calls = {"n": 0}
    monkeypatch.setattr("harvester.notify.httpx.post", lambda *a, **k: calls.__setitem__("n", calls["n"] + 1))

    notify("title", "message")

    assert calls["n"] == 0


def test_notify_posts_to_topic_url_with_headers(monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "my-secret-topic")
    captured = {}

    def fake_post(url, data=None, headers=None, timeout=None):
        captured["url"] = url
        captured["data"] = data
        captured["headers"] = headers

    monkeypatch.setattr("harvester.notify.httpx.post", fake_post)

    notify("Backend down", "3 articles skipped", priority="urgent", tags="warning,electric_plug")

    assert captured["url"] == "https://ntfy.sh/my-secret-topic"
    assert captured["data"] == b"3 articles skipped"
    assert captured["headers"]["Title"] == "Backend down"
    assert captured["headers"]["Priority"] == "urgent"
    assert captured["headers"]["Tags"] == "warning,electric_plug"


def test_notify_omits_tags_header_when_not_given(monkeypatch):
    monkeypatch.setenv("NTFY_TOPIC", "t")
    captured = {}
    monkeypatch.setattr("harvester.notify.httpx.post", lambda url, data=None, headers=None, timeout=None: captured.update(headers=headers))

    notify("title", "message")

    assert "Tags" not in captured["headers"]


def test_notify_swallows_http_errors(monkeypatch):
    """A dead network / unreachable ntfy.sh must not raise into the caller —
    the whole point is this can't be allowed to take down a pipeline run."""
    monkeypatch.setenv("NTFY_TOPIC", "t")

    def fake_post(*a, **k):
        raise httpx.ConnectError("no network")

    monkeypatch.setattr("harvester.notify.httpx.post", fake_post)

    notify("title", "message")  # must not raise
