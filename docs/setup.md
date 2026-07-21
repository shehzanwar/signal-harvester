# Setup Guide

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.12+ | Use `python --version` to check |
| Node.js | 18+ | For the dashboard frontend |
| Ollama | Latest | From [ollama.com](https://ollama.com) |
| GPU | Optional | RTX 5070 / 12GB VRAM runs 12B models; CPU-only works but is slow |

---

## Step 1 — Clone and install

```bash
git clone https://github.com/yourname/signal-harvester.git
cd signal-harvester

python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS/Linux

pip install -e ".[dev]"
```

---

## Step 2 — Install Ollama and pull a model

1. Download and run the Ollama installer from **[ollama.com](https://ollama.com)**.
2. Pull the recommended model:

```bash
ollama pull qwen3:8b
```

3. Verify GPU utilization (should show 100% GPU):

```bash
ollama ps
# qwen3:8b   ... 100% GPU
```

4. _(Optional)_ Pull and register the higher-quality 12B model:

```bash
make model-primary
# Then update your profile YAML: model: harvester-enrich
```

---

## Step 3 — Validate your config

```bash
python -m harvester validate-config
# Config valid:
#   profile       : security-grc
#   feeds         : 12
#   watch_topics  : ['ransomware', ...]
#   model         : qwen3:8b
#   output.root   : output/security-grc
```

---

## Step 4 — Run the pipeline

```bash
python -m harvester run
# [security-grc] Run a3f8c2d1 — fetched=87 new=87 enriched=83 failed=4
```

Output is written to `output/security-grc/`:
- `articles/YYYY/MM/<id>.json` — one file per enriched article
- `digests/YYYY-MM-DD.md` — human-readable daily briefing
- `security-grc.db` — SQLite state database

---

## Step 5 — Start the dashboard

```bash
# Build the frontend first (only needed once, or after frontend changes)
make frontend

# Then serve everything as one process
python -m harvester serve
# Dashboard: http://127.0.0.1:8000
# API docs:  http://127.0.0.1:8000/api/docs
```

During development, run the API and frontend dev server separately:

```bash
# Terminal 1:
python -m harvester serve

# Terminal 2:
cd frontend && npm run dev
# Dashboard at http://localhost:5173 (proxies /api to :8000)
```

---

## Step 6 — Schedule daily runs (Windows Task Scheduler)

Run once from the project root in a Command Prompt (not PowerShell):

```cmd
schtasks /Create /TN "SignalHarvester\DailyBriefing" ^
  /TR "\"%CD%\scripts\run_harvester.cmd\"" ^
  /SC DAILY /ST 06:00 /RU %USERNAME% /F
```

`%CD%` captures the project root at registration time. Change `/ST 06:00` to your preferred wake-up time.

Verify it registered:

```cmd
schtasks /Query /TN "SignalHarvester\DailyBriefing" /V /FO LIST
```

Test without waiting:

```cmd
schtasks /Run /TN "SignalHarvester\DailyBriefing"
# then check logs\scheduler.log
```

**NAS output:** Use a UNC path in your YAML (`\\NAS\intel\...`), not a mapped drive letter — Task Scheduler runs under a different user context and mapped drives may not be visible.

**Full publish cycle** (pipeline → frontend build → git push): replace `run_harvester.cmd` with `publish.cmd` in the `/TR` argument. Requires a configured git remote.

---

## Running multiple profiles

Each profile gets its own scheduled task invocation:

```bash
# Profile flag selects the config
python -m harvester --profile configs/profiles/soccer-intel.yaml run
python -m harvester --profile configs/profiles/ai-research.yaml run

# Or from the Task Scheduler cmd wrapper:
scripts\run_harvester.cmd configs\profiles\soccer-intel.yaml
```

Each profile writes to its own output directory and SQLite database.
