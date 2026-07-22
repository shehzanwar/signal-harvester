# Start llama-server at login for the llamacpp enrichment backend.
# Registered in HKCU Run key (no admin needed) by setup-llamaserver-autostart.ps1,
# or manually with:
#
#   $s = "S:\Projects\Agentic Info Harvest\scripts\start_llamaserver.ps1"
#   Set-ItemProperty HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run `
#     -Name SignalHarvester-LlamaServer `
#     -Value "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$s`""

$llamaDir  = "C:\Users\couga\llama.cpp"
$model     = "C:\Users\couga\.ollama\models\Qwen3-8B-Q5_K_M.gguf"
$logFile   = "S:\Projects\Agentic Info Harvest\logs\llama-server.log"

# Wait for GPU drivers and desktop to settle before loading the model.
Start-Sleep -Seconds 30

# Start-Process detaches llama-server as its own independent process so this
# hidden PS window can exit immediately. Using & with *> in a hidden window
# causes the native exe to silently fail to start.
# -np must match llm.concurrency in the profile YAML.
# Sequential pipeline (default, concurrency=1) -> -np 1 (full 8192 context per request)
# Concurrent pipeline (concurrency=2, ThreadPoolExecutor) -> -np 2 (4096 per slot)
Start-Process -FilePath "$llamaDir\llama-server.exe" `
    -ArgumentList "-m `"$model`" -c 8192 -np 1 -ngl 999 --host 127.0.0.1 --port 11435 --flash-attn on" `
    -WorkingDirectory $llamaDir `
    -RedirectStandardError $logFile `
    -NoNewWindow
