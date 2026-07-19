"""
Golden-set evaluation: python -m harvester eval --golden-set tests/golden

Golden set format: each .json file in the directory is an article dict with an
additional "expected" key:
  {
    "id": "...", "url": "...", "title": "...", "extracted_text": "...",
    "expected": { "tier": "T2", "tier_rationale_contains": ["CPI"], "sentiment_label": "negative" },
    "notes": "Why this is the ground-truth label."
  }
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from harvester.config import ProfileConfig
from harvester.enrich.client import EnrichmentClient

log = logging.getLogger(__name__)

_TIER_ORDER = {"T1": 0, "T2": 1, "T3": 2, "NOISE": 3}


def run_eval(cfg: ProfileConfig, golden_set_dir: str = "tests/golden") -> None:
    golden_path = Path(golden_set_dir)
    if not golden_path.exists():
        print(f"Golden set directory not found: {golden_path.absolute()}")
        print("Create JSON files in that directory with an 'expected' key to run eval.")
        return

    files = [f for f in sorted(golden_path.glob("*.json")) if f.name != "README.md"]
    if not files:
        print(f"No .json files found in {golden_path}")
        print("Run: python scripts/export_golden.py <article_id>")
        return

    print(f"Evaluating {len(files)} golden-set articles with model={cfg.llm.model}\n")
    client = EnrichmentClient(cfg)

    results: list[dict[str, Any]] = []
    for fp in files:
        article = json.loads(fp.read_text(encoding="utf-8"))
        expected = article.pop("expected", {})
        article.pop("notes", None)

        exp_tier = expected.get("tier", "")
        if not exp_tier or exp_tier.upper() == "TODO":
            print(f"[skip] {fp.name}: not yet labeled")
            continue

        try:
            enrichment = client.enrich(article, cfg)
        except Exception as exc:
            log.warning("eval_failed file=%s error=%s", fp.name, exc)
            results.append({"file": fp.name, "error": str(exc)})
            time.sleep(2)
            continue

        rationale_issues = [
            phrase for phrase in expected.get("tier_rationale_contains", [])
            if phrase.lower() not in enrichment.get("tier_rationale", "").lower()
        ]

        results.append({
            "file": fp.name,
            "title": article.get("title", "?")[:60],
            "predicted_tier": enrichment["tier"],
            "expected_tier": exp_tier,
            "predicted_sentiment": enrichment["sentiment"]["label"],
            "expected_sentiment": expected.get("sentiment_label", "?"),
            "tier_exact": enrichment["tier"] == exp_tier,
            "tier_adjacent": _adjacent(enrichment["tier"], exp_tier),
            "sentiment_exact": enrichment["sentiment"]["label"] == expected.get("sentiment_label"),
            "rationale_issues": rationale_issues,
        })

        time.sleep(2)  # llama-server respawn window

    _print_report(results, cfg.llm.model)


def _adjacent(predicted: str, expected: str) -> bool:
    if not expected or expected not in _TIER_ORDER:
        return False
    return abs(_TIER_ORDER.get(predicted, 99) - _TIER_ORDER[expected]) <= 1


def _print_report(results: list[dict[str, Any]], model: str) -> None:
    ok = [r for r in results if "error" not in r]
    errors = [r for r in results if "error" in r]

    if not ok:
        print("No evaluable results.")
        return

    tier_exact = sum(r["tier_exact"] for r in ok)
    tier_adj = sum(r["tier_adjacent"] for r in ok)
    sent_exact = sum(r["sentiment_exact"] for r in ok)
    n = len(ok)

    sep = "-" * 70
    print(sep)
    print(f"Model: {model}  |  Articles: {n}  |  Errors: {len(errors)}")
    print(sep)
    print(f"Tier accuracy    (exact)   : {tier_exact}/{n} = {tier_exact/n*100:.1f}%")
    print(f"Tier accuracy    (adjacent): {tier_adj}/{n} = {tier_adj/n*100:.1f}%")
    print(f"Sentiment accuracy (exact) : {sent_exact}/{n} = {sent_exact/n*100:.1f}%")
    print(sep)

    print("\nPer-article results:")
    for r in ok:
        tier_mark = "OK" if r["tier_exact"] else ("~" if r["tier_adjacent"] else "XX")
        sent_mark = "OK" if r["sentiment_exact"] else "XX"
        print(
            f"  [{tier_mark}] tier={r['predicted_tier']:<5} exp={r['expected_tier']:<5}"
            f" sent={r['predicted_sentiment']:<8} [{sent_mark}]  {r.get('title','')[:50]}"
        )
        for issue in r.get("rationale_issues", []):
            print(f"      rationale missing: {issue!r}")

    if errors:
        print("\nErrors:")
        for r in errors:
            print(f"  {r['file']}: {r['error']}")
    print()
