"""Tests for get_comment_source_staleness_days — the fix that gives visibility
into a Twitter/YouTube comment fetcher that has silently stopped producing
rows (expired twscrape cookies, revoked/quota-exhausted YouTube key). Those
fetchers swallow all errors internally at DEBUG level by design, so this
staleness check is the only way anything outside the process notices."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from harvester.store.db import Database


def _make_db(tmp_path):
    db = Database(tmp_path / "staleness.db")
    db.init_schema()
    return db


def _insert_article(con, aid):
    con.execute(
        """INSERT INTO articles (id, feed_name, url, title, fetched_at, status)
           VALUES (?, 'feed', ?, ?, '2026-07-23T12:00:00+00:00', 'enriched')""",
        (aid, f"https://example.com/{aid}", f"title {aid}"),
    )


def _insert_comment(con, aid, source, fetched_at):
    con.execute(
        """INSERT INTO article_comments (article_id, source, comment_text, comment_score, fetched_at)
           VALUES (?, ?, 'text', 1, ?)""",
        (aid, source, fetched_at),
    )


def test_returns_none_for_source_with_no_rows(tmp_path):
    db = _make_db(tmp_path)

    result = db.get_comment_source_staleness_days()

    assert result["twitter"] is None
    assert result["youtube"] is None
    assert result["hn"] is None
    assert result["bluesky"] is None


def test_computes_days_since_most_recent_row(tmp_path):
    db = _make_db(tmp_path)
    three_days_ago = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    with sqlite3.connect(str(db._path)) as con:
        _insert_article(con, "a1")
        _insert_comment(con, "a1", "twitter", three_days_ago)
        con.commit()

    result = db.get_comment_source_staleness_days()

    assert result["twitter"] is not None
    assert 2.9 < result["twitter"] < 3.1
    assert result["youtube"] is None


def test_uses_most_recent_row_when_multiple_exist(tmp_path):
    db = _make_db(tmp_path)
    old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    recent = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    with sqlite3.connect(str(db._path)) as con:
        _insert_article(con, "a1")
        _insert_article(con, "a2")
        _insert_comment(con, "a1", "youtube", old)
        _insert_comment(con, "a2", "youtube", recent)
        con.commit()

    result = db.get_comment_source_staleness_days()

    assert result["youtube"] < 1.0


def test_sources_are_independent(tmp_path):
    db = _make_db(tmp_path)
    recent = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    with sqlite3.connect(str(db._path)) as con:
        _insert_article(con, "a1")
        _insert_comment(con, "a1", "hn", recent)
        con.commit()

    result = db.get_comment_source_staleness_days()

    assert result["hn"] is not None
    assert result["twitter"] is None
    assert result["youtube"] is None
    assert result["bluesky"] is None
