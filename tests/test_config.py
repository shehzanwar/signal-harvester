import pytest
from pydantic import ValidationError

from harvester.config import ProfileConfig, load_profile

_MINIMAL = {
    "profile": "test",
    "feeds": [{"name": "Test Feed", "url": "https://example.com/feed.xml"}],
    "watch_topics": ["testing"],
    "sentiment_target": "our organization",
    "tiers": {"T1": "Critical", "T2": "Notable", "T3": "Background"},
}


def test_valid_config_loads():
    cfg = ProfileConfig.model_validate(_MINIMAL)
    assert cfg.profile == "test"
    assert len(cfg.feeds) == 1
    assert cfg.llm.model == "qwen3:8b"
    assert cfg.llm.temperature == 0.2


def test_default_output_root():
    cfg = ProfileConfig.model_validate(_MINIMAL)
    assert cfg.output.root == "output"


def test_empty_feeds_rejected():
    with pytest.raises(ValidationError, match="feeds"):
        ProfileConfig.model_validate({**_MINIMAL, "feeds": []})


def test_empty_topics_rejected():
    with pytest.raises(ValidationError, match="watch_topics"):
        ProfileConfig.model_validate({**_MINIMAL, "watch_topics": []})


def test_missing_required_field_rejected():
    data = {k: v for k, v in _MINIMAL.items() if k != "tiers"}
    with pytest.raises(ValidationError):
        ProfileConfig.model_validate(data)


def test_load_profile_file_not_found():
    with pytest.raises(FileNotFoundError):
        load_profile("this_does_not_exist.yaml")


def test_feed_category_default_and_map():
    cfg = ProfileConfig.model_validate(_MINIMAL)
    # Unspecified category falls back to "general".
    assert cfg.feeds[0].category == "general"
    assert cfg.feed_category_map() == {"Test Feed": "general"}


def test_daily_briefing_feeds_have_known_categories():
    """Every feed in the shipped profile must declare a nav category, or it
    silently vanishes from the category bar (defaults to 'general')."""
    from pathlib import Path

    path = Path("configs/profiles/daily-briefing.yaml")
    if not path.exists():
        pytest.skip("daily-briefing.yaml not found (run from project root)")
    cfg = load_profile(path)
    known = {"technology", "finance", "politics", "sports", "world"}
    for feed in cfg.feeds:
        assert feed.category in known, f"{feed.name} has category {feed.category!r}"


def test_load_real_profiles(tmp_path):
    """Smoke-test that the bundled profiles parse without errors."""
    import yaml
    from pathlib import Path

    profiles_dir = Path("configs/profiles")
    if not profiles_dir.exists():
        pytest.skip("configs/profiles not found (run from project root)")
    for yaml_file in profiles_dir.glob("*.yaml"):
        cfg = load_profile(yaml_file)
        assert cfg.profile
        assert cfg.feeds
        assert cfg.watch_topics
