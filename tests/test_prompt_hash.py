"""Tests for prompt_template_hash() — detects an enrichment.md edit that
landed without a PROMPT_VERSION bump, which the version string alone can't."""
from __future__ import annotations

from harvester.config import ProfileConfig
from harvester.enrich.prompts import prompt_template_hash

_BASE_CFG = {
    "profile": "test",
    "feeds": [{"name": "f", "url": "https://example.com/feed.xml"}],
    "watch_topics": ["x"],
    "sentiment_target": "x",
    "tiers": {"T1": "x", "T2": "x", "T3": "x"},
}


def _cfg_with_prompt_path(path: str) -> ProfileConfig:
    return ProfileConfig.model_validate({**_BASE_CFG, "prompts": {"enrichment": path}})


def test_hash_is_deterministic(tmp_path):
    p = tmp_path / "enrichment.md"
    p.write_text("You are an analyst. $watch_topics", encoding="utf-8")
    cfg = _cfg_with_prompt_path(str(p))

    assert prompt_template_hash(cfg) == prompt_template_hash(cfg)


def test_hash_changes_when_template_content_changes(tmp_path):
    p = tmp_path / "enrichment.md"
    p.write_text("Version A of the prompt. $watch_topics", encoding="utf-8")
    cfg = _cfg_with_prompt_path(str(p))
    hash_a = prompt_template_hash(cfg)

    p.write_text("Version B of the prompt, materially different. $watch_topics", encoding="utf-8")
    hash_b = prompt_template_hash(cfg)

    assert hash_a != hash_b


def test_hash_is_independent_of_per_profile_substitution(tmp_path):
    """The hash covers the raw template FILE, not the profile-substituted
    result — two profiles sharing the same enrichment.md must get the same
    hash even though their tier text differs and produces different
    build_system_prompt() output."""
    p = tmp_path / "enrichment.md"
    p.write_text("Tiers: $tier1_criteria / $tier2_criteria / $tier3_criteria", encoding="utf-8")

    cfg_a = ProfileConfig.model_validate({
        **_BASE_CFG, "profile": "a",
        "tiers": {"T1": "profile A criteria", "T2": "x", "T3": "x"},
        "prompts": {"enrichment": str(p)},
    })
    cfg_b = ProfileConfig.model_validate({
        **_BASE_CFG, "profile": "b",
        "tiers": {"T1": "totally different profile B criteria", "T2": "y", "T3": "y"},
        "prompts": {"enrichment": str(p)},
    })

    assert prompt_template_hash(cfg_a) == prompt_template_hash(cfg_b)


def test_falls_back_to_default_template_when_file_missing(tmp_path):
    """A missing prompts.enrichment path falls back to _DEFAULT_SYSTEM_PROMPT
    (same as build_system_prompt()) rather than raising."""
    cfg = _cfg_with_prompt_path(str(tmp_path / "does_not_exist.md"))

    result = prompt_template_hash(cfg)

    assert isinstance(result, str) and len(result) == 12
