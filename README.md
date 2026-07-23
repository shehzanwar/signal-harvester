# signal-harvester

**A self-hosted, configurable intelligence pipeline that turns any set of RSS feeds into a tiered, sentiment-scored daily briefing — no data ever leaves the machine.**

![Dashboard screenshot — dark theme, T1 alerts at top, sentiment badges, tiered feed](docs/screenshot-placeholder.png)

---

## Why this exists

Most news aggregators optimize for volume. This pipeline optimizes for **signal**: every article is classified by urgency tier (T1/T2/T3/Noise) and sentiment relative to a configured target, using a locally-run LLM. The result is a daily briefing that tells you what to act on, what to note, and what to skip — before you've opened a single link.

100% local inference. No API keys. No PII egress. Everything runs on your hardware.

---

## Three domains, one engine

The pipeline is domain-agnostic. All domain knowledge lives in a single YAML profile file.

| Profile | Feeds | Use case |
|---|---|---|
| `security-grc` | CISA, Krebs, BleepingComputer, MSRC, SANS, + 7 more | Threat intel, vulnerability management, compliance monitoring |
| `soccer-intel` | BBC Sport, The Guardian, The Athletic, StatsBomb, + 4 more | Transfer market, injury reports, tactical analysis |
| `ai-research` | arXiv (cs.AI/LG/CL), Anthropic, OpenAI, DeepMind, + 6 more | Foundation model releases, benchmark results, policy |

Adding a new domain: copy a YAML file, edit feeds + tier criteria. Zero code changes. ([Guide →](docs/adding-a-domain.md))

---

## Architecture

```
RSS feeds → Fetcher → Dedup (SQLite) → Extractor (trafilatura)
         → Enricher (Ollama local LLM) → Pydantic validation
         → JSON archive + Markdown digest + SQLite
         → FastAPI + React dashboard
```

**Stack rationale:**

| Layer | Choice | Why |
|---|---|---|
| Ingestion | `feedparser` + `httpx` | De-facto RSS standard; httpx for timeouts/retries |
| Extraction | `trafilatura` | Best open-source article text extraction |
| LLM | **Ollama** (local) | One-installer GPU inference, OpenAI-compatible API, easy model swaps |
| Validation | Pydantic v2 | Config schema + LLM output schema, one tool for both |
| State | SQLite WAL | Zero-ops, single file, perfectly inspectable, idempotent by design |
| Scheduling | Windows Task Scheduler / cron | External scheduler > in-process daemon: survives reboots |
| API | FastAPI | 4 endpoints, auto OpenAPI docs |
| Frontend | React 18 + Vite + TypeScript + Tailwind | Modern, fast, recruiter-recognizable |

---

## Quickstart

```bash
# 1. Install Ollama (ollama.com), then pull a model
ollama pull qwen3:8b

# 2. Clone and install Python dependencies
git clone https://github.com/yourname/signal-harvester.git
cd signal-harvester
python -m venv .venv && .venv\Scripts\activate
pip install -e ".[dev]"

# 3. Validate your profile (optional but recommended)
python -m harvester validate-config

# 4. Run the pipeline
python -m harvester run

# 5. Build the frontend and start the dashboard
cd frontend && npm run build && cd ..
python -m harvester serve
# → http://localhost:8001
```

**Docker (always-on):** `docker compose up -d api` — the frontend is live-mounted
so `npm run build` updates the site without a container rebuild. See
[docs/setup.md](docs/setup.md) for details.

**Time from clone to running:** under 10 minutes (assuming Ollama installed).

Full setup guide: [docs/setup.md](docs/setup.md)

---

## Configuration reference

```yaml
profile: security-grc
dashboard_title: "Security & Compliance Intelligence"

feeds:
  - name: Krebs on Security
    url: https://krebsonsecurity.com/feed/
    trust: high   # high | medium | low

watch_topics: [ransomware, "zero-day vulnerability", "SOC 2"]
sentiment_target: "our organization's security posture"

tiers:
  T1: "Active exploitation confirmed; CVSS 9.0+ with public PoC; confirmed breach at peer org"
  T2: "New disclosure (CVSS 7-8.9); regulatory proposal; significant vendor patch"
  T3: "Opinion; long-term trends; conference summaries"

llm:
  model: qwen3:8b
  base_url: http://localhost:11434/v1
  num_ctx: 8192
  max_article_tokens: 3500

output:
  root: "output/security-grc"   # UNC paths work: \\NAS\intel\security
  formats: [json, markdown]
```

**Key design decision:** the "choose the lower tier when uncertain" rule is baked into the prompt. This intentionally fights small-model tier inflation, where an 8B model might classify everything as T1.

---

## LLM setup

### Recommended model: `qwen3:8b`

Best small-model instruction following in its class, strong JSON reliability, fast on GPU.

```bash
ollama pull qwen3:8b     # ~5 GB, runs fully on RTX 5070 12GB at 60+ tok/s
```

### Higher-quality option: `qwen3:14b`

Noticeably better tier judgment, still fully GPU-resident on 12GB VRAM.

```bash
ollama pull qwen3:14b    # ~9 GB
# Update profile YAML: model: qwen3:14b
```

### Primary registered model: `harvester-enrich`

Gemma-4 12B fine-tune, registered with a fixed SYSTEM prompt and inference parameters tuned for deterministic classification:

```bash
make model-primary   # pulls ~7.4 GB, registers as harvester-enrich
# Update profile YAML: model: harvester-enrich
```

---

## Evaluation results

> _Numbers pending golden-set construction. Target: ≥75% adjacent-tier accuracy on first run._

| Model | Tier exact | Tier adjacent | Sentiment exact | Articles/min |
|---|---|---|---|---|
| `qwen3:8b` (Q4_K_M) | — | — | — | ~20 |
| `qwen3:14b` (Q4_K_M) | — | — | — | ~12 |
| `harvester-enrich` 12B | — | — | — | ~14 |

Run your own eval:

```bash
# Add golden-set JSON files to tests/golden/ (see docs/adding-a-domain.md)
python -m harvester eval --golden-set tests/golden
```

---

## Dashboard

The dashboard is a single-page React app served by FastAPI at `localhost:8001`.

**Visual hierarchy:**
- **T1** articles: full-width at the top, red accent border, always expanded
- **T2**: responsive 3-column card grid
- **T3**: compact collapsible list
- **Noise**: hidden, count shown in footer ("41 items filtered as noise")
- **Sentiment**: color-coded badge (↑ positive / ↓ negative / → neutral / ↕ mixed) + score + rationale on hover
- **KPI strip** (sticky header): Today's new articles · T1 count · avg sentiment bar · noise count · last run time + health dot

**For You feed:** a learned, cross-tier ranking that personalises the order
based on your reading behaviour. Signals are collected entirely client-side
(opens, dwell time, saves, mutes) and stored in `localStorage` — nothing is
sent anywhere. The score breakdown for any article is visible in its detail
panel ("Why ranked here?"). Ranking uses Maximal Marginal Relevance (λ=0.7)
to keep the feed diverse even as the model learns your preferences.

---

## Pipeline reliability

- **Idempotent:** re-running never duplicates articles or re-summarizes processed ones
- **Per-article isolation:** one dead feed or malformed article never kills the run
- **LLM output validation:** Pydantic schema check → one repair reprompt → `failed_llm` quarantine (never corrupts storage)
- **Backfill:** re-enrich any date range or status class after a model upgrade: `python -m harvester backfill --status failed_llm`
- **Provenance:** every enrichment row records the model name and prompt version it was produced by

---

## Scheduling

Run once from the project root to register a daily Task Scheduler job.

**Pipeline only** (refreshes data and dashboard, no git push):

```cmd
schtasks /Create /TN "SignalHarvester\DailyBriefing" ^
  /TR "\"%CD%\scripts\run_harvester.cmd\"" ^
  /SC DAILY /ST 06:00 /RU %USERNAME% /F
```

**Full publish cycle** (pipeline → frontend build → export → git push):

```cmd
schtasks /Create /TN "SignalHarvester\DailyPublish" ^
  /TR "\"%CD%\scripts\publish.cmd\"" ^
  /SC DAILY /ST 06:00 /RU %USERNAME% /F
```

`/F` makes re-running idempotent — safe to run again to change the start time.

Verify: `schtasks /Query /TN "SignalHarvester\DailyBriefing" /V /FO LIST`

Test immediately: `schtasks /Run /TN "SignalHarvester\DailyBriefing"` then tail `logs\scheduler.log`.

---

## Output artifacts

Each run produces:

```
output/security-grc/
  security-grc.db              ← SQLite state (WAL mode)
  articles/2026/07/
    a3f8c2d1...json            ← one file per enriched article
  digests/
    2026-07-13.md              ← human-readable daily briefing
```

The Markdown digest is the "dashboard-down" fallback — it's a complete, readable artifact even if the frontend is unavailable.

---

## Anti-goals

- Not a web crawler
- Not a social-media scraper (Reddit/HN comment aggregation is Phase 2, by design)
- Not a multi-user SaaS
- Not real-time. Daily is the product.

---

## Roadmap

**Phase 2:** HN/Reddit comment aggregation for T1 articles (community sentiment vs. article sentiment delta); embedding-based near-duplicate clustering (`nomic-embed-text` via Ollama); weekly rollup digest with trend charts.

**Phase 3:** Local RAG chat over the archive ("what happened with X this month?"); entity extraction + timelines; ntfy/Discord webhook alerting; model eval harness with LLM-as-judge for summary faithfulness.

---

## Tests

```bash
make test    # unit tests only — no live Ollama required, CI-safe
pytest tests/ -m live    # integration tests against running Ollama
```

---

## License

MIT
