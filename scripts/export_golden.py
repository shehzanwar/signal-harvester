"""Dump an article from the DB into tests/golden/ for golden-set labeling.

Usage:
    python scripts/export_golden.py <article_id_prefix>
    python scripts/export_golden.py <article_id_prefix> --out tests/golden/my-label.json

The output file is pre-filled with the current enrichment's tier and sentiment.
Edit the 'expected' fields to confirm or correct the ground-truth label, then
fill in 'tier_rationale_contains' with 1-3 key phrases that should appear in
the rationale.  Update 'notes' with why this is the right classification.

Run eval against the golden set with:
    python -m harvester --profile configs/profiles/daily-briefing.yaml eval
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from harvester.config import load_profile
from harvester.store.db import Database

PROFILE = "configs/profiles/daily-briefing.yaml"
DEFAULT_OUT = Path("tests/golden")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export article to golden-set format for eval labeling"
    )
    parser.add_argument("article_id", help="Full or prefix of article ID (SHA-256 hex)")
    parser.add_argument(
        "--out",
        default=None,
        metavar="PATH",
        help="Output JSON path (default: tests/golden/<id[:16]>.json)",
    )
    parser.add_argument("--profile", default=PROFILE)
    args = parser.parse_args()

    cfg = load_profile(args.profile)
    db = Database.from_config(cfg)

    con = sqlite3.connect(str(db._path), timeout=30)
    con.row_factory = sqlite3.Row

    row = con.execute(
        "SELECT * FROM articles WHERE id = ? OR id LIKE ?",
        (args.article_id, args.article_id + "%"),
    ).fetchone()
    if not row:
        print(f"No article found matching: {args.article_id!r}", file=sys.stderr)
        sys.exit(1)

    art = dict(row)

    enrich = con.execute(
        "SELECT tier, tier_rationale, sentiment_label, sentiment_rationale "
        "FROM enrichments WHERE article_id = ?",
        (art["id"],),
    ).fetchone()
    con.close()

    current_tier = enrich["tier"] if enrich else "T3"
    current_label = enrich["sentiment_label"] if enrich else "neutral"
    current_rationale = enrich["tier_rationale"] if enrich else ""

    out = {
        "id": art["id"],
        "title": art.get("title", ""),
        "url": art.get("url", ""),
        "feed_name": art.get("feed_name", ""),
        "extracted_text": (art.get("extracted_text") or "")[:2000],
        "expected": {
            "tier": current_tier,
            "tier_rationale_contains": [],
            "sentiment_label": current_label,
        },
        "notes": "TODO: verify tier, fill in tier_rationale_contains, update notes.",
    }

    out_path = (
        Path(args.out) if args.out
        else DEFAULT_OUT / f"{art['id'][:16]}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"Written: {out_path}")
    print(f"Current enrichment: tier={current_tier}  sentiment={current_label}")
    if current_rationale:
        print(f"Current rationale:  {current_rationale[:100]}")
    print("Edit 'expected' and 'notes' to confirm or correct the ground-truth label.")


if __name__ == "__main__":
    main()
