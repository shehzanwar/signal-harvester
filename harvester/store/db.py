from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Generator

from harvester.config import ProfileConfig
from harvester.enrich.prompts import PROMPT_VERSION

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
    article_id          TEXT PRIMARY KEY REFERENCES articles(id),
    summary             TEXT NOT NULL,
    tier                TEXT NOT NULL CHECK (tier IN ('T1','T2','T3','NOISE')),
    tier_rationale      TEXT,
    sentiment_label     TEXT NOT NULL CHECK (sentiment_label IN ('positive','negative','neutral','mixed')),
    sentiment_score     REAL NOT NULL CHECK (sentiment_score BETWEEN -1.0 AND 1.0),
    sentiment_rationale TEXT,
    tags                TEXT NOT NULL,
    model               TEXT NOT NULL,
    prompt_version      TEXT NOT NULL,
    raw_response        TEXT,
    enriched_at         TEXT NOT NULL,
    latency_ms          INTEGER
);

CREATE TABLE IF NOT EXISTS social_signals (
    article_id  TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('hn', 'reddit')),
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

CREATE INDEX IF NOT EXISTS idx_articles_status     ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_fetched_at ON articles(fetched_at);
CREATE INDEX IF NOT EXISTS idx_enrichments_tier    ON enrichments(tier);
CREATE INDEX IF NOT EXISTS idx_enrichments_at      ON enrichments(enriched_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_feed_guid ON articles(feed_name, guid)
    WHERE guid IS NOT NULL;
"""

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
        ]:
            try:
                with self._conn() as con:
                    con.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already exists

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
        with self._conn() as con:
            con.execute(
                """INSERT OR REPLACE INTO enrichments
                   (article_id, summary, tier, tier_rationale, sentiment_label, sentiment_score,
                    sentiment_rationale, tags, model, prompt_version, raw_response,
                    enriched_at, latency_ms)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    article_id,
                    enrichment["summary"],
                    enrichment["tier"],
                    enrichment.get("tier_rationale", ""),
                    enrichment["sentiment"]["label"],
                    enrichment["sentiment"]["score"],
                    enrichment["sentiment"].get("rationale", ""),
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
                           e.tags, e.model, e.enriched_at, e.latency_ms, e.prompt_version,
                           ss_hn.score AS hn_score, ss_hn.comments AS hn_comments,
                           ss_hn.permalink AS hn_url,
                           ss_r.score AS reddit_score, ss_r.comments AS reddit_comments,
                           ss_r.permalink AS reddit_url
                    FROM articles a
                    JOIN enrichments e ON a.id = e.article_id
                    LEFT JOIN social_signals ss_hn
                        ON a.id = ss_hn.article_id AND ss_hn.source = 'hn'
                    LEFT JOIN social_signals ss_r
                        ON a.id = ss_r.article_id AND ss_r.source = 'reddit'
                    WHERE {where}
                    ORDER BY
                        CASE e.tier WHEN 'T1' THEN 1 WHEN 'T2' THEN 2
                                    WHEN 'T3' THEN 3 ELSE 4 END,
                        a.published_at DESC""",
                params,
            ).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["tags"] = json.loads(d["tags"]) if d.get("tags") else []
            results.append(d)
        return results

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
                """SELECT AVG(e.sentiment_score) FROM enrichments e
                   JOIN articles a ON e.article_id=a.id
                   WHERE e.tier != 'NOISE' AND a.fetched_at >= ?
                     AND e.prompt_version = ?""",
                (seven_days_ago, PROMPT_VERSION),
            ).fetchone()[0]
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
        }

    def get_trends(self, days: int = 30) -> dict[str, Any]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        # Trailing comparison window: the 7 calendar days BEFORE today. Including
        # today (the old bug) made every no-history tag ratio out to exactly 7.0.
        prior_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

        with self._conn() as con:
            rows = con.execute(
                """SELECT date(a.fetched_at) AS d, e.tier, e.sentiment_score, e.tags
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
