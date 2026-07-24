from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from harvester.cluster import attach_cluster_metadata
from harvester.config import ProfileConfig
from harvester.store.db import Database

_FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


def build_app(cfg: ProfileConfig | None = None) -> FastAPI:
    app = FastAPI(
        title="Signal Harvester",
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://localhost:8001"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    def _db() -> Database:
        if cfg is None:
            raise HTTPException(500, detail="No profile configured.")
        return Database.from_config(cfg)

    @app.get("/api/articles")
    def list_articles(
        tier: str | None = Query(None, description="Filter by tier: T1, T2, T3, NOISE"),
        limit: int = Query(2000, ge=1, le=5000),
        offset: int = Query(0, ge=0),
        search: str | None = Query(None, description="FTS5 full-text search on title, summary, and tags"),
        today_only: bool = Query(False),
    ) -> dict[str, Any]:
        total, articles = _db().get_articles_page(
            search=search,
            tier=tier,
            today_only=today_only,
            limit=limit,
            offset=offset,
        )
        attach_cluster_metadata(articles)
        cat_map = cfg.feed_category_map() if cfg else {}
        subcat_map = cfg.feed_subcategory_map() if cfg else {}
        for a in articles:
            a["category"] = cat_map.get(a.get("feed_name", ""), "general")
            a["subcategory"] = subcat_map.get(a.get("feed_name", ""), "")
        return {"total": total, "items": articles}

    @app.get("/api/articles/{article_id}/comments")
    def article_comments(article_id: str) -> list[dict[str, Any]]:
        return _db().get_comments(article_id)

    @app.get("/api/stats")
    def stats() -> dict[str, Any]:
        return _db().get_stats()

    @app.get("/api/feed-health")
    def feed_health() -> list[dict[str, Any]]:
        feed_names = [f.name for f in cfg.feeds] if cfg else []
        return _db().get_feed_health(feed_names)

    @app.get("/api/trends")
    def trends(days: int = Query(30, ge=7, le=365)) -> dict[str, Any]:
        return _db().get_trends(days=days)

    @app.get("/api/runs")
    def runs(limit: int = Query(10, ge=1, le=50)) -> list[dict[str, Any]]:
        return _db().get_runs(limit=limit)

    @app.get("/api/profile")
    def profile_info() -> dict[str, Any]:
        if cfg is None:
            raise HTTPException(500, detail="No profile configured.")
        return {
            "profile": cfg.profile,
            "dashboard_title": cfg.dashboard_title,
            "watch_topics": cfg.watch_topics,
            "feeds": [{"name": f.name, "url": f.url, "trust": f.trust} for f in cfg.feeds],
            "model": cfg.llm.model,
        }

    # Serve built frontend as static files so `python -m harvester serve` is one-command demo
    if _FRONTEND_DIST.exists():
        assets = _FRONTEND_DIST / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

        @app.get("/", include_in_schema=False)
        def serve_index() -> FileResponse:
            index = _FRONTEND_DIST / "index.html"
            if not index.exists():
                raise HTTPException(404, detail="Frontend not built. Run: make frontend")
            return FileResponse(
                str(index),
                headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
            )

        @app.get("/{full_path:path}", include_in_schema=False, response_model=None)
        def serve_spa(full_path: str) -> FileResponse | JSONResponse:
            if full_path.startswith("api/"):
                return JSONResponse(
                    status_code=404,
                    content={"detail": f"API endpoint /{full_path} not found"},
                )
            # Serve real built files (manifest.webmanifest, sw.js, icons, favicon)
            # when they exist, guarding against path traversal; otherwise fall back
            # to index.html for client-side routes.
            if full_path:
                candidate = (_FRONTEND_DIST / full_path).resolve()
                root = _FRONTEND_DIST.resolve()
                if candidate.is_file() and root in candidate.parents:
                    return FileResponse(str(candidate))
            index = _FRONTEND_DIST / "index.html"
            if not index.exists():
                raise HTTPException(404, detail="Frontend not built. Run: make frontend")
            return FileResponse(
                str(index),
                headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
            )

    return app
