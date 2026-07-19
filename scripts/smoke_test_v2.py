"""Quick v2 smoke test: enrich 3 articles and inspect raw output.

Usage:  python scripts/smoke_test_v2.py
Prints tier, repair count, and first 200 chars of raw LLM response so you
can confirm format-constrained decoding produces clean JSON on the first try.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harvester.config import load_profile
from harvester.enrich.client import EnrichmentClient, _parse_and_validate
from harvester.store.db import Database

PROFILE = "configs/profiles/daily-briefing.yaml"
N = 3  # articles to test


def main() -> None:
    cfg = load_profile(PROFILE)
    db = Database.from_config(cfg)

    # Grab N articles that have extracted_text — no LLM output re-used from before
    con = sqlite3.connect(str(db._path), timeout=30)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """SELECT a.*, e.tier AS old_tier, e.prompt_version AS old_v
           FROM articles a
           JOIN enrichments e ON a.id = e.article_id
           WHERE a.extracted_text IS NOT NULL
             AND length(a.extracted_text) > 200
           ORDER BY a.fetched_at DESC
           LIMIT ?""",
        (N,),
    ).fetchall()
    con.close()

    if not rows:
        print("No articles with extracted_text found.")
        return

    client = EnrichmentClient(cfg)
    repair_total = 0

    for row in rows:
        art = dict(row)
        print(f"\n{'-'*70}")
        print(f"id:       {art['id']}")
        print(f"feed:     {art['feed_name']}")
        print(f"title:    {art['title'][:80]}")
        print(f"old tier: {art.get('old_tier')} (v{art.get('old_v')})")

        t0 = time.monotonic()
        try:
            result = client.enrich(art, cfg)
            latency = int((time.monotonic() - t0) * 1000)

            raw = result.get("_raw_response", "")
            # Count whether it needed a repair (raw response should parse cleanly)
            needed_repair = False
            try:
                _parse_and_validate(raw, art)
            except Exception:
                needed_repair = True
            repair_total += int(needed_repair)

            print(f"new tier: {result['tier']}  (repair={'YES' if needed_repair else 'no'})")
            print(f"latency:  {latency}ms")
            print(f"summary:  {result['summary'][:100]}…")
            print(f"raw[0:200]: {raw[:200]!r}")
        except Exception as exc:
            print(f"FAILED: {exc}")
        time.sleep(2)  # llama-server respawn window

    print(f"\n{'='*70}")
    print(f"Repairs needed: {repair_total}/{N}")
    print("FORMAT OK: clean JSON on first try" if repair_total == 0 else "REPAIRS NEEDED: check Ollama format support")


if __name__ == "__main__":
    main()
