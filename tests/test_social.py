"""Tests for multi-source social signals: URL normalization, the CHECK-drop
migration, and cross-source aggregation in get_enriched_articles."""
from __future__ import annotations

import sqlite3

from harvester.social import _norm_url, fetch_mastodon_trending
from harvester.store.db import Database


def test_norm_url_strips_query_fragment_and_trailing_slash():
    assert _norm_url("https://Example.com/Path/?utm=1#frag") == "https://example.com/path"
    assert _norm_url("http://a.com/x") == "http://a.com/x"
    assert _norm_url("https://a.com/") == "https://a.com"


def test_mastodon_trending_parse(monkeypatch):
    """Aggregates uses/accounts across the history window, keyed by normalized URL."""
    class FakeResp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return [
                {
                    "url": "https://news.example.com/story/",
                    "history": [
                        {"day": "1", "uses": "10", "accounts": "8"},
                        {"day": "2", "uses": "5", "accounts": "4"},
                    ],
                },
                {"url": "https://z.example.com/dead", "history": [{"uses": "0", "accounts": "0"}]},
            ]

    monkeypatch.setattr("harvester.social.httpx.get", lambda *a, **k: FakeResp())
    trends = fetch_mastodon_trending()
    assert trends["https://news.example.com/story"] == {
        "score": 15,
        "comments": 12,
        "permalink": "https://mastodon.social/explore",
    }
    # zero-engagement links are dropped
    assert "https://z.example.com/dead" not in trends


def _old_check_db(path):
    con = sqlite3.connect(str(path))
    con.executescript(
        """
        CREATE TABLE social_signals (
            article_id TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('hn','reddit')),
            score INTEGER NOT NULL DEFAULT 0,
            comments INTEGER NOT NULL DEFAULT 0,
            permalink TEXT,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (article_id, source)
        );
        """
    )
    con.execute("INSERT INTO social_signals VALUES ('a1','hn',10,2,'x','2026-07-16')")
    con.commit()
    con.close()


def test_migration_drops_check_and_preserves_rows(tmp_path):
    path = tmp_path / "m.db"
    _old_check_db(path)
    db = Database(path)
    db.init_schema()  # runs the migration
    con = sqlite3.connect(str(path))
    sql = con.execute("SELECT sql FROM sqlite_master WHERE name='social_signals'").fetchone()[0]
    assert "CHECK" not in sql
    assert con.execute("SELECT COUNT(*) FROM social_signals").fetchone()[0] == 1
    # A previously-forbidden source now inserts fine.
    con.execute("INSERT INTO social_signals VALUES ('a1','lemmy',5,1,'y','2026-07-16')")
    con.commit()
    con.close()


def test_migration_is_idempotent(tmp_path):
    path = tmp_path / "i.db"
    db = Database(path)
    db.init_schema()
    db.init_schema()  # second call must be a no-op, not error
    assert True


def test_get_enriched_articles_aggregates_social(tmp_path):
    db = Database(tmp_path / "agg.db")
    db.init_schema()
    ts = "2026-07-16T12:00:00+00:00"
    with sqlite3.connect(str(db._path)) as con:
        con.execute(
            "INSERT INTO articles (id, feed_name, url, title, fetched_at, status) "
            "VALUES ('a1','f','http://x','t',?,'enriched')",
            (ts,),
        )
        con.execute(
            "INSERT INTO enrichments (article_id, summary, tier, sentiment_label, "
            "sentiment_score, tags, model, prompt_version, enriched_at) "
            "VALUES ('a1','s','T2','neutral',0.0,'[]','m','v4',?)",
            (ts,),
        )
        con.executemany(
            "INSERT INTO social_signals VALUES (?,?,?,?,?,?)",
            [
                ("a1", "hn", 40, 5, "hnurl", ts),
                ("a1", "lemmy", 12, 3, "lemurl", ts),
                ("a1", "mastodon", 100, 20, "masturl", ts),
            ],
        )
        con.commit()

    arts = db.get_enriched_articles()
    a = arts[0]
    assert a["social_score"] == 152  # 40 + 12 + 100
    sources = {s["source"] for s in a["social"]}
    assert sources == {"hn", "lemmy", "mastodon"}
