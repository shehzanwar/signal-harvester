"""Selection tests for backfill targeting (prompt-version / stale filters)."""
from __future__ import annotations

import sqlite3

from harvester.store.db import Database


def _make_db(tmp_path):
    db = Database(tmp_path / "bf.db")
    db.init_schema()
    return db


def _insert(con, aid, version, day="2026-07-16"):
    ts = f"{day}T12:00:00+00:00"
    con.execute(
        """INSERT INTO articles (id, feed_name, url, title, fetched_at, status)
           VALUES (?, 'feed', ?, ?, ?, 'enriched')""",
        (aid, f"https://example.com/{aid}", f"title {aid}", ts),
    )
    con.execute(
        """INSERT INTO enrichments
           (article_id, summary, tier, sentiment_label, sentiment_score,
            tags, model, prompt_version, enriched_at)
           VALUES (?, 's', 'T3', 'neutral', 0.0, '[]', 'm', ?, ?)""",
        (aid, version, ts),
    )


def _seed(con):
    for i in range(3):
        _insert(con, f"v1_{i}", "v1")
    for i in range(2):
        _insert(con, f"v4_{i}", "v4")
    _insert(con, "pf_0", "pre-filter")
    con.commit()


def test_exclude_current_version_selects_all_stale(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _seed(con)
    # "stale" relative to v4 = the 3 v1 rows + 1 pre-filter row.
    stale = db.get_articles_for_backfill(exclude_prompt_version="v4")
    ids = {a["id"] for a in stale}
    assert ids == {"v1_0", "v1_1", "v1_2", "pf_0"}


def test_stale_includes_orphans_from_an_interrupted_run(tmp_path):
    """An interrupted backfill leaves articles whose enrichment row was already
    deleted (status back to 'extracted'). --stale must still pick those up, or
    they are stranded with no enrichment at all."""
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _seed(con)
        # Simulate the interruption: reset one v1 article mid-flight.
        con.execute("DELETE FROM enrichments WHERE article_id='v1_0'")
        con.execute("UPDATE articles SET status='extracted' WHERE id='v1_0'")
        con.commit()

    stale = db.get_articles_for_backfill(exclude_prompt_version="v4")
    ids = {a["id"] for a in stale}
    assert "v1_0" in ids, "orphaned article was skipped — it would never be re-enriched"
    assert ids == {"v1_0", "v1_1", "v1_2", "pf_0"}


def test_exact_prompt_version_selects_only_that(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _seed(con)
    v1 = db.get_articles_for_backfill(prompt_version="v1")
    assert {a["id"] for a in v1} == {"v1_0", "v1_1", "v1_2"}


def test_prompt_version_combines_with_date(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert(con, "old_v1", "v1", day="2026-07-01")
        _insert(con, "new_v1", "v1", day="2026-07-16")
        con.commit()
    recent = db.get_articles_for_backfill(prompt_version="v1", from_date="2026-07-10")
    assert {a["id"] for a in recent} == {"new_v1"}
