import json

import pytest
from pydantic import ValidationError

from harvester.enrich.schemas import EnrichmentResult, SentimentResult

_VALID = {
    "summary": "A critical vulnerability was discovered in OpenSSL affecting all versions below 3.x.",
    "tier": "T1",
    "tier_rationale": "Active exploitation confirmed by CISA advisory with KEV listing.",
    "sentiment": {
        "label": "negative",
        "score": -0.85,
        "rationale": "Severe risk to security posture with confirmed exploitation in the wild.",
    },
    "tags": ["openssl", "zero-day", "critical vulnerability"],
}


def test_valid_result_parses():
    r = EnrichmentResult.model_validate(_VALID)
    assert r.tier == "T1"
    assert r.sentiment.score == -0.85
    assert len(r.tags) == 3


def test_invalid_tier_rejected():
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "tier": "T0"})


def test_noise_tier_accepted():
    r = EnrichmentResult.model_validate({**_VALID, "tier": "NOISE"})
    assert r.tier == "NOISE"


def test_score_above_range_rejected():
    bad_sent = {**_VALID["sentiment"], "score": 1.5}
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "sentiment": bad_sent})


def test_score_below_range_rejected():
    bad_sent = {**_VALID["sentiment"], "score": -1.1}
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "sentiment": bad_sent})


def test_invalid_sentiment_label_rejected():
    bad_sent = {**_VALID["sentiment"], "label": "ambiguous"}
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "sentiment": bad_sent})


def test_all_sentiment_labels_accepted():
    for label in ("positive", "negative", "neutral", "mixed"):
        sent = {**_VALID["sentiment"], "label": label}
        r = EnrichmentResult.model_validate({**_VALID, "sentiment": sent})
        assert r.sentiment.label == label


def test_empty_summary_rejected():
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "summary": ""})


def test_to_storage_dict():
    r = EnrichmentResult.model_validate(_VALID)
    d = r.to_storage_dict("qwen3:8b", "v1", json.dumps(_VALID))
    assert d["tier"] == "T1"
    assert d["_model"] == "qwen3:8b"
    assert d["_prompt_version"] == "v1"
    assert d["sentiment"]["label"] == "negative"
    assert isinstance(d["tags"], list)
