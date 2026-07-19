from __future__ import annotations

import logging
import re

import trafilatura

log = logging.getLogger(__name__)

_MIN_EXTRACTED_CHARS = 200


def extract_text(url: str, fallback: str = "") -> str:
    """
    Extract main article text from URL via trafilatura.
    Falls back to the feed-level summary if extraction yields too little content.
    Records summary_source in a leading tag so callers know which path fired.
    """
    try:
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            # Decode bytes with declared charset; fall back to utf-8 with replacement
            # to prevent mojibake (e.g. £ → �) from ASCII-misdetected pages.
            if isinstance(downloaded, bytes):
                downloaded = downloaded.decode("utf-8", errors="replace")
            text = trafilatura.extract(
                downloaded,
                include_comments=False,
                include_tables=False,
                favor_recall=True,
            )
            if text and len(text.strip()) >= _MIN_EXTRACTED_CHARS:
                return text.strip()
            log.debug("trafilatura_short url=%s len=%d", url, len(text or ""))
    except Exception as exc:
        log.warning("extract_error url=%s error=%s", url, exc)

    cleaned = _strip_html(fallback)
    if cleaned:
        log.debug("extract_fallback url=%s", url)
        return f"[feed summary]\n{cleaned}"
    return ""


def _strip_html(text: str) -> str:
    clean = re.sub(r"<[^>]+>", " ", text or "")
    return re.sub(r"\s+", " ", clean).strip()
