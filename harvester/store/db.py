from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Generator

from harvester.config import ProfileConfig
from harvester.enrich.prompts import PROMPT_VERSION

log = logging.getLogger(__name__)

# Tags too broad to carry a "trending" signal. Both singular and plural forms
# are listed so the check survives the plural->singular folding in get_trends.
_GENERIC_TREND_TAGS = frozenset({
    "sports", "sport", "politics", "politic", "roundup", "roundups",
    "news", "analysis", "analyses",
})


def _singularize(tag: str) -> str:
    """Fold the last word of a lowercased tag phrase to a naive singular.

    Deliberately conservative: leaves words ending in ss/us/is/as/os (analysis,
    gas, bias, chaos) untouched, and only strips a plain trailing 's'. Callers
    apply this only when the singular form co-occurs in the data, so genuine
    words like 'news' are never mangled unless a real variant exists.
    """
    parts = tag.split()
    if not parts:
        return tag
    last = parts[-1]
    if last.endswith("ies") and len(last) > 4:
        parts[-1] = last[:-3] + "y"
    elif last.endswith(("ss", "us", "is", "as", "os")):
        pass
    elif last.endswith("s") and len(last) > 3:
        parts[-1] = last[:-1]
    return " ".join(parts)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id             TEXT PRIMARY KEY,
    feed_name      TEXT NOT NULL,
    url            TEXT NOT NULL,
    guid           TEXT,
    title          TEXT NOT NULL,
    published_at   TEXT,
    fetched_at     TEXT NOT NULL,
    extracted_text TEXT,
    summary        TEXT,
    status         TEXT NOT NULL DEFAULT 'fetched',
    retry_count    INTEGER DEFAULT 0,
    cluster_id     TEXT
);

CREATE TABLE IF NOT EXISTS enrichments (
    article_id                   TEXT PRIMARY KEY REFERENCES articles(id),
    summary                      TEXT NOT NULL,
    tier                         TEXT NOT NULL CHECK (tier IN ('T1','T2','T3','NOISE')),
    tier_rationale               TEXT,
    sentiment_label              TEXT NOT NULL CHECK (sentiment_label IN ('positive','negative','neutral','mixed')),
    sentiment_score              REAL NOT NULL CHECK (sentiment_score BETWEEN -1.0 AND 1.0),
    sentiment_rationale          TEXT,
    predicted_reaction_label     TEXT CHECK (predicted_reaction_label IN ('positive','negative','neutral','mixed')),
    predicted_reaction_score     REAL CHECK (predicted_reaction_score BETWEEN -1.0 AND 1.0),
    predicted_reaction_rationale TEXT,
    public_sentiment_label       TEXT CHECK (public_sentiment_label IN ('positive','negative','neutral','mixed')),
    public_sentiment_score       REAL CHECK (public_sentiment_score BETWEEN -1.0 AND 1.0),
    dominant_emotion             TEXT,
    sentiment_confidence         TEXT CHECK (sentiment_confidence IN ('high','medium','low','predicted')),
    perception_gap               REAL,
    composite_sentiment_score    REAL CHECK (composite_sentiment_score BETWEEN -1.0 AND 1.0),
    tags                         TEXT NOT NULL,
    model                        TEXT NOT NULL,
    prompt_version               TEXT NOT NULL,
    raw_response                 TEXT,
    enriched_at                  TEXT NOT NULL,
    latency_ms                   INTEGER
);

CREATE TABLE IF NOT EXISTS social_signals (
    article_id  TEXT NOT NULL,
    source      TEXT NOT NULL,
    score       INTEGER NOT NULL DEFAULT 0,
    comments    INTEGER NOT NULL DEFAULT 0,
    permalink   TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (article_id, source)
);

CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    profile     TEXT,
    started_at  TEXT,
    finished_at TEXT,
    fetched     INTEGER,
    new         INTEGER,
    enriched    INTEGER,
    failed      INTEGER,
    notes       TEXT
);

CREATE TABLE IF NOT EXISTS feed_health (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_name     TEXT NOT NULL,
    checked_at    TEXT NOT NULL,
    article_count INTEGER NOT NULL DEFAULT 0,
    error         TEXT
);

CREATE TABLE IF NOT EXISTS article_comments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id     TEXT NOT NULL REFERENCES articles(id),
    source         TEXT NOT NULL,
    comment_text   TEXT NOT NULL,
    comment_score  INTEGER,
    comment_author TEXT,
    fetched_at     TEXT NOT NULL,
    UNIQUE(article_id, source, comment_text)
);

CREATE INDEX IF NOT EXISTS idx_articles_status     ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_fetched_at ON articles(fetched_at);
CREATE INDEX IF NOT EXISTS idx_enrichments_tier    ON enrichments(tier);
CREATE INDEX IF NOT EXISTS idx_enrichments_at      ON enrichments(enriched_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_feed_guid ON articles(feed_name, guid)
    WHERE guid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_feed_health_feed ON feed_health(feed_name, checked_at);
CREATE INDEX IF NOT EXISTS idx_comments_article ON article_comments(article_id);
"""

# FTS5 virtual table + triggers — created separately from _SCHEMA so they can be
# applied as a migration to existing DBs without touching the main schema script.
_FTS_INIT: list[str] = [
    """CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
        article_id UNINDEXED,
        title,
        enrich_summary,
        tags,
        tokenize='porter ascii'
    )""",
    # INSERT OR REPLACE on enrichments fires DELETE + INSERT, so the delete
    # trigger cleans up the old FTS row before the insert trigger adds the new one.
    """CREATE TRIGGER IF NOT EXISTS fts_enrich_after_insert
    AFTER INSERT ON enrichments BEGIN
        DELETE FROM articles_fts WHERE article_id = NEW.article_id;
        INSERT INTO articles_fts(article_id, title, enrich_summary, tags)
        SELECT NEW.article_id, a.title, NEW.summary, NEW.tags
        FROM articles a WHERE a.id = NEW.article_id;
    END""",
    """CREATE TRIGGER IF NOT EXISTS fts_enrich_after_delete
    AFTER DELETE ON enrichments BEGIN
        DELETE FROM articles_fts WHERE article_id = OLD.article_id;
    END""",
]

# Maximum LLM retries across all pipeline runs before an article is abandoned
_MAX_ENRICH_RETRIES = 3


def _article_id(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:32]


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, db_path: str | Path) -> None:
        self._path = Path(db_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_config(cls, cfg: ProfileConfig) -> "Database":
        root = Path(cfg.output.root)
        root.mkdir(parents=True, exist_ok=True)
        return cls(root / f"{cfg.profile}.db")

    @contextmanager
    def _conn(self) -> Generator[sqlite3.Connection, None, None]:
        con = sqlite3.connect(str(self._path), timeout=30)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA foreign_keys=ON")
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def init_schema(self) -> None:
        with self._conn() as con:
            con.executescript(_SCHEMA)
        # Safe migrations for existing DBs
        for stmt in [
            "ALTER TABLE articles ADD COLUMN retry_count INTEGER DEFAULT 0",
            "ALTER TABLE articles ADD COLUMN cluster_id TEXT",
            "ALTER TABLE enrichments ADD COLUMN predicted_reaction_label TEXT",
            "ALTER TABLE enrichments ADD COLUMN predicted_reaction_score REAL",
            "ALTER TABLE enrichments ADD COLUMN predicted_reaction_rationale TEXT",
            "ALTER TABLE enrichments ADD COLUMN public_sentiment_label TEXT",
            "ALTER TABLE enrichments ADD COLUMN public_sentiment_score REAL",
            "ALTER TABLE enrichments ADD COLUMN dominant_emotion TEXT",
            "ALTER TABLE enrichments ADD COLUMN sentiment_confidence TEXT",
            "ALTER TABLE enrichments ADD COLUMN perception_gap REAL",
            "ALTER TABLE enrichments ADD COLUMN composite_sentiment_score REAL",
        ]:
            try:
                with self._conn() as con:
                    con.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists

        self._migrate_social_source_check()
        self._migrate_fts()

    def _migrate_social_source_check(self) -> None:
        """Drop the legacy `CHECK (source IN ('hn','reddit'))` on social_signals.

        SQLite can't ALTER a constraint, so rebuild the table when the old CHECK
        is still present. Idempotent: no-op once the constraint is gone.
        """
        with self._conn() as con:
            row = con.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='social_signals'"
            ).fetchone()
            if not row or "CHECK" not in (row[0] or ""):
                return
            log.info("migrating social_signals: dropping source CHECK constraint")
            con.executescript(
                """
                CREATE TABLE social_signals_new (
                    article_id  TEXT NOT NULL,
                    source      TEXT NOT NULL,
                    score       INTEGER NOT NULL DEFAULT 0,
                    comments    INTEGER NOT NULL DEFAULT 0,
                    permalink   TEXT,
                    fetched_at  TEXT NOT NULL,
                    PRIMARY KEY (article_id, source)
                );
                INSERT OR IGNORE INTO social_signals_new
                    SELECT article_id, source, score, comments, permalink, fetched_at
                    FROM social_signals;
                DROP TABLE social_signals;
                ALTER TABLE social_signals_new RENAME TO social_signals;
                """
            )

    def _migrate_fts(self) -> None:
        """Create FTS5 table + triggers and backfill any un-indexed enrichments."""
        for stmt in _FTS_INIT:
            try:
                with self._conn() as con:
                    con.execute(stmt)
            except sqlite3.OperationalError:
                pass  # already exists
        # Backfill rows that existed before the FTS table was created.
        with self._conn() as con:
            con.execute(
                """INSERT INTO articles_fts(article_id, title, enrich_summary, tags)
                   SELECT e.article_id, a.title, e.summary, e.tags
                   FROM enrichments e
                   JOIN articles a ON a.id = e.article_id
                   WHERE e.article_id NOT IN (SELECT article_id FROM articles_fts)"""
            )

    def insert_new_articles(self, articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Insert articles, silently skip duplicates. Return only the newly inserted ones."""
        new: list[dict[str, Any]] = []
        with self._conn() as con:
            for art in articles:
                art_id = _article_id(art["url"])
                try:
                    con.execute(
                        """INSERT INTO articles
                           (id, feed_name, url, guid, title, published_at, fetched_at, summary, status)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fetched')""",
                        (
                            art_id,
                            art.get("feed_name", ""),
                            art["url"],
                            art.get("guid"),
                            art.get("title", "(no title)"),
                            art.get("published_at"),
                            art.get("fetched_at", _now_utc()),
                            art.get("summary"),
                        ),
                    )
                    new.append({**art, "id": art_id})
                except sqlite3.IntegrityError:
                    pass  # duplicate — skip silently
        return new

    def update_extracted(self, article_id: str, text: str) -> None:
        with self._conn() as con:
            con.execute(
                "UPDATE articles SET extracted_text=?, status='extracted' WHERE id=?",
                (text, article_id),
            )

    def mark_failed(self, article_id: str, status: str) -> None:
        with self._conn() as con:
            if status == "failed_llm":
                con.execute(
                    "UPDATE articles SET status=?, retry_count=COALESCE(retry_count, 0)+1 WHERE id=?",
                    (status, article_id),
                )
            else:
                con.execute("UPDATE articles SET status=? WHERE id=?", (status, article_id))

    def get_articles_for_enrichment(self) -> list[dict[str, Any]]:
        """Return articles ready to enrich: newly extracted + failed_llm below retry cap."""
        with self._conn() as con:
            rows = con.execute(
                f"""SELECT * FROM articles
                    WHERE status = 'extracted'
                       OR (status = 'failed_llm'
                           AND COALESCE(retry_count, 0) < {_MAX_ENRICH_RETRIES})
                    ORDER BY published_at DESC"""
            ).fetchall()
        return [dict(r) for r in rows]

    def save_enrichment(
        self,
        article_id: str,
        enrichment: dict[str, Any],
        *,
        latency_ms: int = 0,
    ) -> None:
        tone = enrichment.get("editorial_tone") or enrichment.get("sentiment") or {}
        reaction = enrichment.get("predicted_reaction") or {}
        with self._conn() as con:
            con.execute(
                """INSERT OR REPLACE INTO enrichments
                   (article_id, summary, tier, tier_rationale, sentiment_label, sentiment_score,
                    sentiment_rationale, predicted_reaction_label, predicted_reaction_score,
                    predicted_reaction_rationale, tags, model, prompt_version, raw_response,
                    enriched_at, latency_ms)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    article_id,
                    enrichment["summary"],
                    enrichment["tier"],
                    enrichment.get("tier_rationale", ""),
                    tone.get("label", "neutral"),
                    tone.get("score", 0.0),
                    tone.get("rationale", ""),
                    reaction.get("label"),
                    reaction.get("score"),
                    reaction.get("rationale"),
                    json.dumps(enrichment.get("tags", [])),
                    enrichment.get("_model", ""),
                    enrichment.get("_prompt_version", "v1"),
                    enrichment.get("_raw_response"),
                    _now_utc(),
                    latency_ms,
                ),
            )
            con.execute("UPDATE articles SET status='enriched' WHERE id=?", (article_id,))

    def update_cluster_ids(self, cluster_map: dict[str, str]) -> None:
        """Write cluster_id for a batch of articles. cluster_map: {article_id: cluster_id}."""
        with self._conn() as con:
            con.executemany(
                "UPDATE articles SET cluster_id=? WHERE id=?",
                [(cid, aid) for aid, cid in cluster_map.items()],
            )

    def save_social_signals(self, signals: list[dict[str, Any]]) -> None:
        """Upsert social signals. Each dict: {article_id, source, score, comments, permalink}."""
        with self._conn() as con:
            con.executemany(
                """INSERT OR REPLACE INTO social_signals
                   (article_id, source, score, comments, permalink, fetched_at)
                   VALUES (:article_id, :source, :score, :comments, :permalink, :fetched_at)""",
                [{**s, "fetched_at": _now_utc()} for s in signals],
            )

    def has_comments(self, article_id: str, source: str) -> bool:
        """Return True if we already have comments for this article from this source."""
        with self._conn() as con:
            row = con.execute(
                "SELECT 1 FROM article_comments WHERE article_id=? AND source=? LIMIT 1",
                (article_id, source),
            ).fetchone()
        return row is not None

    def backfill_social_signals_from_comments(self, source: str) -> int:
        """Create missing social_signals rows for articles that already have
        stored comments from `source` but no aggregated signal row.

        Twitter/YouTube fetching skips any article that already has comments
        from a prior run (has_comments() == True) to avoid re-fetching — but
        that skip happens before save_social_signals() is ever called, so an
        article whose comments were fetched before the "write social_signals
        too" behavior existed (or whose write was interrupted) is left with
        comments the LLM can see but the UI's source-attribution badges never
        show. This aggregates score/comment-count directly from the stored
        comments — no network call — and is safe to run every pipeline run
        since it only inserts rows that don't already exist. Returns the
        number of articles backfilled.
        """
        with self._conn() as con:
            missing = con.execute(
                """SELECT article_id FROM article_comments ac
                   WHERE ac.source = ?
                     AND NOT EXISTS (
                       SELECT 1 FROM social_signals ss
                       WHERE ss.article_id = ac.article_id AND ss.source = ?
                     )
                   GROUP BY article_id""",
                (source, source),
            ).fetchall()
            if not missing:
                return 0
            now = _now_utc()
            for (article_id,) in missing:
                agg = con.execute(
                    """SELECT COALESCE(SUM(comment_score), 0), COUNT(*)
                       FROM article_comments WHERE article_id = ? AND source = ?""",
                    (article_id, source),
                ).fetchone()
                con.execute(
                    """INSERT INTO social_signals (article_id, source, score, comments, permalink, fetched_at)
                       VALUES (?, ?, ?, ?, NULL, ?)""",
                    (article_id, source, agg[0] or 0, agg[1], now),
                )
        return len(missing)

    def save_comments(
        self,
        article_id: str,
        source: str,
        comments: list[dict[str, Any]],
    ) -> int:
        """Insert comments, skipping exact duplicates. Returns count inserted."""
        if not comments:
            return 0
        now = _now_utc()
        inserted = 0
        with self._conn() as con:
            for c in comments:
                try:
                    con.execute(
                        """INSERT OR IGNORE INTO article_comments
                           (article_id, source, comment_text, comment_score, comment_author, fetched_at)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (article_id, source, c["text"], c.get("score"), c.get("author"), now),
                    )
                    inserted += con.execute("SELECT changes()").fetchone()[0]
                except Exception:
                    pass
        return inserted

    def get_comments(self, article_id: str) -> list[dict[str, Any]]:
        """Return all comments for an article across all sources, best-score first."""
        with self._conn() as con:
            rows = con.execute(
                """SELECT source, comment_text AS text, comment_score AS score, comment_author AS author
                   FROM article_comments WHERE article_id = ?
                   ORDER BY CASE WHEN comment_score IS NULL THEN 0 ELSE comment_score END DESC""",
                (article_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_articles_needing_perception(self) -> list[dict[str, Any]]:
        """Return v5+ enriched articles that need perception scoring.

        Includes:
        - Articles never scored (perception_gap IS NULL)
        - Articles scored on predicted fallback (public_sentiment_label IS NULL) that
          now have ≥2 comments — comment fetching may have run after a prior scoring pass.
        - Articles with confidence='predicted' that have since accumulated ≥5 comments —
          enough signal to upgrade from LLM-predicted to comment-informed scoring.
        """
        with self._conn() as con:
            rows = con.execute(
                """SELECT a.id, a.status,
                          e.summary AS enrich_summary,
                          e.sentiment_score,
                          e.predicted_reaction_score,
                          e.predicted_reaction_label
                   FROM articles a
                   JOIN enrichments e ON a.id = e.article_id
                   WHERE a.status = 'enriched'
                     AND e.predicted_reaction_score IS NOT NULL
                     AND (
                       e.perception_gap IS NULL
                       OR (
                         e.public_sentiment_label IS NULL
                         AND (SELECT count(*) FROM article_comments ac
                              WHERE ac.article_id = a.id) >= 2
                       )
                       OR (
                         e.sentiment_confidence = 'predicted'
                         AND (SELECT count(*) FROM article_comments ac
                              WHERE ac.article_id = a.id) >= 5
                       )
                     )
                   ORDER BY a.fetched_at DESC"""
            ).fetchall()
        return [dict(r) for r in rows]

    def save_perception(self, article_id: str, perception: dict[str, Any]) -> None:
        """Write public sentiment and perception gap back to the enrichment row."""
        with self._conn() as con:
            con.execute(
                """UPDATE enrichments SET
                       public_sentiment_label    = ?,
                       public_sentiment_score    = ?,
                       dominant_emotion          = ?,
                       sentiment_confidence      = ?,
                       perception_gap            = ?,
                       composite_sentiment_score = ?
                   WHERE article_id = ?""",
                (
                    perception.get("public_sentiment_label"),
                    perception.get("public_sentiment_score"),
                    perception.get("dominant_emotion"),
                    perception.get("sentiment_confidence"),
                    perception.get("perception_gap"),
                    perception.get("composite_sentiment_score"),
                    article_id,
                ),
            )

    def get_enriched_articles(
        self,
        today_only: bool = False,
        tier: str | None = None,
        since: str | None = None,
    ) -> list[dict[str, Any]]:
        conditions = ["a.status = 'enriched'"]
        params: list[Any] = []
        if today_only:
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            conditions.append("a.fetched_at >= ?")
            params.append(today)
        if since:
            conditions.append("a.fetched_at >= ?")
            params.append(since)
        if tier:
            conditions.append("e.tier = ?")
            params.append(tier.upper())
        where = " AND ".join(conditions)
        with self._conn() as con:
            rows = con.execute(
                f"""SELECT a.*, e.summary AS enrich_summary, e.tier, e.tier_rationale,
                           e.sentiment_label, e.sentiment_score, e.sentiment_rationale,
                           e.predicted_reaction_label, e.predicted_reaction_score,
                           e.predicted_reaction_rationale,
                           e.public_sentiment_label, e.public_sentiment_score,
                           e.dominant_emotion, e.sentiment_confidence, e.perception_gap,
                           e.tags, e.model, e.enriched_at, e.latency_ms, e.prompt_version
                    FROM articles a
                    JOIN enrichments e ON a.id = e.article_id
                    WHERE {where}
                    ORDER BY
                        CASE e.tier WHEN 'T1' THEN 1 WHEN 'T2' THEN 2
                                    WHEN 'T3' THEN 3 ELSE 4 END,
                        a.published_at DESC""",
                params,
            ).fetchall()
            results = []
            by_id: dict[str, dict[str, Any]] = {}
            for r in rows:
                d = dict(r)
                d["tags"] = json.loads(d["tags"]) if d.get("tags") else []
                d["social"] = []
                d["social_score"] = 0
                results.append(d)
                by_id[d["id"]] = d

            # Attach social signals from all sources (aggregate score per article).
            if by_id:
                for s in con.execute(
                    "SELECT article_id, source, score, comments, permalink FROM social_signals"
                ).fetchall():
                    d = by_id.get(s["article_id"])
                    if d is None:
                        continue
                    d["social"].append({
                        "source": s["source"],
                        "score": s["score"] or 0,
                        "comments": s["comments"] or 0,
                        "permalink": s["permalink"],
                    })
                    d["social_score"] += s["score"] or 0
        return results

    def get_articles_page(
        self,
        *,
        search: str | None = None,
        tier: str | None = None,
        today_only: bool = False,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[int, list[dict[str, Any]]]:
        """Paginated article listing with optional FTS5 search.

        Returns (total_matching, page_of_articles). Unlike get_enriched_articles,
        this applies LIMIT/OFFSET at the SQL level and scopes the social-signal
        query to only the returned rows. Used by the API; not used in the pipeline.
        """
        conditions = ["a.status = 'enriched'"]
        params: list[Any] = []

        if today_only:
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            conditions.append("a.fetched_at >= ?")
            params.append(today)
        if tier:
            conditions.append("e.tier = ?")
            params.append(tier.upper())

        fts_params: list[str] = []
        if search:
            tokens = re.findall(r"\w+", search)
            if tokens:
                fts_query = " ".join(f"{t}*" for t in tokens)
                conditions.append(
                    "e.article_id IN (SELECT article_id FROM articles_fts WHERE articles_fts MATCH ?)"
                )
                fts_params.append(fts_query)

        where = " AND ".join(conditions)
        all_params = params + fts_params
        order = (
            "ORDER BY CASE e.tier WHEN 'T1' THEN 1 WHEN 'T2' THEN 2"
            "              WHEN 'T3' THEN 3 ELSE 4 END, a.published_at DESC"
        )

        with self._conn() as con:
            total: int = con.execute(
                f"""SELECT COUNT(*) FROM articles a
                    JOIN enrichments e ON a.id = e.article_id
                    WHERE {where}""",
                all_params,
            ).fetchone()[0]

            rows = con.execute(
                f"""SELECT a.*, e.summary AS enrich_summary, e.tier, e.tier_rationale,
                           e.sentiment_label, e.sentiment_score, e.sentiment_rationale,
                           e.predicted_reaction_label, e.predicted_reaction_score,
                           e.predicted_reaction_rationale,
                           e.public_sentiment_label, e.public_sentiment_score,
                           e.dominant_emotion, e.sentiment_confidence, e.perception_gap,
                           e.tags, e.model, e.enriched_at, e.latency_ms, e.prompt_version
                    FROM articles a
                    JOIN enrichments e ON a.id = e.article_id
                    WHERE {where}
                    {order}
                    LIMIT ? OFFSET ?""",
                all_params + [limit, offset],
            ).fetchall()

            results: list[dict[str, Any]] = []
            by_id: dict[str, dict[str, Any]] = {}
            for r in rows:
                d = dict(r)
                d["tags"] = json.loads(d["tags"]) if d.get("tags") else []
                d["social"] = []
                d["social_score"] = 0
                results.append(d)
                by_id[d["id"]] = d

            if by_id:
                placeholders = ",".join("?" * len(by_id))
                for s in con.execute(
                    f"SELECT article_id, source, score, comments, permalink"
                    f" FROM social_signals WHERE article_id IN ({placeholders})",
                    list(by_id.keys()),
                ).fetchall():
                    d = by_id.get(s["article_id"])
                    if d:
                        d["social"].append({
                            "source": s["source"],
                            "score": s["score"] or 0,
                            "comments": s["comments"] or 0,
                            "permalink": s["permalink"],
                        })
                        d["social_score"] += s["score"] or 0

        return total, results

    def get_articles_for_backfill(
        self,
        from_date: str | None = None,
        to_date: str | None = None,
        status: str | None = None,
        prompt_version: str | None = None,
        exclude_prompt_version: str | None = None,
    ) -> list[dict[str, Any]]:
        """Select articles to re-enrich.

        prompt_version / exclude_prompt_version filter by the enrichment's
        version (join on enrichments) — e.g. exclude_prompt_version=current
        targets only "stale" rows left behind by an older prompt.
        """
        clauses: list[str] = []
        params: list[Any] = []
        if from_date:
            clauses.append("a.fetched_at >= ?")
            params.append(from_date)
        if to_date:
            clauses.append("a.fetched_at <= ?")
            params.append(to_date + "T23:59:59")
        if status:
            clauses.append("a.status = ?")
            params.append(status)
        else:
            clauses.append("a.status IN ('enriched', 'failed_llm', 'extracted')")

        join = ""
        if prompt_version is not None:
            join = "JOIN enrichments e ON e.article_id = a.id"
            clauses.append("e.prompt_version = ?")
            params.append(prompt_version)
        elif exclude_prompt_version is not None:
            # LEFT JOIN so this stays resume-safe: an interrupted backfill leaves
            # articles whose enrichment row was already deleted by
            # reset_enrichment. An INNER JOIN would silently skip them, stranding
            # them with no enrichment at all. IS NULL catches those orphans.
            join = "LEFT JOIN enrichments e ON e.article_id = a.id"
            clauses.append("(e.prompt_version IS NULL OR e.prompt_version != ?)")
            params.append(exclude_prompt_version)

        where = " AND ".join(clauses) if clauses else "1=1"
        with self._conn() as con:
            rows = con.execute(
                f"SELECT a.* FROM articles a {join} WHERE {where} ORDER BY a.fetched_at DESC",
                params,
            ).fetchall()
        return [dict(r) for r in rows]

    def reset_enrichment(self, article_id: str) -> None:
        with self._conn() as con:
            con.execute("DELETE FROM enrichments WHERE article_id=?", (article_id,))
            con.execute(
                "UPDATE articles SET status='extracted', retry_count=0, cluster_id=NULL WHERE id=?",
                (article_id,),
            )

    def record_run(
        self,
        run_id: str,
        profile: str,
        started_at: str,
        finished_at: str,
        counts: dict[str, int],
    ) -> None:
        notes = json.dumps({
            "failed_extract": counts.get("failed_extract", 0),
            "failed_llm": counts.get("failed_llm", 0),
            "noise_prefiltered": counts.get("noise_prefiltered", 0),
        })
        with self._conn() as con:
            con.execute(
                """INSERT INTO runs (id, profile, started_at, finished_at, fetched, new, enriched, failed, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    run_id, profile, started_at, finished_at,
                    counts["fetched"], counts["new"], counts["enriched"], counts["failed"],
                    notes,
                ),
            )

    def get_stats(self) -> dict[str, Any]:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        seven_days_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        with self._conn() as con:
            total = con.execute("SELECT COUNT(*) FROM articles").fetchone()[0]
            enriched = con.execute(
                "SELECT COUNT(*) FROM articles WHERE status='enriched'"
            ).fetchone()[0]
            failed_llm = con.execute(
                "SELECT COUNT(*) FROM articles WHERE status='failed_llm'"
            ).fetchone()[0]
            tier_rows = con.execute(
                "SELECT tier, COUNT(*) FROM enrichments GROUP BY tier"
            ).fetchall()
            today_new = con.execute(
                "SELECT COUNT(*) FROM articles WHERE fetched_at >= ?", (today,)
            ).fetchone()[0]
            last_run = con.execute(
                "SELECT * FROM runs ORDER BY started_at DESC LIMIT 1"
            ).fetchone()
            noise = con.execute(
                "SELECT COUNT(*) FROM enrichments WHERE tier='NOISE'"
            ).fetchone()[0]
            avg_sentiment = con.execute(
                "SELECT AVG(sentiment_score) FROM enrichments WHERE tier != 'NOISE'"
            ).fetchone()[0]
            # Windowed KPIs — scoped to the last 7 days AND the current prompt
            # version. Stale v1-era rows still sit inside the 7-day window and
            # would otherwise inflate T1 (145 v1 rows vs 32 v4 rows as of launch).
            t1_7d = con.execute(
                """SELECT COUNT(*) FROM enrichments e
                   JOIN articles a ON e.article_id=a.id
                   WHERE e.tier='T1' AND a.fetched_at >= ?
                     AND e.prompt_version = ?""",
                (seven_days_ago, PROMPT_VERSION),
            ).fetchone()[0]
            avg_sentiment_7d_row = con.execute(
                """SELECT AVG(COALESCE(e.composite_sentiment_score, e.sentiment_score))
                   FROM enrichments e
                   JOIN articles a ON e.article_id=a.id
                   WHERE e.tier != 'NOISE' AND a.fetched_at >= ?
                     AND e.prompt_version = ?""",
                (seven_days_ago, PROMPT_VERSION),
            ).fetchone()[0]
            version_rows = con.execute(
                "SELECT prompt_version, COUNT(*) FROM enrichments GROUP BY prompt_version ORDER BY COUNT(*) DESC"
            ).fetchall()
        prompt_coverage = {r[0]: r[1] for r in version_rows}
        # "pre-filter" is the version tag for noise articles skipped by the title
        # regex — they were never sent to the LLM so they're not "stale" in the
        # backfill sense.
        stale_count = sum(
            v for k, v in prompt_coverage.items()
            if k != PROMPT_VERSION and k != "pre-filter"
        )
        return {
            "total_articles": total,
            "enriched_articles": enriched,
            "failed_llm": failed_llm,
            "today_new": today_new,
            "noise_filtered": noise,
            "avg_sentiment": round(avg_sentiment, 3) if avg_sentiment is not None else None,
            "avg_sentiment_7d": round(avg_sentiment_7d_row, 3) if avg_sentiment_7d_row is not None else None,
            "tiers": dict(tier_rows),
            "t1_7d": t1_7d,
            "last_run": dict(last_run) if last_run else None,
            "prompt_version": PROMPT_VERSION,
            "prompt_coverage": prompt_coverage,
            "stale_count": stale_count,
        }

    def get_trends(self, days: int = 30) -> dict[str, Any]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        # Trailing comparison window: the 7 calendar days BEFORE today. Including
        # today (the old bug) made every no-history tag ratio out to exactly 7.0.
        prior_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

        with self._conn() as con:
            rows = con.execute(
                """SELECT date(a.fetched_at) AS d, e.tier,
                          COALESCE(e.composite_sentiment_score, e.sentiment_score) AS sentiment_score,
                          e.tags
                   FROM articles a
                   JOIN enrichments e ON a.id = e.article_id
                   WHERE a.fetched_at >= ?
                   ORDER BY d""",
                (cutoff,),
            ).fetchall()

        # First pass: daily tier/sentiment aggregates + raw (day, tag) observations.
        daily: dict[str, dict[str, Any]] = {}
        tag_observations: list[tuple[str, str]] = []
        tag_vocab: set[str] = set()

        for r in rows:
            d = r["d"]
            tier = r["tier"]
            score = r["sentiment_score"]
            tags = json.loads(r["tags"] or "[]")

            if d not in daily:
                daily[d] = {
                    "date": d, "T1": 0, "T2": 0, "T3": 0, "NOISE": 0,
                    "_non_noise": 0, "_sent_sum": 0.0,
                }
            daily[d][tier] = daily[d].get(tier, 0) + 1
            if tier != "NOISE" and score is not None:
                daily[d]["_non_noise"] += 1
                daily[d]["_sent_sum"] += score
                for tag in tags:
                    t = tag.strip().lower()
                    if not t:
                        continue
                    tag_observations.append((d, t))
                    tag_vocab.add(t)

        # Canonicalize: case is already folded; merge a plural into its singular
        # only when the singular co-occurs in the data (so 'strikes'->'strike'
        # merges, but 'news' stays 'news' because 'new' isn't a tag).
        def _canon(tag: str) -> str:
            s = _singularize(tag)
            return s if s != tag and s in tag_vocab else tag

        tag_all: Counter[str] = Counter()
        tag_today: Counter[str] = Counter()
        tag_prior: Counter[str] = Counter()
        tag_prior_days: dict[str, set[str]] = {}

        for d, raw in tag_observations:
            tag = _canon(raw)
            tag_all[tag] += 1
            if d == today:
                tag_today[tag] += 1
            elif prior_cutoff <= d < today:
                tag_prior[tag] += 1
                tag_prior_days.setdefault(tag, set()).add(d)

        # Finalize daily — compute avg_sentiment, drop internal accumulators
        daily_list = []
        for day in sorted(daily.values(), key=lambda x: x["date"]):
            nn = day.pop("_non_noise")
            ss = day.pop("_sent_sum")
            day["avg_sentiment"] = round(ss / nn, 3) if nn > 0 else None
            daily_list.append(day)

        top_tags = [
            {"tag": t, "count": c}
            for t, c in tag_all.most_common(20)
            if t not in _GENERIC_TREND_TAGS
        ][:10]

        # Trending: today's count vs the trailing 7 days (excluding today). A tag
        # needs >=2 mentions today; with <2 distinct prior days of history it is
        # surfaced as "new" rather than assigned a meaningless ratio.
        trending = []
        for tag, cnt in tag_today.items():
            if cnt < 2 or tag in _GENERIC_TREND_TAGS:
                continue
            if len(tag_prior_days.get(tag, ())) < 2:
                trending.append({
                    "tag": tag, "today": cnt,
                    "avg7d": None, "ratio": None, "status": "new",
                })
                continue
            avg7 = tag_prior[tag] / 7.0
            ratio = cnt / avg7 if avg7 > 0 else float(cnt)
            if ratio >= 2.0:
                trending.append({
                    "tag": tag, "today": cnt, "avg7d": round(avg7, 1),
                    "ratio": round(ratio, 1), "status": "trending",
                })

        # Genuine ratio-ranked trends first (desc), then brand-new tags by volume.
        trending.sort(key=lambda x: (
            0 if x["status"] == "trending" else 1,
            -(x["ratio"] or 0),
            -x["today"],
        ))

        return {
            "daily": daily_list,
            "top_tags": top_tags,
            "trending": trending[:10],
        }

    def get_runs(self, limit: int = 10) -> list[dict[str, Any]]:
        with self._conn() as con:
            rows = con.execute(
                "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def prune(
        self,
        article_days: int,
        health_days: int,
        *,
        t3_days: int | None = None,
        noise_days: int | None = None,
        dry_run: bool = False,
    ) -> dict[str, int]:
        """Delete articles past their tier's retention window, and feed_health older than health_days.

        Tiered retention: T3 and NOISE use their own (shorter) windows when given;
        T2 and untiered articles fall back to article_days. T1 articles are exempt
        from pruning entirely — they represent the most significant events and
        should be kept indefinitely.

        Deletes child rows first (comments, social_signals, enrichments) so FK
        constraints are satisfied — article_comments and social_signals both
        reference articles(id) and this connection runs with
        `PRAGMA foreign_keys=ON`, so leaving either behind would raise
        `FOREIGN KEY constraint failed` on the articles DELETE. The FTS trigger
        fires on enrichments DELETE so articles_fts is cleaned up automatically.

        Returns counts of rows deleted (or that would be deleted when dry_run=True).
        """
        now = datetime.now(timezone.utc)

        def _cutoff(days: int) -> str | None:
            return (now - timedelta(days=days)).isoformat() if days > 0 else None

        # tier -> cutoff. NULL tier (shouldn't normally happen, but defensive)
        # falls back to the article_days/T2 window via the "else" branch below.
        tier_cutoffs: dict[str, str | None] = {
            "T2": _cutoff(article_days),
            "T3": _cutoff(t3_days if t3_days is not None else article_days),
            "NOISE": _cutoff(noise_days if noise_days is not None else article_days),
        }
        cutoff_health = _cutoff(health_days)

        counts: dict[str, int] = {"articles": 0, "enrichments": 0, "social_signals": 0, "comments": 0, "feed_health": 0}

        with self._conn() as con:
            ids: list[str] = []
            for tier, cutoff in tier_cutoffs.items():
                if not cutoff:
                    continue
                ids.extend(
                    r[0] for r in con.execute(
                        "SELECT a.id FROM articles a JOIN enrichments e ON e.article_id = a.id "
                        "WHERE e.tier = ? AND a.fetched_at < ?",
                        (tier, cutoff),
                    ).fetchall()
                )
            # Untiered articles (enrichment missing/failed) — treated like T2.
            if tier_cutoffs["T2"]:
                ids.extend(
                    r[0] for r in con.execute(
                        "SELECT a.id FROM articles a LEFT JOIN enrichments e ON e.article_id = a.id "
                        "WHERE e.article_id IS NULL AND a.fetched_at < ?",
                        (tier_cutoffs["T2"],),
                    ).fetchall()
                )

            counts["articles"] = len(ids)
            if ids:
                placeholders = ",".join("?" * len(ids))
                if dry_run:
                    counts["enrichments"] = con.execute(
                        f"SELECT COUNT(*) FROM enrichments WHERE article_id IN ({placeholders})", ids
                    ).fetchone()[0]
                    counts["social_signals"] = con.execute(
                        f"SELECT COUNT(*) FROM social_signals WHERE article_id IN ({placeholders})", ids
                    ).fetchone()[0]
                    counts["comments"] = con.execute(
                        f"SELECT COUNT(*) FROM article_comments WHERE article_id IN ({placeholders})", ids
                    ).fetchone()[0]
                else:
                    counts["comments"] = con.execute(
                        f"DELETE FROM article_comments WHERE article_id IN ({placeholders})", ids
                    ).rowcount
                    counts["social_signals"] = con.execute(
                        f"DELETE FROM social_signals WHERE article_id IN ({placeholders})", ids
                    ).rowcount
                    counts["enrichments"] = con.execute(
                        f"DELETE FROM enrichments WHERE article_id IN ({placeholders})", ids
                    ).rowcount
                    con.execute(
                        f"DELETE FROM articles WHERE id IN ({placeholders})", ids
                    )

            if cutoff_health:
                counts["feed_health"] = con.execute(
                    "SELECT COUNT(*) FROM feed_health WHERE checked_at < ?", (cutoff_health,)
                ).fetchone()[0]
                if not dry_run:
                    con.execute("DELETE FROM feed_health WHERE checked_at < ?", (cutoff_health,))

        return counts

    def vacuum(self) -> None:
        """Reclaim disk space freed by prune()/slim_old_enrichments(). Must run
        outside any open transaction, so this uses its own bare connection
        rather than the usual _conn() contextmanager."""
        con = sqlite3.connect(str(self._path), timeout=30)
        try:
            con.execute("VACUUM")
            con.execute("ANALYZE")
        finally:
            con.close()

    def slim_old_enrichments(self, days: int) -> int:
        """NULL out extracted_text/raw_response for articles older than `days`.

        These columns are only needed during enrichment (and for debugging
        shortly after); everything the dashboard displays — summary, tier,
        sentiment, tags — lives in other columns and is untouched. Only
        articles that still have raw data are updated, so re-running this is
        a cheap no-op on already-slimmed rows. Returns the number of articles
        slimmed.
        """
        if days <= 0:
            return 0
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        with self._conn() as con:
            ids = [
                r[0] for r in con.execute(
                    "SELECT id FROM articles WHERE fetched_at < ? AND extracted_text IS NOT NULL",
                    (cutoff,),
                ).fetchall()
            ]
            if not ids:
                return 0
            placeholders = ",".join("?" * len(ids))
            con.execute(f"UPDATE articles SET extracted_text = NULL WHERE id IN ({placeholders})", ids)
            con.execute(f"UPDATE enrichments SET raw_response = NULL WHERE article_id IN ({placeholders})", ids)
        return len(ids)

    def save_feed_health(self, records: list[dict[str, Any]]) -> None:
        """Persist one health record per feed from the current pipeline run."""
        with self._conn() as con:
            con.executemany(
                """INSERT INTO feed_health (feed_name, checked_at, article_count, error)
                   VALUES (:feed_name, :checked_at, :article_count, :error)""",
                records,
            )

    def get_feed_health(self, feed_names: list[str]) -> list[dict[str, Any]]:
        """Return one summary dict per feed name, including feeds never checked."""
        if not feed_names:
            return []

        # Fetch the last 10 records per feed (sufficient for consecutive-error detection
        # and 3-day silence check on a daily pipeline).
        placeholders = ",".join("?" * len(feed_names))
        with self._conn() as con:
            rows = con.execute(
                f"""SELECT feed_name, checked_at, article_count, error
                    FROM feed_health
                    WHERE feed_name IN ({placeholders})
                    ORDER BY feed_name, checked_at DESC""",
                feed_names,
            ).fetchall()

        feed_records: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            name = r["feed_name"]
            if name not in feed_records:
                feed_records[name] = []
            if len(feed_records[name]) < 10:
                feed_records[name].append(dict(r))

        silent_threshold = (
            datetime.now(timezone.utc) - timedelta(days=3)
        ).isoformat()

        results = []
        for name in feed_names:
            records = feed_records.get(name, [])
            if not records:
                results.append({
                    "feed_name": name,
                    "last_checked": None,
                    "last_article_count": None,
                    "last_error": None,
                    "consecutive_errors": 0,
                    "status": "unknown",
                })
                continue

            latest = records[0]
            consecutive_errors = sum(
                1 for _ in (r for r in records if r["error"])
                if True  # count leading errors
            )
            # count only the unbroken leading run of errors
            consecutive_errors = 0
            for r in records:
                if r["error"]:
                    consecutive_errors += 1
                else:
                    break

            if latest["error"]:
                status = "error"
            elif latest["article_count"] == 0:
                last_seen = next(
                    (r["checked_at"] for r in records if r["article_count"] > 0),
                    None,
                )
                status = "silent" if (last_seen is None or last_seen < silent_threshold) else "ok"
            else:
                status = "ok"

            results.append({
                "feed_name": name,
                "last_checked": latest["checked_at"],
                "last_article_count": latest["article_count"],
                "last_error": latest["error"],
                "consecutive_errors": consecutive_errors,
                "status": status,
            })

        return results
