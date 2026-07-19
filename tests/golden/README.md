# Golden Evaluation Set

Each file in this directory is a labeled real article used to catch tier-calibration
regressions between prompt versions.

## File format

```json
{
  "id": "some-slug",
  "title": "Article title exactly as it came from the feed",
  "url": "https://...",
  "feed_name": "BBC World News",
  "extracted_text": "First 1500 tokens of article body...",
  "expected": {
    "tier": "T2",
    "tier_rationale_contains": ["CPI", "confirmed"],
    "sentiment_label": "negative"
  },
  "notes": "Why this is the ground-truth tier — what makes it T2 and not T1 or T3."
}
```

## Running the eval harness

```bash
python -m pytest tests/test_golden.py -v
```

The harness calls `EnrichmentClient.enrich()` on each article and asserts:
1. `tier` matches `expected.tier`
2. `tier_rationale` contains all strings in `expected.tier_rationale_contains`
3. `sentiment.label` matches `expected.sentiment_label` (if specified)

## Adding articles

Label 2-3 articles from each tier (T1, T2, T3, NOISE). Aim for edge cases:
- T2 articles that are tempting T1 (rate holds, close market moves)
- T3 articles that look like T2 (analyst takes, opinion with data)
- NOISE articles that passed through LLM anyway (sports previews, tee times)

Run `python scripts/export_golden.py <article_id>` (to be written) to dump an
article from the DB into the right format.
