from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class SentimentResult(BaseModel):
    label: Literal["positive", "negative", "neutral", "mixed"]
    score: float = Field(ge=-1.0, le=1.0)
    rationale: str = Field(max_length=300)

    @model_validator(mode="after")
    def label_score_consistent(self) -> "SentimentResult":
        if self.label == "positive" and self.score < 0:
            raise ValueError(f"label=positive but score={self.score:.2f} < 0")
        if self.label == "negative" and self.score > 0:
            raise ValueError(f"label=negative but score={self.score:.2f} > 0")
        return self


class EnrichmentResult(BaseModel):
    summary: str = Field(min_length=10, max_length=600)
    tier: Literal["T1", "T2", "T3", "NOISE"]
    tier_rationale: str = Field(max_length=500)
    editorial_tone: SentimentResult
    predicted_reaction: SentimentResult
    tags: list[str] = Field(min_length=1, max_length=5)

    @field_validator("tags")
    @classmethod
    def tags_must_be_short(cls, v: list[str]) -> list[str]:
        for tag in v:
            if len(tag) > 60:
                raise ValueError(
                    f"Tag too long ({len(tag)} chars) — likely model reasoning leaked into tags: {tag[:40]!r}…"
                )
        return v

    def to_storage_dict(
        self,
        model: str,
        prompt_version: str,
        raw_response: str,
    ) -> dict[str, Any]:
        return {
            "summary": self.summary,
            "tier": self.tier,
            "tier_rationale": self.tier_rationale,
            "editorial_tone": {
                "label": self.editorial_tone.label,
                "score": self.editorial_tone.score,
                "rationale": self.editorial_tone.rationale,
            },
            "predicted_reaction": {
                "label": self.predicted_reaction.label,
                "score": self.predicted_reaction.score,
                "rationale": self.predicted_reaction.rationale,
            },
            "tags": self.tags,
            "_model": model,
            "_prompt_version": prompt_version,
            "_raw_response": raw_response,
        }


class CommentSentimentResult(BaseModel):
    label: Literal["positive", "negative", "neutral", "mixed"]
    score: float = Field(ge=-1.0, le=1.0)
    dominant_emotion: Literal[
        "anger", "approval", "concern", "indifference",
        "amusement", "fear", "sadness", "enthusiasm"
    ]
    confidence: Literal["high", "medium", "low"]
    rationale: str = Field(max_length=300)

    @model_validator(mode="after")
    def label_score_consistent(self) -> "CommentSentimentResult":
        if self.label == "positive" and self.score < 0:
            raise ValueError(f"label=positive but score={self.score:.2f} < 0")
        if self.label == "negative" and self.score > 0:
            raise ValueError(f"label=negative but score={self.score:.2f} > 0")
        return self


COMMENT_SENTIMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "label": {"type": "string", "enum": ["positive", "negative", "neutral", "mixed"]},
        "score": {"type": "number", "minimum": -1.0, "maximum": 1.0},
        "dominant_emotion": {"type": "string", "enum": [
            "anger", "approval", "concern", "indifference",
            "amusement", "fear", "sadness", "enthusiasm",
        ]},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "rationale": {"type": "string", "maxLength": 300},
    },
    "required": ["label", "score", "dominant_emotion", "confidence", "rationale"],
    "additionalProperties": False,
}


_SENTIMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "label": {
            "type": "string",
            "enum": ["positive", "negative", "neutral", "mixed"],
        },
        "score": {"type": "number", "minimum": -1.0, "maximum": 1.0},
        "rationale": {"type": "string", "maxLength": 300},
    },
    "required": ["label", "score", "rationale"],
    "additionalProperties": False,
}

# JSON schema for Ollama structured output — mirrors EnrichmentResult fields
ENRICHMENT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "minLength": 10, "maxLength": 600},
        "tier": {"type": "string", "enum": ["T1", "T2", "T3", "NOISE"]},
        "tier_rationale": {"type": "string", "maxLength": 500},
        "editorial_tone": _SENTIMENT_SCHEMA,
        "predicted_reaction": _SENTIMENT_SCHEMA,
        "tags": {"type": "array", "items": {"type": "string", "maxLength": 60}, "minItems": 1, "maxItems": 5},
    },
    "required": ["summary", "tier", "tier_rationale", "editorial_tone", "predicted_reaction", "tags"],
    "additionalProperties": False,
}
