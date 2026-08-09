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

REM Separate log files per step, in %TEMP%, copied into logs\ after — see
REM the matching comment in publish.cmd for the full investigation. Root
REM cause: the health-check step and the pipeline step were appending to
REM the SAME log file back to back, and PowerShell's file handle on it
REM wasn't always released before cmd.exe reopened it a moment later for
REM the next command's `>>` redirect -- a race condition between two
REM processes sharing one file, not an external lock. Proven by isolating
REM the pipeline command on its own (no preceding writer to the same
REM file), which succeeded every time. Separate files per step removes
REM the shared handle entirely.
SET LOGSTAMP=
FOR /F "usebackq delims=" %%T IN (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) DO SET LOGSTAMP=%%T
IF "%LOGSTAMP%"=="" SET LOGSTAMP=unknown-%RANDOM%
SET HEALTHTEMPLOG=%TEMP%\signalharvester-healthcheck-%LOGSTAMP%.log
SET PIPETEMPLOG=%TEMP%\signalharvester-scheduler-%LOGSTAMP%.log
SET HEALTHLOGFILE=logs\healthcheck-%LOGSTAMP%.log
SET LOGFILE=logs\scheduler-%LOGSTAMP%.log

REM Single llama-server health check right before the run, replacing the old
REM every-5-minutes watchdog scheduled task — same script, same restart-if-
REM down logic (scripts\ensure_llamaserver.ps1), just invoked once here
REM instead of on its own recurring trigger.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%\scripts\ensure_llamaserver.ps1" >> "%HEALTHTEMPLOG%" 2>&1

REM Retried up to 3x with a short pause -- cheap defense in depth; see
REM publish.cmd's matching block for why a bare ERRORLEVEL check isn't
REM sufficient here, and why `ping -n` is used for the delay instead of
REM TIMEOUT (PATH shadowing risk with Git for Windows' own `timeout`).
SET PIPELINE_ATTEMPT=0
:RETRY_PIPELINE
SET /A PIPELINE_ATTEMPT+=1
python -m harvester --profile "%PROFILE%" run >> "%PIPETEMPLOG%" 2>&1
SET PIPELINE_OK=1
IF NOT EXIST "%PIPETEMPLOG%" SET PIPELINE_OK=0
IF "%PIPELINE_OK%"=="1" FOR %%S IN ("%PIPETEMPLOG%") DO IF %%~zS EQU 0 SET PIPELINE_OK=0
IF "%PIPELINE_OK%"=="0" (
    IF %PIPELINE_ATTEMPT% LSS 3 (
        ping -n 21 127.0.0.1 >NUL
        GOTO RETRY_PIPELINE
    )
    ECHO Pipeline did not run after 3 attempts -- %PIPETEMPLOG% was never created or stayed empty.
    EXIT /B 1
)

IF NOT EXIST "logs" MKDIR "logs" >NUL 2>&1
COPY /Y "%HEALTHTEMPLOG%" "%HEALTHLOGFILE%" >NUL 2>&1
COPY /Y "%PIPETEMPLOG%" "%LOGFILE%" >NUL 2>&1

DEACTIVATE
