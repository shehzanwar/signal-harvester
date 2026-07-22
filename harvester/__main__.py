"""CLI entry: python -m harvester [--profile PATH] <command>"""
from __future__ import annotations

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="harvester",
        description="Signal Harvester — privacy-preserving local RSS intelligence pipeline",
    )
    parser.add_argument(
        "--profile",
        default="configs/profiles/daily-briefing.yaml",
        metavar="PATH",
        help="Profile YAML path (default: configs/profiles/daily-briefing.yaml)",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )

    sub = parser.add_subparsers(dest="command", required=True)

    # run
    sub.add_parser("run", help="Fetch, extract, enrich, and write today's digest")

    # serve
    serve_p = sub.add_parser("serve", help="Start the dashboard (API + frontend)")
    serve_p.add_argument("--host", default="127.0.0.1")
    serve_p.add_argument("--port", type=int, default=8001)  # must match vite.config.ts proxy target

    # backfill
    bf = sub.add_parser("backfill", help="Re-enrich articles by date range or status")
    bf.add_argument("--from-date", metavar="YYYY-MM-DD")
    bf.add_argument("--to-date", metavar="YYYY-MM-DD")
    bf.add_argument(
        "--status",
        help="Re-process only articles with this status (e.g. failed_llm)",
    )
    bf.add_argument(
        "--stale",
        action="store_true",
        help="Re-enrich only articles not on the current prompt version",
    )
    bf.add_argument(
        "--prompt-version",
        metavar="VER",
        help="Re-enrich only articles enriched with this exact prompt version (e.g. v1)",
    )

    # weekly-digest
    wd = sub.add_parser("weekly-digest", help="Generate a week-in-review Markdown digest")
    wd.add_argument(
        "--weeks-ago",
        type=int,
        default=0,
        metavar="N",
        help="Generate for N weeks ago (default: 0 = this week)",
    )

    # prune
    prune_p = sub.add_parser("prune", help="Delete old articles according to the retention policy")
    prune_p.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be deleted without deleting anything",
    )
    prune_p.add_argument(
        "--article-days",
        type=int,
        metavar="N",
        help="Override retention.article_days from the profile",
    )
    prune_p.add_argument(
        "--health-days",
        type=int,
        metavar="N",
        help="Override retention.health_days from the profile",
    )

    # prompt-stats
    sub.add_parser("prompt-stats", help="Show prompt version coverage and stale article count")

    # validate-config
    sub.add_parser("validate-config", help="Validate profile YAML and exit")

    # eval
    ev = sub.add_parser("eval", help="Run golden-set evaluation")
    ev.add_argument(
        "--golden-set",
        default="tests/golden",
        metavar="DIR",
        help="Directory containing golden-set JSON files",
    )

    # export
    exp = sub.add_parser("export", help="Export static snapshot site to a directory")
    exp.add_argument(
        "--out",
        default="site",
        metavar="DIR",
        help="Output directory (default: site/)",
    )

    args = parser.parse_args()

    from harvester.logging_setup import setup_logging

    setup_logging(level=args.log_level)

    # ── weekly-digest ─────────────────────────────────────────────────────────
    if args.command == "weekly-digest":
        from datetime import datetime, timedelta, timezone

        from harvester.config import load_profile
        from harvester.store.db import Database
        from harvester.store.writers import write_weekly_digest

        cfg = load_profile(args.profile)
        db = Database.from_config(cfg)
        db.init_schema()

        weeks_ago = getattr(args, "weeks_ago", 0)
        now = datetime.now(timezone.utc) - timedelta(weeks=weeks_ago)
        # Week window: last 7 days ending today (or the reference day).
        week_start = now - timedelta(days=6)
        since = (now - timedelta(days=7)).isoformat()

        articles = db.get_enriched_articles(since=since)
        out = write_weekly_digest(articles, cfg, week_start=week_start)
        if out:
            t1 = sum(1 for a in articles if a.get("tier") == "T1")
            t2 = sum(1 for a in articles if a.get("tier") == "T2")
            print(f"Weekly digest written: {out}")
            print(f"  {len(articles)} articles · T1: {t1} · T2: {t2}")
        return

    # ── prune ─────────────────────────────────────────────────────────────────
    if args.command == "prune":
        from harvester.config import load_profile
        from harvester.store.db import Database

        cfg = load_profile(args.profile)
        db = Database.from_config(cfg)
        db.init_schema()

        article_days = getattr(args, "article_days", None) or cfg.retention.article_days
        health_days = getattr(args, "health_days", None) or cfg.retention.health_days
        dry_run = getattr(args, "dry_run", False)

        counts = db.prune(article_days, health_days, dry_run=dry_run)
        label = "Would delete" if dry_run else "Deleted"
        print(
            f"\n{'[DRY RUN] ' if dry_run else ''}"
            f"Retention policy: articles > {article_days}d, feed_health > {health_days}d\n"
            f"  {label}: {counts['articles']:,} articles, "
            f"{counts['enrichments']:,} enrichments, "
            f"{counts['social_signals']:,} social signals, "
            f"{counts['feed_health']:,} feed_health records\n"
        )
        if dry_run and any(counts.values()):
            print("  Run without --dry-run to apply.")
        return

    # ── prompt-stats ──────────────────────────────────────────────────────────
    if args.command == "prompt-stats":
        from harvester.config import load_profile
        from harvester.enrich.prompts import PROMPT_VERSION
        from harvester.store.db import Database

        cfg = load_profile(args.profile)
        db = Database.from_config(cfg)
        db.init_schema()
        stats = db.get_stats()
        coverage = stats["prompt_coverage"]
        total_enriched = stats["enriched_articles"]
        stale = stats["stale_count"]

        print(f"\nPrompt version coverage ({total_enriched:,} enrichments, current: {PROMPT_VERSION})\n")
        for version, count in sorted(coverage.items(), key=lambda x: x[1], reverse=True):
            pct = count / total_enriched * 100 if total_enriched else 0
            tag = "  [current]" if version == PROMPT_VERSION else ""
            print(f"  {version:<8}{tag:<12} {count:>6,}  ({pct:.1f}%)")

        if stale:
            print(f"\n  {stale:,} stale article(s) — run: harvester backfill --stale")
        else:
            print("\n  All articles are on the current prompt version.")
        print()
        return

    # ── validate-config ───────────────────────────────────────────────────────
    if args.command == "validate-config":
        from harvester.config import load_profile

        try:
            cfg = load_profile(args.profile)
            print(
                f"Config valid:\n"
                f"  profile       : {cfg.profile}\n"
                f"  feeds         : {len(cfg.feeds)}\n"
                f"  watch_topics  : {cfg.watch_topics}\n"
                f"  model         : {cfg.llm.model}\n"
                f"  output.root   : {cfg.output.root}"
            )
        except Exception as exc:
            print(f"Config error: {exc}", file=sys.stderr)
            sys.exit(1)
        return

    # ── run ──────────────────────────────────────────────────────────────────
    if args.command == "run":
        from harvester.config import load_profile
        from harvester.pipeline import run_pipeline

        cfg = load_profile(args.profile)
        run_pipeline(cfg)
        return

    # ── serve ─────────────────────────────────────────────────────────────────
    if args.command == "serve":
        import uvicorn

        from harvester.api import build_app
        from harvester.config import load_profile

        cfg = load_profile(args.profile)
        app = build_app(cfg)
        print(f"Dashboard: http://{args.host}:{args.port}")
        print(f"API docs:  http://{args.host}:{args.port}/api/docs")
        uvicorn.run(app, host=args.host, port=args.port)
        return

    # ── backfill ──────────────────────────────────────────────────────────────
    if args.command == "backfill":
        from harvester.config import load_profile
        from harvester.pipeline import backfill

        cfg = load_profile(args.profile)
        backfill(
            cfg,
            from_date=getattr(args, "from_date", None),
            to_date=getattr(args, "to_date", None),
            status=getattr(args, "status", None),
            stale=getattr(args, "stale", False),
            prompt_version=getattr(args, "prompt_version", None),
        )
        return

    # ── eval ──────────────────────────────────────────────────────────────────
    if args.command == "eval":
        from harvester.config import load_profile
        from harvester.eval import run_eval

        cfg = load_profile(args.profile)
        run_eval(cfg, golden_set_dir=args.golden_set)
        return

    # ── export ────────────────────────────────────────────────────────────────
    if args.command == "export":
        from harvester.config import load_profile
        from harvester.export import export_site

        cfg = load_profile(args.profile)
        export_site(cfg, out_dir=args.out)
        return


if __name__ == "__main__":
    main()
