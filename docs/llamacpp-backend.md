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

You need an OpenAI-compatible server on `:11435`. Two ways to get one; the
harvester only cares that `/v1/chat/completions` answers, so either works.

### Option A — standalone llama.cpp binary (recommended on Windows)

Download a recent Windows CUDA build from
<https://github.com/ggml-org/llama.cpp/releases> (pick the `cuda` variant whose
CUDA version your driver supports — driver 610.74 supports CUDA 13.x; a Blackwell
card like the RTX 5070 needs a build with sm_120 kernels, i.e. a 2026 release).
There are **two zips to download from the same release**:

1. `llama-b10075-bin-win-cuda-13.3-x64.zip` — binaries and ggml DLLs
2. `cudart-llama-bin-win-cuda-13.3-x64.zip` — cuBLAS / cuBLASLt (~373 MB)

Extract both into the same directory (e.g. `C:\Users\<you>\llama.cpp`).

**Two additional DLLs are NOT in either zip** and must be sourced separately:

```
# 1. nvcudart_hybrid64.dll — CUDA hybrid runtime, ships with the NVIDIA driver
#    but NOT registered in System32 on all configurations.
#    Copy it from the driver store:
Copy-Item "C:\Windows\System32\DriverStore\FileRepository\nv_dispi.inf_amd64_*\nvcudart_hybrid64.dll" `
          "C:\Users\<you>\llama.cpp\"

# 2. libomp140.x86_64.dll — LLVM OpenMP runtime (required by ggml-base.dll).
#    If you have Miniconda/Anaconda, copy it from the llvm-openmp conda package:
Copy-Item "C:\Users\<you>\miniconda3\pkgs\llvm-openmp-*\Library\bin\libomp.dll" `
          "C:\Users\<you>\llama.cpp\libomp140.x86_64.dll"
#    Otherwise install LLVM for Windows from https://github.com/llvm/llvm-project/releases
#    and copy libomp140.x86_64.dll from its lib/ directory.
```

Once all four DLL sources are in the same folder, run:

```
llama-server -m C:/Users/couga/.ollama/models/Qwen3-8B-Q5_K_M.gguf ^
  -c 8192 -np 2 -ngl 999 --host 127.0.0.1 --port 11435
```

- `-c 8192` — context window (matches the profile's `num_ctx`).
- `-np 2` — two parallel decoding slots (see "Throughput", below).
- `-ngl 999` — offload all layers to the GPU.

### Option B — llama-cpp-python's server

`pip install llama-cpp-python` ships an OpenAI-compatible server, but the CUDA
wheels do NOT bundle the CUDA runtime — `import llama_cpp` then fails with
`Could not find module 'llama.dll' (or one of its dependencies)` unless
`cudart64_13.dll` / `cublas64_13.dll` are on PATH. The `nvidia-*-cu13` pip
packages are placeholder stubs (0.0.1), so the only fix is installing the **CUDA
Toolkit 13.x** (which puts the runtime on PATH). Once that's done:

```
python -m llama_cpp.server --model C:/Users/couga/.ollama/models/Qwen3-8B-Q5_K_M.gguf ^
  --n_ctx 8192 --n_gpu_layers -1 --host 127.0.0.1 --port 11435
```

Because installing the toolkit is a ~3 GB detour, Option A is the faster route to
a working GPU server. The server can run from any Python env (e.g. base conda) —
it just needs to be reachable at the `base_url` below; the harvester stays in
`.venv` and talks to it over HTTP.

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

## 4. Blackwell (RTX 50-series) performance caveat

Tested on RTX 5070 / driver 610.74 / b10075 build: the standalone `llama-server`
runs at **~3 tokens/second** even with `--flash-attn on` and all layers on the GPU.
Ollama (bundled llama.cpp) on the same hardware runs at ~43 tokens/second. The
GPU is compute-saturated (99% SM util, 9% memory bandwidth) instead of the
memory-bandwidth-bound pattern normal for autoregressive decoding — this is a
build-level regression in b10075's Blackwell CUDA kernels, likely tied to the
experimental `BLACKWELL_NATIVE_FP4` kernel path not fully supporting Q5_K_M.

**Do not enable the `llamacpp` backend on Blackwell until a newer build fixes
this.** Retest with builds from mid-2026 or later. The backend code is production-
ready — only the binary's GPU performance regresses on this specific architecture.

## 5. Validate before trusting it — A/B on the golden set

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

## 6. Throughput (follow-up)

`-np 2` only helps if the pipeline sends concurrent requests. Stage 3 enrichment
is currently a sequential loop (safe for both backends). Once `llamacpp` is
validated, converting that loop to `ThreadPoolExecutor(max_workers=2)` — guarded
on `cfg.llm.backend == "llamacpp"` — roughly doubles throughput on top of the
removed sleeps. Left as a deliberate follow-up so the swap lands without also
changing the pipeline's concurrency model.

## 7. Rollback

The Ollama path is unchanged and remains the default. To roll back, set
`backend: ollama` (or remove the field) and point `base_url` back at
`http://localhost:11434/v1`.
