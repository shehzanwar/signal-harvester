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

# *> redirects all streams (stdout + stderr) to the log.
# The process runs in this hidden PS window until the server is stopped.
& "$llamaDir\llama-server.exe" -m $model -c 8192 -np 2 -ngl 999 --host 127.0.0.1 --port 11435 --flash-attn on *> $logFile
