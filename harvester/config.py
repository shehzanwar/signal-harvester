from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator


class FeedConfig(BaseModel):
    name: str
    url: str
    trust: Literal["high", "medium", "low"] = "medium"
    # Coarse topic bucket used for the dashboard's category navigation. Free-form
    # so other profiles can define their own buckets; the default profile uses
    # technology / finance / politics / sports / world.
    category: str = "general"
    max_articles: int | None = None  # per-feed override; falls back to ProfileConfig.max_articles_per_feed


class TierCriteria(BaseModel):
    T1: str
    T2: str
    T3: str


class LLMConfig(BaseModel):
    # "ollama": /api/generate with the raw-ChatML + stream-salvage workarounds for
    # the Ollama 0.32/Windows wsarecv crash. "llamacpp": clean OpenAI-compatible
    # /v1/chat/completions against a standalone llama-server with native
    # json_schema grammar — no workarounds. See EnrichmentClient.
    backend: Literal["ollama", "llamacpp"] = "ollama"
    model: str = "qwen3:8b"
    base_url: str = "http://localhost:11434/v1"
    api_key: str = "ollama"  # Ollama ignores this; the openai client requires a non-empty value
    num_ctx: int = 8192
    max_article_tokens: int = 3500
    temperature: float = 0.2
    top_p: float = 0.9
    top_k: int = 40
    repeat_penalty: float = 1.05
    seed: int | None = None
    # Parallel enrichment workers. Requires -np N on llama-server to match.
    # llamacpp only — Ollama path always runs sequentially (crash/respawn cycle).
    concurrency: int = 1


class PromptsConfig(BaseModel):
    enrichment: str = "prompts/enrichment.md"


class OutputConfig(BaseModel):
    root: str = "output"
    formats: list[Literal["json", "markdown"]] = ["json", "markdown"]
    digest_time: str = "07:00"


class ScheduleConfig(BaseModel):
    interval: Literal["daily", "hourly"] = "daily"


class RetentionConfig(BaseModel):
    # Days to keep articles and enrichments. 0 = keep forever.
    article_days: int = 90
    # Days to keep feed_health records (cheaper to keep longer).
    health_days: int = 30


class YouTubeConfig(BaseModel):
    # Channel names to boost to the top of YouTube search results.
    # Case-insensitive match against the video's channelTitle field.
    # Channels not in this list are still fetched — they're just deprioritized.
    preferred_channels: list[str] = [
        "BBC News",
        "Reuters",
        "Associated Press",
        "Al Jazeera English",
        "CNN",
        "Sky News",
        "NBC News",
        "ABC News",
        "CBS News",
        "The Guardian",
        "France 24 English",
        "DW News",
        "CNBC",
        "Bloomberg Television",
    ]


class TwitterConfig(BaseModel):
    # Path to the twscrape accounts SQLite database. Create and populate it once
    # via the twscrape CLI before running the pipeline. If the file is absent,
    # Twitter comments are silently skipped — no errors, no pipeline impact.
    db_path: str = "data/twscrape_accounts.db"
    # Cap per pipeline run. twscrape burns one search per article; keep this low
    # to avoid rate-limit pressure on a single-account pool.
    max_articles: int = 20


class SocialConfig(BaseModel):
    youtube: YouTubeConfig = Field(default_factory=YouTubeConfig)
    twitter: TwitterConfig = Field(default_factory=TwitterConfig)


class ProfileConfig(BaseModel):
    profile: str
    dashboard_title: str = "Signal Harvester"
    max_articles_per_feed: int = 20  # cap applied to every feed unless overridden per-feed
    feeds: list[FeedConfig]
    watch_topics: list[str]
    sentiment_target: str
    tiers: TierCriteria
    llm: LLMConfig = Field(default_factory=LLMConfig)
    prompts: PromptsConfig = Field(default_factory=PromptsConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)
    schedule: ScheduleConfig = Field(default_factory=ScheduleConfig)
    retention: RetentionConfig = Field(default_factory=RetentionConfig)
    social: SocialConfig = Field(default_factory=SocialConfig)

    @field_validator("feeds")
    @classmethod
    def feeds_not_empty(cls, v: list[FeedConfig]) -> list[FeedConfig]:
        if not v:
            raise ValueError("feeds: at least one feed must be configured")
        return v

    def feed_category_map(self) -> dict[str, str]:
        """{feed_name: category} for tagging articles at query/export time."""
        return {f.name: f.category for f in self.feeds}

    @field_validator("watch_topics")
    @classmethod
    def topics_not_empty(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("watch_topics: at least one topic must be configured")
        return v


def _interpolate_env(text: str) -> str:
    """Expand ${VAR:-default} and ${VAR} placeholders from environment variables.

    Matches Docker Compose variable-substitution syntax so the same profile YAML
    works both locally (falls back to the default) and inside a container (env var
    overrides the default without touching the file).
    """
    def _replace(m: re.Match[str]) -> str:
        var, _, default = m.group(1).partition(":-")
        return os.environ.get(var.strip(), default)
    return re.sub(r"\$\{([^}]+)\}", _replace, text)


def load_profile(path: str | Path) -> ProfileConfig:
    """Load and validate a profile YAML. Raises FileNotFoundError or ValueError on bad config."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Config not found: {p.absolute()}")
    with p.open(encoding="utf-8-sig") as f:
        data = yaml.safe_load(_interpolate_env(f.read()))
    try:
        return ProfileConfig.model_validate(data)
    except Exception as exc:
        raise ValueError(f"Invalid config at {p}:\n{exc}") from exc
