"""Export enriched articles to an Obsidian vault.

Each article becomes its own note with YAML frontmatter so Obsidian's graph
view, tag search, and dataview queries all work out of the box.

Usage:
    python -m harvester --profile configs/profiles/daily-briefing.yaml \\
        obsidian --vault ~/Documents/Obsidian/SignalHarvester

Folder layout inside the vault:
    articles/YYYY-MM-DD-slug.md   — one note per article
    daily/YYYY-MM-DD.md           — index note per calendar day
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_TIER_EMOJI = {"T1": "🔴", "T2": "🟡", "T3": "🔵", "NOISE": "⚫"}
_SENT_EMOJI = {"positive": "📈", "negative": "📉", "neutral": "➡️", "mixed": "↕️"}

# Windows + Unix filename-unsafe characters
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _slug(text: str, max_len: int = 60) -> str:
    text = _UNSAFE.sub("", text.lower())
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text).strip("-")
    return text[:max_len].rstrip("-")


def _yaml_str(value: str) -> str:
    """Quote a string for YAML, escaping inner double-quotes."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _frontmatter(art: dict[str, Any]) -> str:
    tags = art.get("tags") or []
    tag_list = "[" + ", ".join(_yaml_str(t) for t in tags) + "]"
    pub = (art.get("published_at") or "")[:10] or "unknown"
    fetched = (art.get("fetched_at") or "")[:10] or "unknown"
    tier = art.get("tier", "")
    sentiment = art.get("sentiment_label", "neutral")
    score = art.get("sentiment_score")
    composite = art.get("composite_sentiment_score")
    gap = art.get("perception_gap")
    confidence = art.get("sentiment_confidence", "")
    social = art.get("social_score", 0) or 0

    lines = [
        "---",
        f"id: {art.get('id', '')}",
        f"title: {_yaml_str(art.get('title', ''))}",
        f"url: {_yaml_str(art.get('url', ''))}",
        f"source: {_yaml_str(art.get('feed_name', ''))}",
        f"published: {pub}",
        f"fetched: {fetched}",
        f"tier: {tier}",
        f"tags: {tag_list}",
        f"sentiment: {sentiment}",
    ]
    if score is not None:
        lines.append(f"sentiment_score: {score:.2f}")
    if composite is not None:
        lines.append(f"composite_score: {composite:.2f}")
    if gap is not None:
        lines.append(f"perception_gap: {gap:.2f}")
    if confidence:
        lines.append(f"sentiment_confidence: {confidence}")
    if social:
        lines.append(f"social_score: {social}")
    lines.append("---")
    return "\n".join(lines)


def _article_note(art: dict[str, Any]) -> str:
    title = art.get("title", "(no title)")
    url = art.get("url", "")
    tier = art.get("tier", "")
    tier_emoji = _TIER_EMOJI.get(tier, "")
    summary = art.get("enrich_summary") or art.get("summary", "")
    tier_rationale = art.get("tier_rationale", "")
    sentiment = art.get("sentiment_label", "neutral")
    score = art.get("sentiment_score") or 0.0
    sent_emoji = _SENT_EMOJI.get(sentiment, "➡️")
    sent_rationale = art.get("sentiment_rationale", "")
    tags = art.get("tags") or []
    feed = art.get("feed_name", "")
    pub = (art.get("published_at") or "")[:10] or "unknown"
    gap = art.get("perception_gap")
    confidence = art.get("sentiment_confidence", "")

    tag_links = " · ".join(f"[[{t}]]" for t in tags)

    lines = [
        _frontmatter(art),
        "",
        f"# {tier_emoji} {title}",
        "",
    ]

    if summary:
        lines += ["> " + summary.replace("\n", "\n> "), ""]

    if tier_rationale:
        lines += [f"**Tier rationale:** {tier_rationale}", ""]

    # Sentiment block
    sent_line = f"**Sentiment:** {sent_emoji} {sentiment} ({score:+.2f})"
    if sent_rationale:
        sent_line += f" — {sent_rationale}"
    lines.append(sent_line)

    if gap is not None and confidence and confidence != "predicted":
        gap_desc = "public more positive than press" if gap > 0 else "public more negative than press"
        lines.append(f"**Perception gap:** {gap:+.2f} ({gap_desc}, confidence: {confidence})")

    lines.append("")

    if tag_links:
        lines += [f"**Tags:** {tag_links}", ""]

    lines += [
        f"**Source:** [{feed}]({url}) · Published: {pub}",
        "",
    ]

    return "\n".join(lines)


def _daily_index(date_str: str, articles: list[dict[str, Any]], profile_title: str) -> str:
    by_tier: dict[str, list[dict[str, Any]]] = {"T1": [], "T2": [], "T3": [], "NOISE": []}
    for art in articles:
        by_tier.setdefault(art.get("tier", "NOISE"), []).append(art)

    lines = [
        "---",
        f"date: {date_str}",
        f"type: daily-index",
        f"t1: {len(by_tier['T1'])}",
        f"t2: {len(by_tier['T2'])}",
        f"t3: {len(by_tier['T3'])}",
        f"noise: {len(by_tier['NOISE'])}",
        f"total: {len(articles)}",
        "---",
        "",
        f"# {profile_title} — {date_str}",
        "",
        f"**{len(articles)} articles** · "
        f"T1: {len(by_tier['T1'])} · T2: {len(by_tier['T2'])} · "
        f"T3: {len(by_tier['T3'])} · Noise: {len(by_tier['NOISE'])}",
        "",
    ]

    for tier_key, label in [("T1", "Critical"), ("T2", "Notable"), ("T3", "Background")]:
        emoji = _TIER_EMOJI[tier_key]
        arts = by_tier[tier_key]
        lines.append(f"## {emoji} {label} ({len(arts)})\n")
        for art in arts:
            pub = (art.get("published_at") or "")[:10]
            slug = _slug(art.get("title", "no-title"))
            note_name = f"{pub}-{slug}" if pub else slug
            display = art.get("title", "(no title)")
            lines.append(f"- [[articles/{note_name}|{display}]]")
        lines.append("")

    return "\n".join(lines)


def export_obsidian(
    articles: list[dict[str, Any]],
    vault_path: str | Path,
    profile_title: str = "Signal Harvester",
    *,
    since: str | None = None,
    overwrite: bool = True,
) -> dict[str, int]:
    """Write article notes and daily index notes into an Obsidian vault.

    Args:
        articles:      Enriched article dicts from the DB.
        vault_path:    Root of the Obsidian vault directory.
        profile_title: Dashboard title used in index headings.
        since:         ISO date string — skip articles fetched before this date.
        overwrite:     Re-write existing notes (default True, keeps notes current).

    Returns:
        {"notes_written": N, "indexes_written": M, "skipped": K}
    """
    vault = Path(vault_path).expanduser()
    articles_dir = vault / "articles"
    daily_dir = vault / "daily"
    articles_dir.mkdir(parents=True, exist_ok=True)
    daily_dir.mkdir(parents=True, exist_ok=True)

    # Filter noise and optionally restrict by date
    candidates = [a for a in articles if a.get("tier") != "NOISE"]
    if since:
        candidates = [a for a in candidates if (a.get("fetched_at") or "") >= since]

    # Group by fetch date for daily indexes
    by_day: dict[str, list[dict[str, Any]]] = {}
    for art in candidates:
        day = (art.get("fetched_at") or "")[:10]
        by_day.setdefault(day, []).append(art)

    notes_written = skipped = 0

    for art in candidates:
        pub = (art.get("published_at") or "")[:10]
        slug = _slug(art.get("title", "no-title"))
        filename = f"{pub}-{slug}.md" if pub else f"{slug}.md"
        note_path = articles_dir / filename

        if note_path.exists() and not overwrite:
            skipped += 1
            continue

        note_path.write_text(_article_note(art), encoding="utf-8")
        notes_written += 1

    indexes_written = 0
    for day, day_arts in by_day.items():
        if not day:
            continue
        idx_path = daily_dir / f"{day}.md"
        idx_path.write_text(_daily_index(day, day_arts, profile_title), encoding="utf-8")
        indexes_written += 1

    return {
        "notes_written": notes_written,
        "indexes_written": indexes_written,
        "skipped": skipped,
    }
