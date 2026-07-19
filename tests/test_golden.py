"""Pytest wrapper for golden-set evaluation.

Requires a running Ollama instance — mark with @pytest.mark.slow and opt in:
    pytest tests/test_golden.py -v -m slow

Add entries with:
    python scripts/export_golden.py <article_id>
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

GOLDEN_DIR = Path(__file__).parent / "golden"
PROFILE = "configs/profiles/daily-briefing.yaml"


@pytest.fixture(scope="session")
def cfg():
    from harvester.config import load_profile
    return load_profile(PROFILE)


@pytest.fixture(scope="session")
def enrich_client(cfg):
    from harvester.enrich.client import EnrichmentClient
    return EnrichmentClient(cfg)


def _golden_files():
    return [f for f in sorted(GOLDEN_DIR.glob("*.json")) if f.name != "README.md"]


@pytest.mark.slow
@pytest.mark.parametrize("golden_file", _golden_files(), ids=lambda p: p.stem)
def test_golden(golden_file: Path, enrich_client, cfg) -> None:
    data = json.loads(golden_file.read_text(encoding="utf-8"))
    expected = data.pop("expected", {})
    data.pop("notes", None)

    exp_tier = expected.get("tier", "")
    if not exp_tier or exp_tier.upper() == "TODO":
        pytest.skip(f"{golden_file.stem}: not labeled yet")

    result = enrich_client.enrich(data, cfg)
    time.sleep(2)

    assert result["tier"] == exp_tier, (
        f"Tier mismatch: expected={exp_tier!r} got={result['tier']!r}\n"
        f"title: {data.get('title','')[:80]}\n"
        f"rationale: {result.get('tier_rationale','')}"
    )

    for phrase in expected.get("tier_rationale_contains", []):
        assert phrase.lower() in result.get("tier_rationale", "").lower(), (
            f"rationale missing {phrase!r} for {golden_file.stem}"
        )

    exp_label = expected.get("sentiment_label")
    if exp_label:
        got = result["sentiment"]["label"]
        assert got == exp_label, (
            f"Sentiment mismatch: expected={exp_label!r} got={got!r} for {golden_file.stem}"
        )
