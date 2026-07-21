# llama.cpp inference backend

The default enrichment backend talks to **Ollama** via `/api/generate` with a
pile of workarounds (raw ChatML templating, response streaming to salvage
partial output, 35-second crash sleeps, a multi-turn JSON repair path). All of
it exists to survive one bug: on Ollama 0.32 / Windows, the bundled llama-server
crashes mid-request (`wsarecv: connection forcibly closed`). During the v1→v4
backfill this crash loop turned a ~40-minute job into several hours.

The `llamacpp` backend bypasses Ollama entirely and talks to a **standalone
llama-server** (from llama.cpp) over its OpenAI-compatible
`/v1/chat/completions` endpoint, using native `json_schema` grammar-constrained
decoding. No ChatML, no stream-salvage, no crash sleeps — just one call and one
retry.

## 1. Get llama-server

Download a prebuilt llama.cpp release for Windows (CUDA build if you have an
NVIDIA GPU) from <https://github.com/ggml-org/llama.cpp/releases> and unzip it.
`llama-server.exe` is in the archive. No model download needed — reuse the GGUF
already on disk from Ollama.

## 2. Launch it

```
llama-server -m C:/Users/couga/.ollama/models/Qwen3-8B-Q5_K_M.gguf ^
  -c 8192 -np 2 --host 127.0.0.1 --port 11435
```

- `-c 8192` — context window (matches the profile's `num_ctx`).
- `-np 2` — two parallel decoding slots. With continuous batching this lets the
  pipeline enrich two articles at once (see "Throughput", below).

## 3. Point the profile at it

In `configs/profiles/daily-briefing.yaml`:

```yaml
llm:
  backend: llamacpp
  base_url: http://localhost:11435/v1
  model: harvester-enrich   # any name; llama-server ignores it
```

Then run the pipeline as usual: `python -m harvester run`. The `llamacpp` backend
also skips the 5-second inter-article sleep (which only existed to wait out
Ollama crashes), so runs are dramatically faster.

## 4. Validate before trusting it — A/B on the golden set

Don't adopt on vibes. Benchmark tier/sentiment accuracy against the golden set
under each backend (and each candidate model), and only switch on a measured win:

```
# current Ollama backend
python -m harvester eval --golden-set tests/golden

# flip llm.backend to llamacpp in the profile, relaunch llama-server, then:
python -m harvester eval --golden-set tests/golden
```

To A/B a **newer model**, launch llama-server with a different GGUF and re-run
the eval. Adopt only if the golden-set score holds or improves — a faster
backend that regresses tier accuracy is not a win.

## Throughput (follow-up)

`-np 2` only helps if the pipeline sends concurrent requests. Stage 3 enrichment
is currently a sequential loop (safe for both backends). Once `llamacpp` is
validated, converting that loop to `ThreadPoolExecutor(max_workers=2)` — guarded
on `cfg.llm.backend == "llamacpp"` — roughly doubles throughput on top of the
removed sleeps. Left as a deliberate follow-up so the swap lands without also
changing the pipeline's concurrency model.

## Rollback

The Ollama path is unchanged and remains the default. To roll back, set
`backend: ollama` (or remove the field) and point `base_url` back at
`http://localhost:11434/v1`.
