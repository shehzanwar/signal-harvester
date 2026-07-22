"""Perception gap computation.

Blends editorial_tone (how the journalist frames the story) with predicted_reaction
(LLM prediction of public response) and, when available, public_sentiment (LLM
assessment of actual social media comments) into a composite perception score.

The perception_gap is the key insight: the difference between how the press writes
about an event and how the public actually reacts to it.
"""
from __future__ import annotations

from typing import Any


def compute_perception(
    editorial_score: float,
    predicted_score: float,
    public_score: float | None,
    comment_count: int,
) -> dict[str, Any]:
    """Blend editorial_tone, predicted_reaction, and optional comment-derived public sentiment.

    Returns:
        composite_score: weighted blend of all three signals
        confidence: 'high' (15+ comments), 'medium' (5-14), 'low' (2-4), 'predicted' (no comments)
        perception_gap: public reaction score minus editorial tone score
    """
    if public_score is not None and comment_count >= 5:
        composite = 0.15 * editorial_score + 0.25 * predicted_score + 0.60 * public_score
        confidence = "high" if comment_count >= 15 else "medium"
        gap_base = public_score
    elif public_score is not None and comment_count >= 2:
        composite = 0.25 * editorial_score + 0.40 * predicted_score + 0.35 * public_score
        confidence = "low"
        gap_base = public_score
    else:
        composite = 0.35 * editorial_score + 0.65 * predicted_score
        confidence = "predicted"
        gap_base = predicted_score

    return {
        "composite_score": round(composite, 2),
        "confidence": confidence,
        "perception_gap": round(gap_base - editorial_score, 2),
    }
