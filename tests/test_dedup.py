import pytest

from harvester.store.db import Database, _article_id

_ART1 = {
    "feed_name": "Test Feed",
    "url": "https://example.com/article-1",
    "guid": "guid-1",
    "title": "Article One",
    "published_at": "2026-07-13T10:00:00+00:00",
    "fetched_at": "2026-07-13T10:05:00+00:00",
    "summary": "Summary of article one.",
}
_ART2 = {
    "feed_name": "Test Feed",
    "url": "https://example.com/article-2",
    "guid": "guid-2",
    "title": "Article Two",
    "published_at": "2026-07-13T11:00:00+00:00",
    "fetched_at": "2026-07-13T11:05:00+00:00",
    "summary": "Summary of article two.",
}


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "test.db")
    d.init_schema()
    return d


def test_insert_new_articles(db):
    new = db.insert_new_articles([_ART1, _ART2])
    assert len(new) == 2


def test_dedup_same_url(db):
    db.insert_new_articles([_ART1])
    second = db.insert_new_articles([_ART1])
    assert len(second) == 0


def test_dedup_partial_overlap(db):
    db.insert_new_articles([_ART1])
    new = db.insert_new_articles([_ART1, _ART2])
    assert len(new) == 1
    assert new[0]["url"] == _ART2["url"]


def test_article_id_deterministic():
    assert _article_id("https://example.com/x") == _article_id("https://example.com/x")


def test_article_id_unique_per_url():
    assert _article_id("https://example.com/a") != _article_id("https://example.com/b")


def test_article_id_is_32_chars():
    assert len(_article_id("https://example.com/x")) == 32


def test_status_progression(db):
    new = db.insert_new_articles([_ART1])
    art_id = new[0]["id"]

    # After insert: status = fetched, not yet available for enrichment
    assert db.get_articles_for_enrichment() == []

    db.update_extracted(art_id, "Full article text here.")
    to_enrich = db.get_articles_for_enrichment()
    assert len(to_enrich) == 1
    assert to_enrich[0]["status"] == "extracted"
    assert to_enrich[0]["extracted_text"] == "Full article text here."


def test_mark_failed(db):
    new = db.insert_new_articles([_ART1])
    art_id = new[0]["id"]
    db.update_extracted(art_id, "some text")
    # failed_llm articles re-enter the queue (up to 3 retries) — mark 3 times
    for _ in range(3):
        db.mark_failed(art_id, "failed_llm")
    # After hitting the retry cap the article must be absent from the queue
    assert db.get_articles_for_enrichment() == []


def test_mark_failed_retries_below_cap(db):
    new = db.insert_new_articles([_ART1])
    art_id = new[0]["id"]
    db.update_extracted(art_id, "some text")
    db.mark_failed(art_id, "failed_llm")
    # One failure is below the cap — article should still be queued for retry
    queue = db.get_articles_for_enrichment()
    assert len(queue) == 1
    assert queue[0]["status"] == "failed_llm"


def test_run_recording(db):
    db.record_run("abc123", "test", "2026-07-13T00:00:00", "2026-07-13T00:01:00",
                  {"fetched": 10, "new": 5, "enriched": 4, "failed": 1})
    runs = db.get_runs()
    assert len(runs) == 1
    assert runs[0]["id"] == "abc123"
    assert runs[0]["enriched"] == 4
