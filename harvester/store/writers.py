from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
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


def write_weekly_digest(
    articles: list[dict[str, Any]],
    cfg: ProfileConfig,
    *,
    week_start: datetime,
) -> Path | None:
    """Write a week-in-review Markdown digest for the 7-day window ending today.

    articles: all enriched articles in the window (pre-filtered by caller).
    week_start: the Monday that opens the window (used for the filename/header).
    """
    if "markdown" not in cfg.output.formats:
        return None

    root = Path(cfg.output.root)
    weekly_dir = root / "digests" / "weekly"
    weekly_dir.mkdir(parents=True, exist_ok=True)

    iso_year, iso_week, _ = week_start.isocalendar()
    week_label = f"{iso_year}-W{iso_week:02d}"
    week_end = week_start + timedelta(days=6)
    out_path = weekly_dir / f"{week_label}.md"

    # Partition by tier
    by_tier: dict[str, list[dict[str, Any]]] = {"T1": [], "T2": [], "T3": [], "NOISE": []}
    for art in articles:
        by_tier.setdefault(art.get("tier", "NOISE"), []).append(art)

    t1_arts = by_tier["T1"]
    t2_arts = sorted(by_tier["T2"], key=lambda a: a.get("social_score", 0), reverse=True)
    noise_count = len(by_tier["NOISE"])

    # Day-by-day breakdown
    daily: dict[str, dict[str, int]] = {}
    tag_counter: Counter[str] = Counter()
    for art in articles:
        day = (art.get("fetched_at") or "")[:10]
        if not day:
            continue
        if day not in daily:
            daily[day] = {"T1": 0, "T2": 0, "T3": 0, "NOISE": 0}
        daily[day][art.get("tier", "NOISE")] = daily[day].get(art.get("tier", "NOISE"), 0) + 1
        for tag in art.get("tags") or []:
            tag_counter[tag] += 1

    total = len(articles)
    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    lines = [
        f"# {cfg.dashboard_title} — Week {week_label}",
        f"**{week_start.strftime('%b %d')} – {week_end.strftime('%b %d, %Y')}**",
        "",
        f"*Generated {generated}*  ",
        f"**{total} articles** &nbsp;·&nbsp; "
        f"T1: {len(t1_arts)} &nbsp;·&nbsp; "
        f"T2: {len(t2_arts)} &nbsp;·&nbsp; "
        f"T3: {len(by_tier['T3'])} &nbsp;·&nbsp; "
        f"Noise: {noise_count}",
        "",
        "---",
        "",
    ]

    # T1 — all of them, always
    lines.append(f"## {_TIER_EMOJI['T1']} Critical Events This Week ({len(t1_arts)})\n")
    if not t1_arts:
        lines.append("_No T1 events this week._\n")
    else:
        for art in t1_arts:
            _append_article_block(lines, art)

    # T2 — top 15 by social score
    top_t2 = t2_arts[:15]
    lines.append(f"## {_TIER_EMOJI['T2']} Top Notable Stories ({len(t2_arts)} total, showing {len(top_t2)})\n")
    if not top_t2:
        lines.append("_No T2 stories this week._\n")
    else:
        for art in top_t2:
            _append_article_block(lines, art)

    # Day-by-day volume table
    lines += ["## 📊 Week at a Glance\n", "| Date | T1 | T2 | T3 | Noise | Total |",
              "|------|:--:|:--:|:--:|:-----:|------:|"]
    for day in sorted(daily):
        d = daily[day]
        row_total = sum(d.values())
        dt = datetime.strptime(day, "%Y-%m-%d")
        lines.append(
            f"| {dt.strftime('%a %b %d')} | {d['T1']} | {d['T2']} | {d['T3']} | {d['NOISE']} | {row_total} |"
        )
    lines.append("")

    # Top tags
    top_tags = [f"`{tag}` ({cnt})" for tag, cnt in tag_counter.most_common(15)]
    if top_tags:
        lines += ["**Top tags this week:**", " · ".join(top_tags), ""]

    lines.append(f"---\n*Signal Harvester · profile `{cfg.profile}`*\n")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    log.info("weekly_digest_written path=%s", out_path)
    return out_path


def _append_article_block(lines: list[str], art: dict[str, Any]) -> None:
    s_label = art.get("sentiment_label", "neutral")
    s_emoji = _SENTIMENT_EMOJI.get(s_label, "➡️")
    pub = (art.get("published_at") or "")[:10] or "unknown"
    social = art.get("social_score", 0)
    social_str = f" · **Social:** {social}" if social else ""
    lines += [
        f"### [{art.get('title', '(no title)')}]({art.get('url', '')})",
        f"**Source:** {art.get('feed_name', '')} · **Date:** {pub}{social_str}  ",
        f"**Sentiment:** {s_emoji} {s_label} · "
        f"**Tags:** {', '.join(f'`{t}`' for t in (art.get('tags') or [])[:6])}",
        "",
        f"> {art.get('enrich_summary') or art.get('summary', '')}",
        "",
    ]
