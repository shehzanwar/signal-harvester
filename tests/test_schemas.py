import json

import pytest
from pydantic import ValidationError

from harvester.enrich.schemas import EnrichmentResult, SentimentResult

_VALID = {
    "summary": "A critical vulnerability was discovered in OpenSSL affecting all versions below 3.x.",
    "tier": "T1",
    "tier_rationale": "Active exploitation confirmed by CISA advisory with KEV listing.",
    "editorial_tone": {
        "label": "negative",
        "score": -0.85,
        "rationale": "Severe risk to security posture with confirmed exploitation in the wild.",
    },
    "predicted_reaction": {
        "label": "negative",
        "score": -0.70,
        "rationale": "General public would likely react with widespread concern.",
    },
    "tags": ["openssl", "zero-day", "critical vulnerability"],
}


def test_valid_result_parses():
    r = EnrichmentResult.model_validate(_VALID)
    assert r.tier == "T1"
    assert r.editorial_tone.score == -0.85
    assert len(r.tags) == 3


def test_invalid_tier_rejected():
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "tier": "T0"})


def test_noise_tier_accepted():
    r = EnrichmentResult.model_validate({**_VALID, "tier": "NOISE"})
    assert r.tier == "NOISE"


def test_score_above_range_rejected():
    bad_tone = {**_VALID["editorial_tone"], "score": 1.5}
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "editorial_tone": bad_tone})


def test_score_below_range_rejected():
    bad_tone = {**_VALID["editorial_tone"], "score": -1.1}
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "editorial_tone": bad_tone})


def test_invalid_sentiment_label_rejected():
    bad_tone = {**_VALID["editorial_tone"], "label": "ambiguous"}
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "editorial_tone": bad_tone})


def test_all_sentiment_labels_accepted():
    # Each label must be paired with a sign-consistent score, or the
    # label_score_consistent validator rejects it (positive needs score>=0,
    # negative needs score<=0; neutral/mixed are unconstrained).
    for label, score in (("positive", 0.85), ("negative", -0.85), ("neutral", 0.0), ("mixed", 0.0)):
        tone = {**_VALID["editorial_tone"], "label": label, "score": score}
        r = EnrichmentResult.model_validate({**_VALID, "editorial_tone": tone})
        assert r.editorial_tone.label == label
        assert r.editorial_tone.score == score


def test_empty_summary_rejected():
    with pytest.raises(ValidationError):
        EnrichmentResult.model_validate({**_VALID, "summary": ""})


def test_to_storage_dict():
    r = EnrichmentResult.model_validate(_VALID)
    d = r.to_storage_dict("qwen3:8b", "v1", json.dumps(_VALID))
    assert d["tier"] == "T1"
    assert d["_model"] == "qwen3:8b"
    assert d["_prompt_version"] == "v1"
    assert d["editorial_tone"]["label"] == "negative"
    assert d["predicted_reaction"]["label"] == "negative"
    assert isinstance(d["tags"], list)
