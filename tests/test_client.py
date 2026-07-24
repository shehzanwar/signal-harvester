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


def test_ollama_context_budget_warning_fires_near_num_ctx(monkeypatch, caplog):
    """Ollama's streaming response carries prompt_eval_count/eval_count only
    on the final (done=True) chunk — previously discarded entirely, so this
    backend had zero context-usage visibility. num_ctx=100 makes the 90%
    budget (90 tokens) easy to exceed without a huge fixture."""
    class FakeStream:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            pass

        def iter_lines(self):
            yield json.dumps({
                "response": _VALID_JSON, "done": True,
                "prompt_eval_count": 80, "eval_count": 20,  # total 100 > 90% of num_ctx=100
            })

    monkeypatch.setattr("harvester.enrich.client.httpx.stream", lambda *a, **k: FakeStream())

    cfg = ProfileConfig.model_validate({
        **_CFG, "llm": {"base_url": "http://localhost:11434/v1", "model": "q", "num_ctx": 100},
    })
    with caplog.at_level("WARNING", logger="harvester.enrich.client"):
        EnrichmentClient(cfg).enrich(_ARTICLE, cfg)

    assert any("context_budget_warning" in r.message for r in caplog.records)
    assert any("backend=ollama" in r.message for r in caplog.records)


def test_ollama_context_budget_no_warning_when_within_budget(monkeypatch, caplog):
    class FakeStream:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            pass

        def iter_lines(self):
            yield json.dumps({
                "response": _VALID_JSON, "done": True,
                "prompt_eval_count": 10, "eval_count": 5,  # total 15, well under 90% of 8192
            })

    monkeypatch.setattr("harvester.enrich.client.httpx.stream", lambda *a, **k: FakeStream())

    cfg = ProfileConfig.model_validate({**_CFG, "llm": {"base_url": "http://localhost:11434/v1", "model": "q"}})
    with caplog.at_level("WARNING", logger="harvester.enrich.client"):
        EnrichmentClient(cfg).enrich(_ARTICLE, cfg)

    assert not any("context_budget_warning" in r.message for r in caplog.records)


def test_llamacpp_context_budget_threshold_derives_from_num_ctx(monkeypatch, caplog):
    """Regression guard: the threshold used to be hardcoded at 7500 regardless
    of the profile's num_ctx. A small num_ctx must produce a warning well
    below where the old hardcoded value would have fired."""
    def fake_post(url, json=None, timeout=None):
        body = {
            "choices": [{"message": {"content": _VALID_JSON}}],
            "usage": {"prompt_tokens": 900, "completion_tokens": 50, "total_tokens": 950},
        }

        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return body

        return R()

    monkeypatch.setattr("harvester.enrich.client.httpx.post", fake_post)

    cfg = ProfileConfig.model_validate({**_CFG, "llm": {**_CFG["llm"], "num_ctx": 1000}})
    with caplog.at_level("WARNING", logger="harvester.enrich.client"):
        EnrichmentClient(cfg).enrich(_ARTICLE, cfg)

    assert any("context_budget_warning" in r.message and "backend=llamacpp" in r.message for r in caplog.records)
