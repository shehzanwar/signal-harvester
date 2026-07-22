"""Validate golden-set JSON files for schema correctness.

Checks:
- Valid UTF-8 JSON (no BOM issues)
- Required fields present: id, title, expected.tier
- expected.tier is one of T1, T2, T3, NOISE (not TODO)
- extracted_text is present and non-empty (needed for enrichment)
- tier_rationale_contains is a list of strings

Exit 0 if all pass, exit 1 with error messages if any fail.

Usage:
    python scripts/validate_golden.py tests/golden/
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

VALID_TIERS = {"T1", "T2", "T3", "NOISE"}


def validate_file(path: Path) -> list[str]:
    errors = []

    try:
        text = path.read_text(encoding="utf-8-sig")
    except Exception as e:
        return [f"Cannot read file: {e}"]

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        return [f"Invalid JSON: {e}"]

    if not data.get("id"):
        errors.append("Missing 'id'")
    if not data.get("title"):
        errors.append("Missing 'title'")

    if not data.get("extracted_text", "").strip():
        errors.append(
            "extracted_text is empty — golden file cannot be used for enrichment eval. "
            "Re-export with: py -3.12 scripts/export_golden.py <article_id>"
        )

    expected = data.get("expected", {})
    if not expected:
        errors.append("Missing 'expected' block")
    else:
        tier = expected.get("tier", "")
        if not tier:
            errors.append("expected.tier is missing")
        elif tier.upper() == "TODO":
            errors.append("expected.tier is still TODO — label before committing")
        elif tier not in VALID_TIERS:
            errors.append(f"expected.tier={tier!r} is not one of {VALID_TIERS}")

        phrases = expected.get("tier_rationale_contains", [])
        if not isinstance(phrases, list):
            errors.append("expected.tier_rationale_contains must be a list")
        else:
            for p in phrases:
                if not isinstance(p, str):
                    errors.append(f"tier_rationale_contains element {p!r} is not a string")

        sentiment = expected.get("sentiment_label", "")
        if sentiment and sentiment not in {"positive", "negative", "neutral", "mixed"}:
            errors.append(f"expected.sentiment_label={sentiment!r} is invalid")

    return errors


def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <golden_dir>", file=sys.stderr)
        sys.exit(1)

    golden_dir = Path(sys.argv[1])
    files = sorted(golden_dir.glob("*.json"))
    if not files:
        print(f"No JSON files found in {golden_dir}", file=sys.stderr)
        sys.exit(1)

    total = 0
    failed = 0
    for path in files:
        total += 1
        errors = validate_file(path)
        if errors:
            failed += 1
            print(f"FAIL {path.name}:")
            for e in errors:
                print(f"  - {e}")

    if failed:
        print(f"\n{failed}/{total} golden files failed validation.")
        sys.exit(1)
    else:
        print(f"OK: {total} golden files validated.")


if __name__ == "__main__":
    main()
