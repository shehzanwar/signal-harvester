"""Tests for the llama.cpp enrichment backend (mocked HTTP — no server needed)."""
from __future__ import annotations

import json

import httpx
import pytest

from harvester.config import ProfileConfig
from harvester.enrich.client import EnrichmentClient

_CFG = {
    "profile": "test",
    "feeds": [{"name": "F", "url": "https://example.com/feed.xml"}],
    "watch_topics": ["security"],
    "sentiment_target": "a security team",
    "tiers": {"T1": "critical", "T2": "notable", "T3": "background"},
    "llm": {"backend": "llamacpp", "base_url": "http://localhost:11435/v1", "model": "qwen3-8b"},
}

_ARTICLE = {
    "id": "1",
    "title": "Critical OpenSSL vulnerability found in TLS handshake",
    "extracted_text": "A critical OpenSSL vulnerability affects the TLS handshake and is being exploited.",
    "url": "https://example.com/openssl",
}

# Valid enrichment that shares tokens with the article (passes the confabulation guard).
_VALID_JSON = json.dumps({
    "summary": "A critical OpenSSL vulnerability affects the TLS handshake and needs urgent patching.",
    "tier": "T1",
    "tier_rationale": "Active exploitation confirmed in the wild.",
    "editorial_tone": {"label": "negative", "score": -0.8, "rationale": "Severe security risk."},
    "predicted_reaction": {"label": "negative", "score": -0.7, "rationale": "Public would react with concern."},
    "tags": ["openssl", "vulnerability", "tls"],
})


def _fake_resp(content: str):
    class R:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": content}}]}

    return R()


def test_llamacpp_builds_chat_request(monkeypatch):
    captured = {}

    def fake_post(url, json=None, timeout=None):
        captured["url"] = url
        captured["payload"] = json
        return _fake_resp(_VALID_JSON)

    monkeypatch.setattr("harvester.enrich.client.httpx.post", fake_post)

    cfg = ProfileConfig.model_validate(_CFG)
    result = EnrichmentClient(cfg).enrich(_ARTICLE, cfg)

    assert captured["url"] == "http://localhost:11435/v1/chat/completions"
    p = captured["payload"]
    # response_format/json_schema is intentionally omitted: the GBNF grammar sampler
    # evaluates minLength/maxLength at every token step (~20x slower on b10075).
    # Structural validation is handled by Pydantic + one retry instead.
    assert "response_format" not in p
    assert [m["role"] for m in p["messages"]] == ["system", "user"]
    assert p["chat_template_kwargs"] == {"enable_thinking": False}
    # parsed + validated end-to-end
    assert result["tier"] == "T1"
    assert result["_prompt_version"]
    assert result["tags"] == ["openssl", "vulnerability", "tls"]


def test_llamacpp_retries_then_succeeds(monkeypatch):
    calls = {"n": 0}

    def flaky_post(url, json=None, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("connection refused")
        return _fake_resp(_VALID_JSON)

    monkeypatch.setattr("harvester.enrich.client.httpx.post", flaky_post)
    monkeypatch.setattr("harvester.enrich.client.time.sleep", lambda *_: None)

    cfg = ProfileConfig.model_validate(_CFG)
    result = EnrichmentClient(cfg).enrich(_ARTICLE, cfg)
    assert calls["n"] == 2
    assert result["tier"] == "T1"


def test_llamacpp_raises_after_persistent_failure(monkeypatch):
    def dead_post(url, json=None, timeout=None):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr("harvester.enrich.client.httpx.post", dead_post)
    monkeypatch.setattr("harvester.enrich.client.time.sleep", lambda *_: None)

    cfg = ProfileConfig.model_validate(_CFG)
    with pytest.raises(RuntimeError, match="llama-server"):
        EnrichmentClient(cfg).enrich(_ARTICLE, cfg)


def test_ollama_backend_does_not_hit_chat_endpoint(monkeypatch):
    """Default backend stays on /api/generate (httpx.stream), not /chat/completions."""
    def guard_post(*a, **k):
        raise AssertionError("ollama backend must not call httpx.post")

    monkeypatch.setattr("harvester.enrich.client.httpx.post", guard_post)

    class FakeStream:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            pass

        def iter_lines(self):
            yield json.dumps({"response": _VALID_JSON, "done": True})

    monkeypatch.setattr("harvester.enrich.client.httpx.stream", lambda *a, **k: FakeStream())

    cfg = ProfileConfig.model_validate({**_CFG, "llm": {"base_url": "http://localhost:11434/v1", "model": "q"}})
    assert cfg.llm.backend == "ollama"
    result = EnrichmentClient(cfg).enrich(_ARTICLE, cfg)
    assert result["tier"] == "T1"
