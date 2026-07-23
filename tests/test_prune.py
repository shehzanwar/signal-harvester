"""Tests for tiered retention pruning (Database.prune / slim_old_enrichments)."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from harvester.store.db import Database


def _make_db(tmp_path):
    db = Database(tmp_path / "prune.db")
    db.init_schema()
    return db


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _insert(con, aid, tier, days_ago, with_comment=False, with_social=False):
    ts = _iso(days_ago)
    con.execute(
        """INSERT INTO articles (id, feed_name, url, title, fetched_at, status, extracted_text)
           VALUES (?, 'feed', ?, ?, ?, 'enriched', 'raw article body')""",
        (aid, f"https://example.com/{aid}", f"title {aid}", ts),
    )
    con.execute(
        """INSERT INTO enrichments
           (article_id, summary, tier, sentiment_label, sentiment_score,
            tags, model, prompt_version, enriched_at, raw_response)
           VALUES (?, 's', ?, 'neutral', 0.0, '[]', 'm', 'v1', ?, 'raw llm output')""",
        (aid, tier, ts),
    )
    if with_comment:
        con.execute(
            """INSERT INTO article_comments (article_id, source, comment_text, fetched_at)
               VALUES (?, 'hn', 'a comment', ?)""",
            (aid, ts),
        )
    if with_social:
        con.execute(
            """INSERT INTO social_signals (article_id, source, score, comments, fetched_at)
               VALUES (?, 'hn', 10, 2, ?)""",
            (aid, ts),
        )


def test_t1_never_pruned_regardless_of_age(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert(con, "old_t1", "T1", days_ago=9999)
        con.commit()
    db.prune(article_days=1, health_days=1, t3_days=1, noise_days=1)
    with sqlite3.connect(str(db._path)) as con:
        assert con.execute("SELECT COUNT(*) FROM articles WHERE id='old_t1'").fetchone()[0] == 1


def test_tiers_use_independent_windows(tmp_path):
    """A 10-day-old T3 article is pruned (t3_days=5) while a 10-day-old T2
    article survives (article_days=30) — the tiers must not share one cutoff."""
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert(con, "t3_old", "T3", days_ago=10)
        _insert(con, "t2_old", "T2", days_ago=10)
        con.commit()
    db.prune(article_days=30, health_days=30, t3_days=5, noise_days=30)
    with sqlite3.connect(str(db._path)) as con:
        remaining = {r[0] for r in con.execute("SELECT id FROM articles").fetchall()}
    assert remaining == {"t2_old"}


def test_prune_deletes_comments_without_fk_violation(tmp_path):
    """Regression test: article_comments references articles(id) and this
    connection runs with PRAGMA foreign_keys=ON. Pruning an article that still
    has comment rows must not raise 'FOREIGN KEY constraint failed'."""
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert(con, "commented", "T3", days_ago=30, with_comment=True, with_social=True)
        con.commit()

    counts = db.prune(article_days=90, health_days=30, t3_days=5, noise_days=3)

    assert counts["comments"] == 1
    assert counts["social_signals"] == 1
    assert counts["articles"] == 1
    with sqlite3.connect(str(db._path)) as con:
        assert con.execute("SELECT COUNT(*) FROM articles").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM article_comments").fetchone()[0] == 0


def test_dry_run_deletes_nothing(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert(con, "t3_old", "T3", days_ago=10, with_comment=True)
        con.commit()
    counts = db.prune(article_days=30, health_days=30, t3_days=5, noise_days=30, dry_run=True)
    assert counts["articles"] == 1
    assert counts["comments"] == 1
    with sqlite3.connect(str(db._path)) as con:
        assert con.execute("SELECT COUNT(*) FROM articles").fetchone()[0] == 1


def test_slim_old_enrichments_clears_raw_text_only(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert(con, "old", "T2", days_ago=10)
        _insert(con, "recent", "T2", days_ago=1)
        con.commit()

    slimmed = db.slim_old_enrichments(days=7)

    assert slimmed == 1
    with sqlite3.connect(str(db._path)) as con:
        old_row = con.execute(
            "SELECT a.extracted_text, e.raw_response, e.summary FROM articles a "
            "JOIN enrichments e ON e.article_id = a.id WHERE a.id = 'old'"
        ).fetchone()
        recent_row = con.execute(
            "SELECT a.extracted_text, e.raw_response FROM articles a "
            "JOIN enrichments e ON e.article_id = a.id WHERE a.id = 'recent'"
        ).fetchone()
    assert old_row[0] is None and old_row[1] is None
    assert old_row[2] == "s"  # summary untouched
    assert recent_row[0] is not None and recent_row[1] is not None
