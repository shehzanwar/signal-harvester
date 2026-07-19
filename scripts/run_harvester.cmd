@echo off
REM Windows Task Scheduler wrapper for signal-harvester.
REM Activates the virtual environment explicitly — scheduled tasks run under a different
REM user context and often cannot find .venv on PATH without this.
REM
REM Task Scheduler setup:
REM   Action: Start a Program
REM   Program: C:\path\to\signal-harvester\scripts\run_harvester.cmd
REM   Start in: C:\path\to\signal-harvester
REM
REM Set PROFILE below to the profile you want to run, or pass it as %1.

SET PROJECT_DIR=%~dp0..
SET VENV=%PROJECT_DIR%\.venv
SET PROFILE=%~1
IF "%PROFILE%"=="" SET PROFILE=configs\profiles\daily-briefing.yaml

IF NOT EXIST "%VENV%\Scripts\activate.bat" (
    ECHO ERROR: Virtual environment not found at %VENV%
    ECHO Run: python -m venv .venv  then  .venv\Scripts\pip install -e .[dev]
    EXIT /B 1
)

CALL "%VENV%\Scripts\activate.bat"
CD /D "%PROJECT_DIR%"

python -m harvester --profile "%PROFILE%" run >> logs\scheduler.log 2>&1

DEACTIVATE
