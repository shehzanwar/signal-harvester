# Watchdog for the llamacpp enrichment backend. Checks whether llama-server
# is actually responding on :11435; if not, kills any stuck process and
# restarts it. Meant to run on a recurring Windows Scheduled Task (see
# scripts/setup-llamaserver-watchdog.ps1), NOT dependent on any particular
# login session staying active, a terminal staying open, or any other
# software (Claude Code included) running.
#
# Root cause this exists for: start_llamaserver.ps1 only fires once, at
# interactive logon (HKCU Run key). If llama-server later crashes, nothing
# ever restarts it — it stays dead until the next login. That silently broke
# every enrichment for over a day (2026-07-24 23:38 through 2026-07-25
# 16:15+) across two separate scheduled pipeline runs before anyone noticed.

$llamaDir = "C:\Users\couga\llama.cpp"
$model    = "C:\Users\couga\.ollama\models\Qwen3-8B-Q5_K_M.gguf"
$errLog   = "S:\Projects\Agentic Info Harvest\logs\llama-server.log"
$watchLog = "S:\Projects\Agentic Info Harvest\logs\llama-server-watchdog.log"
$envFile  = "S:\Projects\Agentic Info Harvest\.env"

function Write-WatchLog($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File -FilePath $watchLog -Append -Encoding utf8
}

# Reads NTFY_TOPIC from .env directly (no python -m harvester's dotenv loader
# available here — this is a plain PS1, not a harvester subprocess) so a
# restart still gets reported even though it auto-fixed itself: repeated
# restarts are a sign of a deeper problem (thermal shutdown, driver issue,
# out of VRAM) worth knowing about even when each individual one self-heals.
function Send-Ntfy($title, $message) {
    if (-not (Test-Path $envFile)) { return }
    $topicLine = Get-Content $envFile | Where-Object { $_ -match '^NTFY_TOPIC=' } | Select-Object -First 1
    if (-not $topicLine) { return }
    $topic = ($topicLine -split '=', 2)[1].Trim()
    if (-not $topic) { return }
    try {
        Invoke-WebRequest -Uri "https://ntfy.sh/$topic" -Method Post -Body $message `
            -Headers @{ Title = $title; Priority = "high"; Tags = "warning,arrows_counterclockwise" } `
            -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop | Out-Null
    } catch {
        Write-WatchLog "ntfy_send_failed: $_"
    }
}

$healthy = $false
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:11435/v1/models" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $healthy = $true }
} catch {
    # Any failure (connection refused, timeout, non-200) means unhealthy — fall through to restart.
}

if ($healthy) {
    exit 0
}

Write-WatchLog "llama-server not responding on :11435 -- restarting"

# Clear out any hung/zombie process before relaunching, in case it's alive
# but wedged (not just absent).
Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Start-Process -FilePath "$llamaDir\llama-server.exe" `
    -ArgumentList "-m `"$model`" -c 8192 -np 1 -ngl 999 --host 127.0.0.1 --port 11435 --flash-attn on" `
    -WorkingDirectory $llamaDir `
    -RedirectStandardError $errLog `
    -NoNewWindow

Start-Sleep -Seconds 10
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:11435/v1/models" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    Write-WatchLog "restart result: HTTP $($resp.StatusCode)"
    Send-Ntfy "llama-server restarted" "Watchdog found it down and restarted it successfully. Repeated restarts may indicate a deeper issue (driver, VRAM, thermal)."
} catch {
    Write-WatchLog "restart result: still unreachable after relaunch attempt -- $_"
    Send-Ntfy "llama-server restart FAILED" "Watchdog tried to restart llama-server but it's still unreachable. Needs manual attention."
}
