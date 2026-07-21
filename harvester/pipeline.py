from __future__ import annotations

import logging
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any

from harvester.cluster import attach_cluster_metadata, cluster_articles
from harvester.config import ProfileConfig
from harvester.enrich.client import EnrichmentClient
from harvester.enrich.prompts import PROMPT_VERSION
from harvester.extract import extract_text
from harvester.social import SocialFetcher
from harvester.sources.rss import RSSSource
from harvester.store.db import Database
from harvester.store.writers import write_json_article, write_markdown_digest

log = logging.getLogger(__name__)

# llama-server on Ollama 0.32.0/Windows crashes ~2s after generating a response.
# It respawns in ~1.77s. 5s gives a comfortable margin; the retry loop in
# client.py (35s wait x 2 = 70s total) backstops any remaining mid-respawn hits.
_INTER_ARTICLE_SLEEP = 5

# Title patterns that reliably identify schedule/preview/live-update noise without
# needing an LLM call. Keep this list conservative — false positives kill useful
# articles; false negatives just burn a little LLM time.
_NOISE_TITLE_RE = re.compile(
    r"\b("
    r"predicted?\s+lineup"
    r"|starting\s+lineup"
    r"|tee[\s\-]?time"
    r"|live\s+update"
    r"|live\s+blog"
    r"|live\s+score"
    r"|how\s+to\s+watch"
    r"|watch\s+live"
    r"|kick[\-\s]?off\s+time"
    r"|fantasy\s+(picks?|lineup)"
    r")\b",
    re.IGNORECASE,
)


def _is_title_noise(title: str) -> bool:
    return bool(_NOISE_TITLE_RE.search(title))


def _noise_enrichment_dict(model: str) -> dict[str, Any]:
    return {
        "summary": "Pre-filtered as routine noise by title pattern.",
        "tier": "NOISE",
        "tier_rationale": "Title matched a noise pattern (lineup, tee-time, live-updates, or watch guide).",
        "sentiment": {"label": "neutral", "score": 0.0, "rationale": "N/A — noise article."},
        "tags": ["noise"],
        "_model": f"{model}:pre-filter",
        "_prompt_version": "pre-filter",
        "_raw_response": "",
    }


def run_pipeline(cfg: ProfileConfig) -> dict[str, int]:
    """
    Execute a full pipeline run: fetch -> extract -> enrich -> cluster -> social -> write.
    Returns counts dict. Individual article failures are isolated.
    """
    run_id = uuid.uuid4().hex[:8]
    started_at = datetime.now(timezone.utc).isoformat()
    log.info("run_start run_id=%s profile=%s", run_id, cfg.profile)

    db = Database.from_config(cfg)
    db.init_schema()

    counts: dict[str, int] = {
        "fetched": 0, "new": 0, "enriched": 0, "failed": 0,
        "failed_extract": 0, "failed_llm": 0, "noise_prefiltered": 0,
    }

    # -- Stage 1: Fetch -------------------------------------------------------
    source = RSSSource(cfg)
    raw_articles = source.fetch()
    counts["fetched"] = len(raw_articles)
    new_articles = db.insert_new_articles(raw_articles)
    counts["new"] = len(new_articles)
    log.info("fetch_done fetched=%d new=%d", counts["fetched"], counts["new"])

    if not new_articles:
        log.info("no_new_articles -- skipping extraction and enrichment")
        _finalize(db, run_id, cfg, started_at, counts)
        return counts

    # -- Stage 2: Extract (parallel I/O) -------------------------------------
    def _do_extract(art: dict[str, Any]) -> tuple[str, Exception | None]:
        try:
            text = extract_text(art["url"], art.get("summary", ""))
            db.update_extracted(art["id"], text)
            return art["id"], None
        except Exception as exc:
            db.mark_failed(art["id"], "failed_extract")
            return art["id"], exc

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_do_extract, art): art for art in new_articles}
        for future in as_completed(futures):
            art_id, exc = future.result()
            if exc is not None:
                log.warning("extract_failed id=%s error=%s", art_id, exc)
                counts["failed_extract"] += 1

    # -- Stage 3: Enrich -----------------------------------------------------
    # Includes newly extracted articles AND previously failed ones below the retry cap.
    client = EnrichmentClient(cfg)
    to_enrich = db.get_articles_for_enrichment()
    log.info("enrich_start count=%d", len(to_enrich))

    for art in to_enrich:
        # Fast-path: obvious noise by title -- skip LLM entirely
        title = art.get("title", "")
        if _is_title_noise(title):
            log.debug("noise_prefiltered id=%s title=%r", art["id"], title[:60])
            db.save_enrichment(art["id"], _noise_enrichment_dict(cfg.llm.model))
            counts["enriched"] += 1
            counts["noise_prefiltered"] += 1
            continue

        try:
            t0 = time.monotonic()
            enrichment = client.enrich(art, cfg)
            latency_ms = int((time.monotonic() - t0) * 1000)
            db.save_enrichment(art["id"], enrichment, latency_ms=latency_ms)
            counts["enriched"] += 1
            log.debug(
                "enriched id=%s tier=%s latency_ms=%d",
                art["id"], enrichment["tier"], latency_ms,
            )
        except Exception as exc:
            log.warning("enrich_failed id=%s error=%s", art["id"], exc)
            db.mark_failed(art["id"], "failed_llm")
            counts["failed"] += 1
            counts["failed_llm"] += 1
        # The inter-article pause exists only to let Ollama's llama-server crash and
        # respawn between requests. A standalone llama-server doesn't crash, so the
        # llamacpp backend skips the wait entirely (this is most of a run's wall time).
        if cfg.llm.backend == "ollama":
            time.sleep(_INTER_ARTICLE_SLEEP)

    # -- Stage 4: Cluster ----------------------------------------------------
    # Cluster over a rolling 48h window of ALL enriched articles (not just this
    # run's batch) so a story breaking yesterday and corroborated today still
    # merges. Sort representative-preferred — highest-trust feed first, then most
    # recent — so the cluster's founding member is the card we surface.
    window_start = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
    window_articles = db.get_enriched_articles(since=window_start)
    if window_articles:
        trust_rank = {"high": 0, "medium": 1, "low": 2}
        feed_trust = {f.name: trust_rank.get(f.trust, 1) for f in cfg.feeds}
        # Stable two-key sort: recency DESC first, then trust ASC (primary).
        window_articles.sort(key=lambda a: a.get("published_at") or "", reverse=True)
        window_articles.sort(key=lambda a: feed_trust.get(a.get("feed_name", ""), 1))

        cluster_articles(window_articles)
        cluster_map = {a["id"]: a["cluster_id"] for a in window_articles if "cluster_id" in a}
        db.update_cluster_ids(cluster_map)
        cluster_count = len(set(cluster_map.values()))
        log.info(
            "cluster_done window=48h articles=%d clusters=%d",
            len(window_articles), cluster_count,
        )

    # -- Stage 5: Social signals (best-effort, parallel) ---------------------
    today_articles = db.get_enriched_articles(today_only=True)
    enriched_today = [a for a in today_articles if a.get("tier") not in ("NOISE",)]
    if enriched_today:
        # One fetcher per run: it does the Mastodon batch prefetch + any gated
        # auth (Bluesky/Reddit) once, then reuses them across articles.
        fetcher = SocialFetcher()

        def _fetch_social(art: dict[str, Any]) -> list[dict[str, Any]]:
            signals = fetcher.fetch(art["url"])
            return [{"article_id": art["id"], **s} for s in signals]

        all_signals: list[dict[str, Any]] = []
        # Reddit throttle (1 req/s) means we can't use too many workers for social
        with ThreadPoolExecutor(max_workers=3) as pool:
            for signals in pool.map(_fetch_social, enriched_today[:50]):  # cap to avoid overload
                all_signals.extend(signals)
        if all_signals:
            db.save_social_signals(all_signals)
            log.info("social_done signals=%d", len(all_signals))

    # -- Stage 6: Write ------------------------------------------------------
    enriched_all = db.get_enriched_articles(today_only=True)
    attach_cluster_metadata(enriched_all)
    for art in enriched_all:
        try:
            write_json_article(art, cfg)
        except Exception as exc:
            log.warning("write_json_failed id=%s error=%s", art["id"], exc)

    write_markdown_digest(enriched_all, cfg, run_id=run_id)

    _finalize(db, run_id, cfg, started_at, counts)
    return counts


def _finalize(
    db: Database,
    run_id: str,
    cfg: ProfileConfig,
    started_at: str,
    counts: dict[str, int],
) -> None:
    finished_at = datetime.now(timezone.utc).isoformat()
    db.record_run(run_id, cfg.profile, started_at, finished_at, counts)
    failure_rate = counts["failed"] / max(counts["new"], 1) * 100
    log.info(
        "run_complete run_id=%s fetched=%d new=%d enriched=%d failed=%d (%.0f%%)",
        run_id, counts["fetched"], counts["new"],
        counts["enriched"], counts["failed"], failure_rate,
    )
    print(
        f"\n[{cfg.profile}] Run {run_id} -- "
        f"fetched={counts['fetched']} new={counts['new']} "
        f"enriched={counts['enriched']} failed={counts['failed']} "
        f"(extract={counts['failed_extract']} llm={counts['failed_llm']} "
        f"prefiltered={counts['noise_prefiltered']})"
    )


def backfill(
    cfg: ProfileConfig,
    from_date: str | None = None,
    to_date: str | None = None,
    status: str | None = None,
    stale: bool = False,
    prompt_version: str | None = None,
) -> None:
    """Re-enrich existing articles filtered by date range, status, or prompt
    version. `stale=True` targets everything not on the current PROMPT_VERSION."""
    db = Database.from_config(cfg)
    db.init_schema()
    exclude = PROMPT_VERSION if stale else None
    articles = db.get_articles_for_backfill(
        from_date=from_date,
        to_date=to_date,
        status=status,
        prompt_version=prompt_version,
        exclude_prompt_version=exclude,
    )
    log.info("backfill_start count=%d", len(articles))
    if not articles:
        print("No articles match the backfill criteria.")
        return

    client = EnrichmentClient(cfg)
    success = fail = 0
    for art in articles:
        db.reset_enrichment(art["id"])
        try:
            t0 = time.monotonic()
            enrichment = client.enrich(art, cfg)
            latency_ms = int((time.monotonic() - t0) * 1000)
            db.save_enrichment(art["id"], enrichment, latency_ms=latency_ms)
            success += 1
        except Exception as exc:
            log.warning("backfill_failed id=%s error=%s", art["id"], exc)
            db.mark_failed(art["id"], "failed_llm")
            fail += 1
        time.sleep(_INTER_ARTICLE_SLEEP)

    print(f"Backfill complete: {success} enriched, {fail} failed (of {len(articles)} total)")
