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
    serve_p.add_argument("--port", type=int, default=8000)

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
