from __future__ import annotations

import logging
import sys
from pathlib import Path


def setup_logging(log_dir: str | None = None, level: str = "INFO") -> None:
    fmt = "%(asctime)s %(levelname)-8s %(name)s  %(message)s"
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_dir:
        Path(log_dir).mkdir(parents=True, exist_ok=True)
        handlers.append(
            logging.FileHandler(Path(log_dir) / "harvester.log", encoding="utf-8")
        )
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=fmt,
        handlers=handlers,
        force=True,
    )
    # Silence noisy third-party loggers
    for noisy in ("httpx", "httpcore", "trafilatura", "feedparser", "openai", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
