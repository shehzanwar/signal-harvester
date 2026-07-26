"""Push notifications via ntfy.sh — free, no account, no API key. POST a
message to https://ntfy.sh/{topic} and anyone subscribed to that topic (via
the ntfy app or a browser tab) gets it pushed immediately.

Gated on the NTFY_TOPIC env var (set in .env, gitignored — the topic name
is a shared secret in the sense that anyone who knows it can read your
notifications, since ntfy.sh topics are public unless self-hosted). Silently
does nothing when unset, so this is a pure opt-in with zero pipeline impact
if not configured.

Existed as a deliberate gap until a real incident (llama-server crashed and
stayed down silently for over a day, across two scheduled runs, discovered
only by manually reading logs) made the case for it concrete.
"""
from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger(__name__)

_NTFY_BASE = "https://ntfy.sh"
_TIMEOUT = 10.0


def notify(title: str, message: str, priority: str = "default", tags: str | None = None) -> None:
    """Best-effort push notification. Never raises — a notification failure
    must not take down the pipeline run it's trying to report on.

    priority: "min" | "low" | "default" | "high" | "urgent" (ntfy's scale)
    tags: comma-separated ntfy emoji-shortcode tags, e.g. "warning,skull"
    """
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return
    headers = {"Title": title, "Priority": priority}
    if tags:
        headers["Tags"] = tags
    try:
        httpx.post(f"{_NTFY_BASE}/{topic}", data=message.encode("utf-8"), headers=headers, timeout=_TIMEOUT)
    except httpx.HTTPError as exc:
        log.debug("ntfy_notify_failed title=%r err=%s", title, exc)
