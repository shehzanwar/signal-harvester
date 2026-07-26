@echo off
REM Manual-test convenience only -- double-click to run the watchdog once
REM and see output in a visible console. The actual registered scheduled
REM task (SignalHarvester\LlamaServerWatchdog) does NOT go through this
REM file: it calls powershell.exe -WindowStyle Hidden directly (see
REM scripts/llamaserver_watchdog_task.xml), because routing through cmd.exe
REM here would flash a visible console window every 5 minutes -- cmd.exe's
REM own window isn't hidden just because the PowerShell it launches is.
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "S:\Projects\Agentic Info Harvest\scripts\ensure_llamaserver.ps1"
