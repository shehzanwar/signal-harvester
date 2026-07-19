"""Clustering tests using real headline sets pulled from the corpus.

The positive set is the genuine "US retaliatory strikes on Iran after the Jordan
attack" storyline as it actually appeared across BBC / The Hill / NPR / PBS /
Axios — note the tags disagree on surface form (us-iran-conflict vs us-iran
conflict vs iran conflict), which is exactly why we cluster on word-split tag
tokens, not whole tags. The negatives are distinct same-day stories, including a
topic-adjacent Gaza conflict piece that must NOT be swept into the Iran cluster.
"""
from __future__ import annotations

from harvester.cluster import attach_cluster_metadata, cluster_articles

# Same event — different outlets, different wording, inconsistent tag forms.
IRAN_STRIKES = [
    {"id": "bbc", "feed_name": "BBC World News",
     "title": "US and Iran exchange strikes after two US deaths in Jordan attack",
     "tags": ["us-iran-conflict", "military-strikes", "geopolitical-tension"]},
    {"id": "hill", "feed_name": "The Hill",
     "title": "US military unleashes retaliatory strikes against Iran after soldiers killed in Jordan",
     "tags": ["us military", "iran conflict", "retaliatory strikes"]},
    {"id": "npr", "feed_name": "NPR World",
     "title": "U.S. launches new airstrikes to 'punish' Iran for troop deaths",
     "tags": ["us-iran-conflict", "military-strikes", "geopolitical-tension"]},
    {"id": "pbs", "feed_name": "PBS NewsHour",
     "title": "U.S. military launches new airstrikes to punish Iran for deaths of US troops",
     "tags": ["us-iran conflict", "strait of hormuz", "military strikes"]},
    {"id": "axios", "feed_name": "Axios",
     "title": "Two U.S. troops killed in Iranian missile attack on Jordan",
     "tags": ["iran", "jordan", "military conflict", "us casualties", "missile attack"]},
]

# Distinct stories that must each stay on their own.
DISTINCT = [
    {"id": "wc", "feed_name": "BBC Sport",
     "title": "England beat Spain to reach the World Cup final",
     "tags": ["world cup", "football", "england"]},
    {"id": "fed", "feed_name": "Reuters",
     "title": "Federal Reserve holds interest rates steady at 5.25%",
     "tags": ["federal reserve", "interest rates", "monetary policy"]},
    {"id": "jobs", "feed_name": "CNBC",
     "title": "US economy adds 250,000 jobs in a strong November report",
     "tags": ["us economy", "jobs", "labor market"]},
    # Topic-adjacent trap: shares "military"/"conflict" with the Iran story.
    {"id": "gaza", "feed_name": "Al Jazeera",
     "title": "Israeli forces advance into northern Gaza as ceasefire talks stall",
     "tags": ["israel", "gaza", "military conflict", "ceasefire"]},
]


def test_same_storyline_articles_merge():
    arts = [dict(a) for a in IRAN_STRIKES]
    cluster_articles(arts)
    cluster_ids = {a["id"]: a["cluster_id"] for a in arts}
    # All five collapse into a single cluster founded by the first (bbc).
    assert len(set(cluster_ids.values())) == 1
    assert set(cluster_ids.values()) == {"bbc"}


def test_distinct_stories_do_not_merge():
    arts = [dict(a) for a in (IRAN_STRIKES + DISTINCT)]
    cluster_articles(arts)
    by_id = {a["id"]: a["cluster_id"] for a in arts}

    # Iran set still one cluster.
    assert len({by_id[a["id"]] for a in IRAN_STRIKES}) == 1
    iran_cluster = by_id["bbc"]

    # Each distinct story is its own singleton, none joined to Iran.
    for d in DISTINCT:
        assert by_id[d["id"]] == d["id"], f"{d['id']} wrongly clustered"
        assert by_id[d["id"]] != iran_cluster


def test_single_shared_token_does_not_merge():
    """Two stories sharing only one content token must not cluster (min_shared)."""
    arts = [
        {"id": "a", "feed_name": "X", "title": "Apple unveils new iPhone chip",
         "tags": ["apple", "hardware"]},
        {"id": "b", "feed_name": "Y", "title": "Apple Records reissues Beatles catalogue",
         "tags": ["music", "beatles"]},
    ]
    cluster_articles(arts)
    assert arts[0]["cluster_id"] != arts[1]["cluster_id"]


def test_cluster_metadata_counts_sources():
    arts = [dict(a) for a in IRAN_STRIKES]
    cluster_articles(arts)
    attach_cluster_metadata(arts)
    rep = next(a for a in arts if a["id"] == "bbc")
    assert rep["cluster_size"] == 5
    # 5 distinct feeds in the storyline.
    assert len(rep["cluster_sources"]) == 5
    assert "BBC World News" in rep["cluster_sources"]
