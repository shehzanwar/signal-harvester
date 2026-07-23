"""Tests for backfill_social_signals_from_comments — the fix for orphaned
twitter/youtube comments that predate the save_social_signals() write."""
from __future__ import annotations

import sqlite3

from harvester.store.db import Database


def _make_db(tmp_path):
    db = Database(tmp_path / "backfill.db")
    db.init_schema()
    return db


def _insert_article(con, aid):
    con.execute(
        """INSERT INTO articles (id, feed_name, url, title, fetched_at, status)
           VALUES (?, 'feed', ?, ?, '2026-07-23T12:00:00+00:00', 'enriched')""",
        (aid, f"https://example.com/{aid}", f"title {aid}"),
    )


def _insert_comment(con, aid, source, score, text=None):
    con.execute(
        """INSERT INTO article_comments (article_id, source, comment_text, comment_score, fetched_at)
           VALUES (?, ?, ?, ?, '2026-07-23T12:00:00+00:00')""",
        (aid, source, text or f"comment {score}", score),
    )


def test_backfills_missing_social_signal_from_stored_comments(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert_article(con, "orphan")
        _insert_comment(con, "orphan", "twitter", 5)
        _insert_comment(con, "orphan", "twitter", 3)
        con.commit()

    count = db.backfill_social_signals_from_comments("twitter")

    assert count == 1
    with sqlite3.connect(str(db._path)) as con:
        row = con.execute(
            "SELECT score, comments FROM social_signals WHERE article_id='orphan' AND source='twitter'"
        ).fetchone()
    assert row == (8, 2)


def test_does_not_touch_articles_with_existing_signal(tmp_path):
    """An article whose social_signals row already exists must not be
    re-aggregated/overwritten by the backfill."""
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert_article(con, "already_has_signal")
        _insert_comment(con, "already_has_signal", "twitter", 100)
        con.execute(
            """INSERT INTO social_signals (article_id, source, score, comments, fetched_at)
               VALUES ('already_has_signal', 'twitter', 999, 1, '2026-07-23T12:00:00+00:00')"""
        )
        con.commit()

    count = db.backfill_social_signals_from_comments("twitter")

    assert count == 0
    with sqlite3.connect(str(db._path)) as con:
        row = con.execute(
            "SELECT score FROM social_signals WHERE article_id='already_has_signal' AND source='twitter'"
        ).fetchone()
    assert row == (999,)  # untouched


def test_is_source_scoped(tmp_path):
    """Backfilling 'twitter' must not create rows for a 'youtube'-only article."""
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert_article(con, "yt_only")
        _insert_comment(con, "yt_only", "youtube", 10)
        con.commit()

    count = db.backfill_social_signals_from_comments("twitter")

    assert count == 0
    with sqlite3.connect(str(db._path)) as con:
        assert con.execute("SELECT COUNT(*) FROM social_signals").fetchone()[0] == 0


def test_idempotent(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert_article(con, "orphan")
        _insert_comment(con, "orphan", "twitter", 5)
        con.commit()

    first = db.backfill_social_signals_from_comments("twitter")
    second = db.backfill_social_signals_from_comments("twitter")

    assert first == 1
    assert second == 0
