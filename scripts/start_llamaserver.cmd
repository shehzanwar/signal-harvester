@echo off
REM Start llama-server at login for the llamacpp enrichment backend.
REM Registered as a Task Scheduler "At logon" task by:
REM
REM   schtasks /Create /TN "SignalHarvester\LlamaServer" ^
REM     /TR "\"%CD%\scripts\start_llamaserver.cmd\"" ^
REM     /SC ONLOGON /DELAY 0:00:30 /RU %USERNAME% /F
REM
REM Logs to logs\llama-server.log. Rotates by overwriting each login
REM (the previous session's log is lost — size stays bounded).

SET LLAMA_DIR=C:\Users\couga\llama.cpp
SET MODEL=C:\Users\couga\.ollama\models\Qwen3-8B-Q5_K_M.gguf
SET PROJECT_DIR=%~dp0..

REM Wait 30s for the desktop and GPU drivers to settle before loading the model.
REM ping is used instead of timeout because timeout blocks in hidden-window mode
REM (launched from the Startup folder VBS with window style 0).
ping 127.0.0.1 -n 31 >nul

"%LLAMA_DIR%\llama-server.exe" ^
  -m "%MODEL%" ^
  -c 8192 -np 2 -ngl 999 ^
  --host 127.0.0.1 --port 11435 ^
  --flash-attn on >> "%PROJECT_DIR%\logs\llama-server.log" 2>&1
