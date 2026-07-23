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
| `daily-briefing` (live) | 33 feeds across technology, finance, politics, sports, world | General daily intelligence briefing — the profile actually running in production |
| `security-grc` | CISA, Krebs, BleepingComputer, MSRC, SANS, + 7 more | Threat intel, vulnerability management, compliance monitoring |
| `soccer-intel` | BBC Sport, The Guardian, The Athletic, StatsBomb, + 4 more | Transfer market, injury reports, tactical analysis |
| `ai-research` | arXiv (cs.AI/LG/CL), Anthropic, OpenAI, DeepMind, + 6 more | Foundation model releases, benchmark results, policy |

Adding a new domain: copy a YAML file, edit feeds + tier criteria. Zero code changes. ([Guide →](docs/adding-a-domain.md))

---

## Architecture

```
RSS feeds → Fetcher → Dedup (SQLite) → Extractor (trafilatura)
         → Social enrichment (HN, Reddit, Bluesky, Mastodon, Lemmy, Twitter/X, YouTube — best-effort)
         → Enricher (local llama.cpp LLM: editorial tone + predicted reaction) → Pydantic validation
         → Comment-informed public sentiment + perception gap
         → JSON archive + Markdown digest + SQLite
         → FastAPI + React dashboard (or static export for GitHub Pages)
```

**Stack rationale:**

| Layer | Choice | Why |
|---|---|---|
| Ingestion | `feedparser` + `httpx` | De-facto RSS standard; httpx for timeouts/retries |
| Extraction | `trafilatura` | Best open-source article text extraction |
| LLM | **llama.cpp** (`llama-server`, local) | OpenAI-compatible `/v1/chat/completions`; ~65 t/s on a Blackwell GPU with `--flash-attn on` — see [docs/llamacpp-backend.md](docs/llamacpp-backend.md) |
| Social signals | `praw`, `twscrape`, YouTube Data API v3, HN/Bluesky/Mastodon/Lemmy public APIs | Comment-informed "actual public reaction" layer, all best-effort and gated behind config/credentials |
| Validation | Pydantic v2 | Config schema + LLM output schema, one tool for both |
| State | SQLite WAL | Zero-ops, single file, perfectly inspectable, idempotent by design |
| Scheduling | Windows Task Scheduler / cron | External scheduler > in-process daemon: survives reboots |
| API | FastAPI | Dashboard endpoints + static JSON export for GitHub Pages, auto OpenAPI docs |
| Frontend | React 18 + Vite + TypeScript + Tailwind | Modern, fast, recruiter-recognizable |
| Deployment | Docker Compose (always-on API) + GitHub Pages (static snapshot) | Two separate Vite build targets — see [Deployment](#deployment) |

> Earlier versions ran on Ollama. The `ollama` backend still works (see
> [docs/llamacpp-backend.md](docs/llamacpp-backend.md) for the rollback path),
> but `llamacpp` is now the default — it bypasses a Windows-specific Ollama
> crash loop and is ~50% faster on the same hardware.

---

## Quickstart

```bash
# 1. Set up a local llama.cpp server (see docs/llamacpp-backend.md for the
#    full Windows CUDA setup — DLLs, model download, launch flags)
llama-server -m /path/to/Qwen3-8B-Q5_K_M.gguf -c 8192 -np 1 -ngl 999 \
  --host 127.0.0.1 --port 11435 --flash-attn on

# 2. Clone and install Python dependencies
git clone https://github.com/shehzanwar/signal-harvester.git
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
so `npm run build` updates the site without a container rebuild. `llama-server`
runs natively on the host GPU; the container reaches it via
`host.docker.internal`. See [Deployment](#deployment) below and
[docs/setup.md](docs/setup.md) for details.

**Time from clone to running:** under 10 minutes (assuming a llama.cpp server is already up).

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
  backend: llamacpp
  model: harvester-enrich
  base_url: http://localhost:11435/v1
  num_ctx: 8192
  max_article_tokens: 3500

output:
  root: "output/security-grc"   # UNC paths work: \\NAS\intel\security
  formats: [json, markdown]
```

**Key design decision:** the "choose the lower tier when uncertain" rule is baked into the prompt. This intentionally fights small-model tier inflation, where an 8B model might classify everything as T1.

---

## LLM setup

### Backend: `llamacpp` (default)

The pipeline talks to a standalone `llama-server` process over its
OpenAI-compatible `/v1/chat/completions` endpoint — no Ollama dependency, no
ChatML workarounds. Full Windows CUDA setup (DLL sourcing, launch flags,
throughput tuning) is in [docs/llamacpp-backend.md](docs/llamacpp-backend.md).
The `ollama` backend is still supported as a fallback (`backend: ollama` in
the profile YAML) if you'd rather not run a standalone server.

### Model in production: `Qwen3-8B` (Q5_K_M GGUF)

Best small-model instruction following in its class, strong JSON reliability,
~65 t/s on a Blackwell GPU with `--flash-attn on`. Registered in the profile
as `harvester-enrich` (the name is arbitrary — `llama-server` ignores it and
serves whatever GGUF it was launched with).

```bash
llama-server -m /path/to/Qwen3-8B-Q5_K_M.gguf -c 8192 -np 1 -ngl 999 \
  --host 127.0.0.1 --port 11435 --flash-attn on
```

```yaml
llm:
  backend: llamacpp
  model: harvester-enrich
  base_url: http://localhost:11435/v1
```

Swapping models or GGUFs: don't adopt on impression alone — validate against
the golden set first (see [Golden set & CI](#golden-set--ci) below).

---

## Golden set & CI

`tests/golden/` holds **50 hand-labeled articles** (expected tier, editorial
tone, predicted reaction) used to catch prompt/model regressions before they
reach production. GitHub Actions ([.github/workflows/golden-validate.yml](.github/workflows/golden-validate.yml))
runs `scripts/validate_golden.py` plus the full non-slow pytest suite on
every change to `configs/profiles/**`, `prompts/**`, `tests/golden/**`, or
`harvester/enrich/**` — a prompt edit that breaks schema conformance or an
existing test fails CI, not a live pipeline run.

```bash
python -m harvester eval --golden-set tests/golden   # score a model/prompt combo
python scripts/validate_golden.py tests/golden/       # schema-only check (what CI runs)
```

---

## Dashboard

The dashboard is a single-page React app served by FastAPI at `localhost:8001`
(or exported as a static JSON snapshot for GitHub Pages — see [Deployment](#deployment)).

**Visual hierarchy:**
- **T1** articles: full-width at the top, red accent border, always expanded
- **T2**: responsive 3-column card grid
- **T3**: compact collapsible list
- **Noise**: hidden, count shown in footer ("41 items filtered as noise")
- **KPI strip** (sticky header): Today's new articles · T1 count · avg sentiment bar · noise count · last run time + health dot
- **5-minute briefing tab:** a condensed view — the day's T1/T2 headlines only, for a fast catch-up read

**Perception model — three sentiment layers, not one:**
- **Editorial tone:** how the *journalist* frames the story (label + score + rationale)
- **Predicted reaction:** the LLM's estimate of how the general public would react to the news itself, independent of the article's framing
- **Public sentiment (comment-informed):** when social signals are available, actual comment sentiment from HN/Reddit/YouTube/etc. replaces the prediction, tagged with a confidence level (`high`/`medium`/`low`/`predicted`) and a dominant emotion
- **Perception gap:** the delta between editorial tone and (predicted or actual) public reaction — surfaces stories where the press and the public read the same facts very differently

**Social signal attribution:** cards and the detail panel ("Perception" tab)
show which platforms contributed comment data for a given article — HN,
Reddit, Bluesky, Mastodon, Lemmy, Twitter/X, and YouTube — with per-source
score/comment counts and permalinks where available. All seven are
best-effort and gated behind config/credentials (see [docs/setup.md](docs/setup.md));
the pipeline runs fine with zero of them configured.

**For You feed:** a learned, cross-tier ranking that personalises the order
based on your reading behaviour. Signals are collected entirely client-side
(opens, dwell time, saves, mutes) and stored in `localStorage` — nothing is
sent anywhere. Dwell time and repeated exposure without engagement ("story
fatigue") both feed the ranking, and a small adaptive-exploration slice keeps
surfacing outside your established preferences so the feed doesn't collapse
into a filter bubble. The score breakdown for any article is visible in its
detail panel ("Why ranked here?"). Ranking uses Maximal Marginal Relevance
(λ=0.7) to keep the feed diverse even as the model learns your preferences.

---

## Pipeline reliability

- **Idempotent:** re-running never duplicates articles or re-summarizes processed ones
- **Per-article isolation:** one dead feed or malformed article never kills the run
- **LLM output validation:** Pydantic schema check → one repair reprompt → `failed_llm` quarantine (never corrupts storage)
- **Backfill:** re-enrich any date range or status class after a model upgrade: `python -m harvester backfill --status failed_llm`
- **Provenance:** every enrichment row records the model name and prompt version it was produced by
- **Golden-set gated:** prompt and profile changes run against a 50-article golden set in CI before they can regress production (see [Golden set & CI](#golden-set--ci))

---

## Deployment

Two separate builds target two different destinations — they are **not**
interchangeable:

| Build | Command | Output | Base path | Mode | Target |
|---|---|---|---|---|---|
| Live API | `npm run build` | `frontend/dist/` | `/` | `IS_STATIC=false` | Docker (`docker compose up -d api`), talks to the live FastAPI backend |
| Static snapshot | `npm run build:static` | `frontend/dist-static/` | `/signal-harvester/` | `IS_STATIC=true` | GitHub Pages, reads a pre-exported JSON snapshot, no backend required |

`scripts/publish.cmd` runs both: pipeline → `build:static` → `python -m harvester export` → git push (updates GitHub Pages) — it does **not** touch the Docker `dist/` build, so the always-on API container keeps serving the live build independently. Building the wrong target into `frontend/dist/` (e.g. accidentally running `build -- --mode static`) breaks the live API dashboard, since it will try to fetch a static JSON snapshot that doesn't exist on that server.

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

- Not a web crawler — RSS feeds and their linked comment threads only, never arbitrary crawling
- Not a general social-media aggregator — comment sources exist solely to inform per-article sentiment, not as a standalone feed
- Not a multi-user SaaS
- Not real-time. Daily is the product.

---

## Roadmap

**Done:** HN/Reddit/Bluesky/Mastodon/Lemmy/Twitter/YouTube comment aggregation with a three-layer perception model (editorial tone / predicted reaction / comment-informed public sentiment) and a perception gap metric; embedding-based near-duplicate clustering; weekly rollup digest; For You ranking v2 (MMR diversity, dwell-time learning, story fatigue, adaptive exploration); Docker deployment with a separate GitHub Pages static export; golden-set eval harness gated in CI.

**Next up:** T3/NOISE reclassification (tighten NOISE calibration examples to shrink the background-tier volume); dashboard polish (date grouping, T1 hero section, true-compact T3 rows, clearer KPI strip labeling).

**Later:** Local RAG chat over the archive ("what happened with X this month?"); entity extraction + timelines; ntfy/Discord webhook alerting; LLM-as-judge eval for summary faithfulness.

---

## Tests

```bash
make test              # unit tests only — no live LLM server required, CI-safe
pytest tests/ -m "not slow"   # what CI runs (47 tests as of prompt v6)
pytest tests/ -m live         # integration tests against a running llama-server/Ollama
python scripts/validate_golden.py tests/golden/   # golden-set schema check
```

---

## License

MIT
