"""Tests for get_feed_health()'s silent_days threshold — the knob pipeline.py
uses to warn on 48h feed staleness independently of the dashboard API's
3-day display default."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from harvester.store.db import Database


def _make_db(tmp_path):
    db = Database(tmp_path / "health.db")
    db.init_schema()
    return db


def _iso(hours_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


def test_feed_silent_at_60h_flagged_with_48h_threshold(tmp_path):
    """A feed that last returned articles 60h ago (well past 48h, short of 72h)
    must be flagged by the pipeline's 48h warning."""
    db = _make_db(tmp_path)
    db.save_feed_health([{"feed_name": "DeadFeed", "checked_at": _iso(60), "article_count": 8, "error": None}])
    db.save_feed_health([{"feed_name": "DeadFeed", "checked_at": _iso(1), "article_count": 0, "error": None}])

    results = db.get_feed_health(["DeadFeed"], silent_days=2.0)

    assert results[0]["status"] == "silent"


def test_feed_silent_at_60h_not_flagged_with_default_3day_threshold(tmp_path):
    """The same 60h-since-last-article feed should NOT yet be flagged by the
    dashboard API's more lenient 3-day default — different consumers,
    different urgency thresholds."""
    db = _make_db(tmp_path)
    db.save_feed_health([{"feed_name": "DeadFeed", "checked_at": _iso(60), "article_count": 8, "error": None}])
    db.save_feed_health([{"feed_name": "DeadFeed", "checked_at": _iso(1), "article_count": 0, "error": None}])

    results = db.get_feed_health(["DeadFeed"])  # default silent_days=3.0

    assert results[0]["status"] == "ok"


def test_feed_with_articles_never_silent_regardless_of_threshold(tmp_path):
    db = _make_db(tmp_path)
    db.save_feed_health([
        {"feed_name": "HealthyFeed", "checked_at": _iso(1), "article_count": 12, "error": None},
    ])

    results = db.get_feed_health(["HealthyFeed"], silent_days=2.0)

    assert results[0]["status"] == "ok"


def test_feed_error_status_independent_of_silent_days(tmp_path):
    db = _make_db(tmp_path)
    db.save_feed_health([
        {"feed_name": "BrokenFeed", "checked_at": _iso(1), "article_count": 0, "error": "404 Not Found"},
    ])

    results = db.get_feed_health(["BrokenFeed"], silent_days=2.0)

    assert results[0]["status"] == "error"
    assert results[0]["consecutive_errors"] == 1
