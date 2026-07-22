from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx
from pydantic import ValidationError

from harvester.config import ProfileConfig
from harvester.enrich.prompts import PROMPT_VERSION, build_system_prompt, build_user_message
from harvester.enrich.schemas import ENRICHMENT_JSON_SCHEMA, EnrichmentResult

log = logging.getLogger(__name__)

# Qwen3 / ChatML prompt template — used when calling /api/generate directly.
# This bypasses the apply-template and tokenize subprocesses in Ollama's OpenAI
# compat layer, which crash repeatedly on Windows (observed with 0.32.0).
#
# The empty <think>\n\n</think> prefill is the canonical way to suppress Qwen3's
# chain-of-thought mode via /api/generate (where the "think: false" API param
# is not available). Without it the model fills num_predict with thinking tokens
# and produces no JSON output.
_CHATML = (
    "<|im_start|>system\n{system}\n<|im_end|>\n"
    "<|im_start|>user\n{user}\n<|im_end|>\n"
    "<|im_start|>assistant\n<think>\n\n</think>\n"
)

# Multi-turn repair prompt: re-sends the original user message + the model's
# bad response so it can correct its JSON without losing the article context.
# Without this, the repair call had no article content and the model fabricated
# a summary from its training data (observed: golf article → AI chip summary).
_CHATML_REPAIR = (
    "<|im_start|>system\n{system}\n<|im_end|>\n"
    "<|im_start|>user\n{user}\n<|im_end|>\n"
    "<|im_start|>assistant\n<think>\n\n</think>\n"
    "{bad_response}\n<|im_end|>\n"
    "<|im_start|>user\n"
    "Your JSON was invalid: {error}\n\n"
    "Output ONLY the corrected JSON object. No markdown, no explanation.\n"
    "<|im_end|>\n"
    "<|im_start|>assistant\n<think>\n\n</think>\n"
)

_STOPWORDS = frozenset({
    "the", "a", "an", "and", "or", "in", "on", "at", "to", "for", "of", "with",
    "by", "from", "is", "was", "are", "were", "has", "have", "had", "this", "that",
    "it", "its", "be", "been", "but", "not", "as", "up", "do", "did", "will",
    "would", "could", "should", "may", "might", "can", "than", "then", "into",
    "over", "out", "after", "before", "about", "all", "also", "new", "more",
    "one", "two", "three", "said", "says", "say", "get", "got", "set", "use",
    "used", "via", "per", "both", "who", "what", "when", "where", "how", "which",
})


def _content_tokens(text: str) -> set[str]:
    return {w for w in re.findall(r'\b[a-z]{3,}\b', text.lower()) if w not in _STOPWORDS}


def _is_on_topic(summary: str, title: str, text: str) -> bool:
    """Return False if the summary shares no meaningful tokens with the article."""
    article_tokens = _content_tokens(title + " " + text[:500])
    if len(article_tokens) < 5:
        return True  # too sparse to judge reliably
    return bool(article_tokens & _content_tokens(summary))


class EnrichmentClient:
    def __init__(self, cfg: ProfileConfig) -> None:
        self._cfg = cfg
        self._system_prompt = build_system_prompt(cfg)
        # Ollama /api/generate URL (strip /v1 if present).
        base = cfg.llm.base_url.rstrip("/")
        if base.endswith("/v1"):
            base = base[:-3]
        self._generate_url = f"{base}/api/generate"
        # llama-server OpenAI-compatible chat endpoint (base_url keeps its /v1).
        self._chat_url = cfg.llm.base_url.rstrip("/") + "/chat/completions"

    def enrich(self, article: dict[str, Any], cfg: ProfileConfig) -> dict[str, Any]:
        if cfg.llm.backend == "llamacpp":
            raw = self._enrich_llamacpp(article, cfg)
        else:
            raw = self._enrich_ollama(article, cfg)
        result = _parse_and_validate(raw, article)
        return result.to_storage_dict(
            model=cfg.llm.model,
            prompt_version=PROMPT_VERSION,
            raw_response=raw,
        )

    def _enrich_ollama(self, article: dict[str, Any], cfg: ProfileConfig) -> str:
        """Legacy path: raw ChatML + stream-salvage + multi-turn repair, needed to
        survive the Ollama 0.32/Windows wsarecv crash. Returns the raw response
        that _parse_and_validate then re-checks (the repair here pre-validates)."""
        user_msg = build_user_message(article, max_tokens=cfg.llm.max_article_tokens)
        initial_prompt = _CHATML.format(system=self._system_prompt, user=user_msg)

        raw = self._call_llm(initial_prompt)
        try:
            _parse_and_validate(raw, article)
        except (ValueError, ValidationError) as first_exc:
            log.warning(
                "llm_output_invalid id=%s error=%s — attempting repair",
                article.get("id", "?"),
                first_exc,
            )
            repair_prompt = _CHATML_REPAIR.format(
                system=self._system_prompt,
                user=user_msg,
                bad_response=raw[:2000],
                error=str(first_exc)[:200],
            )
            raw = self._call_llm(repair_prompt)
        return raw

    def _enrich_llamacpp(self, article: dict[str, Any], cfg: ProfileConfig) -> str:
        """Clean path: one call, native json_schema grammar, one retry. No ChatML,
        no stream-salvage, no crash sleeps — llama-server doesn't crash like Ollama."""
        user_msg = build_user_message(article, max_tokens=cfg.llm.max_article_tokens)
        raw = self._call_llamacpp(user_msg)
        try:
            _parse_and_validate(raw, article)
        except (ValueError, ValidationError) as exc:
            log.warning("llamacpp_output_invalid id=%s error=%s — one retry", article.get("id", "?"), exc)
            raw = self._call_llamacpp(user_msg)
        return raw

    def _call_llamacpp(self, user_msg: str) -> str:
        payload: dict[str, Any] = {
            "model": self._cfg.llm.model,
            "messages": [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": user_msg},
            ],
            "temperature": self._cfg.llm.temperature,
            "top_p": self._cfg.llm.top_p,
            "top_k": self._cfg.llm.top_k,
            "repeat_penalty": self._cfg.llm.repeat_penalty,
            "max_tokens": 1024,
            # Qwen3: send tokens to JSON, not chain-of-thought.
            # We skip response_format/json_schema here because the GBNF grammar
            # sampler (which evaluates minLength/maxLength string constraints at
            # every token step) is ~20x slower than free generation on this build.
            # Pydantic validation + one retry catches any structural issues.
            "chat_template_kwargs": {"enable_thinking": False},
        }
        if self._cfg.llm.seed is not None:
            payload["seed"] = self._cfg.llm.seed

        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                resp = httpx.post(self._chat_url, json=payload, timeout=120.0)
                resp.raise_for_status()
                body = resp.json()
                usage = body.get("usage", {})
                prompt_tok = usage.get("prompt_tokens", "?")
                completion_tok = usage.get("completion_tokens", "?")
                total_tok = usage.get("total_tokens", "?")
                log.debug(
                    "llamacpp_tokens prompt=%s completion=%s total=%s",
                    prompt_tok, completion_tok, total_tok,
                )
                if isinstance(total_tok, int) and total_tok > 7500:
                    log.warning(
                        "context_budget_warning total_tokens=%d (limit=8192) — "
                        "consider truncating articles or bumping n_ctx",
                        total_tok,
                    )
                content = body["choices"][0]["message"]["content"]
                if content and content.strip():
                    return content
                last_exc = ValueError("llama-server returned empty content")
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                last_exc = exc
            if attempt < 2:
                time.sleep(2)
        raise RuntimeError(
            f"llama-server /v1/chat/completions failed after 3 attempts: {last_exc}"
        )

    def _call_llm(self, prompt: str) -> str:
        payload: dict[str, Any] = {
            "model": self._cfg.llm.model,
            "prompt": prompt,
            # raw=True: skip Ollama's apply-template IPC call to llama-server.
            # On Ollama 0.32.0/Windows, llama-server crashes when apply-template is
            # invoked (wsarecv: connection forcibly closed).  Since we build the full
            # ChatML template ourselves in _CHATML, Ollama's template step is redundant
            # and we can safely bypass it.
            "raw": True,
            # stream=True: tokens are forwarded to us as they arrive from llama-server.
            # llama-server crashes after generating the response (before Ollama can return
            # it in non-streaming mode).  With streaming we receive each token in-flight,
            # so the full response is already in our buffer when the crash happens.
            "stream": True,
            # format: grammar-constrained decoding — forces the model to produce tokens
            # that conform to the JSON schema.  Orthogonal to raw/stream; reduces repair
            # retries by eliminating malformed JSON at the source.
            "format": ENRICHMENT_JSON_SCHEMA,
            "options": {
                "temperature": self._cfg.llm.temperature,
                "top_p": self._cfg.llm.top_p,
                "top_k": self._cfg.llm.top_k,
                "repeat_penalty": self._cfg.llm.repeat_penalty,
                "num_ctx": self._cfg.llm.num_ctx,
                "num_predict": 1024,
            },
        }
        if self._cfg.llm.seed is not None:
            payload["options"]["seed"] = self._cfg.llm.seed

        last_exc: Exception | None = None
        for attempt in range(3):
            full_response = ""
            try:
                with httpx.stream("POST", self._generate_url, json=payload, timeout=120.0) as resp:
                    resp.raise_for_status()
                    for line in resp.iter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        full_response += chunk.get("response", "")
                        if chunk.get("done"):
                            break
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                if attempt < 2:
                    # 500s = llama-server crash; it respawns in ~1.77s but extended
                    # episodes can take up to ~35s. 35s sleep gives safe margin.
                    wait = 35
                    log.warning(
                        "ollama_http_error attempt=%d status=%s — sleeping %ds",
                        attempt, exc.response.status_code, wait,
                    )
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"Ollama /api/generate failed after 3 attempts: {exc}") from exc
            except (httpx.RequestError, httpx.TimeoutException) as exc:
                last_exc = exc
                is_timeout = isinstance(exc, httpx.TimeoutException)
                # Transport error mid-stream: if we collected content before the crash,
                # use it — the model already finished generating before crashing.
                if full_response.strip():
                    log.debug("stream_salvaged length=%d after transport error: %s", len(full_response), exc)
                    break
                if attempt < 2:
                    # Timeouts = Ollama deadlocked (not a crash to wait for respawn).
                    # Retry immediately after a brief pause; don't waste 35s.
                    wait = 5 if is_timeout else 35
                    log.warning(
                        "ollama_%s attempt=%d — sleeping %ds",
                        "timeout" if is_timeout else "transport_error",
                        attempt, wait,
                    )
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"Ollama /api/generate failed after 3 attempts: {exc}") from exc

            if full_response.strip():
                break
            # Empty response from a clean stream — unlikely but retry
            last_exc = ValueError("Ollama streaming returned empty response")
            if attempt < 2:
                wait = 8 * (2 ** attempt)
                log.warning("ollama_empty_response attempt=%d — sleeping %ds", attempt, wait)
                time.sleep(wait)
            else:
                raise RuntimeError("Ollama returned empty response after 3 attempts") from last_exc

        return full_response


def _parse_and_validate(raw: str, article: dict[str, Any] | None = None) -> EnrichmentResult:
    text = raw.strip()
    # Strip <think>...</think> blocks produced by reasoning models
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    # Strip markdown code fences if present
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1)
    # Find the outermost JSON object
    obj_match = re.search(r"\{.*\}", text, re.DOTALL)
    if not obj_match:
        raise ValueError(f"No JSON object found in response (length={len(raw)})")
    try:
        data = json.loads(obj_match.group(0))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc
    result = EnrichmentResult.model_validate(data)

    # Sanity guard: if the summary shares no meaningful tokens with the article,
    # the model likely hallucinated content from training data.
    if article is not None:
        title = article.get("title", "")
        text_body = article.get("extracted_text") or article.get("summary") or ""
        if not _is_on_topic(result.summary, title, text_body):
            raise ValueError(
                f"confabulation_detected: summary shares no content tokens with article "
                f"(title={title[:60]!r}, summary={result.summary[:60]!r})"
            )

    return result
