@echo off
REM Task Scheduler wrapper for ensure_llamaserver.ps1 -- avoids nested-quote
REM parsing issues when registering the task via schtasks /TR.
powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "S:\Projects\Agentic Info Harvest\scripts\ensure_llamaserver.ps1"
