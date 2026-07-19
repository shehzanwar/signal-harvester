"""Unit tests for Database.get_trends — the trailing-window + folding logic.

These are pure-Python (temp SQLite, no Ollama). They pin the Phase A fixes:
  * today is excluded from the 7-day trailing comparison window (no more fake 7.0);
  * tags with <2 distinct prior days are surfaced as status="new", not a ratio;
  * generic tags are dropped from trending and top_tags;
  * plural/singular variants fold together when the singular co-occurs.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

from harvester.store.db import Database


def _day(n: int) -> str:
    """ISO date string for `n` days before today (UTC). n=0 is today."""
    return (datetime.now(timezone.utc) - timedelta(days=n)).strftime("%Y-%m-%d")


def _make_db(tmp_path):
    db = Database(tmp_path / "trends.db")
    db.init_schema()
    return db


def _insert(con: sqlite3.Connection, aid: str, day: str, tags: list[str],
            tier: str = "T2", score: float = 0.1) -> None:
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
           VALUES (?, 's', ?, 'neutral', ?, ?, 'm', 'v4', ?)""",
        (aid, tier, score, json.dumps(tags), ts),
    )


def _seed(con: sqlite3.Connection) -> None:
    n = 0

    def add(day: str, tags: list[str]) -> None:
        nonlocal n
        n += 1
        _insert(con, f"a{n}", day, tags)

    # Brand-new tag: only today, no prior history -> must be "new", not 7.0.
    add(_day(0), ["novel-topic"])
    add(_day(0), ["novel-topic"])
    add(_day(0), ["novel-topic"])

    # Genuine spike: history on 3 distinct prior days, big jump today -> trending.
    for d in (1, 2, 3):
        add(_day(d), ["iran-conflict"])
    for _ in range(4):
        add(_day(0), ["iran-conflict"])

    # Stable tag: ~2/day every day incl. today -> ratio ~1.0, NOT trending.
    for d in (1, 2, 3, 4, 5):
        add(_day(d), ["weather"])
        add(_day(d), ["weather"])
    add(_day(0), ["weather"])
    add(_day(0), ["weather"])

    # Generic tag: present today and before -> excluded from trending + top_tags.
    for d in (0, 0, 1, 2):
        add(_day(d), ["news"])

    # Plural/singular folding: "strike" has prior history on 2 days, "strikes"
    # appears twice today; both should collapse to one "strike" entry.
    add(_day(1), ["strike"])
    add(_day(2), ["strike"])
    add(_day(0), ["strikes"])
    add(_day(0), ["strikes"])


def test_trending_window_and_folding(tmp_path):
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _seed(con)
        con.commit()

    trends = db.get_trends(days=30)
    trending = {t["tag"]: t for t in trends["trending"]}
    top = {t["tag"] for t in trends["top_tags"]}

    # --- brand-new tag: status "new", no fabricated ratio ---
    assert "novel-topic" in trending
    assert trending["novel-topic"]["status"] == "new"
    assert trending["novel-topic"]["ratio"] is None

    # --- genuine spike: real trending with a ratio well above 1 ---
    assert "iran-conflict" in trending
    assert trending["iran-conflict"]["status"] == "trending"
    assert trending["iran-conflict"]["ratio"] is not None
    assert trending["iran-conflict"]["ratio"] > 2.0

    # --- stable tag: not trending at all ---
    assert "weather" not in trending

    # --- generic tag: excluded from BOTH surfaces ---
    assert "news" not in trending
    assert "news" not in top

    # --- folding: singular+plural collapse into one "strike" entry ---
    assert "strikes" not in trending
    assert "strike" in trending
    assert trending["strike"]["today"] == 2  # both of today's "strikes"


def test_no_degenerate_seven_ratio(tmp_path):
    """A tag that only ever appears today must never ratio out to exactly 7.0
    (the pre-fix bug where the trailing avg divided today's count by 7)."""
    db = _make_db(tmp_path)
    with sqlite3.connect(str(db._path)) as con:
        _insert(con, "x1", _day(0), ["fresh"])
        _insert(con, "x2", _day(0), ["fresh"])
        con.commit()

    trends = db.get_trends(days=30)
    fresh = next(t for t in trends["trending"] if t["tag"] == "fresh")
    assert fresh["status"] == "new"
    assert fresh["ratio"] != 7.0
