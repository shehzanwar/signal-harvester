"""Export pipeline data as static JSON for a portfolio snapshot site.

Usage: python -m harvester --profile <profile> export [--out site/]

Copies frontend/dist/ into site/ and writes site/data/*.json with the same
shapes as the live API endpoints.  The frontend in static mode (VITE_STATIC=true)
reads these files instead of calling /api/*.
"""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from harvester.cluster import attach_cluster_metadata
from harvester.config import ProfileConfig
from harvester.enrich.prompts import PROMPT_VERSION
from harvester.store.db import Database

_FRONTEND_ROOT = Path(__file__).parent.parent / "frontend"
# Prefer the dedicated static build (VITE_STATIC=true, base=/signal-harvester/)
# over the live-API Docker build so exports stay self-contained.
_FRONTEND_DIST = (
    _FRONTEND_ROOT / "dist-static"
    if (_FRONTEND_ROOT / "dist-static").exists()
    else _FRONTEND_ROOT / "dist"
)

# Fields to strip from articles before publishing (raw body, performance data)
_STRIP_FIELDS = {"extracted_text", "summary", "raw_response", "latency_ms"}


def export_site(cfg: ProfileConfig, out_dir: str = "site") -> None:
    out = Path(out_dir)
    data_dir = out / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    db = Database.from_config(cfg)

    # ── Copy built frontend ──────────────────────────────────────────────────
    if _FRONTEND_DIST.exists():
        for item in _FRONTEND_DIST.iterdir():
            dest = out / item.name
            if item.is_dir():
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(item, dest)
            else:
                shutil.copy2(item, dest)
        print(f"Copied frontend dist -> {out}/")
    else:
        print(
            "WARNING: frontend/dist not found. "
            "Run 'cd frontend && npm run build' before exporting."
        )

    # ── Fetch from DB ────────────────────────────────────────────────────────
    articles = db.get_enriched_articles()
    clean = []
    for art in articles:
        a: dict[str, Any] = {
            k: v for k, v in art.items() if k not in _STRIP_FIELDS
        }
        clean.append(a)

    # Populate cluster_size / cluster_sources from cluster_id so the static site
    # shows "N sources" badges — the live API does this at api.py:55.
    attach_cluster_metadata(clean)

    # Tag each article with its feed's category for the dashboard nav.
    cat_map = cfg.feed_category_map()
    for a in clean:
        a["category"] = cat_map.get(a.get("feed_name", ""), "general")

    stats = db.get_stats()
    trends = db.get_trends(days=30)
    profile_info = {
        "profile": cfg.profile,
        "dashboard_title": cfg.dashboard_title,
        "watch_topics": cfg.watch_topics,
        "feeds": [{"name": f.name, "url": f.url, "trust": f.trust} for f in cfg.feeds],
        "model": cfg.llm.model,
    }
    meta = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "prompt_version": PROMPT_VERSION,
        "total_articles": len(clean),
        "profile": cfg.profile,
        "static": True,
    }

    # ── Write data files ─────────────────────────────────────────────────────
    def write(name: str, obj: Any) -> int:
        path = data_dir / name
        text = json.dumps(obj, ensure_ascii=False, default=str)
        path.write_text(text, encoding="utf-8")
        return len(text)

    comments_by_article = db.get_all_comments_by_article()

    sizes = {
        "articles.json": write("articles.json", {"total": len(clean), "items": clean}),
        "stats.json": write("stats.json", stats),
        "trends.json": write("trends.json", trends),
        "profile.json": write("profile.json", profile_info),
        "meta.json": write("meta.json", meta),
        "comments.json": write("comments.json", comments_by_article),
    }

    print("\nData files written:")
    for name, size in sizes.items():
        print(f"  site/data/{name:<20} {size/1024:.1f} KB")

    print(f"\nExport complete: {len(clean)} articles -> {out_dir}/")
    print(f"Preview locally: python -m http.server 8080 --directory {out_dir}")
    print("Deploy: push site/ to GitHub Pages or Cloudflare Pages.")
