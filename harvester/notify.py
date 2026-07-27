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
from typing import Any

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


# Discord colors (decimal, matching Discord's own embed color swatches).
_DISCORD_COLOR = {"info": 0x3498DB, "warning": 0xF1C40F, "critical": 0xE74C3C}


def notify_discord(
    title: str,
    message: str,
    *,
    url: str | None = None,
    level: str = "info",
) -> None:
    """Best-effort Discord webhook notification. Never raises — same
    contract as notify(): a notification failure must not take down the
    pipeline run it's trying to report on.

    Gated on the DISCORD_BRIEFING_WEBHOOK_URL env var (set in .env,
    gitignored — the URL itself is the credential; anyone who has it can
    post to the channel). Silently does nothing when unset.

    Deliberately not DISCORD_WEBHOOK_URL: that name collided with an
    existing, unrelated job-notifier webhook set as a persistent OS env
    var, which silently won (python-dotenv doesn't override already-set
    env vars) and sent briefing messages to the wrong channel.

    level: "info" | "warning" | "critical" — picks the embed's accent color.
    url: optional link the embed title becomes clickable to (e.g. the
    dashboard, or a specific article).
    """
    webhook = os.environ.get("DISCORD_BRIEFING_WEBHOOK_URL")
    if not webhook:
        return
    embed: dict[str, Any] = {
        "title": title[:256],  # Discord's own embed title limit
        "description": message[:4096],  # Discord's own embed description limit
        "color": _DISCORD_COLOR.get(level, _DISCORD_COLOR["info"]),
    }
    if url:
        embed["url"] = url
    try:
        httpx.post(webhook, json={"embeds": [embed]}, timeout=_TIMEOUT)
    except httpx.HTTPError as exc:
        log.debug("discord_notify_failed title=%r err=%s", title, exc)
