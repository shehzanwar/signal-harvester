.PHONY: setup model model-primary run serve eval validate test lint fmt clean frontend docker-build docker-up docker-run docker-down help

PROFILE ?= configs/profiles/daily-briefing.yaml
PYTHON   := python

help:
	@echo "Signal Harvester — available targets:"
	@echo "  setup          Install Python dependencies (pip install -e .[dev])"
	@echo "  model          Pull qwen3:8b (fast default model)"
	@echo "  model-primary  Register harvester-enrich (Qwen3-8B-Q5_K_M, already local)"
	@echo "  run            Run the pipeline (PROFILE=... to override)"
	@echo "  serve          Start dashboard on http://localhost:8000"
	@echo "  validate       Validate profile YAML"
	@echo "  eval           Run golden-set evaluation"
	@echo "  test           Run unit tests (no live Ollama required)"
	@echo "  lint           Run ruff linter"
	@echo "  fmt            Auto-format with ruff"
	@echo "  frontend       Build React dashboard"
	@echo "  clean          Remove output/ and cache files"
	@echo "  docker-build   Build the Docker image"
	@echo "  docker-up      Start the dashboard API container (detached)"
	@echo "  docker-run     Run the pipeline once inside Docker"
	@echo "  docker-down    Stop all containers"

setup:
	pip install -e ".[dev]"

model:
	ollama pull qwen3:8b

model-primary:
	@echo "Registering Qwen3-8B-Q5_K_M (already downloaded, no network needed)..."
	ollama create harvester-enrich -f ollama/Modelfile
	@echo "Done. Profile already set to: model: harvester-enrich"

run:
	$(PYTHON) -m harvester --profile $(PROFILE) run

serve:
	$(PYTHON) -m harvester --profile $(PROFILE) serve

validate:
	$(PYTHON) -m harvester --profile $(PROFILE) validate-config

eval:
	$(PYTHON) -m harvester --profile $(PROFILE) eval

test:
	pytest tests/ -v -m "not live"

lint:
	ruff check harvester/ tests/

fmt:
	ruff format harvester/ tests/
	ruff check --fix harvester/ tests/

frontend:
	cd frontend && npm install && npm run build

clean:
	rm -rf output/ .pytest_cache/ .ruff_cache/ .mypy_cache/
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

docker-build:
	docker compose build

docker-up:
	docker compose up -d api

docker-run:
	docker compose run --rm pipeline

docker-down:
	docker compose down
