from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harvester.config import ProfileConfig

log = logging.getLogger(__name__)

_TIER_EMOJI = {"T1": "🔴", "T2": "🟡", "T3": "🔵", "NOISE": "⚫"}
_SENTIMENT_EMOJI = {"positive": "📈", "negative": "📉", "neutral": "➡️", "mixed": "↕️"}


def write_json_article(article: dict[str, Any], cfg: ProfileConfig) -> None:
    if "json" not in cfg.output.formats:
        return
    root = Path(cfg.output.root)
    fetched = article.get("fetched_at", "")
    year = fetched[:4] if fetched else "0000"
    month = fetched[5:7] if len(fetched) > 6 else "00"
    out_dir = root / "articles" / year / month
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{article['id']}.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(article, f, ensure_ascii=False, indent=2)


def write_markdown_digest(
    articles: list[dict[str, Any]],
    cfg: ProfileConfig,
    *,
    run_id: str = "",
) -> Path | None:
    if "markdown" not in cfg.output.formats:
        return None
    root = Path(cfg.output.root)
    digests_dir = root / "digests"
    digests_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_path = digests_dir / f"{today}.md"

    by_tier: dict[str, list[dict[str, Any]]] = {"T1": [], "T2": [], "T3": [], "NOISE": []}
    for art in articles:
        by_tier.setdefault(art.get("tier", "NOISE"), []).append(art)

    t1, t2, t3, noise = (
        len(by_tier["T1"]),
        len(by_tier["T2"]),
        len(by_tier["T3"]),
        len(by_tier["NOISE"]),
    )

    lines = [
        f"# {cfg.dashboard_title} — {today}",
        "",
        f"**Profile:** `{cfg.profile}` | **Model:** `{cfg.llm.model}` | **Run:** `{run_id}`  ",
        f"**Articles enriched:** {len(articles)} | T1: {t1} · T2: {t2} · T3: {t3} · Noise: {noise}",
        "",
    ]

    for tier_key, label in [("T1", "Critical"), ("T2", "Notable"), ("T3", "Background")]:
        emoji = _TIER_EMOJI[tier_key]
        tier_arts = by_tier[tier_key]
        lines.append(f"## {emoji} Tier {tier_key} — {label} ({len(tier_arts)})\n")
        if not tier_arts:
            lines.append("_No items this run._\n")
            continue
        for art in tier_arts:
            s_label = art.get("sentiment_label", "neutral")
            s_score = art.get("sentiment_score", 0.0)
            s_emoji = _SENTIMENT_EMOJI.get(s_label, "➡️")
            pub = (art.get("published_at") or "")[:10] or "unknown"
            lines += [
                f"### [{art.get('title', '(no title)')}]({art.get('url', '')})",
                f"**Source:** {art.get('feed_name', '')} · **Published:** {pub}  ",
                f"**Sentiment:** {s_emoji} {s_label} ({s_score:+.2f}) — {art.get('sentiment_rationale', '')}  ",
                f"**Tags:** {', '.join(f'`{t}`' for t in (art.get('tags') or []))}",
                "",
                f"> {art.get('enrich_summary') or art.get('summary', '')}",
                "",
                f"_{art.get('tier_rationale', '')}_",
                "",
            ]

    lines.append(f"---\n_{noise} item(s) filtered as noise._\n")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    log.info("digest_written path=%s", out_path)
    return out_path
